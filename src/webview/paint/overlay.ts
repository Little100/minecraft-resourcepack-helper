import { symmetryPoint } from '../../core/paintSymmetry'
import { brushRadius, forEachStampPixel } from '../painting'
import { overlayScale } from './brushPreview'
import type { Hover } from './app'
import { cropRectOf, frameHeightOf, maskEdges } from './geometry'
import type { PaintState } from './state'

// 放大倍数低于该值时不画网格, 避免线条糊成一片
const GRID_MIN_ZOOM = 4
// 选区变化时才重新计算轮廓
const outlines = new WeakMap<Uint8Array, Path2D>()

// 从页面主题取画布颜色，缺少时用默认色
function token(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

export function drawOverlay(ctx: CanvasRenderingContext2D, state: PaintState, hover: Hover, footprint?: Array<[number, number]>): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  const viewport = ctx.canvas.getBoundingClientRect()
  const zoom = Math.min(viewport.width / state.width, viewport.height / state.height)
  const [scaleX, scaleY] = overlayScale(state.width, state.height, ctx.canvas.width, ctx.canvas.height)
  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0)
  ctx.lineWidth = 1 / zoom
  if (state.showGrid && zoom >= GRID_MIN_ZOOM) drawGrid(ctx, state)
  if (state.frameCount > 1) drawFrames(ctx, state, viewport.width, viewport.height)
  if (state.selection) drawSelection(ctx, state)
  if (state.crop?.active) drawCrop(ctx, state)
  if (state.pen.length > 0) drawPen(ctx, state, hover)
  if (state.tool === 'symmetry') drawSymmetry(ctx, state, hover)
  if (hover.point && state.tool !== 'hand') drawHover(ctx, hover.point, state, footprint)
}

function drawGrid(ctx: CanvasRenderingContext2D, state: PaintState): void {
  ctx.save()
  ctx.globalAlpha = 0.5
  ctx.strokeStyle = token('--mcrh-border', '#808080')
  ctx.beginPath()
  for (let x = 1; x < state.width; x++) {
    ctx.moveTo(x, 0)
    ctx.lineTo(x, state.height)
  }
  for (let y = 1; y < state.height; y++) {
    ctx.moveTo(0, y)
    ctx.lineTo(state.width, y)
  }
  ctx.stroke()
  ctx.restore()
}

function drawFrames(ctx: CanvasRenderingContext2D, state: PaintState, cssWidth: number, cssHeight: number): void {
  const frameHeight = frameHeightOf(state.height, state.frameCount)
  const zoom = state.zoom
  ctx.save()
  ctx.setLineDash([4 / zoom, 3 / zoom])
  ctx.strokeStyle = token('--mcrh-accent', '#007fd4')
  ctx.beginPath()
  for (let k = 1; k < state.frameCount; k++) {
    ctx.moveTo(0, k * frameHeight)
    ctx.lineTo(state.width, k * frameHeight)
  }
  ctx.stroke()
  ctx.setLineDash([])
  ctx.setTransform(ctx.canvas.width / cssWidth, 0, 0, ctx.canvas.height / cssHeight, 0, 0)
  ctx.font = `10px ${token('--mcrh-font', 'sans-serif')}`
  ctx.textBaseline = 'top'
  const background = token('--mcrh-bg', '#1e1e1e')
  const muted = token('--mcrh-fg-muted', '#999999')
  for (let i = 0; i < state.frameCount; i++) {
    const label = String(i + 1)
    const top = i * frameHeight * cssHeight / state.height + 2
    const width = ctx.measureText(label).width + 6
    ctx.globalAlpha = 0.75
    ctx.fillStyle = background
    ctx.fillRect(2, top, width, 14)
    ctx.globalAlpha = 1
    ctx.fillStyle = muted
    ctx.fillText(label, 5, top + 2)
  }
  ctx.restore()
}

// 用反色描边让选区线在深浅背景上都可见
function drawSelection(ctx: CanvasRenderingContext2D, state: PaintState): void {
  const selection = state.selection
  if (!selection) return
  let path = outlines.get(selection.mask)
  if (!path) {
    path = new Path2D()
    const edges = maskEdges(selection.mask, state.width, state.height)
    for (let i = 0; i < edges.length; i += 4) {
      path.moveTo(edges[i], edges[i + 1])
      path.lineTo(edges[i + 2], edges[i + 3])
    }
    outlines.set(selection.mask, path)
  }
  ctx.save()
  ctx.strokeStyle = token('--mcrh-fg', '#d4d4d4')
  ctx.stroke(path)
  ctx.strokeStyle = token('--mcrh-bg', '#1e1e1e')
  ctx.setLineDash([4 / state.zoom, 4 / state.zoom])
  ctx.stroke(path)
  ctx.restore()
}

function drawCrop(ctx: CanvasRenderingContext2D, state: PaintState): void {
  const crop = state.crop
  if (!crop) return
  const rect = cropRectOf(crop.start, crop.end, state.width, state.height)
  if (!rect) return
  ctx.save()
  ctx.globalAlpha = 0.5
  ctx.fillStyle = token('--mcrh-bg', '#1e1e1e')
  ctx.beginPath()
  ctx.rect(0, 0, state.width, state.height)
  ctx.rect(rect.x, rect.y, rect.width, rect.height)
  ctx.fill('evenodd')
  ctx.globalAlpha = 1
  ctx.strokeStyle = token('--mcrh-fg', '#d4d4d4')
  ctx.setLineDash([4 / state.zoom, 3 / state.zoom])
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height)
  ctx.restore()
}

function drawPen(ctx: CanvasRenderingContext2D, state: PaintState, hover: Hover): void {
  const points = state.pen
  const accent = token('--mcrh-accent', '#007fd4')
  ctx.save()
  ctx.strokeStyle = accent
  ctx.fillStyle = accent
  ctx.beginPath()
  points.forEach(([x, y], index) => {
    if (index === 0) ctx.moveTo(x + 0.5, y + 0.5)
    else ctx.lineTo(x + 0.5, y + 0.5)
  })
  ctx.stroke()
  const last = points[points.length - 1]
  if (hover.point) {
    ctx.setLineDash([3 / state.zoom, 3 / state.zoom])
    ctx.beginPath()
    ctx.moveTo(last[0] + 0.5, last[1] + 0.5)
    ctx.lineTo(hover.point[0] + 0.5, hover.point[1] + 0.5)
    ctx.stroke()
  }
  for (const [x, y] of points) ctx.fillRect(x, y, 1, 1)
  ctx.restore()
}

function drawHover(ctx: CanvasRenderingContext2D, point: [number, number], state: PaintState, footprint?: Array<[number, number]>): void {
  ctx.save()
  ctx.strokeStyle = token('--mcrh-fg', '#d4d4d4')
  const inset = ctx.lineWidth / 2
  const cells = footprint ?? [point]
  if (['brush', 'nearby', 'symmetry', 'eraser'].includes(state.tool) && !footprint) { ctx.restore(); return }
  for (const [x, y] of cells) ctx.strokeRect(x + inset, y + inset, 1 - 2 * inset, 1 - 2 * inset)
  ctx.restore()
}

function drawSymmetry(ctx: CanvasRenderingContext2D, state: PaintState, hover: Hover): void {
  const fh = state.frameHeight ?? state.height / Math.max(1, state.frameCount), top = Math.floor((hover.point?.[1] ?? 0) / fh) * fh
  ctx.save(); ctx.strokeStyle = token('--mcrh-accent', '#3794ff'); ctx.globalAlpha = .7; ctx.setLineDash([4 / state.zoom, 4 / state.zoom]); ctx.beginPath()
  if (state.symmetryMode !== 'x') { ctx.moveTo(state.width / 2, top); ctx.lineTo(state.width / 2, top + fh) }
  if (state.symmetryMode !== 'y') { ctx.moveTo(0, top + fh / 2); ctx.lineTo(state.width, top + fh / 2) }
  ctx.stroke(); ctx.setLineDash([])
  if (hover.point && !hover.altKey) {
    const radius = brushRadius(state.brushSize, { pointerType: hover.pointerType ?? 'mouse', pressure: hover.pressure ?? 1 }), inset = ctx.lineWidth / 2
    forEachStampPixel(state, ...hover.point, radius, (x, y) => {
      for (const [px, py] of [[x, y], symmetryPoint(x, y, state.width, fh, state.symmetryMode)]) {
        if (!state.selection || state.selection.mask[py * state.width + px]) ctx.strokeRect(px + inset, py + inset, 1 - 2 * inset, 1 - 2 * inset)
      }
    })
  }
  ctx.restore()
}
