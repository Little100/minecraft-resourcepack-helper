import { uiText } from '../i18n/messages'
import { edgeSpans } from './alphaContours'
import type { JavaModelData } from './javaModelResources'

export const GENERATED_BASE_FIELD = 'mcrh_generated_base'
export interface GeneratedItemImage { width: number; height: number; data: Uint8Array }
const object = (value: unknown): value is JavaModelData => !!value && typeof value === 'object' && !Array.isArray(value)


export function generatedBaseElementCount(model: unknown): number | undefined {
  if (!object(model) || !Array.isArray(model.elements)) return
  const marker = model[GENERATED_BASE_FIELD]
  if (!object(marker) || marker.version !== 1 || marker.storage !== undefined && marker.storage !== 'geometry') return
  if (!Number.isSafeInteger(marker.elements) || Number(marker.elements) <= 0 || Number(marker.elements) > model.elements.length || !object(marker.layers)) return
  const layers = Object.entries(marker.layers).sort(([left], [right]) => left.localeCompare(right))
  if (!layers.length || layers.length > 5 || !layers.every(([slot, texture], index) => slot === 'layer' + index && typeof texture === 'string' && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(texture) && !texture.split(/[/:]/).some(part => part === '.' || part === '..'))) return
  return Number(marker.elements)
}

export function generatedItemElements(image: GeneratedItemImage, slot: string, tintindex: number, metadata: unknown, maxElements: number): JavaModelData[] {
  const { width, height, data } = image
  if (![width, height, maxElements].every(value => Number.isSafeInteger(value) && value > 0) || width * height > 4 * 1024 * 1024 || data.length !== width * height * 4) throw new Error(uiText("core.generatedItemGeometry.invalidSizeOrBudgetOfTheScheme"))
  const animation = object(metadata) ? metadata.animation : undefined
  if (animation !== undefined && !object(animation)) throw new Error(uiText("core.generatedItemGeometry.theOriginalPasteAnimationMetadataIsInvalid"))
  const animated = object(animation), small = Math.min(width, height)
  const frameWidth = animated ? animation.width ?? (animation.height === undefined ? small : width) : width
  const frameHeight = animated ? animation.height ?? (animation.width === undefined ? small : height) : height
  if (![frameWidth, frameHeight].every(value => Number.isSafeInteger(value) && Number(value) > 0) || width % Number(frameWidth) || height % Number(frameHeight)) throw new Error(uiText("core.generatedItemGeometry.theOriginalAnimatedFrameSizeIsInvalid"))
  const fw = Number(frameWidth), fh = Number(frameHeight), columns = width / fw, frameCount = columns * height / fh
  const schedule = animated ? animation.frames : undefined
  if (schedule !== undefined && (!Array.isArray(schedule) || schedule.length === 0 || schedule.length > 200_000)) throw new Error(uiText("core.generatedItemGeometry.theOriginalAnimatedFrameListIsInvalid"))
  const selected = new Set<number>()
  for (const entry of Array.isArray(schedule) ? schedule : []) {
    const index = object(entry) ? entry.index : entry
    if (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= frameCount) throw new Error(uiText("core.generatedItemGeometry.theOriginalAnimatedFrameIndexIsInvalid"))
    selected.add(Number(index))
  }
  const edges = new Uint8Array(fw * fh)
  let visible = false
  const frames: Iterable<number> = Array.isArray(schedule) ? selected : { *[Symbol.iterator](): Generator<number> { for (let index = 0; index < frameCount; index++) yield index } }
  for (const frame of frames) {
    const ox = frame % columns * fw, oy = Math.floor(frame / columns) * fh
    const opaque = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < fw && y < fh && data[((oy + y) * width + ox + x) * 4 + 3]! > 0
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) if (opaque(x, y)) {
      visible = true
      if (!opaque(x, y - 1)) edges[y * fw + x]! |= 1
      if (!opaque(x, y + 1)) edges[y * fw + x]! |= 2
      if (!opaque(x - 1, y)) edges[y * fw + x]! |= 4
      if (!opaque(x + 1, y)) edges[y * fw + x]! |= 8
    }
  }
  if (!visible) return []
  const texture = '#' + slot, sx = 16 / fw, sy = 16 / fh
  const elements: JavaModelData[] = []
  const add = (element: JavaModelData): void => {
    if (elements.length >= maxElements) throw new Error(uiText("core.generatedItemGeometry.theOriginalProfileIsTooComplexGenerating"))
    elements.push(element)
  }
  add({ from: [0, 0, 7.5], to: [16, 16, 8.5], faces: { north: { texture, uv: [16, 0, 0, 16], tintindex }, south: { texture, uv: [0, 0, 16, 16], tintindex } } })
  for (const span of edgeSpans(fw, fh, (x, y, axis, sign) => edges[y * fw + x]! & (axis === 0 ? sign < 0 ? 4 : 8 : sign < 0 ? 1 : 2) ? 1 : 0)) {
    const x0 = span.axis === 0 ? span.cell : span.start, x1 = span.axis === 0 ? span.cell + 1 : span.end
    const y0 = span.axis === 1 ? span.cell : span.start, y1 = span.axis === 1 ? span.cell + 1 : span.end
    const face = span.axis === 0 ? span.sign < 0 ? 'west' : 'east' : span.sign < 0 ? 'up' : 'down'
    add({ from: [x0 * sx, 16 - y1 * sy, 7.5], to: [x1 * sx, 16 - y0 * sy, 8.5], faces: { [face]: { texture, uv: [x0 * sx, y0 * sy, x1 * sx, y1 * sy], tintindex } } })
  }
  return elements
}
