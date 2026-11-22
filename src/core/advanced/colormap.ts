import { uiText } from '../../i18n/messages'
import { PNG } from 'pngjs'
import { inflateSync } from 'node:zlib'

export type TintColor = number | string
export type ColormapKind = 'grass' | 'foliage' | 'dry_foliage'
export type GrassColorModifier = 'none' | 'dark_forest' | 'swamp'
export type FoliageType = 'default' | 'birch' | 'spruce'
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
export interface JsonObject { [key: string]: JsonValue }
export interface GeneratedFile { path: string; content: Uint8Array | string }
export interface BiomeClimate { temperature: number; downfall: number }
export interface ColormapCoordinate {
  x: number
  y: number
  index: number
  temperature: number
  downfall: number
  humidity: number
}
export interface ColormapImage { width: number; height: number; data: Uint8Array }
export type ColormapGenerationOptions =
  | { color: TintColor }
  | { cold: TintColor; dry: TintColor; wet: TintColor }
  | { sample: (x: number, y: number) => TintColor }
export interface BiomeTintOverrides {
  foliage_color?: TintColor | null
  grass_color?: TintColor | null
  dry_foliage_color?: TintColor | null
  grass_color_modifier?: GrassColorModifier | null
}
export interface BiomeTintOptions {
  kind: ColormapKind
  climate?: BiomeClimate
  colormap?: ColormapImage
  effects?: BiomeTintOverrides
  foliageType?: FoliageType
  swampNoise?: number
}
export interface TintRemovalResult { model: JsonObject; removed: number; warnings: string[] }

export const COLORMAP_SIZE = 256
export const FIXED_FOLIAGE_TINTS: Readonly<{ birch: number; spruce: number }> = Object.freeze({
  birch: 0x80a755,
  spruce: 0x619961
})
const COLORMAP_BYTES = COLORMAP_SIZE * COLORMAP_SIZE * 4
const MAX_INPUT_BYTES = 8 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const COLOR_KEYS = ['foliage_color', 'grass_color', 'dry_foliage_color'] as const
const MODIFIERS: readonly GrassColorModifier[] = ['none', 'dark_forest', 'swamp']
const KINDS: readonly ColormapKind[] = ['grass', 'foliage', 'dry_foliage']
const FACE_NAMES = ['north', 'south', 'east', 'west', 'up', 'down'] as const

function assertObject<T>(value: T, label: string): asserts value is T & Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(uiText("core.advanced.colormap.mustBeAnOrdinaryJsonObject", label))
  }
}

function assertFinite(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(uiText("core.advanced.colormap.mustBeLimited", label))
}

function assertKind(kind: unknown): asserts kind is ColormapKind {
  if (!KINDS.includes(kind as ColormapKind)) throw new TypeError(uiText("core.advanced.colormap.colourChartTypesMustBeGrassFoliage"))
}

function assertModifier(modifier: unknown): asserts modifier is GrassColorModifier {
  if (!MODIFIERS.includes(modifier as GrassColorModifier)) throw new TypeError(uiText("core.advanced.colormap.grassModifiersMustBeNoneDarkForest"))
}

export function parseTintColor(color: TintColor): number {
  if (typeof color === 'number' && Number.isInteger(color) && color >= 0 && color <= 0xffffff) return color
  if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color.trim())) return Number.parseInt(color.trim().slice(1), 16)
  throw new TypeError(uiText("core.advanced.colormap.colourMustBeAnIntegerNumberOf"))
}

export function tintColorToHex(color: TintColor): string {
  return `#${parseTintColor(color).toString(16).padStart(6, '0')}`
}

// 原版按行索引颜色图，湿度是夹取后的温度与降雨量的乘积
export function getColormapCoordinate(climate: BiomeClimate): ColormapCoordinate {
  assertObject(climate, uiText("core.advanced.colormap.climaticClimate"))
  assertFinite(climate.temperature, 'temperature')
  assertFinite(climate.downfall, 'downfall')
  const temperature = Math.max(0, Math.min(1, climate.temperature))
  const downfall = Math.max(0, Math.min(1, climate.downfall))
  const humidity = temperature * downfall
  const x = Math.floor((1 - temperature) * (COLORMAP_SIZE - 1))
  const y = Math.floor((1 - humidity) * (COLORMAP_SIZE - 1))
  return { x, y, index: y * COLORMAP_SIZE + x, temperature, downfall, humidity }
}

function assertImage(image: ColormapImage): void {
  assertObject(image, uiText("core.advanced.colormap.colourChart"))
  if (image.width !== COLORMAP_SIZE || image.height !== COLORMAP_SIZE) throw new RangeError(uiText("core.advanced.colormap.theOriginalColoursMustBeX"))
  if (!(image.data instanceof Uint8Array) || image.data.length !== COLORMAP_BYTES) {
    throw new RangeError(uiText("core.advanced.colormap.colourDiagramsMustProvideCompleteX256Rgba"))
  }
}

// 在解压前限制 IHDR 尺寸，拒绝动画、截断块和异常体积
function assertPng(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 33 || bytes.byteLength > MAX_INPUT_BYTES) {
    throw new RangeError(uiText("core.advanced.colormap.colourChartPngMustBeNonEmpty"))
  }
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE) || buffer.readUInt32BE(8) !== 13 ||
      buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error(uiText("core.advanced.colormap.colourChartIsNotAValidPng"))
  if (buffer.readUInt32BE(16) !== COLORMAP_SIZE || buffer.readUInt32BE(20) !== COLORMAP_SIZE) {
    throw new RangeError(uiText("core.advanced.colormap.theOriginalColorChartPngMustBe"))
  }
  const compressed: Buffer[] = []
  let chunks = 0
  let offset = 8
  while (offset + 12 <= buffer.length) {
    if (++chunks > 4096) throw new RangeError(uiText("core.advanced.colormap.tooManyPngBlocksInColourCharts"))
    const length = buffer.readUInt32BE(offset)
    const end = offset + length + 12
    if (end > buffer.length) throw new Error(uiText("core.advanced.colormap.colourChartPngBlockInterrupted"))
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') compressed.push(buffer.subarray(offset + 8, end - 4))
    if (type === 'acTL') throw new Error(uiText("core.advanced.colormap.colourChartMustBeStaticPngNot"))
    if (type === 'IEND') {
      if (length !== 0 || end !== buffer.length) throw new Error(uiText("core.advanced.colormap.iendOrTailDataInvalidForColour"))
      if (!compressed.length) throw new Error(uiText("core.advanced.colormap.colorChartPngMissingIdat"))
      try {
        inflateSync(Buffer.concat(compressed), { maxOutputLength: COLORMAP_SIZE * COLORMAP_SIZE * 8 + COLORMAP_SIZE * 4 })
      } catch {
        throw new Error(uiText("core.advanced.colormap.colourChartPngCompressedDataDamagedOr"))
      }
      return
    }
    offset = end
  }
  throw new Error(uiText("core.advanced.colormap.colorChartPngMissingCompleteIend"))
}

export function decodeColormapPng(bytes: Uint8Array): ColormapImage {
  assertPng(bytes)
  try {
    const png = PNG.sync.read(Buffer.from(bytes), { checkCRC: true })
    const image = { width: png.width, height: png.height, data: new Uint8Array(png.data) }
    assertImage(image)
    return image
  } catch (error) {
    throw new Error(uiText("core.advanced.colormap.colourChartPngDecoded", error instanceof Error ? error.message : String(error)))
  }
}

export function encodeColormapPng(image: ColormapImage): Uint8Array {
  assertImage(image)
  const png = new PNG({ width: image.width, height: image.height })
  png.data = Buffer.from(image.data)
  return new Uint8Array(PNG.sync.write(png))
}

export function sampleColormap(image: ColormapImage, climate: BiomeClimate): number {
  assertImage(image)
  const offset = getColormapCoordinate(climate).index * 4
  return (image.data[offset] << 16) | (image.data[offset + 1] << 8) | image.data[offset + 2]
}

function mixTriangle(cold: number, dry: number, wet: number, x: number, y: number): number {
  const coldWeight = x / (COLORMAP_SIZE - 1)
  const dryWeight = Math.max(0, y - x) / (COLORMAP_SIZE - 1)
  const wetWeight = 1 - Math.max(x, y) / (COLORMAP_SIZE - 1)
  let color = 0
  for (const shift of [16, 8, 0]) {
    const channel = Math.round(((cold >> shift) & 255) * coldWeight +
      ((dry >> shift) & 255) * dryWeight + ((wet >> shift) & 255) * wetWeight)
    color |= channel << shift
  }
  return color
}

export function generateColormap(options: ColormapGenerationOptions): ColormapImage {
  assertObject(options, uiText("core.advanced.colormap.colourChartGenerationOptions"))
  const modes = [Object.hasOwn(options, 'color'), Object.hasOwn(options, 'sample'),
    ['cold', 'dry', 'wet'].some(key => Object.hasOwn(options, key))].filter(Boolean).length
  if (modes !== 1) throw new TypeError(uiText("core.advanced.colormap.colourChartGenerationOptionsMustAndCan"))
  let sample: (x: number, y: number) => TintColor
  if ('color' in options) {
    const color = parseTintColor(options.color as TintColor)
    sample = () => color
  } else if ('sample' in options) {
    if (typeof options.sample !== 'function') throw new TypeError(uiText("core.advanced.colormap.sampleMustBeAFunction"))
    sample = options.sample as (x: number, y: number) => TintColor
  } else {
    const { cold, dry, wet } = options as { cold: TintColor; dry: TintColor; wet: TintColor }
    const colors = [cold, dry, wet].map(parseTintColor)
    sample = (x, y) => mixTriangle(colors[0], colors[1], colors[2], x, y)
  }
  const data = new Uint8Array(COLORMAP_BYTES)
  for (let y = 0; y < COLORMAP_SIZE; y++) {
    for (let x = 0; x < COLORMAP_SIZE; x++) {
      const color = parseTintColor(sample(x, y))
      const offset = (y * COLORMAP_SIZE + x) * 4
      data[offset] = color >> 16
      data[offset + 1] = (color >> 8) & 255
      data[offset + 2] = color & 255
      data[offset + 3] = 255
    }
  }
  return { width: COLORMAP_SIZE, height: COLORMAP_SIZE, data }
}

export function generateColormapFiles(kind: ColormapKind, imageOrOptions: ColormapImage | ColormapGenerationOptions): GeneratedFile[] {
  assertKind(kind)
  assertObject(imageOrOptions, uiText("core.advanced.colormap.colourchartOrGenerationOptions"))
  const image = Object.hasOwn(imageOrOptions, 'data') ? imageOrOptions as ColormapImage : generateColormap(imageOrOptions as ColormapGenerationOptions)
  return [{ path: `assets/minecraft/textures/colormap/${kind}.png`, content: encodeColormapPng(image) }]
}

// swampNoise 是原版在世界坐标乘 0.0225 后取得的 BIOME_INFO_NOISE 值
export function applyGrassColorModifier(color: TintColor, modifier: GrassColorModifier, swampNoise?: number): number {
  const rgb = parseTintColor(color)
  assertModifier(modifier)
  if (swampNoise !== undefined) assertFinite(swampNoise, 'swampNoise')
  if (modifier === 'dark_forest') return ((rgb & 0xfefefe) + 0x28340a) >>> 1
  if (modifier === 'swamp') {
    assertFinite(swampNoise, uiText("core.advanced.colormap.swampnoiseForSwampFixer"))
    return swampNoise < -0.1 ? 0x4c763c : 0x6a7039
  }
  return rgb
}

function assertOverrides(overrides: BiomeTintOverrides): void {
  assertObject(overrides, uiText("core.advanced.colormap.groupColorOverwrite"))
  for (const key of Object.keys(overrides)) {
    if (![...COLOR_KEYS, 'grass_color_modifier'].includes(key)) throw new TypeError(uiText("core.advanced.colormap.unknownGroupColourOverlayField", key))
  }
  for (const key of COLOR_KEYS) {
    const value = overrides[key]
    if (value !== undefined && value !== null) parseTintColor(value)
  }
  if (overrides.grass_color_modifier !== undefined && overrides.grass_color_modifier !== null) assertModifier(overrides.grass_color_modifier)
}

export function resolveBiomeTint(options: BiomeTintOptions): number {
  assertObject(options, uiText("core.advanced.colormap.groupTintOptions"))
  assertKind(options.kind)
  if (options.climate !== undefined) getColormapCoordinate(options.climate)
  if (options.colormap !== undefined) assertImage(options.colormap)
  const effects = options.effects ?? {}
  assertOverrides(effects)
  const foliageType = options.foliageType ?? 'default'
  if (!['default', 'birch', 'spruce'].includes(foliageType)) throw new TypeError(uiText("core.advanced.colormap.foliagetypeMustBeDefaultBilchOrSpruce"))
  if (foliageType !== 'default' && options.kind !== 'foliage') throw new TypeError(uiText("core.advanced.colormap.birchSpruceFixedTintOnlyAppliesTo"))
  if (options.swampNoise !== undefined) assertFinite(options.swampNoise, 'swampNoise')
  if (foliageType !== 'default') return FIXED_FOLIAGE_TINTS[foliageType]
  const modifier = effects.grass_color_modifier ?? 'none'
  if (options.kind === 'grass' && modifier === 'swamp') return applyGrassColorModifier(0, modifier, options.swampNoise)
  const override = effects[`${options.kind}_color`]
  let base: number
  if (override !== undefined && override !== null) base = parseTintColor(override)
  else {
    if (!options.colormap || !options.climate) throw new TypeError(uiText("core.advanced.colormap.colormapAndClimateMustBeProvidedWhen"))
    base = sampleColormap(options.colormap, options.climate)
  }
  return options.kind === 'grass' ? applyGrassColorModifier(base, modifier, options.swampNoise) : base
}

// 克隆纯 JSON 并保留特殊键，禁止循环、访问器和隐式字段丢失
function cloneJson(value: unknown, ancestors = new Set<object>(), depth = 0): JsonValue {
  if (depth > 128) throw new RangeError(uiText("core.advanced.colormap.jsonEmbeddedDepthMoreThan"))
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    assertFinite(value, uiText("core.advanced.colormap.jsonValue"))
    return value
  }
  if (typeof value !== 'object') throw new TypeError(uiText("core.advanced.colormap.enterAValueThatCanNotBe"))
  if (ancestors.has(value)) throw new TypeError(uiText("core.advanced.colormap.enterJsonNotToIncludeLoopReferences"))
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError(uiText("core.advanced.colormap.enterJsonCannotContainSymbolField"))
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const result: JsonValue[] = []
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !('value' in descriptor)) throw new TypeError(uiText("core.advanced.colormap.enterJsonNotToIncludeAThin"))
        result.push(cloneJson(descriptor.value, ancestors, depth + 1))
      }
      if (Object.keys(value).some(key => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) {
        throw new TypeError(uiText("core.advanced.colormap.enterJsonArraysNotToContainExtra"))
      }
      return result
    }
    assertObject(value, uiText("core.advanced.colormap.enterJson"))
    const result: JsonObject = {}
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if (!('value' in descriptor)) throw new TypeError(uiText("core.advanced.colormap.enterJsonNotToIncludeAccessor"))
      Object.defineProperty(result, key, { value: cloneJson(descriptor.value, ancestors, depth + 1),
        enumerable: true, configurable: true, writable: true })
    }
    return result
  } finally {
    ancestors.delete(value)
  }
}

function readJsonObject(input: JsonObject | string, label: string): JsonObject {
  let value: unknown = input
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) throw new RangeError(uiText("core.advanced.colormap.jsonOverMib", label))
    try { value = JSON.parse(input) }
    catch { throw new SyntaxError(uiText("core.advanced.colormap.jsonSyntax", label)) }
  }
  assertObject(value, label)
  return cloneJson(value) as JsonObject
}

function assertBiome(biome: JsonObject, complete: boolean): void {
  assertFinite(biome.temperature, uiText("core.advanced.colormap.cluster"))
  assertFinite(biome.downfall, uiText("core.advanced.colormap.groupDownfall"))
  assertObject(biome.effects, uiText("core.advanced.colormap.effects"))
  if (!complete) return
  if (biome.has_precipitation !== undefined) {
    if (typeof biome.has_precipitation !== 'boolean') throw new TypeError(uiText("core.advanced.colormap.groupHasPrecipitationMustBeABoolean"))
  } else if (!['none', 'rain', 'snow'].includes(biome.precipitation as string)) {
    throw new TypeError(uiText("core.advanced.colormap.fullGroupDefinitionMustContainHasPrecipitation"))
  }
  if (!Array.isArray(biome.features)) throw new TypeError(uiText("core.advanced.colormap.fullGroupDefinitionMustContainFeaturesArray"))
  assertObject(biome.spawners, uiText("core.advanced.colormap.fullGroupDefinedSpawners"))
  assertObject(biome.spawn_costs, uiText("core.advanced.colormap.fullGroupDefinedSpawnCosts"))
  if (typeof biome.carvers !== 'string' && !Array.isArray(biome.carvers)) assertObject(biome.carvers, uiText("core.advanced.colormap.fullGroupDefinedCarvers"))
}

export function applyBiomeTintOverrides(biome: JsonObject | string, overrides: BiomeTintOverrides): JsonObject {
  assertOverrides(overrides)
  const result = readJsonObject(biome, uiText("core.advanced.colormap.cluster_67f831"))
  assertBiome(result, false)
  const effects = result.effects as JsonObject
  for (const key of COLOR_KEYS) {
    const value = overrides[key]
    if (value === null) delete effects[key]
    else if (value !== undefined) effects[key] = parseTintColor(value)
  }
  if (overrides.grass_color_modifier === null) delete effects.grass_color_modifier
  else if (overrides.grass_color_modifier !== undefined) effects.grass_color_modifier = overrides.grass_color_modifier
  return result
}

function resourceLocation(id: string): { namespace: string; path: string } {
  if (typeof id !== 'string' || !id || id.length > 512) throw new TypeError(uiText("core.advanced.colormap.resourceIdMustBeANonEmpty"))
  const parts = id.split(':')
  if (parts.length > 2) throw new TypeError(uiText("core.advanced.colormap.invalidNamespaceSeparatorForResourceId"))
  const namespace = parts.length === 2 ? parts[0] : 'minecraft'
  const path = parts.length === 2 ? parts[1] : parts[0]
  if (!/^[a-z0-9_.-]+$/.test(namespace) || !/^[a-z0-9_./-]+$/.test(path)) throw new TypeError(uiText("core.advanced.colormap.resourceIdMustUseValidLowercaseNaming"))
  const segments = [namespace, ...path.split('/')]
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.endsWith('.') ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment))) throw new TypeError(uiText("core.advanced.colormap.resourceIdContainsUnsafePathClips"))
  return { namespace, path }
}

export function exportBiomeTintDatapack(biomeId: string, biome: JsonObject | string, overrides: BiomeTintOverrides): GeneratedFile[] {
  const id = resourceLocation(biomeId)
  const result = applyBiomeTintOverrides(biome, overrides)
  assertBiome(result, true)
  return [{ path: `data/${id.namespace}/worldgen/biome/${id.path}.json`, content: JSON.stringify(result, null, 2) + '\n' }]
}

export function removeModelTintIndices(model: JsonObject | string): TintRemovalResult {
  const result = readJsonObject(model, uiText("core.advanced.colormap.model"))
  const warnings: string[] = []
  let removed = 0
  if (result.elements !== undefined && !Array.isArray(result.elements)) throw new TypeError(uiText("core.advanced.colormap.modelsMustBeArrays"))
  if (result.parent !== undefined && typeof result.parent !== 'string') throw new TypeError(uiText("core.advanced.colormap.modelParentMustBeAResourceId"))
  const elements = result.elements as JsonValue[] | undefined
  if (result.parent && !elements?.length) warnings.push(uiText("core.advanced.colormap.theModelInheritsGeometryFromTheParent"))
  for (const element of elements ?? []) {
    assertObject(element, uiText("core.advanced.colormap.model_2280cb"))
    if (element.faces === undefined) continue
    assertObject(element.faces, uiText("core.advanced.colormap.models"))
    for (const faceName of FACE_NAMES) {
      const face: JsonValue | undefined = (element.faces as JsonObject)[faceName]
      if (face === undefined) continue
      assertObject(face, uiText("core.advanced.colormap.modelFace", faceName))
      if (Object.hasOwn(face, 'tintindex')) {
        delete face.tintindex
        removed++
      }
    }
  }
  return { model: result, removed, warnings }
}

export function exportUntintedModel(modelId: string, model: JsonObject | string): GeneratedFile[] {
  const id = resourceLocation(modelId)
  const result = removeModelTintIndices(model)
  if (result.warnings.length) throw new Error(uiText("core.advanced.colormap.modelTintFromAnUndisplayedParentCannot"))
  return [{ path: `assets/${id.namespace}/models/${id.path}.json`, content: JSON.stringify(result.model, null, 2) + '\n' }]
}