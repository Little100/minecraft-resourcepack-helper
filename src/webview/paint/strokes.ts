import { nearbyColor } from '../../core/nearbyColor'
import { symmetryPoint } from '../../core/paintSymmetry'
import { applyShape, diffBounds, floodFill, forEachStampPixel, linePoints, strokeOn, type CanvasSize, type Rgba, type SelectionRect, type Shape } from '../painting'
import type { App } from './app'
import { clipRect, extractRect, restoreOutsideMask, segmentArea } from './ops'
import { markPixelsChanged, unionRect, type LayerBuffer, type PaintState } from './state'

function canvasOf(state: PaintState): CanvasSize {
  return { width: state.width, height: state.height }
}

export function paintSegment(
  app: App,
  layer: LayerBuffer,
  before: Uint8Array,
  from: [number, number],
  to: [number, number],
  radius: number,
  erase: boolean,
  rgba: Rgba
): void {
  const { state } = app
  if (state.tool === 'nearby' && !erase) {
    const area = clipRect(segmentArea(from, to, radius), state.width, state.height)
    for (const [x, y] of linePoints(...from, ...to)) forEachStampPixel(state, x, y, radius, (px, py) => {
      if (!state.selection || state.selection.mask[py * state.width + px]) layer.pixels.set(nearbyColor(rgba, state.nearbyRange), (py * state.width + px) * 4)
    })
    if (area.width > 0 && area.height > 0) { markPixelsChanged(state, area); app.host.previewStroke?.(layer.id, area) }
    app.requestRender()
    return
  }
  if (state.tool === 'symmetry') {
    const frameHeight = state.frameHeight ?? state.height / Math.max(1, state.frameCount)
    const color = erase ? [0, 0, 0, 0] : rgba
    const put = (x: number, y: number): void => { if (!state.selection || state.selection.mask[y * state.width + x]) layer.pixels.set(color, (y * state.width + x) * 4) }
    let x0 = state.width, y0 = state.height, x1 = -1, y1 = -1
    const paint = (x: number, y: number): void => { put(x, y); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
    for (const [x, y] of linePoints(...from, ...to)) forEachStampPixel(state, x, y, radius, (px, py) => { paint(px, py); const mirror = symmetryPoint(px, py, state.width, frameHeight, state.symmetryMode); paint(...mirror) })
    if (x1 >= x0 && y1 >= y0) { const area = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }; markPixelsChanged(state, area); app.host.previewStroke?.(layer.id, area) }
    app.requestRender(); return
  }
  strokeOn(layer.pixels, canvasOf(state), from, to, radius, erase, rgba)
  const area = clipRect(segmentArea(from, to, radius), state.width, state.height)
  if (state.selection) restoreOutsideMask(layer.pixels, before, state.width, state.selection.mask, area)
  if (area.width > 0 && area.height > 0) markPixelsChanged(state, area)
  app.host.previewStroke?.(layer.id, area)
  app.requestRender()
}

// 移动形状预览时恢复旧位置的像素
export function drawShapePreview(
  app: App,
  layer: LayerBuffer,
  before: Uint8Array,
  previous: SelectionRect | undefined,
  shape: Shape,
  origin: [number, number],
  head: [number, number],
  radius: number,
  erase: boolean,
  rgba: Rgba
): SelectionRect {
  const { state } = app
  const area = clipRect(segmentArea(origin, head, radius), state.width, state.height)
  if (previous) restoreRect(layer.pixels, before, state.width, previous)
  applyShape(layer.pixels, canvasOf(state), shape, origin, head, radius, rgba, erase)
  if (state.selection) restoreOutsideMask(layer.pixels, before, state.width, state.selection.mask, area)
  const dirty = previous ? unionRect(previous, area) : area
  if (dirty.width > 0 && dirty.height > 0) markPixelsChanged(state, dirty)
  app.host.previewStroke?.(layer.id, dirty)
  app.requestRender()
  return area
}

export function fillAt(app: App, layer: LayerBuffer, x: number, y: number): void {
  const { state } = app
  const before = layer.pixels.slice()
  floodFill(layer.pixels, state.width, state.height, x, y, state.color, state.tolerance, state.selection?.mask)
  commitDiff(app, layer, before)
}

export function scatterAt(app: App): void {
  app.openScatter?.()
}

export function commitDiff(app: App, layer: LayerBuffer, before: Uint8Array): void {
  const { state } = app
  const rect = diffBounds(before, layer.pixels, state.width)
  if (!rect) {
    app.host.cancelPreviewStroke?.()
    app.requestRender()
    return
  }
  markPixelsChanged(state, rect)
  app.host.post({
    command: 'commit',
    layerId: layer.id,
    rect,
    pixels: extractRect(layer.pixels, state.width, rect)
  })
  app.requestRender()
}

function restoreRect(target: Uint8Array, before: Uint8Array, width: number, rect: SelectionRect): void {
  const rowBytes = rect.width * 4
  for (let row = 0; row < rect.height; row++) {
    const start = ((rect.y + row) * width + rect.x) * 4
    target.set(before.subarray(start, start + rowBytes), start)
  }
}
