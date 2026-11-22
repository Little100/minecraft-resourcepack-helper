import { uiText } from '../../i18n/messages'
import { DEFAULT_EDGE_RECOLOR, recolorEdges, type EdgeRecolorOptions } from '../edgeRecolor'
import { PNG } from 'pngjs'
import { z } from 'zod'
import { decodeTexturePng } from './pngCodec'
import { generateCtmTextures, type GeneratedFile } from './textures'
import { assertPackToolsPath } from './packToolsProtocol'

export interface PixelImage { width: number; height: number; data: Uint8Array }
export interface PixelMask { size: number; cells: readonly number[] }
export interface TextureBatchOptions { effect: EdgeRecolorOptions['mode']; strength: number; colorSource: 'theme' | 'pixel'; mask: PixelMask; frameWidth?: number; frameHeight?: number; automaticEdges?: boolean; edgeRadius?: number; hueShift?: number; edgeTolerance?: number; transitionSource?: EdgeRecolorOptions['transitionSource']; transitionSide?: EdgeRecolorOptions['transitionSide']; transitionSteps?: number }
const maskSchema = z.strictObject({ size: z.number().int().min(1).max(64), cells: z.array(z.number().int().min(0).max(4095)).max(4096) }).refine(mask => mask.cells.every(index => index < mask.size * mask.size), uiText("core.advanced.textureBatch.theSelectedGridGoesBeyondTheGrid"))
const optionsSchema = z.strictObject({ effect: z.enum(['darken', 'lighten', 'bevel', 'transition']), strength: z.number().finite().min(0).max(1), colorSource: z.enum(['theme', 'pixel']), mask: maskSchema, automaticEdges: z.boolean().optional(), edgeRadius: z.number().int().min(1).max(32).optional(), hueShift: z.number().finite().min(-60).max(60).optional(), edgeTolerance: z.number().finite().min(0).max(255).optional(), transitionSource: z.enum(['nearby', 'mix']).optional(), transitionSide: z.enum(['lighter', 'darker', 'both']).optional(), transitionSteps: z.number().int().min(1).max(8).optional(), frameWidth: z.number().int().positive().max(4096).optional(), frameHeight: z.number().int().positive().max(4096).optional() }).refine(options => options.effect !== 'transition' || options.automaticEdges === true, uiText("core.advanced.textureBatch.middleTransitionRequiresAutomaticEdgePresetsOf"))
export function ringMask(size: number, thickness = 1): PixelMask {
  if (!Number.isInteger(size) || size < 1 || size > 64 || !Number.isInteger(thickness) || thickness < 1 || thickness > Math.ceil(size / 2)) throw new Error(uiText("core.advanced.textureBatch.gridSizeOrEdgeWidthInvalid"))
  const cells: number[] = []
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (Math.min(x, y, size - 1 - x, size - 1 - y) < thickness) cells.push(y * size + x)
  return { size, cells }
}
export function encodePixelImage(image: PixelImage): Uint8Array { const png = new PNG({ width: image.width, height: image.height }); png.data = Buffer.from(image.data); return PNG.sync.write(png) }
export function decodePixelImage(bytes: Uint8Array): PixelImage { const image = decodeTexturePng(bytes); return { width: image.width, height: image.height, data: Uint8Array.from(image.data) } }
// 透明像素不参与统计，半透明像素按覆盖率参与主色投票
export function themeColor(image: PixelImage): readonly [number, number, number] {
  const buckets = new Map<number, { weight: number; sums: number[] }>()
  for (let index = 0; index < image.data.length; index += 4) {
    const alpha = image.data[index + 3] / 255
    if (!alpha) continue
    const r = image.data[index], g = image.data[index + 1], b = image.data[index + 2], key = (r >> 4) << 8 | (g >> 4) << 4 | b >> 4
    const bucket = buckets.get(key) ?? { weight: 0, sums: [0, 0, 0] }; bucket.weight += alpha
    for (let channel = 0; channel < 3; channel++) bucket.sums[channel] += image.data[index + channel] * alpha
    buckets.set(key, bucket)
  }
  let chosen: { weight: number; sums: number[] } | undefined
  for (const bucket of buckets.values()) if (!chosen || bucket.weight > chosen.weight) chosen = bucket
  return chosen ? chosen.sums.map(value => Math.round(value / chosen!.weight)) as [number, number, number] : [0, 0, 0]
}
export function animationFrameSize(image: Pick<PixelImage, 'width' | 'height'>, metadata?: Uint8Array): { frameWidth: number; frameHeight: number } {
  if (!metadata) return { frameWidth: image.width, frameHeight: image.height }
  if (metadata.length > 1024 * 1024) throw new Error(uiText("core.advanced.textureBatch.animatedMetadataInExcessOfMib"))
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadata)) as { animation?: { width?: unknown; height?: unknown } }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('animation' in value)) return { frameWidth: image.width, frameHeight: image.height }
  if (!value.animation || typeof value.animation !== 'object' || Array.isArray(value.animation)) throw new Error(uiText("core.advanced.textureBatch.animationMustBeAnObject"))
  const animation = value.animation, small = Math.min(image.width, image.height)
  const frameWidth = animation.width ?? (animation.height === undefined ? small : image.width)
  const frameHeight = animation.height ?? (animation.width === undefined ? small : image.height)
  if (typeof frameWidth !== 'number' || typeof frameHeight !== 'number' || !Number.isInteger(frameWidth) || !Number.isInteger(frameHeight) || frameWidth < 1 || frameHeight < 1 || image.width % frameWidth || image.height % frameHeight) throw new Error(uiText("core.advanced.textureBatch.animationFrameSizeIsInvalidOrCannot"))
  return { frameWidth, frameHeight }
}
export function applyPixelPreset(source: PixelImage, input: TextureBatchOptions, palette = themeColor(source)): PixelImage {
  const options = optionsSchema.parse(input), width = options.frameWidth ?? source.width, height = options.frameHeight ?? source.height
  if (!Number.isInteger(source.width) || !Number.isInteger(source.height) || source.width < 1 || source.height < 1 || source.width * source.height > 4194304 || source.data.length !== source.width * source.height * 4 || source.width % width || source.height % height) throw new Error(uiText("core.advanced.textureBatch.invalidImageOrFrameSize"))
  const automaticMask = options.automaticEdges ? new Uint8Array(source.width * source.height) : undefined
  const output: PixelImage = { width: source.width, height: source.height, data: source.data.slice() }
  const selected = new Set(options.mask.cells)
  const size = options.mask.size, stride = size + 1, prefix = new Uint16Array(stride ** 2)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) prefix[(y + 1) * stride + x + 1] = Number(selected.has(y * size + x)) + prefix[y * stride + x + 1] + prefix[(y + 1) * stride + x] - prefix[y * stride + x]
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    const mx = Math.floor(x % width / width * options.mask.size), my = Math.floor(y % height / height * options.mask.size), index = (y * source.width + x) * 4
    if (!source.data[index + 3]) continue
    const right = Math.ceil((x % width + 1) / width * size), bottom = Math.ceil((y % height + 1) / height * size)
    if (prefix[bottom * stride + right] - prefix[my * stride + right] - prefix[bottom * stride + mx] + prefix[my * stride + mx] === 0) continue
    if (automaticMask) { automaticMask[index / 4] = 1; continue }
    const light = options.effect === 'lighten' || options.effect === 'bevel' && mx + my < options.mask.size
    for (let channel = 0; channel < 3; channel++) { const original = options.colorSource === 'theme' ? palette[channel] : source.data[index + channel]; output.data[index + channel] = Math.round(light ? original + (255 - original) * options.strength : original * (1 - options.strength)) }
  }
  if (automaticMask) output.data = recolorEdges(source.data, source.width, source.height, { radius: options.edgeRadius ?? 2, strength: options.strength, hueShift: options.hueShift ?? 6, mode: options.effect, tolerance: options.edgeTolerance ?? DEFAULT_EDGE_RECOLOR.tolerance, transitionSource: options.transitionSource ?? DEFAULT_EDGE_RECOLOR.transitionSource, transitionSide: options.transitionSide ?? DEFAULT_EDGE_RECOLOR.transitionSide, transitionSteps: options.transitionSteps ?? DEFAULT_EDGE_RECOLOR.transitionSteps, frameWidth: width, frameHeight: height }, automaticMask)
  return output
}
// Compact 顺序对应孤立、全连通、左右边、上下边及缺少对角连接的内角
export function connectedBorderTiles(source: PixelImage, options: TextureBatchOptions, palette = themeColor(source)): PixelImage[] {
  const parsed = optionsSchema.parse(options), size = parsed.mask.size
  if (parsed.automaticEdges) throw new Error(uiText("core.advanced.textureBatch.autoContourColourNotUsedForCompact"))
  const ring = new Set(parsed.mask.cells)
  let thickness = 0
  for (let width = 1; width < size / 2; width++) { const candidate = ringMask(size, width).cells; if (candidate.length === ring.size && candidate.every(index => ring.has(index))) { thickness = width; break } }
  if (!thickness) throw new Error(uiText("core.advanced.textureBatch.linkingTexturePresetsRequireACompleteOuter"))
  const side = (index: number) => index % size < thickness || index % size >= size - thickness
  const cap = (index: number) => Math.floor(index / size) < thickness || Math.floor(index / size) >= size - thickness
  const masks = [parsed.mask.cells, [], parsed.mask.cells.filter(side), parsed.mask.cells.filter(cap), parsed.mask.cells.filter(index => side(index) && cap(index))]
  return masks.map(cells => applyPixelPreset(source, { ...parsed, mask: { size, cells } }, palette))
}
export const connectedBlockPath = /^assets\/([a-z0-9_.-]+)\/textures\/(block\/.+)\.png$/
export function generateConnectedBorder(path: string, bytes: Uint8Array, options: TextureBatchOptions, metadata?: Uint8Array, faces = 'all'): GeneratedFile[] {
  assertPackToolsPath(path)
  const matched = connectedBlockPath.exec(path)
  if (!matched) throw new Error(uiText("core.advanced.textureBatch.onlySquareBottomsBelowTexturesBlockAccept"))
  const source = decodePixelImage(bytes), frame = animationFrameSize(source, metadata)
  if (frame.frameWidth !== frame.frameHeight || frame.frameWidth % 2) throw new Error(uiText("core.advanced.textureBatch.compactCtmRequiresASquareFrameLong"))
  const tiles = connectedBorderTiles(source, { ...options, ...frame }), name = 'mcrh_border/' + matched[1] + '/' + matched[2]
  const generated = generateCtmTextures({ namespace: matched[1], name, method: 'ctm_compact', matchTiles: matched[1] + ':' + matched[2], tiles: '0-4', connect: 'tile', faces, images: tiles.map((tile, index) => ({ name: index + '.png', content: encodePixelImage(tile) })) })
  if (metadata) for (const file of [...generated]) if (file.path.endsWith('.png')) generated.push({ path: file.path + '.mcmeta', content: metadata.slice() })
  return generated
}
