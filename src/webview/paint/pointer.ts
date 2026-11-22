import { brushRadius, magicWandSelect, type Rgba, type SelectionRect, type Shape } from '../painting'
import { rememberColor, type App } from './app'
import { constrainHead, exceedsDragThreshold, isPenCloseEvent, selectionRectOf } from './geometry'
import { rectMask, sampleComposite } from './ops'
import { activeLayer, dropSelection, combineSelection, markPixelsChanged, type LayerBuffer, type PaintState } from './state'
import type { Stage } from './stage'
import { commitDiff, drawShapePreview, scatterAt, fillAt, paintSegment } from './strokes'
import { addPenPoint, closeSelectionPath } from './selectionPath'

type GestureKind = 'pen' | 'paint' | 'shape' | 'select' | 'crop' | 'pick' | 'pan'

interface Gesture {
  id: number
  kind: GestureKind
  temporaryPick?: boolean
  path?: PaintState['pen']
  client: [number, number]
  origin: [number, number]
  last: [number, number]
  moved: boolean
  erase: boolean
  rgba: Rgba
  shape?: Shape
  layer?: LayerBuffer
  before?: Uint8Array
  preview?: SelectionRect
  selectionBefore?: Uint8Array
  scroll: [number, number]
}

export function attachPointer(app: App, stage: Stage): void {
  const { state, scroller } = app
  let gesture: Gesture | undefined
  let pendingPenClick: Gesture | undefined
  let suppressPenDoubleClick = false

  const inside = (point: [number, number]): boolean =>
    point[0] >= 0 && point[1] >= 0 && point[0] < state.width && point[1] < state.height

  function start(event: PointerEvent, kind: GestureKind, origin: [number, number], extra: Partial<Gesture> = {}): void {
    gesture = {
      id: event.pointerId,
      kind,
      client: [event.clientX, event.clientY],
      origin,
      last: origin,
      moved: false,
      erase: false,
      rgba: [0, 0, 0, 0],
      scroll: [scroller.scrollLeft, scroller.scrollTop],
      ...extra
    }
    scroller.setPointerCapture(event.pointerId)
  }

  function onDown(event: PointerEvent): void {
    updateHover(event)
    if (gesture) return
    pendingPenClick = undefined
    suppressPenDoubleClick = event.altKey || app.modifiers.space || event.button !== 0
    const tool = state.tool
    if (event.button === 1 || app.modifiers.space) {
      event.preventDefault()
      start(event, 'pan', [0, 0])
      app.requestRender()
      return
    }
    if (event.button === 0 && event.altKey) {
      beginPick(event, stage.pixelAt([event.clientX, event.clientY]), true)
      return
    }
    if (tool === 'hand') {
      event.preventDefault()
      start(event, 'pan', [0, 0])
      app.requestRender()
      return
    }
    const paintLike = tool === 'brush' || tool === 'nearby' || tool === 'symmetry' || tool === 'eraser' || tool === 'line' || tool === 'rect' || tool === 'ellipse'
    if (event.button !== 0 && !(event.button === 2 && paintLike)) return
    const pixel = stage.pixelAt([event.clientX, event.clientY])
    switch (tool) {
      case 'select': {
        const selectionBefore = state.selection?.mask
        if (state.selectionMode === 'replace') dropSelection(state)
        app.requestRender()
        start(event, 'select', pixel, { selectionBefore })
      }
        return
      case 'wand':
        magicWand(pixel, event.ctrlKey || event.metaKey || event.shiftKey)
        return
      case 'brush':
      case 'symmetry':
      case 'nearby':
        beginPaint(event, pixel, event.button === 2)
        return
      case 'eraser':
        beginPaint(event, pixel, true)
        return
      case 'scatter':
        scatterAt(app)
        return
      case 'fill':
        pourFill(pixel)
        return
      case 'picker':
        beginPick(event, pixel)
        return
      case 'line':
      case 'rect':
      case 'ellipse':
        beginShape(event, pixel, tool, event.button === 2)
        return
      case 'polygon':
        if (inside(pixel)) start(event, 'pen', pixel, { path: state.pen })
        return
      case 'crop':
        beginCrop(event)
        return
    }
  }

  function updateHover(event: PointerEvent): void {
    const point = stage.pixelAt([event.clientX, event.clientY])
    app.hover.client = [event.clientX, event.clientY]
    app.hover.point = inside(point) ? point : undefined
    app.hover.pointerType = event.pointerType
    app.hover.pressure = event.pressure
    app.hover.buttons = event.buttons
    app.hover.altKey = event.altKey
  }

  function onMove(event: PointerEvent): void {
    const client: [number, number] = [event.clientX, event.clientY]
    const pixel = stage.pixelAt(client)
    updateHover(event)
    app.requestRender()
    const g = gesture
    if (!g || event.pointerId !== g.id) return
    if (g.temporaryPick && !event.altKey) {
      endGesture(g.id)
      return
    }
    switch (g.kind) {
      case 'pan':
        scroller.scrollLeft = g.scroll[0] - (client[0] - g.client[0])
        scroller.scrollTop = g.scroll[1] - (client[1] - g.client[1])
        return
      case 'paint':
        if (g.layer && g.before) paintSegment(app, g.layer, g.before, g.last, pixel, brushRadius(state.brushSize, event), g.erase, g.rgba)
        g.last = pixel
        return
      case 'shape':
        if (g.layer && g.before && g.shape) {
          const head = event.shiftKey ? constrainHead(g.shape, g.origin, pixel) : pixel
          g.preview = drawShapePreview(app, g.layer, g.before, g.preview, g.shape, g.origin, head, brushRadius(state.brushSize, event), g.erase, g.rgba)
        }
        return
      case 'select':
        if (!g.moved) {
          if (!exceedsDragThreshold(g.client, client)) return
          g.moved = true
        }
        combineSelection(state, rectMask(state.width, state.height, selectionRectOf(g.origin, pixel, state.width, state.height)), g.selectionBefore ?? null)
        app.requestRender()
        return
      case 'crop':
        if (!state.crop) return
        if (!state.crop.active) {
          if (!exceedsDragThreshold(g.client, client)) return
          state.crop.active = true
          app.requestChrome()
        }
        state.crop.end = stage.gridAt(client)
        app.requestRender()
        return
      case 'pick':
        if (inside(pixel)) pickAt(pixel)
        return
    }
  }

  function onUp(event: PointerEvent): void {
    updateHover(event)
    app.hover.buttons = 0
    app.requestRender()
    endGesture(event.pointerId)
  }

  function endGesture(pointerId: number, cancelled = false): void {
    const g = gesture
    if (!g || pointerId !== g.id) return
    gesture = undefined
    delete scroller.dataset.temporaryTool
    if (scroller.hasPointerCapture(pointerId)) scroller.releasePointerCapture(pointerId)
    switch (g.kind) {
      case 'pen':
        if (!cancelled && state.tool === 'polygon' && g.path === state.pen) pendingPenClick = g
        return
      case 'paint':
      case 'shape':
        if (g.layer && g.before) {
          if (cancelled) {
            g.layer.pixels.set(g.before)
            markPixelsChanged(state, undefined)
            app.host.cancelPreviewStroke?.()
            app.requestRender()
          } else commitDiff(app, g.layer, g.before)
        }
        return
      case 'select':
        app.requestChrome()
        app.requestRender()
        return
      case 'crop':
        if (state.crop && !state.crop.active) state.crop = undefined
        app.requestChrome()
        app.requestRender()
        return
      case 'pick':
        rememberColor(app, state.color)
        return
      case 'pan':
        return
    }
  }

  function beginPaint(event: PointerEvent, pixel: [number, number], erase: boolean): void {
    const layer = activeLayer(state)
    if (!layer || !inside(pixel)) return
    const rgba: Rgba = erase ? [0, 0, 0, 0] : state.color
    if (!erase) rememberColor(app, rgba)
    const before = layer.pixels.slice()
    start(event, 'paint', pixel, { erase, rgba, layer, before })
    paintSegment(app, layer, before, pixel, pixel, brushRadius(state.brushSize, event), erase, rgba)
  }

  function beginShape(event: PointerEvent, pixel: [number, number], shape: Shape, erase: boolean): void {
    const layer = activeLayer(state)
    if (!layer || !inside(pixel)) return
    const rgba: Rgba = erase ? [0, 0, 0, 0] : state.color
    if (!erase) rememberColor(app, rgba)
    start(event, 'shape', pixel, { erase, rgba, layer, before: layer.pixels.slice(), shape })
  }

  function magicWand(pixel: [number, number], additive = false): void {
    const layer = activeLayer(state)
    if (!layer || !inside(pixel)) return
    combineSelection(state, magicWandSelect(layer.pixels, state.width, state.height, pixel[0], pixel[1], state.tolerance, true), state.selection?.mask, additive ? 'add' : state.selectionMode)
    app.requestChrome()
    app.requestRender()
  }

  function pourFill(pixel: [number, number]): void {
    const layer = activeLayer(state)
    if (!layer || !inside(pixel)) return
    rememberColor(app, state.color)
    fillAt(app, layer, pixel[0], pixel[1])
  }

  function beginPick(event: PointerEvent, pixel: [number, number], temporaryPick = false): void {
    if (!inside(pixel)) return
    pickAt(pixel)
    start(event, 'pick', pixel, { temporaryPick })
    if (temporaryPick) scroller.dataset.temporaryTool = 'picker'
  }

  function pickAt(pixel: [number, number]): void {
    state.color = sampleComposite(state, pixel[0], pixel[1])
    app.requestChrome()
    app.requestRender()
  }

  function beginCrop(event: PointerEvent): void {
    const grid = stage.gridAt([event.clientX, event.clientY])
    state.crop = { start: grid, end: grid, active: false }
    start(event, 'crop', grid)
    app.requestChrome()
    app.requestRender()
  }

  scroller.addEventListener('pointerdown', onDown)
  scroller.addEventListener('pointermove', onMove)
  scroller.addEventListener('pointerup', onUp)
  const cancelGesture = (event: PointerEvent): void => {
    app.hover.buttons = 0
    endGesture(event.pointerId, true)
    app.requestRender()
  }
  scroller.addEventListener('pointercancel', cancelGesture)
  scroller.addEventListener('lostpointercapture', cancelGesture)
  scroller.addEventListener('click', event => {
    const pending = pendingPenClick
    pendingPenClick = undefined
    if (!pending || event.detail > 1 || state.tool !== 'polygon' || pending.path !== state.pen || event.altKey || app.modifiers.space) return
    addPenPoint(app, pending.origin)
  })
  const view = scroller.ownerDocument.defaultView
  view?.addEventListener('keyup', event => {
    if (event.key !== 'Alt') return
    delete scroller.dataset.temporaryTool
    if (gesture?.temporaryPick) endGesture(gesture.id)
  })
  view?.addEventListener('blur', () => {
    delete scroller.dataset.temporaryTool
    pendingPenClick = undefined
    if (gesture) endGesture(gesture.id, true)
  })
  scroller.addEventListener('pointerleave', () => { app.hover.point = undefined; app.hover.client = undefined; app.requestRender() })
  scroller.addEventListener('dblclick', event => {
    if (suppressPenDoubleClick || event.altKey || app.modifiers.space) return
    if (state.tool === 'polygon' && isPenCloseEvent(event)) closeSelectionPath(app)
  })
  scroller.addEventListener('contextmenu', event => event.preventDefault())
}
