import type { SelectionRect, Shape } from '../painting'

export const DRAG_THRESHOLD = 2

export const ZOOM_STEPS = [1 / 1024, 1 / 512, 1 / 256, 1 / 128, 1 / 64, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 3 / 4, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128] as const
export const MIN_ZOOM = ZOOM_STEPS[0]
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]
const MAX_FIT_ZOOM = 48

// 移动足够远才算拖动，忽略轻微抖动
export function exceedsDragThreshold(from: [number, number], to: [number, number]): boolean {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  return Math.hypot(dx, dy) > DRAG_THRESHOLD
}

// 按像素边缘取画布内的矩形，不包括右边和底边
export function cropRectOf(
  start: [number, number],
  end: [number, number],
  width: number,
  height: number
): SelectionRect | undefined {
  const x0 = clampInt(Math.min(start[0], end[0]), 0, width)
  const y0 = clampInt(Math.min(start[1], end[1]), 0, height)
  const x1 = clampInt(Math.max(start[0], end[0]), 0, width)
  const y1 = clampInt(Math.max(start[1], end[1]), 0, height)
  if (x1 - x0 < 1 || y1 - y0 < 1) return undefined
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

export function selectionRectOf(
  start: [number, number],
  end: [number, number],
  width: number,
  height: number
): SelectionRect {
  const x0 = clampInt(Math.min(start[0], end[0]), 0, width - 1)
  const y0 = clampInt(Math.min(start[1], end[1]), 0, height - 1)
  const x1 = clampInt(Math.max(start[0], end[0]), 0, width - 1)
  const y1 = clampInt(Math.max(start[1], end[1]), 0, height - 1)
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
}

export function constrainHead(shape: Shape, origin: [number, number], head: [number, number]): [number, number] {
  const dx = head[0] - origin[0]
  const dy = head[1] - origin[1]
  if (shape === 'line') {
    const length = Math.hypot(dx, dy)
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
    return [Math.round(origin[0] + Math.cos(angle) * length), Math.round(origin[1] + Math.sin(angle) * length)]
  }
  const side = Math.max(Math.abs(dx), Math.abs(dy))
  return [origin[0] + Math.sign(dx || 1) * side, origin[1] + Math.sign(dy || 1) * side]
}

export function isPenCloseEvent(event: { type: string; key?: string }): boolean {
  return event.type === 'dblclick' || event.key === 'Enter'
}

// 按档位缩放，到上下限就停止
export function stepZoom(current: number, direction: 1 | -1): number {
  if (direction > 0) {
    const next = ZOOM_STEPS.find(step => step > current)
    return next ?? MAX_ZOOM
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    if (ZOOM_STEPS[i] < current) return ZOOM_STEPS[i]
  }
  return MIN_ZOOM
}

// 缩放倍率只限制范围, 保留适应大图所需的分数精度
export function clampZoom(value: number): number {
  return Number.isFinite(value) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value)) : MIN_ZOOM
}

export function fitZoom(width: number, height: number, viewWidth: number, viewHeight: number): number {
  const ratio = Math.min(viewWidth / Math.max(1, width), viewHeight / Math.max(1, height))
  return Math.min(MAX_FIT_ZOOM, clampZoom(ratio >= 1 ? Math.floor(ratio) : ratio))
}

export function frameHeightOf(height: number, frameCount: number): number {
  return Math.max(1, Math.floor(height / Math.max(1, frameCount)))
}

export function frameIndexAt(y: number, height: number, frameCount: number): number {
  const index = Math.floor(y / frameHeightOf(height, frameCount))
  return clampInt(index, 0, Math.max(0, frameCount - 1))
}

// 沿选区的像素边缘生成线段
export function maskEdges(mask: Uint8Array, width: number, height: number): number[] {
  const segments: number[] = []
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!at(x, y)) continue
      if (!at(x, y - 1)) segments.push(x, y, x + 1, y)
      if (!at(x, y + 1)) segments.push(x, y + 1, x + 1, y + 1)
      if (!at(x - 1, y)) segments.push(x, y, x, y + 1)
      if (!at(x + 1, y)) segments.push(x + 1, y, x + 1, y + 1)
    }
  }
  return segments
}

// 输入不是有限数时用最小值
export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}
