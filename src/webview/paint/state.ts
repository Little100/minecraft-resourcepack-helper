import { uiText } from '../../i18n/messages'
import type { SymmetryMode } from '../../core/paintSymmetry'
import { defaultVariantId, variantLayers } from '../../core/randomVariants'
import type { LayerInfo, LayersMessage, PatchMessage, SnapshotMessage } from '../messages'
import { maskBounds, type Rgba, type SelectionRect } from '../painting'
import { formatRgba, type ToolId } from '../tools'

export const BRUSH_RANGE = { min: 1, max: 16 } as const
export const TOLERANCE_RANGE = { min: 0, max: 255 } as const
export const DEFAULT_TOLERANCE = 24
export const RECENT_COLOR_LIMIT = 8

export interface LayerBuffer extends LayerInfo {
  pixels: Uint8Array
}

export type SelectionMode = 'replace' | 'add' | 'subtract' | 'intersect' | 'xor'

export interface Selection {
  mask: Uint8Array
  bounds: SelectionRect
}

export interface CropDraft {
  start: [number, number]
  end: [number, number]
  active: boolean
}

export interface PaintState {
  previewVariantId?: string
  width: number
  height: number
  frameCount: number
  frameHeight?: number
  transformedLayers?: LayerBuffer[]
  layers: LayerBuffer[]
  activeLayerId?: string
  selectedLayerIds?: string[]
  keybindings?: Record<string, string>
  backgroundColor?: Rgba
  tool: ToolId
  symmetryMode: SymmetryMode
  brushSize: number
  nearbyRange: number
  scatterSeed?: string
  scatterDensity: number
  scatterOpaqueOnly: boolean
  tolerance: number
  color: Rgba
  recentColors: string[]
  selection?: Selection
  selectionMode: SelectionMode
  pen: Array<[number, number]>
  penRedo: Array<[number, number]>
  crop?: CropDraft
  showSmartGuides: boolean
  showGrid: boolean
  showTransparent: boolean
  zoom: number
  zoomTouched: boolean
  dirty?: SelectionRect
  fullRedraw: boolean
  revision: number
}

export function createState(): PaintState {
  return {
    width: 16,
    height: 16,
    frameCount: 1,
    layers: [],
    tool: 'brush',
    selectionMode: 'replace',
    symmetryMode: 'y',
    brushSize: 1,
    nearbyRange: 16,
    scatterDensity: 10,
    scatterOpaqueOnly: true,
    tolerance: DEFAULT_TOLERANCE,
    color: [255, 255, 255, 255],
    backgroundColor: [0, 0, 0, 255],
    recentColors: [],
    pen: [],
    penRedo: [],
    showSmartGuides: true,
    showGrid: true,
    showTransparent: true,
    zoom: 16,
    zoomTouched: false,
    fullRedraw: true,
    revision: 0
  }
}

export function layerById(state: PaintState, id: string | undefined): LayerBuffer | undefined {
  return state.layers.find(layer => layer.id === id)
}

export function activeLayer(state: PaintState): LayerBuffer | undefined {
  return layerById(state, state.activeLayerId)
}

export function selectTool(state: PaintState, tool: ToolId): void {
  state.tool = tool
  resetPen(state)
  state.crop = undefined
}

// 清除路径草稿及其重做分支
export function resetPen(state: PaintState): void {
  state.pen = []
  state.penRedo = []
}

export function setSelection(state: PaintState, mask: Uint8Array): void {
  const bounds = maskBounds(mask, state.width, state.height)
  state.selection = { mask, bounds: bounds ?? { x: 0, y: 0, width: 0, height: 0 } }
}

// 相交结果为空时仍限制绘制
export function combineSelection(state: PaintState, mask: Uint8Array, previous: Uint8Array | null | undefined = state.selection?.mask, mode: SelectionMode = state.selectionMode): void {
  if (mask.length !== state.width * state.height) throw new Error(uiText("webview.paint.state.theSizeOfTheConstituencyIsNot"))
  const result = new Uint8Array(mask.length)
  for (let index = 0; index < mask.length; index++) {
    const a = previous?.[index] === 1, b = mask[index] === 1
    result[index] = Number(!previous || mode === 'replace' ? b : mode === 'add' ? a || b : mode === 'subtract' ? a && !b : mode === 'intersect' ? a && b : a !== b)
  }
  setSelection(state, result)
}

export function dropSelection(state: PaintState): void {
  state.selection = undefined
}

// 画布大小变了就清除选区和未完成的操作
export function applySnapshot(state: PaintState, message: SnapshotMessage): boolean {
  const sizeChanged = message.width !== state.width || message.height !== state.height
  state.width = message.width
  state.height = message.height
  state.frameCount = message.frameCount
  state.frameHeight = message.frameHeight
  state.transformedLayers = undefined
  state.layers = message.layers.map(layer => ({
    id: layer.id,
    name: layer.name,
    visible: layer.visible,
    opacity: layer.opacity,
    randomVariant: layer.randomVariant,
    pixels: new Uint8Array(layer.pixels)
  }))
  state.activeLayerId = resolveActive(state, message.activeLayerId)
  if (activeLayer(state)?.randomVariant) state.previewVariantId = state.activeLayerId
  if (!state.layers.some(layer => layer.id === state.previewVariantId && layer.randomVariant)) state.previewVariantId = defaultVariantId(state.layers)
  const selected = (state.selectedLayerIds ?? []).filter(id => state.layers.some(layer => layer.id === id))
  state.selectedLayerIds = selected.length && state.activeLayerId && selected.includes(state.activeLayerId) ? selected : state.activeLayerId ? [state.activeLayerId] : []
  if (sizeChanged) {
    dropSelection(state)
    resetPen(state)
    state.crop = undefined
  }
  state.dirty = undefined
  state.fullRedraw = true
  state.revision++
  return sizeChanged
}

export function applyLayers(state: PaintState, message: LayersMessage): void {
  const previous = new Map(state.layers.map(layer => [layer.id, layer]))
  state.layers = message.layers.map(info => ({
    id: info.id,
    name: info.name,
    visible: info.visible,
    opacity: info.opacity,
    randomVariant: info.randomVariant,
    pixels: previous.get(info.id)?.pixels ?? new Uint8Array(state.width * state.height * 4)
  }))
  state.activeLayerId = resolveActive(state, message.activeLayerId)
  if (activeLayer(state)?.randomVariant) state.previewVariantId = state.activeLayerId
  if (!state.layers.some(layer => layer.id === state.previewVariantId && layer.randomVariant)) state.previewVariantId = defaultVariantId(state.layers)
  const selected = (state.selectedLayerIds ?? []).filter(id => state.layers.some(layer => layer.id === id))
  state.selectedLayerIds = selected.length && state.activeLayerId && selected.includes(state.activeLayerId) ? selected : state.activeLayerId ? [state.activeLayerId] : []
  state.fullRedraw = true
  state.revision++
}

export function applyPatch(state: PaintState, message: PatchMessage): void {
  const layer = layerById(state, message.layerId)
  const { x, y, width, height } = message.rect
  const source = new Uint8Array(message.pixels)
  const inside = x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= state.width && y + height <= state.height
  if (!layer || !inside || source.length !== width * height * 4) return
  const rowBytes = width * 4
  for (let row = 0; row < height; row++) {
    layer.pixels.set(source.subarray(row * rowBytes, (row + 1) * rowBytes), ((y + row) * state.width + x) * 4)
  }
  state.dirty = unionRect(state.dirty, message.rect)
  state.revision++
}

export function unionRect(current: SelectionRect | undefined, next: SelectionRect): SelectionRect {
  if (!current) return { ...next }
  const x0 = Math.min(current.x, next.x)
  const y0 = Math.min(current.y, next.y)
  const x1 = Math.max(current.x + current.width, next.x + next.width)
  const y1 = Math.max(current.y + current.height, next.y + next.height)
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

// 当前图层还在就保持选中
function resolveActive(state: PaintState, preferred: string | undefined): string | undefined {
  if (preferred !== undefined && state.layers.some(layer => layer.id === preferred)) return preferred
  const current = state.activeLayerId
  if (current !== undefined && state.layers.some(layer => layer.id === current)) return current
  return state.layers[0]?.id
}

export function markPixelsChanged(state: PaintState, rect: SelectionRect | undefined): void {
  state.revision++
  if (rect) state.dirty = unionRect(state.dirty, rect)
  else state.fullRedraw = true
}

export function pushRecentColor(recent: readonly string[], color: Rgba): string[] {
  const hex = formatRgba(color)
  return [hex, ...recent.filter(item => item !== hex)].slice(0, RECENT_COLOR_LIMIT)
}

export function previewLayers(state: PaintState): LayerBuffer[] {
  return variantLayers(state.layers, activeLayer(state)?.randomVariant ? state.activeLayerId : state.previewVariantId)
}
