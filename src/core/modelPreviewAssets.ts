import { uiText } from '../i18n/messages'
import { constants, type Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { TextDecoder } from 'node:util'
import { legacySpecialModel, specialModelTexturePaths } from './specialModelAssets'

export type ModelPreviewAssetsErrorCode =
  | 'INVALID_PATH' | 'INVALID_ROOT' | 'INVALID_OPTIONS' | 'INVALID_LAYER' | 'SYMLINK' | 'INVALID_FILE'
  | 'IO_ERROR' | 'FILE_CHANGED' | 'FILE_LIMIT' | 'TOTAL_LIMIT' | 'DISCOVERY_LIMIT'
  | 'DEPTH_LIMIT' | 'RESOLUTION_LIMIT' | 'INVALID_JSON' | 'INVALID_MODEL'
  | 'INVALID_BLOCKSTATE' | 'MODEL_CYCLE' | 'TEXTURE_CYCLE' | 'MISSING_ASSET'

export class ModelPreviewAssetsError extends Error {
  readonly missingPaths?: readonly string[]

  constructor(readonly code: ModelPreviewAssetsErrorCode, message: string, readonly assetPath?: string, options?: ErrorOptions & { missingPaths?: readonly string[] }) {
    super(message, options)
    this.name = 'ModelPreviewAssetsError'
    this.missingPaths = options?.missingPaths ? Object.freeze([...options.missingPaths]) : undefined
  }
}

export interface ModelPreviewAssetLimits {
  maxFileBytes: number
  maxJsonBytes: number
  maxTotalBytes: number
  maxRoots: number
  maxEntries: number
  maxFiles: number
  maxDirectoryDepth: number
  maxModelDepth: number
  maxJsonDepth: number
  maxJsonNodes: number
  maxResolutionSteps: number
  maxStateCombinations: number
  maxInstances: number
  maxCandidates: number
}

export type ModelPreviewAssetsOptions = Partial<ModelPreviewAssetLimits>

export const DEFAULT_MODEL_PREVIEW_ASSET_LIMITS: Readonly<ModelPreviewAssetLimits> = Object.freeze({
  maxFileBytes: 32 * 1024 * 1024,
  maxJsonBytes: 4 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxRoots: 16,
  maxEntries: 200_000,
  maxFiles: 100_000,
  maxDirectoryDepth: 64,
  maxModelDepth: 64,
  maxJsonDepth: 128,
  maxJsonNodes: 200_000,
  maxResolutionSteps: 2_000_000,
  maxStateCombinations: 65_536,
  maxInstances: 1024,
  maxCandidates: 10_000
})

export interface ModelPreviewInstance {
  model: string
  modelPath: string
  x: number
  y: number
  uvlock: boolean
  weight: number
  // 偏移单位为方块，显式选择单个 half 时不附加偏移
  offset: [number, number, number]
  properties: Record<string, string>
}

export interface ModelPreviewCandidateOptions {
  // direct 仅验证同资源 ID 的实际资产，all 还发现不同文件名的反向关联
  discovery?: 'direct' | 'all'
}

export interface ModelPreviewCandidate {
  kind: 'block' | 'model' | 'item'
  id: string
  // item 可指向现代 items 定义或 legacy models/item 模型
  path: string
  // 自动组合上下半部时省略 half，便于直接传给 blockstateInstances
  properties: Record<string, string>
  // special 记录 base 模型，empty 和动态节点可为空
  models: string[]
  texturePaths: string[]
  // 仅可确定为空的静态物品内容设为 true
  empty?: boolean
}

export interface ModelPreviewResolvedModel {
  id: string
  path: string
  model: Record<string, unknown>
  parents: string[]
  textures: Record<string, string>
  texturePaths: string[]
  missingPaths: string[]
  available: boolean
  legacySpecial?: boolean
  empty?: boolean
}

type JsonObject = Record<string, unknown>
type ItemPreviewNode =
  | { kind: 'model' | 'special'; modelPath: string }
  | { kind: 'all' | 'any'; children: ItemPreviewNode[] }
  | { kind: 'empty' }
  | { kind: 'dynamic' }
type ItemPreviewDefinition = { root: ItemPreviewNode; references: Set<string>; texturePaths: Set<string>; error?: ModelPreviewAssetsError }
type ItemPreviewResolution = { available: boolean; empty: boolean; models: ModelPreviewResolvedModel[]; missingPaths: string[] }
type FileStat = Stats
type Located = { absolute: string; stat: FileStat }
type MergedModel = { model: JsonObject; parents: string[]; missing: string[]; builtin?: string; depth: number }
type Apply = { model: string; modelPath: string; x: number; y: number; uvlock: boolean; weight: number }
type Condition = { kind: 'property'; name: string; values: string[] } | { kind: 'all' | 'any'; children: Condition[] }
type Blockstate = {
  variants: { properties: Record<string, string>; apply: Apply[] }[]
  multipart: { condition: Condition; apply: Apply[] }[]
  values: Record<string, string[]>
}
type Context = {
  steps: number
  json: Map<string, JsonObject | undefined>
  merged: Map<string, MergedModel | undefined>
  models: Map<string, ModelPreviewResolvedModel | undefined>
  existing: Map<string, boolean>
}

const CATEGORIES = new Set(['models', 'blockstates', 'items', 'atlases', 'textures', 'lang', 'font'])
const RENDERER_AUXILIARY_FILES = new Set(['default_blockstates', 'default_blockstates_preferred', 'waterlogging', 'culling', 'lighting', 'offsets', 'colors', 'items'].map(name => 'assets/block-model-renderer/' + name + '.json'))
const DISCOVERY_CATEGORIES = new Set(['models', 'blockstates', 'items'])
const NAMESPACE = /^[a-z0-9_.-]+$/
const SEGMENT = /^[a-z0-9_.-]+$/
const PROPERTY = /^[a-z0-9_]+$/
const VALUE = /^[a-z0-9_.-]+$/
const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR'])
const own = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key)
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)
const textureSprite = (value: unknown): string | undefined => typeof value === 'string' ? value : object(value) && typeof value.sprite === 'string' ? value.sprite : undefined
const unique = (values: Iterable<string>): string[] => [...new Set(values)].sort()
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
const errorCode = (error: unknown): string | undefined => object(error) && typeof error.code === 'string' ? error.code : undefined

function fail(code: ModelPreviewAssetsErrorCode, message: string, assetPath?: string): never {
  throw new ModelPreviewAssetsError(code, message, assetPath)
}

function safeSegments(parts: string[]): boolean {
  return parts.every(part => SEGMENT.test(part) && part !== '.' && part !== '..')
}

function assetPath(value: string, prefix = false): string {
  if (typeof value !== 'string' || value.includes('\\') || value.includes('\0') || value.startsWith('/') || value.includes(':')) {
    fail('INVALID_PATH', uiText("core.modelPreviewAssets.theResourcePathMustBeASlash"), value)
  }
  const normalized = prefix && value.endsWith('/') ? value.slice(0, -1) : value
  if (normalized === 'pack.mcmeta') return normalized
  if (RENDERER_AUXILIARY_FILES.has(normalized)) return normalized
  if (prefix && normalized === '') return ''
  const parts = normalized.split('/')
  if (!safeSegments(parts) || parts[0] !== 'assets' || (parts.length > 1 && !NAMESPACE.test(parts[1]))) {
    fail('INVALID_PATH', uiText("core.modelPreviewAssets.resourcePathOrNamespaceInvalid"), value)
  }
  if (parts.length > 2 && !CATEGORIES.has(parts[2])) fail('INVALID_PATH', uiText("core.modelPreviewAssets.theResourceDirectoryIsNotAllowed"), value)
  if (prefix) return normalized
  if (parts.length < 4) fail('INVALID_PATH', uiText("core.modelPreviewAssets.resourcePathMissingFilename"), value)
  const filename = parts[parts.length - 1]
  const allowed = parts[2] === 'textures' ? /\.png(?:\.mcmeta)?$/.test(filename) : filename.endsWith('.json')
  if (!allowed) fail('INVALID_PATH', uiText("core.modelPreviewAssets.onlyTheModelsAreAllowedToBe"), value)
  return normalized
}

function reference(value: string, category: 'models' | 'blockstates' | 'textures'): string {
  if (typeof value !== 'string') fail('INVALID_PATH', uiText("core.modelPreviewAssets.resourceIdMustBeAString"))
  if (value.startsWith('assets/')) {
    const validated = assetPath(value)
    if (validated.split('/')[2] !== category) fail('INVALID_PATH', uiText("core.modelPreviewAssets.resourceTypeInconsistentWithRequest"), value)
    return validated
  }
  const parts = value.split(':')
  const namespace = parts.length === 1 ? 'minecraft' : parts[0]
  const location = parts.length === 1 ? parts[0] : parts[1]
  if (parts.length > 2 || !NAMESPACE.test(namespace) || !safeSegments(namespace.split('/')) || !location || !safeSegments(location.split('/'))) {
    fail('INVALID_PATH', uiText("core.modelPreviewAssets.resourceIdInvalid"), value)
  }
  const extension = category === 'textures' ? '.png' : '.json'
  return assetPath(`assets/${namespace}/${category}/${location}${location.endsWith(extension) ? '' : extension}`)
}

function resourceId(value: string): string {
  const parts = value.split('/')
  return `${parts[1]}:${parts.slice(3).join('/').replace(/\.(?:json|png)$/, '')}`
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function sameFile(left: FileStat, right: FileStat): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

// 每个实例代表固定优先级的目录栈，累计预算跨请求生效；重新选择资源版本时创建新实例
export class ModelPreviewAssets {
  readonly roots: readonly string[]
  readonly limits: Readonly<ModelPreviewAssetLimits>
  private consumedBytes = 0
  private reservedBytes = 0

  constructor(roots: string[], options: ModelPreviewAssetsOptions = {}) {
    if (!object(options)) fail('INVALID_OPTIONS', uiText("core.modelPreviewAssets.resourceLimitsMustBeTheTarget"))
    const limits = { ...DEFAULT_MODEL_PREVIEW_ASSET_LIMITS }
    for (const [key, value] of Object.entries(options)) {
      if (!own(limits, key) || !Number.isSafeInteger(value) || value <= 0) fail('INVALID_OPTIONS', uiText("core.modelPreviewAssets.ineffectiveResourceLimit", key))
      limits[key as keyof ModelPreviewAssetLimits] = value
    }
    this.limits = Object.freeze(limits)
    if (!Array.isArray(roots) || roots.length === 0 || roots.length > limits.maxRoots) fail('INVALID_ROOT', uiText("core.modelPreviewAssets.theNumberOfResourceRootDirectoriesIs"))
    this.roots = Object.freeze(normalizeRoots(roots))
  }

  get bytesRead(): number { return this.consumedBytes }

  // 缺失返回 undefined，非法路径和读取限额使用带 code 的异常
  async read(requestPath: string, layer?: number): Promise<Uint8Array | undefined> {
    const validated = assetPath(requestPath)
    const located = await this.locate(validated, layer)
    if (!located) return undefined
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    let reservation = 0
    try {
      handle = await fs.open(located.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      const stat = await handle.stat()
      if (!stat.isFile()) fail('INVALID_FILE', uiText("core.modelPreviewAssets.resourceIsNotANormalFile"), validated)
      if (!sameFile(located.stat, stat)) fail('FILE_CHANGED', uiText("core.modelPreviewAssets.changeResourceBeforeReadingPleaseTryAgain"), validated)
      const checked = await this.inspect(located.absolute, true)
      if (!checked || !sameFile(stat, checked)) fail('FILE_CHANGED', uiText("core.modelPreviewAssets.changeResourceBeforeReadingPleaseTryAgain"), validated)
      this.checkFileSize(validated, stat.size)
      if (stat.size > this.limits.maxTotalBytes - this.consumedBytes - this.reservedBytes) fail('TOTAL_LIMIT', uiText("core.modelPreviewAssets.accumulatedResourcesReadBeyondMaxtotalbytesPleaseNarrow"), validated)
      reservation = stat.size
      this.reservedBytes += reservation
      const bytes = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset)
        this.consumedBytes += result.bytesRead
        this.reservedBytes -= result.bytesRead
        reservation -= result.bytesRead
        if (!result.bytesRead) fail('FILE_CHANGED', uiText("core.modelPreviewAssets.resourcesAreCutOffWhileReadingPlease"), validated)
        offset += result.bytesRead
      }
      const after = await handle.stat()
      const checkedAfter = await this.inspect(located.absolute, true)
      if (!sameFile(stat, after) || !checkedAfter || !sameFile(stat, checkedAfter)) fail('FILE_CHANGED', uiText("core.modelPreviewAssets.resourceChangesWhileReadingPleaseTryAgain"), validated)
      if (validated === 'pack.mcmeta') this.parseJson(bytes, validated)
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    } catch (error) {
      if (error instanceof ModelPreviewAssetsError) throw error
      throw new ModelPreviewAssetsError(errorCode(error) === 'ELOOP' ? 'SYMLINK' : 'IO_ERROR', uiText("core.modelPreviewAssets.resourceReadingFailed"), validated, { cause: error })
    } finally {
      this.reservedBytes -= reservation
      await handle?.close()
    }
  }

  async readJson(requestPath: string, layer?: number): Promise<unknown | undefined> {
    const validated = assetPath(requestPath)
    if (validated.endsWith('.png')) fail('INVALID_PATH', uiText("core.modelPreviewAssets.pngCannotBeReadAsJson"), validated)
    return this.json(validated, this.context(), layer)
  }

  // 返回去重排序后的完整资源路径，高优先级目录覆盖同名低优先级文件
  async list(prefix = '', layer?: number): Promise<string[]> {
    const validated = assetPath(prefix, true)
    if (validated === 'pack.mcmeta') fail('INVALID_PATH', uiText("core.modelPreviewAssets.listOnlyAssetsResourceDirectories"), validated)
    return this.listAssets(validated, layer)
  }

  private async listAssets(validated: string, layer?: number, categories = CATEGORIES): Promise<string[]> {
    const selectedRoots = this.layers(layer)
    const found = new Set<string>()
    let entries = 0
    let files = 0
    const walk = async (root: string, relative: string, depth: number): Promise<void> => {
      if (depth > this.limits.maxDirectoryDepth) fail('DEPTH_LIMIT', uiText("core.modelPreviewAssets.resourceCountExceedingMaxdirectorydeptth"), relative)
      const absolute = path.join(root, ...relative.split('/'))
      const stat = await this.inspect(absolute, false)
      if (!stat) return
      if (!stat.isDirectory()) fail('INVALID_FILE', uiText("core.modelPreviewAssets.resourceDirectoryIsNotANormalDirectory"), relative)
      const directory = await fs.opendir(absolute)
      for await (const entry of directory) {
        if (++entries > this.limits.maxEntries) fail('DISCOVERY_LIMIT', uiText("core.modelPreviewAssets.theResourceCountExceedsMaxentriesPleaseNarrow"), relative)
        const parts = `${relative}/${entry.name}`.split('/')
        if (!safeSegments([entry.name])) continue
        if (parts.length === 2 && !NAMESPACE.test(entry.name)) continue
        if (parts.length === 3 && !categories.has(entry.name)) continue
        const child = parts.join('/')
        const couldMatch = !validated || child === validated || child.startsWith(`${validated}/`) || validated.startsWith(`${child}/`)
        if (!couldMatch) continue
        const childStat = await this.inspect(path.join(root, ...parts), false)
        if (!childStat) fail('FILE_CHANGED', uiText("core.modelPreviewAssets.resourceChangesDuringTheCountPleaseTry"), child)
        if (childStat.isDirectory()) {
          await walk(root, child, depth + 1)
        } else if (parts.length >= 4 && childStat.isFile()) {
          const allowed = parts[2] === 'textures' ? /\.png(?:\.mcmeta)?$/.test(entry.name) : entry.name.endsWith('.json')
          if (!allowed) continue
          if (++files > this.limits.maxFiles) fail('DISCOVERY_LIMIT', uiText("core.modelPreviewAssets.resourceCountAboveMaxfilesPleaseNarrowThe"), child)
          found.add(child)
        } else if (parts.length < 4 && childStat.isFile()) {
          continue
        } else if (!childStat.isFile()) {
          fail('INVALID_FILE', uiText("core.modelPreviewAssets.resourceDirectoryContainsNonOrdinaryFiles"), child)
        }
      }
      const after = await this.inspect(absolute, false)
      if (!after || after.dev !== stat.dev || after.ino !== stat.ino) fail('FILE_CHANGED', uiText("core.modelPreviewAssets.theResourceDirectoryHasChangedDuringThe"), relative)
    }
    try {
      for (const root of selectedRoots) await walk(root, 'assets', 0)
    } catch (error) {
      if (error instanceof ModelPreviewAssetsError) throw error
      throw new ModelPreviewAssetsError('IO_ERROR', uiText("core.modelPreviewAssets.resourceDirectoryCountFailed"), validated, { cause: error })
    }
    return [...found].sort()
  }

  async resolveModel(idOrPath: string): Promise<ModelPreviewResolvedModel | undefined> {
    return this.resolve(reference(idOrPath, 'models'), this.context())
  }

  async blockstateValues(idOrPath: string): Promise<Record<string, string[]>> {
    const validated = reference(idOrPath, 'blockstates')
    const state = await this.blockstate(validated, this.context())
    if (!state) fail('MISSING_ASSET', uiText("core.modelPreviewAssets.blockstateJsonNotFound"), validated)
    return state.values
  }

  async blockstateInstances(idOrPath: string, properties: Readonly<Record<string, string>> = {}): Promise<ModelPreviewInstance[]> {
    const validated = reference(idOrPath, 'blockstates')
    const context = this.context()
    const state = await this.blockstate(validated, context)
    if (!state) fail('MISSING_ASSET', uiText("core.modelPreviewAssets.blockstateJsonNotFound"), validated)
    const instances = await this.instances(state, properties, context)
    if (!instances) this.missingAsset(validated, this.contextMissing(context), uiText("core.modelPreviewAssets.noModelAvailableForTheSelectedState"))
    return instances
  }

  // 目录接口保留完整路径，直属条目接口直接返回库所需的 name
  async listDirectories(prefix = 'assets', layer?: number): Promise<string[]> {
    const validated = assetPath(prefix, true) || 'assets'
    const entries = await this.directoryEntries(validated, layer)
    return entries.filter(entry => entry.directory).map(entry => `${validated}/${entry.name}`)
  }

  async listEntries(prefix = 'assets', layer?: number): Promise<string[]> {
    return (await this.directoryEntries(assetPath(prefix, true) || 'assets', layer)).map(entry => entry.name)
  }

  private async directoryEntries(validated: string, layer?: number): Promise<{ name: string; directory: boolean }[]> {
    if (validated === 'pack.mcmeta') fail('INVALID_PATH', uiText("core.modelPreviewAssets.noPackMcentaIsNotADirectory"), validated)
    const found = new Map<string, boolean>()
    let entries = 0
    let files = 0
    try {
      for (const root of this.layers(layer)) {
        const absolute = path.join(root, ...validated.split('/'))
        const stat = await this.inspect(absolute, false)
        if (!stat) continue
        if (!stat.isDirectory()) fail('INVALID_FILE', uiText("core.modelPreviewAssets.elementTargetsAreNotDirectories"), validated)
        const directory = await fs.opendir(absolute)
        for await (const entry of directory) {
          if (++entries > this.limits.maxEntries) fail('DISCOVERY_LIMIT', uiText("core.modelPreviewAssets.directoryCountExceedingMaxentries"), validated)
          if (!safeSegments([entry.name])) continue
          const parts = `${validated}/${entry.name}`.split('/')
          if (parts.length === 3 && !CATEGORIES.has(entry.name)) continue
          const child = await this.inspect(path.join(absolute, entry.name), false)
          if (!child) fail('FILE_CHANGED', uiText("core.modelPreviewAssets.resourceChangesDuringTheCountPleaseTry"), validated)
          if (!child.isDirectory()) {
            if (parts.length < 4) continue
            if (!child.isFile()) fail('INVALID_FILE', uiText("core.modelPreviewAssets.resourceIsNotANormalFile"), parts.join('/'))
            const allowed = parts[2] === 'textures' ? /\.png(?:\.mcmeta)?$/.test(entry.name) : entry.name.endsWith('.json')
            if (!allowed) continue
            if (++files > this.limits.maxFiles) fail('DISCOVERY_LIMIT', uiText("core.modelPreviewAssets.directoryCountsMoreThanMaxfiles"), validated)
          }
          if (!found.has(entry.name)) found.set(entry.name, child.isDirectory())
        }
        const after = await this.inspect(absolute, false)
        if (!after || after.dev !== stat.dev || after.ino !== stat.ino) fail('FILE_CHANGED', uiText("core.modelPreviewAssets.theResourceDirectoryHasChangedDuringThe"), validated)
      }
    } catch (error) {
      if (error instanceof ModelPreviewAssetsError) throw error
      throw new ModelPreviewAssetsError('IO_ERROR', uiText("core.modelPreviewAssets.cannotInitialiseEvolutionSMailComponent"), validated, { cause: error })
    }
    return [...found].sort(([left], [right]) => compare(left, right)).map(([name, directory]) => ({ name, directory }))
  }
  async candidates(inputPath: string, options: ModelPreviewCandidateOptions = {}): Promise<ModelPreviewCandidate[]> {
    if (!object(options) || Object.keys(options).some(key => key !== 'discovery') || (options.discovery !== undefined && options.discovery !== 'direct' && options.discovery !== 'all')) {
      fail('INVALID_OPTIONS', uiText("core.modelPreviewAssets.candidatesMustBeDirectedOrAll"))
    }
    let input = await this.inputPath(inputPath)
    if (input === 'pack.mcmeta') return []
    if (input.endsWith('.png.mcmeta')) input = input.slice(0, -'.mcmeta'.length)
    const context = this.context()
    if (!await this.exists(input, context)) return []
    const [, namespace, category, ...segments] = input.split('/')
    if (category === 'atlases' || category === 'lang') return []
    const location = segments.join('/').replace(/\.(?:json|png)$/, '')
    const identity = category === 'models' || category === 'textures' ? location.replace(/^(?:block|item)\//, '') : location
    const base = 'assets/' + namespace + '/'
    const directModels = new Set<string>(category === 'blockstates' || category === 'items' ? [] : [base + 'models/' + identity + '.json', base + 'models/block/' + identity + '.json', base + 'models/item/' + identity + '.json'])
    const directItems = new Set<string>(category === 'blockstates' ? [] : [base + 'items/' + identity + '.json'])
    const directStates = new Set<string>([category === 'blockstates' ? input : base + 'blockstates/' + identity + '.json'])
    const strictModels = new Set<string>()
    if (category === 'models') { directModels.add(input); strictModels.add(input) }
    const itemDefinitions = new Map<string, ItemPreviewDefinition | undefined>()
    const loadItem = async (itemPath: string): Promise<ItemPreviewDefinition | undefined> => {
      if (itemDefinitions.has(itemPath)) return itemDefinitions.get(itemPath)
      let item: ItemPreviewDefinition | undefined
      try {
        const definition = await this.json(itemPath, context)
        if (definition) item = this.itemDefinition(definition, itemPath, context)
      } catch (error) {
        this.discoveryError(error, directItems.has(itemPath))
        item = { root: { kind: 'empty' }, references: new Set(), texturePaths: new Set(), error: error as ModelPreviewAssetsError }
      }
      itemDefinitions.set(itemPath, item)
      if (item?.error && directItems.has(itemPath)) throw item.error
      return item
    }
    for (const itemPath of directItems) {
      for (const modelPath of (await loadItem(itemPath))?.references ?? []) {
        directModels.add(modelPath)
        if (category === 'items') strictModels.add(modelPath)
      }
    }
    const nearbyStates = new Set<string>(), nearbyModels = new Set<string>()
    if (category === 'textures' && segments[0] === 'block') {
      let stem = identity
      while (stem.slice(stem.lastIndexOf('/') + 1).includes('_')) {
        stem = stem.slice(0, stem.lastIndexOf('_'))
        const statePath = base + 'blockstates/' + stem + '.json'
        let state: Blockstate | undefined
        try { state = await this.blockstate(statePath, context) }
        catch (error) { this.discoveryError(error, false); continue }
        if (!state) continue
        nearbyStates.add(statePath)
        for (const apply of [...state.variants.map(variant => variant.apply), ...state.multipart.map(part => part.apply)].flat()) nearbyModels.add(apply.modelPath)
      }
    }
    const paths = category === 'blockstates' ? [input] : unique([
      ...(options.discovery === 'direct' ? [] : await this.listAssets('', undefined, DISCOVERY_CATEGORIES)),
      ...directModels, ...directItems, ...directStates, ...nearbyStates
    ])
    // 引用索引仅保守筛选关联，继承覆盖和实际面纹理仍由 resolve 验证
    const related = new Set([...directModels, ...nearbyModels])
    const children = new Map<string, string[]>()
    if (options.discovery !== 'direct' && category !== 'blockstates') {
      for (const modelPath of paths) {
        if (modelPath.split('/')[2] !== 'models') continue
        try {
          const raw = await this.json(modelPath, context)
          if (!raw) continue
          const legacyId = /^assets\/minecraft\/models\/item\/([^/]+)\.json$/.exec(modelPath)?.[1]
          const special = legacyId ? legacySpecialModel(legacyId) : undefined
          if (category === 'textures' && special && specialModelTexturePaths(special).includes(input)) related.add(modelPath)
          if (typeof raw.parent === 'string') {
            const parent = reference(raw.parent, 'models')
            const descendants = children.get(parent) ?? []
            descendants.push(modelPath)
            children.set(parent, descendants)
          }
          if (category === 'textures' && object(raw.textures) && Object.values(raw.textures).some(value => {
            const sprite = textureSprite(value)
            return sprite !== undefined && !sprite.startsWith('#') && reference(sprite, 'textures') === input
          })) related.add(modelPath)
        } catch (error) { this.discoveryError(error, strictModels.has(modelPath)) }
      }
      const pending = [...related]
      while (pending.length) {
        this.step(context)
        for (const child of children.get(pending.pop()!) ?? []) {
          if (related.has(child)) continue
          related.add(child)
          pending.push(child)
        }
      }
    }
    const missingRelevant = new Set<string>()
    const matching = new Map<string, ModelPreviewResolvedModel>()
    const candidates: ModelPreviewCandidate[] = []
    const add = (candidate: ModelPreviewCandidate): void => {
      if (candidates.length >= this.limits.maxCandidates) fail('RESOLUTION_LIMIT', uiText("core.modelPreviewAssets.candidaturesExceedMaxcandidatesPleaseNarrowDownOr"), input)
      candidates.push(candidate)
    }
    for (const modelPath of related) {
      let model: ModelPreviewResolvedModel | undefined
      try { model = await this.resolve(modelPath, context) }
      catch (error) { this.discoveryError(error, strictModels.has(modelPath)); continue }
      if (!model) continue
      const matches = category === 'textures' ? model.texturePaths.includes(input) || directModels.has(modelPath) : directModels.has(modelPath) || model.parents.some(parent => directModels.has(parent))
      if (!model.available) {
        if (model.empty && category === 'models' && segments[0] === 'item' && modelPath === input) matching.set(modelPath, model)
        const declared = category === 'textures' && Object.values(model.textures).includes(resourceId(input))
        if (matches || declared) for (const missing of model.missingPaths) missingRelevant.add(missing)
        continue
      }
      if (!matches) continue
      matching.set(modelPath, model)
      if ((category !== 'textures' || modelPath.split('/')[3] !== 'item') && !model.legacySpecial) {
        add({ kind: 'model', id: model.id, path: model.path, properties: {}, models: [model.id], texturePaths: model.texturePaths })
      }
    }
    for (const itemPath of paths) {
      if (itemPath.split('/')[2] !== 'items') continue
      const item = await loadItem(itemPath)
      if (!item || (!directItems.has(itemPath) && !item.texturePaths.has(input) && ![...item.references].some(modelPath => matching.has(modelPath) || directModels.has(modelPath)))) continue
      if (item.error) throw item.error
      const resolved = await this.resolveItem(item.root, context, category === 'items' && itemPath === input)
      if (!resolved.available) {
        for (const missing of resolved.missingPaths) missingRelevant.add(missing)
        if (category === 'items' && itemPath === input) this.missingAsset(input, resolved.missingPaths, uiText("core.modelPreviewAssets.theDefinitionOfTheItemLacksAvailable"))
        continue
      }
      add({ kind: 'item', id: resourceId(itemPath), path: itemPath, properties: {}, models: unique(resolved.models.map(model => model.id)), texturePaths: unique([...item.texturePaths, ...resolved.models.flatMap(model => model.texturePaths)]), ...(resolved.empty ? { empty: true } : {}) })
    }
    if (category === 'textures' || category === 'models' && (segments[0] === 'item' || options.discovery !== 'direct')) {
      for (const [modelPath, model] of matching) {
        const parts = modelPath.split('/')
        if (parts[3] !== 'item' || model.legacySpecial && category === 'textures' && !model.texturePaths.includes(input)) continue
        const itemPath = 'assets/' + parts[1] + '/items/' + parts.slice(4).join('/')
        const definition = await loadItem(itemPath)
        if (definition) {
          if (definition.error) throw definition.error
          continue
        }
        add({ kind: 'item', id: parts[1] + ':' + parts.slice(4).join('/').replace(/\.json$/, ''), path: modelPath, properties: {}, models: [model.id], texturePaths: model.texturePaths, ...(model.empty ? { empty: true } : {}) })
      }
    }
    const actualTextureModels = new Set([...matching].filter(([, model]) => model.texturePaths.includes(input)).map(([modelPath]) => modelPath))
    for (const statePath of paths) {
      if (statePath.split('/')[2] !== 'blockstates') continue
      try {
        const state = await this.blockstate(statePath, context)
        if (!state) continue
        const applies = [...state.variants.map(variant => variant.apply), ...state.multipart.map(part => part.apply)].flat()
        const direct = directStates.has(statePath)
        const relevantModels = nearbyStates.has(statePath) ? actualTextureModels : new Set(matching.keys())
        if (!direct && !applies.some(apply => relevantModels.has(apply.modelPath))) continue
        for (const properties of this.combinations(state, context)) {
          const instances = await this.instances(state, properties, context, relevantModels)
          if (!instances || (!direct && !instances.some(instance => relevantModels.has(instance.modelPath)))) continue
          const selected = await Promise.all(instances.map(instance => this.resolve(instance.modelPath, context)))
          add({
            kind: 'block', id: resourceId(statePath), path: statePath, properties,
            models: unique(instances.map(instance => instance.model)),
            texturePaths: unique(selected.flatMap(model => model?.texturePaths ?? []))
          })
          break
        }
      } catch (error) { this.discoveryError(error, category === 'blockstates' && statePath === input) }
    }
    if (!candidates.length) {
      if (category === 'blockstates') this.missingAsset(input, this.contextMissing(context), uiText("core.modelPreviewAssets.selectedBlockstateWithoutFullPreviewStatus"))
      if (missingRelevant.size && (options.discovery !== 'direct' || category !== 'textures')) this.missingAsset(input, missingRelevant, uiText("core.modelPreviewAssets.theAssociatedModelLacksResourcesPleaseSupplement"))
    }
    return candidates.sort((left, right) => compare(left.kind, right.kind) || compare(left.id, right.id))
  }

  private itemDefinition(definition: JsonObject, itemPath: string, context: Context): ItemPreviewDefinition {
    const references = new Set<string>(), texturePaths = new Set<string>()
    let error: ModelPreviewAssetsError | undefined
    const visit = (value: unknown): ItemPreviewNode => {
      this.step(context)
      try {
        if (!object(value) || typeof value.type !== 'string') fail('INVALID_MODEL', uiText("core.modelPreviewAssets.defineItemNodeMustContainType"), itemPath)
        const type = value.type.startsWith('minecraft:') ? value.type.slice('minecraft:'.length) : value.type
        if (type === 'empty') return { kind: 'empty' }
        if (type === 'bundle/selected_item') return { kind: 'dynamic' }
        if (type === 'model' || type === 'special') {
          const id = type === 'special' ? value.base : value.model
          if (typeof id !== 'string') fail('INVALID_MODEL', type === 'special' ? uiText("core.modelPreviewAssets.theDefinitionOfSpecialItemsMustInclude") : uiText("core.modelPreviewAssets.theDefinitionOfTheItemMustContain"), itemPath)
          if (type === 'special' && (!object(value.model) || typeof value.model.type !== 'string' || !value.model.type)) fail('INVALID_MODEL', uiText("core.modelPreviewAssets.specialItemsDefinitionMustContainRendererType"), itemPath)
          const modelPath = reference(id, 'models')
          if (type === 'special') for (const path of specialModelTexturePaths(value.model as JsonObject)) texturePaths.add(path)
          references.add(modelPath)
          return { kind: type, modelPath }
        }
        if (type === 'condition') return { kind: 'any', children: [visit(value.on_true), visit(value.on_false)] }
        if (type === 'composite') {
          if (!Array.isArray(value.models)) fail('INVALID_MODEL', uiText("core.modelPreviewAssets.theGroupOfModelsMustBeAssembled"), itemPath)
          return { kind: 'all', children: value.models.map(visit) }
        }
        if (type === 'select' || type === 'range_dispatch') {
          const entries = type === 'select' ? value.cases : value.entries
          if (!Array.isArray(entries)) fail('INVALID_MODEL', type + uiText("core.modelPreviewAssets.theBranchesMustBeInGroups"), itemPath)
          const children = entries.map(entry => visit(object(entry) ? entry.model : undefined))
          children.push(value.fallback === undefined ? { kind: 'empty' } : visit(value.fallback))
          return { kind: 'any', children }
        }
        return fail('INVALID_MODEL', uiText("core.modelPreviewAssets.typeOfObjectDefinitionNotSupported", value.type), itemPath)
      } catch (cause) {
        if (!(cause instanceof ModelPreviewAssetsError) || !['INVALID_MODEL', 'INVALID_PATH'].includes(cause.code)) throw cause
        error ??= cause
        return { kind: 'empty' }
      }
    }
    const root = visit(definition.model)
    return { root, references, texturePaths, error }
  }

  private async resolveItem(node: ItemPreviewNode, context: Context, strict: boolean): Promise<ItemPreviewResolution> {
    this.step(context)
    // 动态内容由渲染库根据物品 data 解析
    if (node.kind === 'empty' || node.kind === 'dynamic') return { available: true, empty: node.kind === 'empty', models: [], missingPaths: [] }
    if ('modelPath' in node) {
      try {
        const model = await this.resolve(node.modelPath, context)
        // 特殊几何由渲染库处理，base 只要求依赖完整
        if (model && (node.kind === 'special' ? !model.missingPaths.length : model.available || model.empty)) return { available: true, empty: node.kind === 'model' && model.empty === true, models: [model], missingPaths: [] }
        return { available: false, empty: false, models: [], missingPaths: model?.missingPaths ?? [node.modelPath] }
      } catch (error) {
        this.discoveryError(error, strict)
        return { available: false, empty: false, models: [], missingPaths: [] }
      }
    }
    const children: ItemPreviewResolution[] = []
    for (const child of node.children) children.push(await this.resolveItem(child, context, strict))
    return {
      available: node.kind === 'all' ? children.every(child => child.available) : children.some(child => child.available),
      empty: children.every(child => child.empty),
      models: children.filter(child => child.available).flatMap(child => child.models),
      missingPaths: unique(children.flatMap(child => child.missingPaths))
    }
  }

  private discoveryError(error: unknown, strict: boolean): void {
    if (strict || !(error instanceof ModelPreviewAssetsError) || !['INVALID_JSON', 'INVALID_MODEL', 'INVALID_BLOCKSTATE', 'INVALID_PATH', 'MODEL_CYCLE', 'TEXTURE_CYCLE'].includes(error.code)) throw error
  }

  private contextMissing(context: Context): string[] {
    return unique([...context.models].flatMap(([modelPath, model]) => model ? model.missingPaths : [modelPath]))
  }

  private missingAsset(requestPath: string, missing: Iterable<string>, message: string): never {
    const missingPaths = unique(missing)
    const detail = missingPaths.length ? uiText("core.modelPreviewAssets.missing", missingPaths.slice(0, 16).join(', '), missingPaths.length > 16 ? uiText("core.modelPreviewAssets.totalDetailsInMissingpaths", missingPaths.length) : '') : ''
    throw new ModelPreviewAssetsError('MISSING_ASSET', message + detail, requestPath, { missingPaths })
  }

  private layers(layer?: number): readonly string[] {
    if (layer === undefined) return this.roots
    if (!Number.isInteger(layer) || layer < 0 || layer >= this.roots.length) fail('INVALID_LAYER', uiText("core.modelPreviewAssets.playerMustBeAValidRootsIndex"))
    return [this.roots[layer]]
  }

  // 内容与存在性缓存仅限本次请求，资源层修改无需额外失效通知
  private context(): Context {
    return { steps: 0, json: new Map(), merged: new Map(), models: new Map(), existing: new Map() }
  }

  private step(context: Context, count = 1): void {
    context.steps += count
    if (context.steps > this.limits.maxResolutionSteps) fail('RESOLUTION_LIMIT', uiText("core.modelPreviewAssets.resourceResolutionExceedsMaxresolumentstepsPleaseNarrowDown"))
  }

  private checkFileSize(requestPath: string, size: number): void {
    const limit = requestPath.endsWith('.png') ? this.limits.maxFileBytes : Math.min(this.limits.maxFileBytes, this.limits.maxJsonBytes)
    if (!Number.isSafeInteger(size) || size < 0 || size > limit) fail('FILE_LIMIT', uiText("core.modelPreviewAssets.resourcesInExcessOfMaxfilebytesOrMaxjsonbytes"), requestPath)
  }

  private async inspect(absolute: string, file: boolean): Promise<FileStat | undefined> {
    const parsed = path.parse(absolute)
    let current = parsed.root
    const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
    try {
      for (const [index, segment] of segments.entries()) {
        current = path.join(current, segment)
        const stat = await fs.lstat(current)
        if (stat.isSymbolicLink()) fail('SYMLINK', uiText("core.modelPreviewAssets.symbolicLinkOrDirectoryConnectionIsNot"), current)
        const last = index === segments.length - 1
        if (!last && !stat.isDirectory()) fail('INVALID_FILE', uiText("core.modelPreviewAssets.resourcePathContainsNonDirectoryNodes"), current)
        if (last) {
          if (file && !stat.isFile()) fail('INVALID_FILE', uiText("core.modelPreviewAssets.resourceIsNotANormalFile"), current)
          return stat
        }
      }
      return await fs.lstat(current)
    } catch (error) {
      if (error instanceof ModelPreviewAssetsError) throw error
      if (MISSING_CODES.has(errorCode(error) ?? '')) return undefined
      throw new ModelPreviewAssetsError('IO_ERROR', uiText("core.modelPreviewAssets.cannotCheckResourcePath"), absolute, { cause: error })
    }
  }

  private async locate(requestPath: string, layer?: number): Promise<Located | undefined> {
    for (const root of this.layers(layer)) {
      const absolute = path.join(root, ...requestPath.split('/'))
      const stat = await this.inspect(absolute, true)
      if (stat) {
        this.checkFileSize(requestPath, stat.size)
        return { absolute, stat }
      }
    }
    return undefined
  }

  private async exists(requestPath: string, context: Context): Promise<boolean> {
    this.step(context)
    if (!context.existing.has(requestPath)) context.existing.set(requestPath, Boolean(await this.locate(requestPath)))
    return context.existing.get(requestPath)!
  }

  private async inputPath(input: string): Promise<string> {
    if (typeof input !== 'string') fail('INVALID_PATH', uiText("core.modelPreviewAssets.candidateInputMustBeTheFilePath"))
    if (!path.isAbsolute(input)) return assetPath(input)
    if (input.includes('\0') || input.split(/[\\/]/).includes('..')) fail('INVALID_PATH', uiText("core.modelPreviewAssets.theCandidatePathDoesNotAllowThe"), input)
    const absolute = path.resolve(input)
    for (const root of this.roots) {
      if (!isInside(root, absolute)) continue
      const relative = assetPath(path.relative(root, absolute).split(path.sep).join('/'))
      await this.inspect(absolute, true)
      return relative
    }
    return fail('INVALID_PATH', uiText("core.modelPreviewAssets.candidateFileIsNotInTheResource"), input)
  }

  private parseJson(bytes: Uint8Array, requestPath: string): JsonObject {
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')) as unknown
    } catch (error) {
      throw new ModelPreviewAssetsError('INVALID_JSON', uiText("core.modelPreviewAssets.resourceIsNotAValidUtfJson"), requestPath, { cause: error })
    }
    if (!object(value)) fail('INVALID_JSON', uiText("core.modelPreviewAssets.resourceJsonTopLevelMustBeAn"), requestPath)
    const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }]
    let nodes = 0
    while (pending.length) {
      const item = pending.pop()!
      if (++nodes > this.limits.maxJsonNodes) fail('RESOLUTION_LIMIT', uiText("core.modelPreviewAssets.jsonNodeExceedingMaxjsonNodes"), requestPath)
      if (item.depth > this.limits.maxJsonDepth) fail('DEPTH_LIMIT', uiText("core.modelPreviewAssets.jsonEmbeddedMasjsondepth"), requestPath)
      if (item.value !== null && typeof item.value === 'object') {
        for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 })
      }
    }
    return value
  }

  private async json(requestPath: string, context: Context, layer?: number): Promise<JsonObject | undefined> {
    this.step(context)
    if (context.json.has(requestPath)) return context.json.get(requestPath)
    const bytes = await this.read(requestPath, layer)
    if (!bytes) { context.json.set(requestPath, undefined); return undefined }
    const value = this.parseJson(bytes, requestPath)
    context.json.set(requestPath, value)
    return value
  }

  private async merge(modelPath: string, context: Context, ancestors: string[] = []): Promise<MergedModel | undefined> {
    this.step(context)
    if (ancestors.includes(modelPath)) fail('MODEL_CYCLE', uiText("core.modelPreviewAssets.modelParentChainCycling"), modelPath)
    if (ancestors.length >= this.limits.maxModelDepth) fail('DEPTH_LIMIT', uiText("core.modelPreviewAssets.modelParentChainExceedingMaxmodeldepth"), modelPath)
    if (context.merged.has(modelPath)) {
      const cached = context.merged.get(modelPath)
      if (cached && cached.depth + ancestors.length > this.limits.maxModelDepth) fail('DEPTH_LIMIT', uiText("core.modelPreviewAssets.modelParentChainExceedingMaxmodeldepth"), modelPath)
      return cached
    }
    const raw = await this.json(modelPath, context)
    if (!raw) { context.merged.set(modelPath, undefined); return undefined }
    if (raw.textures !== undefined && !object(raw.textures)) fail('INVALID_MODEL', uiText("core.modelPreviewAssets.modelTexturesMustBeObjects"), modelPath)
    const textures = raw.textures ?? {}
    for (const value of Object.values(textures)) if (textureSprite(value) === undefined) fail('INVALID_MODEL', uiText("core.modelPreviewAssets.modelTextureReferencesMustBeAString"), modelPath)
    let parent: MergedModel | undefined
    let parentPath: string | undefined
    let builtin: string | undefined
    if (raw.parent !== undefined) {
      if (typeof raw.parent !== 'string') fail('INVALID_MODEL', uiText("core.advanced.modelInheritance.theModelParentMustBeAResource"), modelPath)
      parentPath = reference(raw.parent, 'models')
      if (parentPath.startsWith('assets/minecraft/models/builtin/')) builtin = resourceId(parentPath)
      else parent = await this.merge(parentPath, context, [...ancestors, modelPath])
    }
    const model: JsonObject = { ...parent?.model, ...raw, textures: { ...(parent?.model.textures as JsonObject | undefined), ...(textures as JsonObject) } }
    delete model.parent
    const merged: MergedModel = {
      model,
      parents: parentPath ? [parentPath, ...(parent?.parents ?? [])] : [],
      missing: parentPath && !parent && !builtin ? [parentPath] : [...(parent?.missing ?? [])],
      builtin: builtin ?? parent?.builtin,
      depth: 1 + (parent?.depth ?? 0)
    }
    context.merged.set(modelPath, merged)
    return merged
  }

  private async resolve(modelPath: string, context: Context): Promise<ModelPreviewResolvedModel | undefined> {
    this.step(context)
    if (context.models.has(modelPath)) return context.models.get(modelPath)
    const merged = await this.merge(modelPath, context)
    if (!merged) { context.models.set(modelPath, undefined); return undefined }
    const variables = Object.fromEntries(Object.entries(merged.model.textures as JsonObject).map(([key, value]) => [key, textureSprite(value) ?? fail('INVALID_MODEL', uiText("core.modelPreviewAssets.modelTextureReferencesMustContainSprite"), modelPath)]))
    const missing = new Set(merged.missing)
    const texture = (value: string, seen: Set<string>): string | undefined => {
      this.step(context)
      if (!value.startsWith('#')) return reference(value, 'textures')
      const key = value.slice(1)
      if (!key || !SEGMENT.test(key)) fail('INVALID_MODEL', uiText("core.modelPreviewAssets.textureVariableNameInvalid"), modelPath)
      if (seen.has(key)) fail('TEXTURE_CYCLE', uiText("core.modelPreviewAssets.modelTextureVariableExistsInCirculation"), modelPath)
      if (seen.size >= this.limits.maxModelDepth) fail('DEPTH_LIMIT', uiText("core.modelPreviewAssets.textureVariableReferenceMoreThanMaxmodeldepth"), modelPath)
      if (!own(variables, key)) { missing.add(`#${key}`); return undefined }
      const result = texture(variables[key], new Set([...seen, key]))
      return result
    }
    const used = new Set<string>()
    const addTexture = (value: unknown): void => {
      if (typeof value !== 'string') fail('INVALID_MODEL', uiText("core.modelPreviewAssets.theModelTextureMustBeAString"), modelPath)
      const location = texture(value, new Set())
      if (location) used.add(location)
    }
    const elements = merged.model.elements
    if (elements !== undefined) {
      if (!Array.isArray(elements)) fail('INVALID_MODEL', uiText("core.advanced.colormap.modelsMustBeArrays"), modelPath)
      for (const element of elements) {
        this.step(context)
        if (!object(element) || (element.faces !== undefined && !object(element.faces))) fail('INVALID_MODEL', uiText("core.modelPreviewAssets.invalidModelElementsOrFaces"), modelPath)
        for (const face of Object.values(element.faces ?? {})) {
          if (!object(face)) fail('INVALID_MODEL', uiText("core.modelPreviewAssets.theModelMustBeAnObject"), modelPath)
          const slot = face.texture
          addTexture(typeof slot === 'string' && !slot.startsWith('#') ? '#' + slot : slot)
        }
      }
    } else if (merged.builtin === 'minecraft:builtin/generated') {
      for (const [key, value] of Object.entries(variables)) if (/^layer\d+$/.test(key)) addTexture(value)
    }
    const legacyId = /^assets\/minecraft\/models\/item\/([^/]+)\.json$/.exec(modelPath)?.[1]
    const special = merged.builtin === 'minecraft:builtin/entity' && legacyId ? legacySpecialModel(legacyId) : undefined
    if (special) for (const path of specialModelTexturePaths(special)) used.add(path)
    const textures = Object.fromEntries(Object.entries(variables).map(([key, value]) => [key, value.startsWith('#') ? value : resourceId(reference(value, 'textures'))]))
    if (!special) for (const usedPath of used) if (!await this.exists(usedPath, context)) missing.add(usedPath)
    const result: ModelPreviewResolvedModel = {
      id: resourceId(modelPath), path: modelPath, model: merged.model, parents: merged.parents,
      textures, texturePaths: unique(used), missingPaths: unique(missing), available: (used.size > 0 || Boolean(special)) && missing.size === 0,
      ...(special ? { legacySpecial: true } : {}),
      ...(!merged.builtin && missing.size === 0 && (elements === undefined || Array.isArray(elements) && elements.length === 0) ? { empty: true } : {})
    }
    context.models.set(modelPath, result)
    return result
  }

  private async blockstate(statePath: string, context: Context): Promise<Blockstate | undefined> {
    const raw = await this.json(statePath, context)
    if (!raw) return undefined
    const values = new Map<string, Set<string>>()
    const addValue = (name: string, value: string): void => {
      if (!PROPERTY.test(name) || !VALUE.test(value) || value === '.' || value === '..') fail('INVALID_BLOCKSTATE', uiText("core.modelPreviewAssets.blockstateAttributeOrValueIsInvalid"), statePath)
      if (!values.has(name)) values.set(name, new Set())
      values.get(name)!.add(value)
    }
    const apply = (value: unknown): Apply[] => {
      const variants = Array.isArray(value) ? value : [value]
      if (!variants.length) fail('INVALID_BLOCKSTATE', uiText("core.modelPreviewAssets.blockstateCandidateCannotBeEmpty"), statePath)
      return variants.map(entry => {
        this.step(context)
        if (!object(entry) || typeof entry.model !== 'string') fail('INVALID_BLOCKSTATE', uiText("core.modelPreviewAssets.blockstateModelMustBeAResourceId"), statePath)
        const modelPath = reference(entry.model, 'models')
        for (const axis of ['x', 'y']) if (entry[axis] !== undefined && (!Number.isInteger(entry[axis]) || (entry[axis] as number) < 0 || (entry[axis] as number) > 270 || (entry[axis] as number) % 90 !== 0)) fail('INVALID_BLOCKSTATE', uiText("core.modelPreviewAssets.theModelMustRotateWithALegitimate"), statePath)
        if (entry.uvlock !== undefined && typeof entry.uvlock !== 'boolean') fail('INVALID_BLOCKSTATE', uiText("core.modelPreviewAssets.uvlockMustBeABooleanValue"), statePath)
        if (entry.weight !== undefined && (!Number.isSafeInteger(entry.weight) || (entry.weight as number) <= 0)) fail('INVALID_BLOCKSTATE', uiText("core.modelPreviewAssets.weightMustBePositive"), statePath)
        return { model: resourceId(modelPath), modelPath, x: (entry.x as number | undefined) ?? 0, y: (entry.y as number | undefined) ?? 0, uvlock: (entry.uvlock as boolean | undefined) ?? false, weight: (entry.weight as number | undefined) ?? 1 }
      })
    }
    const condition = (value: unknown, depth = 0): Condition => {
      this.step(context)
      if (depth > this.limits.maxJsonDepth) fail('DEPTH_LIMIT', uiText("core.modelPreviewAssets.blockstateConditionExceedingMaxjsondeptth"), statePath)
      if (!object(value)) fail('INVALID_BLOCKSTATE', uiText("core.modelPreviewAssets.multipartWhenMustBeAnObject"), statePath)
      const children: Condition[] = []
      for (const [key, item] of Object.entries(value)) {
        if (key === 'OR' || key === 'AND') {
          if (!Array.isArray(item) || !item.length) fail('INVALID_BLOCKSTATE', uiText("core.modelPreviewAssets.orAndMustBeANonEmpty"), statePath)
          children.push({ kind: key === 'OR' ? 'any' : 'all', children: item.map(child => condition(child, depth + 1)) })
        } else {
          if (typeof item !== 'string' && typeof item !== 'boolean' && !(typeof item === 'number' && Number.isFinite(item))) fail('INVALID_BLOCKSTATE', uiText("core.modelPreviewAssets.multipartPropertiesInvalid"), statePath)
          const choices = String(item).split('|')
          for (const choice of choices) addValue(key, choice)
          children.push({ kind: 'property', name: key, values: unique(choices) })
        }
      }
      return { kind: 'all', children }
    }
    const state: Blockstate = { variants: [], multipart: [], values: {} }
    if (raw.variants !== undefined) {
      if (!object(raw.variants)) fail('INVALID_BLOCKSTATE', uiText("core.modelPreviewAssets.variansMustBeObjects"), statePath)
      for (const [key, value] of Object.entries(raw.variants)) {
        this.step(context)
        const properties = new Map<string, string>()
        if (key !== '') {
          for (const pair of key.split(',')) {
            const parts = pair.split('=')
            if (parts.length !== 2 || properties.has(parts[0])) fail('INVALID_BLOCKSTATE', uiText("core.modelPreviewAssets.invalidAttributeExpression"), statePath)
            addValue(parts[0], parts[1])
            properties.set(parts[0], parts[1])
          }
        }
        state.variants.push({ properties: Object.fromEntries(properties), apply: apply(value) })
      }
    }
    if (raw.multipart !== undefined) {
      if (!Array.isArray(raw.multipart)) fail('INVALID_BLOCKSTATE', uiText("core.modelPreviewAssets.multipartMustBeAnArray"), statePath)
      for (const part of raw.multipart) {
        this.step(context)
        if (!object(part)) fail('INVALID_BLOCKSTATE', uiText("core.modelPreviewAssets.multipartMustBeAnObject"), statePath)
        state.multipart.push({ condition: part.when === undefined ? { kind: 'all', children: [] } : condition(part.when), apply: apply(part.apply) })
      }
    }
    if (!state.variants.length && !state.multipart.length) fail('INVALID_BLOCKSTATE', uiText("core.modelPreviewAssets.blockstateMustContainVariansOrMultipart"), statePath)
    state.values = Object.fromEntries([...values].sort(([a], [b]) => compare(a, b)).map(([key, choices]) => [key, unique(choices)]))
    return state
  }

  private matches(condition: Condition, properties: Record<string, string>, context: Context): boolean {
    this.step(context)
    if (condition.kind === 'property') return own(properties, condition.name) && condition.values.includes(properties[condition.name])
    return condition.kind === 'all' ? condition.children.every(child => this.matches(child, properties, context)) : condition.children.some(child => this.matches(child, properties, context))
  }

  private paired(state: Blockstate): boolean {
    return own(state.values, 'half') && state.values.half.length === 2 && state.values.half.includes('lower') && state.values.half.includes('upper')
  }

  private async instances(state: Blockstate, requested: Readonly<Record<string, string>>, context: Context, preferred?: ReadonlySet<string>): Promise<ModelPreviewInstance[] | undefined> {
    if (!object(requested)) fail('INVALID_BLOCKSTATE', uiText("core.modelPreviewAssets.statusSelectionMustBeAnAttributeObject"))
    for (const [key, value] of Object.entries(requested)) {
      if (!own(state.values, key) || !state.values[key].includes(value)) fail('INVALID_BLOCKSTATE', uiText("core.modelPreviewAssets.existingBlockstateAttributeOrValue", key))
    }
    const defaults = Object.fromEntries(Object.entries(state.values).map(([key, values]) => [key, values[0]]))
    const properties: Record<string, string> = { ...defaults, ...requested }
    const paired = this.paired(state) && !own(requested, 'half')
    const selections = paired ? [{ ...properties, half: 'lower' }, { ...properties, half: 'upper' }] : [properties]
    const result: ModelPreviewInstance[] = []
    for (const selected of selections) {
      const applies = state.variants.filter(variant => {
        this.step(context)
        return Object.entries(variant.properties).every(([key, value]) => own(selected, key) && selected[key] === value)
      }).map(variant => variant.apply)
      for (const part of state.multipart) if (this.matches(part.condition, selected, context)) applies.push(part.apply)
      if (!applies.length) return undefined
      for (const alternatives of applies) {
        this.step(context)
        let chosen: Apply | undefined
        const ordered = preferred ? [...alternatives.filter(value => preferred.has(value.modelPath)), ...alternatives.filter(value => !preferred.has(value.modelPath))] : alternatives
        for (const alternative of ordered) {
          if ((await this.resolve(alternative.modelPath, context))?.available) { chosen = alternative; break }
        }
        if (!chosen) return undefined
        if (result.length >= this.limits.maxInstances) fail('RESOLUTION_LIMIT', uiText("core.modelPreviewAssets.renderInstanceMoreThanMaxinstances"))
        result.push({ ...chosen, offset: paired && selected.half === 'upper' ? [0, 1, 0] : [0, 0, 0], properties: { ...selected } })
      }
    }
    return result
  }

  private *combinations(state: Blockstate, context: Context): Generator<Record<string, string>> {
    const properties = Object.entries(state.values).filter(([key]) => key !== 'half' || !this.paired(state))
    let count = 1
    for (const [, values] of properties) {
      if (count > Math.floor(this.limits.maxStateCombinations / values.length)) fail('RESOLUTION_LIMIT', uiText("core.modelPreviewAssets.stateCombinationExceedingMaxstatecomminationsPleaseNarrowDown"))
      count *= values.length
    }
    for (let index = 0; index < count; index++) {
      this.step(context)
      let remainder = index
      const selected = new Map<string, string>()
      for (const [key, values] of properties) {
        selected.set(key, values[remainder % values.length])
        remainder = Math.floor(remainder / values.length)
      }
      yield Object.fromEntries(selected)
    }
  }
}

function normalizeRoots(roots: string[]): string[] {
  return roots.map(root => {
    if (typeof root !== 'string' || !root.trim() || root.includes('\0')) fail('INVALID_ROOT', uiText("core.modelPreviewAssets.theResourceRootDirectoryMustBeA"))
    return path.resolve(root)
  })
}

