import { previewLayers } from './state'
import { brushRadius, compositeAt, forEachStampPixel, type Rgba, type SelectionRect } from '../painting'
import { activeLayer, type PaintState } from './state'

export interface BrushHover { point?: [number, number]; pointerType?: string; pressure?: number; buttons?: number; altKey?: boolean }

export interface BrushPreview { rect: SelectionRect; pixels: Uint8ClampedArray; footprint: Array<[number, number]> }

export function brushPreview(state: PaintState, hover: BrushHover): BrushPreview | undefined {
  if (!hover.point || hover.altKey || (hover.buttons ?? 0) !== 0 || !['brush', 'nearby', 'symmetry', 'eraser'].includes(state.tool)) return undefined
  const layer = activeLayer(state)
  if (!layer?.visible) return undefined
  const radius = brushRadius(state.brushSize, { pointerType: hover.pointerType ?? 'mouse', pressure: hover.pressure ?? 1 })
  const footprint: Array<[number, number]> = []
  forEachStampPixel(state, hover.point[0], hover.point[1], radius, (x, y) => {
    if (!state.selection || state.selection.mask[y * state.width + x] === 1) footprint.push([x, y])
  })
  if (!footprint.length) return undefined
  const xs = footprint.map(point => point[0]), ys = footprint.map(point => point[1])
  const rect = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs) + 1, height: Math.max(...ys) - Math.min(...ys) + 1 }
  const pixels = new Uint8ClampedArray(rect.width * rect.height * 4)
  const layers = previewLayers(state)
  for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) pixels.set(compositeAt(layers, state.width, x + rect.x, y + rect.y), (y * rect.width + x) * 4)
  const color: Rgba = state.tool === 'eraser' ? [0, 0, 0, 0] : state.color
  for (const [x, y] of footprint) pixels.set(compositeAt(layers, state.width, x, y, { layer, color }), ((y - rect.y) * rect.width + x - rect.x) * 4)
  return { rect, pixels, footprint }
}

export interface CanvasViewport { left: number; top: number; width: number; height: number }

export function canvasPoint(client: [number, number], viewport: CanvasViewport, width: number, height: number, snap: 'floor' | 'round' = 'floor'): [number, number] {
  const quantize = snap === 'round' ? Math.round : Math.floor
  return [quantize((client[0] - viewport.left) * width / viewport.width), quantize((client[1] - viewport.top) * height / viewport.height)]
}

export function overlayScale(width: number, height: number, backingWidth: number, backingHeight: number): [number, number] {
  return [backingWidth / width, backingHeight / height]
}
