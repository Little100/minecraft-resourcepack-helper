import { detectGuideAnchors, nearbyGuides, guideMeasurements, type GuideAnchors, type GuideMeasurement } from '../../core/smartGuides'
import type { Hover } from './app'
import type { PaintState } from './state'

export interface GuideViewport {
  width: number
  height: number
  imageLeft: number
  imageTop: number
  zoom: number
  pointer?: [number, number]
  revision: number
}

// 辅助线使用屏幕坐标，缩放贴图不会放大线宽、刻度或字体
export function createSmartGuides() {
  let cachedRevision = -1, cachedFrame = -1, anchors: GuideAnchors = { x: [], y: [] }, cachedWidth = 0, cachedFrameHeight = 0
  return (ctx: CanvasRenderingContext2D, state: PaintState, hover: Hover, pixels: Uint8ClampedArray | undefined, viewport: GuideViewport): void => {
    if (!state.showSmartGuides || !hover.point || !pixels || hover.altKey || ((hover.buttons ?? 0) & 4) || state.transformedLayers || !['brush', 'nearby', 'symmetry', 'eraser', 'line', 'rect', 'ellipse', 'pen'].includes(state.tool)) return
    const frameHeight = state.frameHeight ?? state.height / Math.max(1, state.frameCount), frame = Math.floor(hover.point[1] / frameHeight), top = frame * frameHeight
    if (cachedFrame !== frame || cachedWidth !== state.width || cachedFrameHeight !== frameHeight || cachedRevision !== viewport.revision && !((hover.buttons ?? 0) & 3)) {
      anchors = detectGuideAnchors(pixels.subarray(top * state.width * 4, (top + frameHeight) * state.width * 4), state.width, frameHeight)
      cachedRevision = viewport.revision; cachedFrame = frame; cachedWidth = state.width; cachedFrameHeight = frameHeight
    }
    const xs = [(state.width - 1) / 2, -.5, state.width - .5, ...anchors.x], ys = [(frameHeight - 1) / 2, -.5, frameHeight - .5, ...anchors.y]
    if (state.selection) {
      const rect = state.selection.bounds
      if (rect.y < top + frameHeight && rect.y + rect.height > top) {
        xs.unshift(rect.x - .5, rect.x + rect.width - .5, rect.x + (rect.width - 1) / 2)
        const first = Math.max(0, rect.y - top), last = Math.min(frameHeight, rect.y + rect.height - top)
        ys.unshift(first - .5, last - .5, (first + last - 1) / 2)
      }
    }
    for (const point of state.pen) if (point[1] >= top && point[1] < top + frameHeight) { xs.push(point[0]); ys.push(point[1] - top) }
    const { width, height, imageLeft, imageTop, zoom } = viewport
    const pointer = viewport.pointer ?? [imageLeft + (hover.point[0] + .5) * zoom, imageTop + (hover.point[1] + .5) * zoom]
    const guides = nearbyGuides({ x: xs, y: ys }, (pointer[0] - imageLeft) / zoom - .5, (pointer[1] - imageTop) / zoom - top - .5, Math.min(.5, 4 / zoom))
    if (guides.x === undefined && guides.y === undefined) return
    const css = getComputedStyle(ctx.canvas)
    ctx.save(); ctx.lineWidth = 1; ctx.strokeStyle = css.getPropertyValue('--mp-guide-color').trim() || '#e552d8'; ctx.globalAlpha = .85
    ctx.setLineDash([]); ctx.beginPath()
    const gap = Math.max(14, state.brushSize * zoom / 2 + 4), snap = (value: number): number => Math.floor(value) + .5
    if (guides.x !== undefined) {
      const x = snap(imageLeft + (guides.x + .5) * zoom)
      if (x >= 0 && x < width) {
        ctx.moveTo(x, 0); ctx.lineTo(x, Math.max(0, pointer[1] - gap))
        ctx.moveTo(x, Math.min(height, pointer[1] + gap)); ctx.lineTo(x, height)
      }
    }
    if (guides.y !== undefined) {
      const y = snap(imageTop + (top + guides.y + .5) * zoom)
      if (y >= 0 && y < height) {
        ctx.moveTo(0, y); ctx.lineTo(Math.max(0, pointer[0] - gap), y)
        ctx.moveTo(Math.min(width, pointer[0] + gap), y); ctx.lineTo(width, y)
      }
    }
    ctx.stroke(); ctx.globalAlpha = 1
    const measurements = guideMeasurements({ x: xs, y: ys }, guides, hover.point[0], hover.point[1] - top, state.width, frameHeight)
    for (const axis of ['x', 'y'] as const) {
      const nearest = measurements.filter(item => item.axis === axis).sort((a, b) => a.pixels - b.pixels)[0]
      if (nearest) drawMeasurement(ctx, nearest, viewport, top, state.width, state.height)
    }
    ctx.restore()
  }
}

// 测距只占用贴图外留白，没有空间时保留对齐线并省略刻度和文字
function drawMeasurement(ctx: CanvasRenderingContext2D, measurement: GuideMeasurement, view: GuideViewport, frameTop: number, imageWidth: number, imageHeight: number): void {
  const { imageLeft, imageTop, zoom, width, height } = view
  const horizontal = measurement.axis === 'x'
  const start = (horizontal ? imageLeft : imageTop + frameTop * zoom) + (measurement.from + .5) * zoom
  const end = (horizontal ? imageLeft : imageTop + frameTop * zoom) + (measurement.to + .5) * zoom
  const edge = horizontal ? imageTop : imageLeft
  const farEdge = edge + (horizontal ? imageHeight : imageWidth) * zoom
  const maximum = horizontal ? height : width
  const at = edge >= 30 ? edge - 12 : farEdge <= maximum - 30 ? farEdge + 12 : undefined
  const visibleStart = Math.max(4, start), visibleEnd = Math.min((horizontal ? width : height) - 4, end)
  if (at === undefined || start < 4 || end > (horizontal ? width : height) - 4 || visibleEnd - visibleStart < 56) return
  ctx.beginPath()
  if (horizontal) {
    ctx.moveTo(visibleStart, at); ctx.lineTo(visibleEnd, at)
    for (const x of [visibleStart, visibleEnd]) { ctx.moveTo(x, at - 3); ctx.lineTo(x, at + 3) }
  } else {
    ctx.moveTo(at, visibleStart); ctx.lineTo(at, visibleEnd)
    for (const y of [visibleStart, visibleEnd]) { ctx.moveTo(at - 3, y); ctx.lineTo(at + 3, y) }
  }
  ctx.stroke()
  const label = Number(measurement.pixels.toFixed(2)) + ' px'
  ctx.font = '11px ' + (getComputedStyle(ctx.canvas).getPropertyValue('--mcrh-font').trim() || 'sans-serif')
  ctx.fillStyle = ctx.strokeStyle; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.save()
  if (horizontal) ctx.translate((visibleStart + visibleEnd) / 2, at - 9)
  else { ctx.translate(at - 9, (visibleStart + visibleEnd) / 2); ctx.rotate(-Math.PI / 2) }
  ctx.fillText(label, 0, 0); ctx.restore()
}
