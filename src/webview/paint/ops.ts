import { previewLayers } from './state'
import { clearSelection, compositeAt, type Rgba, type SelectionRect } from '../painting'
import { activeLayer, dropSelection, markPixelsChanged, type PaintState } from './state'

export function extractRect(pixels: Uint8Array, width: number, rect: SelectionRect): ArrayBuffer {
  const out = new Uint8Array(rect.width * rect.height * 4)
  const rowBytes = rect.width * 4
  for (let row = 0; row < rect.height; row++) {
    const src = ((rect.y + row) * width + rect.x) * 4
    out.set(pixels.subarray(src, src + rowBytes), row * rowBytes)
  }
  return out.buffer
}

// 恢复选区外的像素，只处理画布内的部分
export function restoreOutsideMask(
  target: Uint8Array,
  before: Uint8Array,
  width: number,
  mask: Uint8Array,
  area: SelectionRect
): void {
  const height = Math.floor(target.length / 4 / width)
  const clipped = clipRect(area, width, height)
  for (let y = clipped.y; y < clipped.y + clipped.height; y++) {
    for (let x = clipped.x; x < clipped.x + clipped.width; x++) {
      const pixel = y * width + x
      if (mask[pixel] === 1) continue
      const i = pixel * 4
      target.set(before.subarray(i, i + 4), i)
    }
  }
}

export function deleteSelection(state: PaintState): SelectionRect | undefined {
  const layer = activeLayer(state)
  const selection = state.selection
  if (!layer || !selection || !selection.bounds.width || !selection.bounds.height) return undefined
  clearSelection(layer.pixels, state.width, selection.mask)
  dropSelection(state)
  markPixelsChanged(state, selection.bounds)
  return selection.bounds
}

export function sampleComposite(state: PaintState, x: number, y: number): Rgba {
  return compositeAt(previewLayers(state), state.width, x, y)
}

export function clipRect(rect: SelectionRect, width: number, height: number): SelectionRect {
  const x0 = Math.max(0, rect.x)
  const y0 = Math.max(0, rect.y)
  const x1 = Math.min(width, rect.x + rect.width)
  const y1 = Math.min(height, rect.y + rect.height)
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) }
}

// 标记矩形内的画布像素
export function rectMask(width: number, height: number, rect: SelectionRect): Uint8Array {
  const mask = new Uint8Array(width * height)
  const area = clipRect(rect, width, height)
  for (let y = area.y; y < area.y + area.height; y++) {
    mask.fill(1, y * width + area.x, y * width + area.x + area.width)
  }
  return mask
}

export function segmentArea(from: [number, number], to: [number, number], radius: number): SelectionRect {
  const x0 = Math.min(from[0], to[0]) - radius - 1
  const y0 = Math.min(from[1], to[1]) - radius - 1
  const x1 = Math.max(from[0], to[0]) + radius + 1
  const y1 = Math.max(from[1], to[1]) + radius + 1
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
}
