import { uiText } from '../../i18n/messages'
import { createSmartGuides } from './smartGuides'
import { variantLayers } from '../../core/randomVariants'
import { compositeAt, type SelectionRect } from '../painting'
import type { Hover } from './app'
import { el } from './dom'
import { clampZoom, fitZoom, stepZoom } from './geometry'
import { drawOverlay } from './overlay'
import { brushPreview, canvasPoint } from './brushPreview'
import { clipRect } from './ops'
import type { LayerBuffer, PaintState } from './state'

const FIT_MARGIN = 48

export interface Stage {
  readonly scroller: HTMLElement
  readonly sourceCanvas: HTMLCanvasElement
  readonly sourceRevision: number
  render(): void
  zoomTo(zoom: number, anchor?: [number, number]): void
  fitWindow(): void
  // 屏幕坐标换算为画布像素, 结果可能越界, 由调用方判断
  pixelAt(client: [number, number]): [number, number]
  // 屏幕坐标换算为最近的网格线坐标, 裁剪以网格线为边界
  gridAt(client: [number, number]): [number, number]
}

export function mountStage(parent: HTMLElement, state: PaintState, hover: Hover, requestRender: () => void): Stage {
  const smartGuides = createSmartGuides()
  const scroller = el('div', 'mp-stage')
  scroller.setAttribute('aria-label', uiText("webview.paint.stage.pasteCanvassScrollerScalingMiddleClickDrag"))
  const inner = el('div', 'mp-stage-inner')
  const wrap = el('div', 'mp-canvas mp-checker')
  const pixels = el('canvas', 'mp-pixels')
  const overlay = el('canvas', 'mp-overlay')
  wrap.append(pixels, overlay)
  inner.append(wrap)
  scroller.append(inner)
  const guideCanvas = el('canvas', 'mp-guides')
  guideCanvas.setAttribute('aria-hidden', 'true')
  parent.append(scroller, guideCanvas)
  const sourceCanvas = el('canvas')
  const sourceCtx = requireContext(sourceCanvas)
  const pixelCtx = requireContext(pixels)
  let previewBounds: SelectionRect | undefined
  const overlayCtx = requireContext(overlay)
  const guideCtx = requireContext(guideCanvas)
  let sourceRevision = 0
  let image: ImageData | undefined
  let shownWidth = 0
  let shownHeight = 0
  let shownZoom = 0
  let renderedLayers: Array<Pick<LayerBuffer, 'id' | 'visible' | 'opacity' | 'pixels'>> = []

  function layout(): void {
    const sizeChanged = state.width !== shownWidth || state.height !== shownHeight
    if (sizeChanged) {
      pixels.width = state.width
      pixels.height = state.height
      sourceCanvas.width = state.width
      sourceCanvas.height = state.height
      previewBounds = undefined
      image = pixelCtx.createImageData(state.width, state.height)
      shownWidth = state.width
      shownHeight = state.height
      state.fullRedraw = true
    }
    if (sizeChanged || state.zoom !== shownZoom) {
      wrap.style.width = `${state.width * state.zoom}px`
      wrap.style.height = `${state.height * state.zoom}px`
      shownZoom = state.zoom
    }
    const rect = pixels.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const backingWidth = Math.max(1, Math.round(rect.width * dpr))
    const backingHeight = Math.max(1, Math.round(rect.height * dpr))
    if (overlay.width !== backingWidth) overlay.width = backingWidth
    if (overlay.height !== backingHeight) overlay.height = backingHeight
  }

  // 对指定矩形逐像素合成可见图层, 只把该矩形写回像素层, 避免整幅重算
  function composite(rect: SelectionRect, layers: readonly LayerBuffer[]): void {
    if (!image || rect.width <= 0 || rect.height <= 0) return
    const data = image.data
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        const color = compositeAt(layers, state.width, x, y)
        const i = (y * state.width + x) * 4
        data[i] = color[0]
        data[i + 1] = color[1]
        data[i + 2] = color[2]
        data[i + 3] = color[3]
      }
    }
    pixelCtx.putImageData(image, 0, 0, rect.x, rect.y, rect.width, rect.height)
    sourceCtx.putImageData(image, 0, 0, rect.x, rect.y, rect.width, rect.height)
    sourceRevision++
  }

  // 变换仅替换像素，显隐与不透明度始终跟随当前图层
  function displayLayers(): readonly LayerBuffer[] {
    const layers = variantLayers(state.layers, state.layers.find(layer => layer.id === state.activeLayerId)?.randomVariant ? state.activeLayerId : state.previewVariantId)
    if (!state.transformedLayers) return layers
    const transformed = new Map(state.transformedLayers.map(layer => [layer.id, layer]))
    return layers.map(layer => {
      const preview = transformed.get(layer.id)
      return preview ? { ...preview, visible: layer.visible, opacity: layer.opacity } : layer
    })
  }

  function render(): void {
    layout()
    const layers = displayLayers()
    const metadataChanged = layers.length !== renderedLayers.length || layers.some((layer, index) => {
      const previous = renderedLayers[index]
      return !previous || layer.id !== previous.id || layer.visible !== previous.visible || layer.opacity !== previous.opacity || layer.pixels !== previous.pixels
    })
    if (metadataChanged) {
      state.fullRedraw = true
      renderedLayers = layers.map(({ id, visible, opacity, pixels }) => ({ id, visible, opacity, pixels }))
    }
    if (previewBounds && image) pixelCtx.putImageData(image, 0, 0, previewBounds.x, previewBounds.y, previewBounds.width, previewBounds.height)
    previewBounds = undefined
    if (state.fullRedraw) composite({ x: 0, y: 0, width: state.width, height: state.height }, layers)
    else if (state.dirty) composite(clipRect(state.dirty, state.width, state.height), layers)
    state.fullRedraw = false
    state.dirty = undefined
    wrap.classList.toggle('is-opaque', !state.showTransparent)
    if (hover.client) {
      const rect = scroller.getBoundingClientRect()
      const point = pixelAt(hover.client)
      const overStage = hover.client[0] >= rect.left && hover.client[0] < rect.right && hover.client[1] >= rect.top && hover.client[1] < rect.bottom
      hover.point = overStage && point[0] >= 0 && point[1] >= 0 && point[0] < state.width && point[1] < state.height ? point : undefined
    }
    const temporary = scroller.dataset.temporaryTool === 'picker' || scroller.dataset.spaceHand === 'true'
    const activeHover: Hover = temporary ? { ...hover, point: undefined } : hover
    const preview = brushPreview(state, activeHover)
    if (preview) {
      const patch = pixelCtx.createImageData(preview.rect.width, preview.rect.height)
      patch.data.set(preview.pixels)
      pixelCtx.putImageData(patch, preview.rect.x, preview.rect.y)
      previewBounds = preview.rect
    }
    drawOverlay(overlayCtx, state, activeHover, preview?.footprint)
    const viewport = scroller.getBoundingClientRect(), bounds = wrap.getBoundingClientRect(), dpr = window.devicePixelRatio || 1
    const width = scroller.clientWidth, height = scroller.clientHeight
    const backingWidth = Math.max(1, Math.round(width * dpr)), backingHeight = Math.max(1, Math.round(height * dpr))
    if (guideCanvas.width !== backingWidth) guideCanvas.width = backingWidth
    if (guideCanvas.height !== backingHeight) guideCanvas.height = backingHeight
    guideCanvas.style.width = width + 'px'; guideCanvas.style.height = height + 'px'
    guideCtx.setTransform(1, 0, 0, 1, 0, 0); guideCtx.clearRect(0, 0, guideCanvas.width, guideCanvas.height)
    guideCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
    smartGuides(guideCtx, state, activeHover, image?.data, {
      width, height, imageLeft: bounds.left - viewport.left, imageTop: bounds.top - viewport.top,
      zoom: bounds.width / state.width, revision: sourceRevision,
      pointer: activeHover.client ? [activeHover.client[0] - viewport.left, activeHover.client[1] - viewport.top] : undefined
    })
  }

  function zoomTo(zoom: number, anchor?: [number, number]): void {
    const next = clampZoom(zoom)
    state.zoomTouched = true
    if (next === state.zoom) return
    const focus = anchor ?? viewportCenter(scroller)
    const before = wrap.getBoundingClientRect()
    const focusX = (focus[0] - before.left) / before.width
    const focusY = (focus[1] - before.top) / before.height
    state.zoom = next
    layout()
    const after = wrap.getBoundingClientRect()
    scroller.scrollLeft += after.left + focusX * after.width - focus[0]
    scroller.scrollTop += after.top + focusY * after.height - focus[1]
    requestRender()
  }

  function fitWindow(): void {
    state.zoomTouched = false
    state.zoom = fitZoom(state.width, state.height, scroller.clientWidth - FIT_MARGIN, scroller.clientHeight - FIT_MARGIN)
    layout()
    scroller.scrollLeft = 0
    scroller.scrollTop = 0
    requestRender()
  }

  scroller.addEventListener('wheel', event => {
    const editing = [event.target, document.activeElement].some(target => target instanceof HTMLElement &&
      (target.isContentEditable || target.closest('input, textarea, select, [contenteditable=true]')))
    if (editing || document.querySelector('.mp-shortcuts[open]')) return
    if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
      if (event.deltaX === 0 && event.deltaY === 0) return
      event.preventDefault()
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? scroller.clientWidth : 1
      scroller.scrollLeft += (event.deltaX || event.deltaY) * unit
      return
    }
    if (event.deltaY === 0) return
    event.preventDefault()
    zoomTo(stepZoom(state.zoom, event.deltaY < 0 ? 1 : -1), [event.clientX, event.clientY])
  }, { passive: false })

  new ResizeObserver(() => {
    if (!state.zoomTouched) fitWindow()
    else requestRender()
  }).observe(scroller)
  new ResizeObserver(() => requestRender()).observe(wrap)
  scroller.addEventListener('scroll', requestRender, { passive: true })

  function pixelAt(client: [number, number]): [number, number] {
    const rect = wrap.getBoundingClientRect()
    return canvasPoint(client, rect, state.width, state.height)
  }

  // 网格线坐标按四舍五入取值, 使裁剪边界落在光标最近的像素边缘上
  function gridAt(client: [number, number]): [number, number] {
    const rect = wrap.getBoundingClientRect()
    return canvasPoint(client, rect, state.width, state.height, 'round')
  }

  return { scroller, sourceCanvas, get sourceRevision() { return sourceRevision }, render, zoomTo, fitWindow, pixelAt, gridAt }
}

function requireContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d')
  if (!context) throw new Error(uiText("webview.paint.stage.unableToRetrieveTheTwoDimensionalDrawing"))
  return context
}

function viewportCenter(scroller: HTMLElement): [number, number] {
  const rect = scroller.getBoundingClientRect()
  return [rect.left + scroller.clientWidth / 2, rect.top + scroller.clientHeight / 2]
}
