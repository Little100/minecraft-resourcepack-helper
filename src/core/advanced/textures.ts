import { uiText } from '../../i18n/messages'
export interface GeneratedFile {
  path: string
  content: string | Uint8Array
}

export type CtmMethod = 'ctm' | 'ctm_compact' | 'compact' | 'horizontal' | 'vertical' | 'random'
export type NaturalTransform = '2' | '4' | 'F' | '2F' | '4F'
export type TokenList = string | readonly string[]
export type NumberList = string | readonly number[]

export interface TextureImage {
  name: string
  content: Uint8Array
}

export interface HeightRange {
  min: number
  max: number
}

export interface CtmTextureSpec {
  kind?: 'ctm' | 'random-block'
  name: string
  namespace?: string
  method?: CtmMethod
  matchBlocks?: TokenList
  matchTiles?: TokenList
  tiles: TokenList
  weights?: NumberList
  symmetry?: 'none' | 'opposite' | 'all'
  linked?: boolean
  connect?: 'block' | 'tile' | 'material'
  faces?: TokenList
  biomes?: TokenList
  heights?: readonly (number | HeightRange)[]
  innerSeams?: boolean
  replacements?: Readonly<Record<string, number>>
  images?: readonly TextureImage[]
}

export interface NaturalTextureSpec {
  kind?: 'natural'
  namespace?: string
  texture?: string
  transform?: NaturalTransform
  entries?: readonly { texture: string; transform: NaturalTransform }[]
}

export interface RandomEntityRule {
  skins?: NumberList
  textures?: NumberList
  weights?: NumberList
  biomes?: TokenList
  heights?: readonly (number | HeightRange)[]
  name?: string
  baby?: boolean
  weather?: TokenList
}

export interface RandomEntityTextureSpec extends RandomEntityRule {
  kind?: 'random-entity'
  namespace?: string
  texture: string
  rules?: readonly RandomEntityRule[]
  variants?: readonly { index: number; content: Uint8Array }[]
}

export type AdvancedTextureSpec =
  | (CtmTextureSpec & { kind: 'ctm' | 'random-block' })
  | (NaturalTextureSpec & { kind: 'natural' })
  | (RandomEntityTextureSpec & { kind: 'random-entity' })

export const CTM_TILE_COUNTS = Object.freeze({ ctm: 47, ctm_compact: 5, compact: 5, horizontal: 4, vertical: 4 })
const MAX_TOKENS = 4096
const NAMESPACE_PATTERN = /^[a-z0-9_.-]+$/
const RESOURCE_PATH_PATTERN = /^[a-z0-9_./-]+$/
const NATURAL_TRANSFORMS = new Set<string>(['2', '4', 'F', '2F', '4F'])

function invalid(message: string): never {
  throw new Error(`(${message})`)
}

export function validateResourcePath(value: string, label = uiText("core.advanced.textures.resourcePath")): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || !RESOURCE_PATH_PATTERN.test(value)) {
    invalid(uiText("core.advanced.textures.includeOnlyLowercaseResourcePathCharacters", label))
  }
  if (value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    invalid(uiText("core.advanced.textures.canTIncludeAbsolutePathsEmptySections", label))
  }
  if (value.split('/').some(part => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || part.endsWith('.'))) {
    invalid(uiText("core.advanced.textures.containsUnsafeFilenames", label))
  }
  return value
}

function namespaceOf(value = 'minecraft'): string {
  if (!NAMESPACE_PATTERN.test(value) || value === '.' || value === '..') invalid(uiText("core.advanced.textures.namespaceIsInvalid"))
  validateResourcePath(value, uiText("core.advanced.textures.namespace"))
  return value
}

function resourceLocation(value: string, label: string): string {
  const parts = value.split(':')
  if (parts.length > 2) invalid(uiText("core.advanced.textures.notALegalResourceLocation", label))
  if (parts.length === 2) namespaceOf(parts[0])
  validateResourcePath(parts[parts.length - 1], label)
  return value
}

function tokens(value: TokenList, label: string): string[] {
  const result = typeof value === 'string' ? value.trim().split(/\s+/) : Array.from(value)
  if (!result.length || result.length > MAX_TOKENS || result.some(v => typeof v !== 'string' || !v || /\s/.test(v))) {
    invalid(uiText("core.advanced.textures.canTInjectIntoEmptyOrContaining", label))
  }
  return result
}

function integer(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(uiText("core.advanced.textures.itMustBePresentBetween", label, min, max))
  return value
}

// 数字区间会展开计数，路径名称保持原样
export function expandTextureTiles(value: TokenList): string[] {
  const result: string[] = []
  for (const token of tokens(value, 'tiles')) {
    const range = /^(\d+)-(\d+)$/.exec(token)
    if (range) {
      const start = integer(Number(range[1]), 0, MAX_TOKENS - 1, uiText("core.advanced.textures.tilesStart"))
      const end = integer(Number(range[2]), start, MAX_TOKENS - 1, uiText("core.advanced.textures.tilesEndpoint"))
      for (let n = start; n <= end; n++) result.push(String(n))
    } else {
      validateResourcePath(token, uiText("core.advanced.textures.tilePath"))
      result.push(token)
    }
    if (result.length > MAX_TOKENS) invalid(uiText("core.advanced.textures.theNumberIsAboveTheSecurityLimit"))
  }
  return result
}

function numbers(value: NumberList, label: string, minimum = 0): number[] {
  if (typeof value !== 'string') {
    if (!value.length || value.length > MAX_TOKENS) invalid(uiText("core.advanced.textures.canTBeEmptyOrBeyondThe", label))
    return value.map(v => integer(v, minimum, 0x7fffffff, label))
  }
  const result: number[] = []
  for (const token of tokens(value, label)) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(token)
    if (!range) invalid(uiText("core.advanced.textures.onlyIntegersOrIncrementsCanBeIncluded", label))
    const start = integer(Number(range[1]), minimum, 0x7fffffff, label)
    const end = integer(Number(range[2] ?? range[1]), start, 0x7fffffff, label)
    if (end - start + result.length + 1 > MAX_TOKENS) invalid(uiText("core.advanced.textures.quantityExceededSecurityCeiling", label))
    for (let n = start; n <= end; n++) result.push(n)
  }
  return result
}

function weightsLine(value: NumberList | undefined, count: number, key = 'weights'): string[] {
  if (value === undefined) return []
  const values = numbers(value, uiText("core.advanced.textures.weight"))
  if (values.length !== count || !values.some(v => v > 0)) invalid(uiText("core.advanced.textures.theNumberOfWeightsMustBeEqual"))
  return [`${key}=${values.join(' ')}`]
}

function blockToken(value: string): string {
  const parts = value.split(':')
  const stateStart = parts[1]?.includes('=') ? 1 : parts.length > 1 ? 2 : 1
  resourceLocation(parts.slice(0, stateStart).join(':'), uiText("core.advanced.textures.blockId"))
  for (const state of parts.slice(stateStart)) {
    if (!/^[a-z0-9_]+=[a-z0-9_-]+(?:,[a-z0-9_-]+)*$/.test(state)) invalid(uiText("core.advanced.textures.theBoxStatusFilterIsInvalid"))
  }
  return value
}

function selectionLines(spec: CtmTextureSpec): string[] {
  const result: string[] = []
  if (spec.matchBlocks !== undefined) result.push(`matchBlocks=${tokens(spec.matchBlocks, 'matchBlocks').map(blockToken).join(' ')}`)
  if (spec.matchTiles !== undefined) result.push(`matchTiles=${tokens(spec.matchTiles, 'matchTiles').map(t => resourceLocation(t, uiText("core.advanced.textures.matchTexture"))).join(' ')}`)
  if (!result.length) invalid(uiText("core.advanced.textures.mustSpecifyWatchblocksOrMatchtilesToAvoid"))
  return result
}

function biomeLine(value: TokenList | undefined, key: string): string[] {
  if (value === undefined) return []
  return [`${key}=${tokens(value, uiText("core.advanced.colormap.cluster_67f831")).map(t => resourceLocation(t, uiText("core.advanced.textures.groupId"))).join(' ')}`]
}

function heightLine(value: readonly (number | HeightRange)[] | undefined, key: string): string[] {
  if (value === undefined) return []
  if (!value.length || value.length > MAX_TOKENS) invalid(uiText("core.advanced.textures.highAltitudeAreasCannotBeEmptyOr"))
  const endpoint = (n: number) => n < 0 ? `(${n})` : String(n)
  const values = value.map(v => {
    if (typeof v === 'number') return String(integer(v, -0x7fffffff, 0x7fffffff, uiText("core.advanced.textures.height")))
    const min = integer(v.min, -0x7fffffff, 0x7fffffff, uiText("core.advanced.textures.heightBottom"))
    const max = integer(v.max, min, 0x7fffffff, uiText("core.advanced.textures.altitudeTop"))
    return `${endpoint(min)}-${endpoint(max)}`
  })
  return [`${key}=${values.join(' ')}`]
}

function boolLine(value: boolean | undefined, key: string): string[] {
  if (value === undefined) return []
  if (typeof value !== 'boolean') invalid(uiText("core.advanced.textures.mustBeABooleanValue", key))
  return [`${key}=${value}`]
}

function enumLine(value: string | undefined, key: string, allowed: readonly string[]): string[] {
  if (value === undefined) return []
  if (!allowed.includes(value)) invalid(uiText("core.advanced.textures.notWithinAllowedValue", key))
  return [`${key}=${value}`]
}

function serialize(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`
}

function imageFiles(images: readonly TextureImage[] | undefined, directory: string): GeneratedFile[] {
  const seen = new Set<string>()
  return (images ?? []).map(image => {
    const name = validateResourcePath(image.name, uiText("core.advanced.textures.pasteFileName"))
    if (!name.endsWith('.png') || !(image.content instanceof Uint8Array)) invalid(uiText("core.advanced.textures.pasteMustBeAPngFileAnd"))
    if (seen.has(name)) invalid(uiText("core.advanced.textures.pasteFilePathDuplicated"))
    seen.add(name)
    return { path: `${directory}/${name}`, content: new Uint8Array(image.content) }
  })
}

export function generateCtmTextures(spec: CtmTextureSpec): GeneratedFile[] {
  const namespace = namespaceOf(spec.namespace)
  const name = validateResourcePath(spec.name, uiText("core.advanced.textures.ctmRuleName"))
  const method = spec.method === 'compact' ? 'ctm_compact' : spec.method ?? 'ctm'
  if (!['ctm', 'ctm_compact', 'horizontal', 'vertical', 'random'].includes(method)) invalid(uiText("core.advanced.textures.unsupportedCtmMethod"))
  const tiles = expandTextureTiles(spec.tiles)
  const expected = method === 'random' ? undefined : CTM_TILE_COUNTS[method as keyof typeof CTM_TILE_COUNTS]
  const replacements = Object.entries(spec.replacements ?? {})
  if (method === 'ctm_compact' && replacements.length) {
    if (tiles.length < 5) invalid(uiText("core.advanced.textures.compactTakesAtLeastBaseFiles"))
    for (const [key, value] of replacements) {
      if (!/^(?:0|[1-9]\d*)$/.test(key)) invalid(uiText("core.advanced.textures.compactReplacementIndexMustBeInteger"))
      integer(Number(key), 0, 46, 'compact CTM case')
      integer(value, 0, tiles.length - 1, uiText("core.advanced.textures.compactFileIndex"))
    }
  } else if (expected !== undefined && tiles.length !== expected) {
    invalid(uiText("core.advanced.textures.mustProvideChangFileCurrentlyAs", method, expected, tiles.length))
  }
  if (method !== 'ctm_compact' && replacements.length) invalid(uiText("core.advanced.textures.ctmCaseReplacementOnlyForCtmCompact"))
  if (method !== 'random' && (spec.weights !== undefined || spec.symmetry !== undefined || spec.linked !== undefined)) {
    invalid(uiText("core.advanced.textures.weightsSymmetryAndLinkedOnlyToThe"))
  }
  if (spec.innerSeams !== undefined && method !== 'ctm' && method !== 'ctm_compact') invalid(uiText("core.advanced.textures.innerseamsOnlyForEightWayCtm"))
  const lines = [...selectionLines(spec), `method=${method}`, `tiles=${tokens(spec.tiles, 'tiles').join(' ')}`]
  lines.push(...enumLine(spec.connect, 'connect', ['block', 'tile', 'material']))
  if (spec.faces !== undefined) {
    const faces = tokens(spec.faces, 'faces')
    if (faces.some(v => !['bottom', 'top', 'north', 'south', 'east', 'west', 'sides', 'all'].includes(v))) invalid(uiText("core.advanced.textures.facesAreIllegal"))
    lines.push(`faces=${faces.join(' ')}`)
  }
  lines.push(...biomeLine(spec.biomes, 'biomes'), ...heightLine(spec.heights, 'heights'))
  lines.push(...boolLine(spec.innerSeams, 'innerSeams'))
  if (method === 'random') {
    lines.push(...weightsLine(spec.weights, tiles.length), ...enumLine(spec.symmetry, 'symmetry', ['none', 'opposite', 'all']))
    lines.push(...boolLine(spec.linked, 'linked'))
  }
  for (const [key, value] of replacements.sort((a, b) => Number(a[0]) - Number(b[0]))) lines.push(`ctm.${key}=${value}`)
  const directory = `assets/${namespace}/optifine/ctm/${name}`
  return [{ path: `${directory}/${name.split('/').pop()}.properties`, content: serialize(lines) }, ...imageFiles(spec.images, directory)]
}

export function generateRandomBlockTextures(spec: CtmTextureSpec): GeneratedFile[] {
  return generateCtmTextures({ ...spec, method: 'random' })
}

export function generateNaturalTextures(spec: NaturalTextureSpec): GeneratedFile[] {
  const namespace = namespaceOf(spec.namespace)
  const entries = spec.entries ?? (spec.texture !== undefined && spec.transform !== undefined ? [{ texture: spec.texture, transform: spec.transform }] : [])
  if (!entries.length || entries.length > MAX_TOKENS) invalid(uiText("core.advanced.textures.weNeedTextureAndTransformation"))
  const seen = new Set<string>()
  const lines = entries.map(entry => {
    let texture = resourceLocation(entry.texture, uiText("core.advanced.textures.naturalTexture"))
    if (texture.endsWith('.png')) texture = texture.slice(0, -4)
    if (!NATURAL_TRANSFORMS.has(entry.transform)) invalid(uiText("core.advanced.textures.naturalTextureTransformationsMustBeFF"))
    if (seen.has(texture)) invalid(uiText("core.advanced.textures.theNaturalTextureRuleRepeats"))
    seen.add(texture)
    return `${texture}=${entry.transform}`
  })
  return [{ path: `assets/${namespace}/optifine/natural.properties`, content: serialize(lines) }]
}

// Java properties 的反斜杠和键值分隔符需要转义
function propertyValue(value: string): string {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value) || value.length > 4096) invalid(uiText("core.advanced.textures.entityNameDoesNotAllowLineChange"))
  return value.replace(/\\/g, '\\\\').replace(/([=:#!])/g, '\\$1').replace(/^ /, '\\ ')
    .replace(/[^\x20-\x7e]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

export function generateRandomEntityTextures(spec: RandomEntityTextureSpec): GeneratedFile[] {
  const namespace = namespaceOf(spec.namespace)
  let texture = validateResourcePath(spec.texture, uiText("core.advanced.textures.entityBasisTexture"))
  if (texture.endsWith('.png')) texture = texture.slice(0, -4)
  if (!texture.startsWith('entity/')) invalid(uiText("core.advanced.textures.randomPhysicalTextureMustBeAnEntity"))
  const rules = spec.rules ?? [spec]
  if (!rules.length || rules.length > MAX_TOKENS) invalid(uiText("core.advanced.textures.randomEntityRulesCannotBeEmptyOr"))
  const lines: string[] = []
  rules.forEach((rule, offset) => {
    const suffix = offset + 1
    if (rule.skins !== undefined && rule.textures !== undefined) invalid(uiText("core.advanced.textures.couldNotSpecifyBothSkinsAndTextures"))
    const indices = numbers(rule.skins ?? rule.textures ?? [], uiText("core.advanced.textures.entityTextureIndex"), 1)
    lines.push(`textures.${suffix}=${indices.join(' ')}`)
    lines.push(...weightsLine(rule.weights, indices.length, `weights.${suffix}`))
    lines.push(...biomeLine(rule.biomes, `biomes.${suffix}`), ...heightLine(rule.heights, `heights.${suffix}`))
    if (rule.name !== undefined) lines.push(`name.${suffix}=${propertyValue(rule.name)}`)
    lines.push(...boolLine(rule.baby, `baby.${suffix}`))
    if (rule.weather !== undefined) {
      const weather = tokens(rule.weather, 'weather')
      if (weather.some(v => !['clear', 'rain', 'thunder'].includes(v))) invalid(uiText("core.advanced.textures.itSIllegal"))
      lines.push(`weather.${suffix}=${weather.join(' ')}`)
    }
  })
  const files: GeneratedFile[] = [{ path: `assets/${namespace}/optifine/random/${texture}.properties`, content: serialize(lines) }]
  const seen = new Set<number>()
  for (const variant of spec.variants ?? []) {
    const index = integer(variant.index, 1, 0x7fffffff, uiText("core.advanced.textures.physicalVariantIndex"))
    if (seen.has(index) || !(variant.content instanceof Uint8Array)) invalid(uiText("core.advanced.textures.entityVariantRepetitionOrContentIsNot"))
    seen.add(index)
    const separator = /\d$/.test(texture) ? '.' : ''
    const target = index === 1 ? `assets/${namespace}/textures/${texture}.png` : `assets/${namespace}/optifine/random/${texture}${separator}${index}.png`
    files.push({ path: target, content: new Uint8Array(variant.content) })
  }
  return files
}

export function generateAdvancedTextures(spec: AdvancedTextureSpec): GeneratedFile[] {
  switch (spec.kind) {
    case 'ctm': return generateCtmTextures(spec)
    case 'random-block': return generateRandomBlockTextures(spec)
    case 'natural': return generateNaturalTextures(spec)
    case 'random-entity': return generateRandomEntityTextures(spec)
    default: return invalid(uiText("core.advanced.textures.unknownAdvancedTextureType"))
  }
}
