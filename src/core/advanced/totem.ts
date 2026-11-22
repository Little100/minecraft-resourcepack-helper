import { uiText } from '../../i18n/messages'
import { readFileSync, statSync } from 'node:fs'
import { inflateRawSync, inflateSync } from 'node:zlib'
import { PNG } from 'pngjs'

export type TotemModel = 'steve' | 'alex'
export type TotemPose = 'sitting' | 'standing'
export interface TotemGeneratedFile { path: string; content: Uint8Array | string }
export interface TotemTemplate {
  model: TotemModel
  pose: 'sitting'
  modelJson: Record<string, unknown>
  warnings: string[]
}
export interface TotemGenerateOptions {
  skinPng: Uint8Array
  model: TotemModel
  pose: TotemPose
  templateModel: unknown
  namespace?: string
  modelName?: string
  textureName?: string
  replaceVanilla?: boolean
}
export interface TotemGenerationResult {
  files: TotemGeneratedFile[]
  warnings: string[]
  model: TotemModel
  pose: TotemPose
  poseSource: 'sample' | 'derived'
  modelPath: string
  texturePath: string
}
export interface MojangSkinFetchOptions {
  timeoutMs?: number
  maxResponseBytes?: number
  signal?: AbortSignal
  fetchImpl?: typeof globalThis.fetch
}
export interface MojangSkinResult {
  playerName: string
  uuid: string
  model: TotemModel
  skinPng: Uint8Array
  skinUrl: string
}

type FaceName = 'north' | 'south' | 'east' | 'west' | 'up' | 'down'
interface ModelFace { uv: number[]; texture: string; rotation?: number; [key: string]: unknown }
interface ModelElement {
  from: number[]
  to: number[]
  faces: Partial<Record<FaceName, ModelFace>>
  rotation?: { angle: number; axis: string; origin: number[]; [key: string]: unknown }
  [key: string]: unknown
}
interface DollModel extends Record<string, unknown> {
  elements: ModelElement[]
  textures: Record<string, string>
}
const MODEL_ENTRY = 'assets/minecraft/models/item/totem_of_undying.json'
const MAX_ARCHIVE = 8 * 1024 * 1024
const MAX_MODEL = 512 * 1024
const MAX_SKIN = 2 * 1024 * 1024
const FACE_NAMES: FaceName[] = ['north', 'south', 'east', 'west', 'up', 'down']
const LICENSE_WARNING = uiText("core.advanced.totem.theGeometrySourceOfTheTemplateIs")

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function modelKind(value: unknown): asserts value is TotemModel {
  if (value !== 'steve' && value !== 'alex') throw new Error(uiText("core.advanced.totem.modelOnlySupportsSteveOrlex"))
}

function vector(value: unknown, size: number, min: number, max: number): value is number[] {
  return Array.isArray(value) && value.length === size && value.every(n => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max)
}

function validateModel(input: unknown): DollModel {
  if (!record(input)) throw new Error(uiText("core.advanced.totem.theTemplateModelMustBeAJson"))
  const seen = new Set<object>()
  let nodes = 0
  const clone = (value: unknown, depth: number): unknown => {
    if (depth > 32 || ++nodes > 50000) throw new Error(uiText("core.advanced.totem.stampModelTooDeepOrTooNodal"))
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(uiText("core.advanced.totem.stampModelContainsNonLimitedNumbers"))
    if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
      if (typeof value === 'string' && value.length > 8192) throw new Error(uiText("core.advanced.totem.stampModelStringTooLong"))
      return value
    }
    if (!value || typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null && !Array.isArray(value))) throw new Error(uiText("core.advanced.totem.stampModelAllowsOnlyNormalJsonValues"))
    if (seen.has(value)) throw new Error(uiText("core.advanced.totem.stampModelIncludesLoopReferences"))
    seen.add(value)
    const output: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {}
    for (const [key, property] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (Array.isArray(value) && key === 'length') continue
      if (!property.enumerable) continue
      if (['__proto__', 'prototype', 'constructor'].includes(key) || property.get || property.set) throw new Error(uiText("core.advanced.totem.stampModelContainsUnsafeProperties"))
      ;(output as Record<string, unknown>)[key] = clone(property.value, depth + 1)
    }
    seen.delete(value)
    return output
  }
  const model = clone(input, 0) as DollModel
  if (Buffer.byteLength(JSON.stringify(model), 'utf8') > MAX_MODEL) throw new Error(uiText("core.advanced.totem.stampModelInExcessOfKib"))
  if (!Array.isArray(model.elements) || !model.elements.length || model.elements.length > 128 || !record(model.textures)) {
    throw new Error(uiText("core.advanced.totem.theTemplateModelRequiresValidTexturesAnd"))
  }
  if (model.parent !== undefined && model.parent !== null) throw new Error(uiText("core.advanced.totem.totemTemplatesMustBeSelfContainedStereo"))
  for (const element of model.elements) {
    if (!record(element) || !vector(element.from, 3, -16, 32) || !vector(element.to, 3, -16, 32)
      || element.from.some((v, i) => v > element.to[i]) || !record(element.faces)) throw new Error(uiText("core.advanced.totem.theWidgetCoordinatesOrFacesOfThe"))
    if (element.rotation && (!vector(element.rotation.origin, 3, -16, 32) || !['x', 'y', 'z'].includes(element.rotation.axis)
      || ![-45, -22.5, 0, 22.5, 45].includes(element.rotation.angle))) throw new Error(uiText("core.advanced.totem.stampModelRotationDataInvalid"))
    for (const [name, face] of Object.entries(element.faces)) {
      if (!FACE_NAMES.includes(name as FaceName) || !record(face) || !vector(face.uv, 4, 0, 16) || typeof face.texture !== 'string'
        || !/^#[a-zA-Z0-9_.-]+$/.test(face.texture) || ![0, 90, 180, 270].includes(face.rotation ?? 0)) {
        throw new Error(uiText("core.advanced.totem.theFaceOfTheTemplateModelUv"))
      }
      if (!['#missing', '#layer0'].includes(face.texture) && typeof model.textures[face.texture.slice(1)] !== 'string') {
        throw new Error(uiText("core.advanced.totem.theTemplateContainsUndefinedTextureReferences", face.texture))
      }
    }
  }
  return model
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// 只解压固定模型条目，不释放作者贴图或写入ZIP中的路径
function modelFromZip(input: Uint8Array): Buffer {
  if (!(input instanceof Uint8Array) || input.length < 22 || input.length > MAX_ARCHIVE) throw new Error(uiText("core.advanced.totem.theTemplateZipMustBeValidAnd"))
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break }
  }
  if (end < 0) throw new Error(uiText("core.advanced.totem.teamZipLacksAValidCentralDirectory"))
  const count = bytes.readUInt16LE(end + 10)
  const centralSize = bytes.readUInt32LE(end + 12)
  const centralOffset = bytes.readUInt32LE(end + 16)
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || count !== bytes.readUInt16LE(end + 8)
    || count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff
    || centralOffset + centralSize > end) throw new Error(uiText("core.advanced.totem.teamZipDoesNotSupportMultipleVolumes"))
  let offset = centralOffset
  let selected: Buffer | undefined
  for (let index = 0; index < count; index++) {
    if (offset + 46 > centralOffset + centralSize || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error(uiText("core.advanced.totem.teamZipCentralDirectoryCorrupted"))
    const flags = bytes.readUInt16LE(offset + 8)
    const method = bytes.readUInt16LE(offset + 10)
    const checksum = bytes.readUInt32LE(offset + 16)
    const compressed = bytes.readUInt32LE(offset + 20)
    const size = bytes.readUInt32LE(offset + 24)
    const nameSize = bytes.readUInt16LE(offset + 28)
    const extraSize = bytes.readUInt16LE(offset + 30)
    const commentSize = bytes.readUInt16LE(offset + 32)
    const local = bytes.readUInt32LE(offset + 42)
    const next = offset + 46 + nameSize + extraSize + commentSize
    if (next > centralOffset + centralSize) throw new Error(uiText("core.advanced.totem.teamZipEntryNameCrossed"))
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameSize)
    if (name === MODEL_ENTRY) {
      if (selected) throw new Error(uiText("core.advanced.totem.teamZipContainsADuplicateTotemModel"))
      if ((flags & 1) || ![0, 8].includes(method) || size > MAX_MODEL || compressed > MAX_ARCHIVE
        || local + 30 > centralOffset || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error(uiText("core.advanced.totem.stampModelEntriesEncryptedOverlimitedOrCompressed"))
      const localNameSize = bytes.readUInt16LE(local + 26)
      const dataOffset = local + 30 + localNameSize + bytes.readUInt16LE(local + 28)
      if (dataOffset + compressed > centralOffset || bytes.readUInt16LE(local + 8) !== method
        || bytes.readUInt16LE(local + 6) !== flags
        || bytes.toString('utf8', local + 30, local + 30 + localNameSize) !== MODEL_ENTRY) throw new Error(uiText("core.advanced.totem.localZipHeadOfTemplateModelDamaged"))
      try {
        const packed = bytes.subarray(dataOffset, dataOffset + compressed)
        selected = method === 0 ? Buffer.from(packed) : inflateRawSync(packed, { maxOutputLength: MAX_MODEL })
      } catch { throw new Error(uiText("core.advanced.totem.templateModelDecompressionFailureOrActualSize")) }
      if (selected.length !== size || crc32(selected) !== checksum) throw new Error(uiText("core.advanced.totem.stampModelSizeOrCrcValidationFailed"))
    }
    offset = next
  }
  if (!selected) throw new Error(uiText("core.advanced.totem.stampZipMissing", MODEL_ENTRY))
  return selected
}

export function parseTotemTemplate(zipBytes: Uint8Array, model: TotemModel): TotemTemplate {
  modelKind(model)
  let json: unknown
  try { json = JSON.parse(modelFromZip(zipBytes).toString('utf8')) }
  catch (error) { throw new Error(uiText("core.advanced.totem.stampParsingFailed", error instanceof Error ? error.message : String(error))) }
  const modelJson = validateModel(json)
  validateDollKind(modelJson, model)
  return { model, pose: 'sitting', modelJson, warnings: [LICENSE_WARNING] }
}

export function loadTotemTemplate(source: string | Uint8Array, model: TotemModel): TotemTemplate {
  if (typeof source !== 'string') return parseTotemTemplate(source, model)
  if (statSync(source).size > MAX_ARCHIVE) throw new Error(uiText("core.advanced.totem.stampZipCannotExceedMib"))
  return parseTotemTemplate(readFileSync(source), model)
}

function decodeSkin(input: Uint8Array, model: TotemModel): PNG {
  if (!(input instanceof Uint8Array) || input.length < 33 || input.length > MAX_SKIN) throw new Error(uiText("core.advanced.totem.skinPngShallBeValidAndNot"))
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(8) !== 13
    || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error(uiText("core.advanced.totem.skinMustBeValidPng"))
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (width !== 64 || (height !== 32 && height !== 64)) throw new Error(uiText("core.advanced.totem.skinOnlyX64OrLegalOldX32"))
  if (height === 32 && model === 'alex') throw new Error(uiText("core.advanced.totem.oldVersionX32OnlySupportsSteveS"))
  let offset = 8
  let ended = false
  const idat: Buffer[] = []
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if (length > bytes.length - offset - 12) throw new Error(uiText("core.advanced.totem.skinPngBlockCutOff"))
    if (type === 'IHDR' && offset !== 8) throw new Error(uiText("core.advanced.totem.skinPngContainsRepeatIhdr"))
    if (type === 'acTL') throw new Error(uiText("core.advanced.totem.skinCanTBeApng"))
    if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
    if (type === 'IEND') {
      if (length !== 0) throw new Error(uiText("core.advanced.totem.skinnedPngSIendIsInvalid"))
      ended = true
      break
    }
  }
  if (!ended || offset !== bytes.length) throw new Error(uiText("core.advanced.totem.skinPngLacksCompleteIendOrContains"))
  try {
    if (bytes[28] === 1) inflateSync(Buffer.concat(idat), { maxOutputLength: width * height * 8 + height * 7 + 64 })
    return PNG.sync.read(bytes, { checkCRC: true })
  }
  catch (error) { throw new Error(uiText("core.advanced.totem.skinPngDecodedFailed", error instanceof Error ? error.message : String(error))) }
}

export function normalizeTotemSkin(skinPng: Uint8Array, model: TotemModel): Uint8Array {
  modelKind(model)
  const skin = decodeSkin(skinPng, model)
  if (skin.height === 64) return Uint8Array.from(skinPng)
  const image = new PNG({ width: 64, height: 64 })
  image.data = Buffer.alloc(64 * 64 * 4)
  skin.data.copy(image.data)
  const copy = (sx: number, sy: number, dx: number, dy: number, width: number, height: number): void => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const src = ((sy + y) * 64 + sx + width - 1 - x) * 4
        const dst = ((dy + y) * 64 + dx + x) * 4
        skin.data.copy(image.data, dst, src, src + 4)
      }
    }
  }
  for (const [sourceX, targetX] of [[0, 16], [40, 32]]) {
    copy(sourceX + 4, 16, targetX + 4, 48, 4, 4)
    copy(sourceX + 8, 16, targetX + 8, 48, 4, 4)
    copy(sourceX + 8, 20, targetX, 52, 4, 12)
    copy(sourceX + 4, 20, targetX + 4, 52, 4, 12)
    copy(sourceX, 20, targetX + 8, 52, 4, 12)
    copy(sourceX + 12, 20, targetX + 12, 52, 4, 12)
  }
  for (const [x0, y0, x1, y1] of [[0, 0, 32, 16], [0, 16, 64, 32], [16, 48, 48, 64]]) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) image.data[(y * 64 + x) * 4 + 3] = 255
  }
  let opaqueHat = true
  for (let y = 0; y < 32; y++) for (let x = 32; x < 64; x++) if (skin.data[(y * 64 + x) * 4 + 3] < 128) opaqueHat = false
  if (opaqueHat) for (let y = 0; y < 16; y++) for (let x = 32; x < 64; x++) image.data[(y * 64 + x) * 4 + 3] = 0
  return PNG.sync.write(image, { colorType: 6 })
}

type Part = 'head' | 'body' | 'arm' | 'leg' | 'icon'
function partOf(element: ModelElement): Part {
  const size = element.to.map((n, i) => n - element.from[i])
  if (size[2] === 0 && size[0] > 0 && size[1] > 0) return 'icon'
  const uv = element.faces.north?.uv
  if (!uv) throw new Error(uiText("core.advanced.totem.stampsLackIdentifiableNorthFacedUv"))
  if (size.every(n => n >= 7 && n <= 8.2)) return 'head'
  if (size[0] >= 4 && size[0] <= 5.2 && size[1] >= 5.8 && size[2] >= 2.5 && size[2] <= 3.2) return 'body'
  if (size[1] >= 1.8 && size[1] <= 2.3 && size[2] >= 5.8 && size[2] <= 6.3) return uv[0] >= 8 ? 'arm' : 'leg'
  throw new Error(uiText("core.advanced.totem.theTemplateIsNotASupportedBody"))
}

function validateDollKind(model: DollModel, kind: TotemModel): void {
  const parts = model.elements.map(partOf)
  for (const part of ['head', 'body', 'arm', 'leg'] as Part[]) {
    if (parts.filter(p => p === part).length !== (part === 'head' || part === 'body' ? 2 : 4)) throw new Error(uiText("core.advanced.totem.stampboardedPartIncomplete", part))
  }
  for (const element of model.elements.filter(e => partOf(e) === 'arm')) {
    const width = Math.abs(element.faces.north!.uv[2] - element.faces.north!.uv[0])
    if (Math.abs(width - (kind === 'alex' ? 0.75 : 1)) > 0.001) throw new Error(uiText("core.advanced.totem.steveAlexSelectedDoesNotMatchThe"))
  }
}

// 旋转肢体时同时重映射面和UV旋转，保持样本的纹理覆盖区域
function standingModel(model: DollModel): void {
  const remap: Record<FaceName, { face: FaceName; rotation: number }> = {
    north: { face: 'down', rotation: 180 }, south: { face: 'up', rotation: 0 },
    up: { face: 'north', rotation: 180 }, down: { face: 'south', rotation: 0 },
    east: { face: 'east', rotation: 90 }, west: { face: 'west', rotation: 270 }
  }
  for (const element of model.elements) {
    const part = partOf(element)
    if (part === 'head' || part === 'body' || part === 'icon') {
      const delta = part === 'icon' ? [0, 6, 1.25] : [0, 6, -3]
      element.from = element.from.map((n, i) => n + delta[i])
      element.to = element.to.map((n, i) => n + delta[i])
    } else {
      const dimensions = element.to.map((n, i) => n - element.from[i])
      const side = (element.from[0] + element.to[0]) / 2 < 8 ? -1 : 1
      const armWidth = Math.abs(element.faces.north!.uv[2] - element.faces.north!.uv[0]) * 2
      const centerX = part === 'arm' ? 8 + side * (2.4 + armWidth / 2) : 8 + side
      const centerY = part === 'arm' ? 9 : 3
      element.from = [centerX - dimensions[0] / 2, centerY - dimensions[2] / 2, 8 - dimensions[1] / 2]
      element.to = [centerX + dimensions[0] / 2, centerY + dimensions[2] / 2, 8 + dimensions[1] / 2]
      const faces: Partial<Record<FaceName, ModelFace>> = {}
      for (const [name, face] of Object.entries(element.faces)) {
        const target = remap[name as FaceName]
        faces[target.face] = { ...face, rotation: ((face.rotation ?? 0) + target.rotation) % 360 }
      }
      element.faces = faces
    }
    delete element.rotation
  }
}

function resourceName(value: string, name: string, namespace = false): string {
  const pattern = namespace ? /^[a-z0-9_.-]+$/ : /^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*$/
  if (typeof value !== 'string' || !pattern.test(value) || value.length > 160 || value.split('/').some(p => p === '.' || p === '..')) {
    throw new Error(uiText("core.advanced.totem.itHasToBeASmallSafe", name))
  }
  return value
}

export function generateTotemFiles(options: TotemGenerateOptions): TotemGenerationResult {
  modelKind(options.model)
  if (options.pose !== 'sitting' && options.pose !== 'standing') throw new Error(uiText("core.advanced.totem.poseOnlySupportingSittingOrStanding"))
  if (options.replaceVanilla !== undefined && typeof options.replaceVanilla !== 'boolean') throw new Error(uiText("core.advanced.totem.replaceVanillaMustBeBoolean"))
  const namespace = resourceName(options.namespace ?? 'minecraft', 'namespace', true)
  const modelName = resourceName(options.modelName ?? `player_totem_${options.model}_${options.pose}`, 'modelName')
  const textureName = resourceName(options.textureName ?? modelName, 'textureName')
  const model = validateModel(options.templateModel)
  validateDollKind(model, options.model)
  const skin = normalizeTotemSkin(options.skinPng, options.model)
  const skinResource = `${namespace}:item/doll/${textureName}`
  const warnings = [LICENSE_WARNING]
  model.credit = uiText("core.advanced.totem.templateAuthorChiquistUserProvidedSourceOf", typeof model.credit === 'string' ? model.credit + '; ' : '', options.pose === 'standing' ? uiText("core.advanced.totem.itAlsoIncludesTheGeometryOfThe") : '')
  const textureKeys = Object.keys(model.textures)
  model.textures = Object.fromEntries(textureKeys.map(key => [key, skinResource]))
  model.textures['0'] = skinResource
  model.textures.particle = skinResource
  model.textures.layer0 = 'minecraft:item/totem_of_undying'
  for (const element of model.elements) {
    for (const face of Object.values(element.faces)) if (face.texture === '#missing') face.texture = '#layer0'
  }
  if (options.pose === 'standing') {
    standingModel(model)
    warnings.push(uiText("core.advanced.totem.standPositionsAreDerivedFromTheParts"))
  }
  const originalHeight = Buffer.from(options.skinPng.buffer, options.skinPng.byteOffset, options.skinPng.byteLength).readUInt32BE(20)
  if (originalHeight === 32) warnings.push(uiText("core.advanced.totem.oldSteveSSkinIsMirroredTo"))
  const modelPath = `assets/${namespace}/models/item/${modelName}.json`
  const texturePath = `assets/${namespace}/textures/item/doll/${textureName}.png`
  const json = JSON.stringify(model, null, 2) + '\n'
  const files: TotemGeneratedFile[] = [{ path: modelPath, content: json }, { path: texturePath, content: skin }]
  if (options.replaceVanilla !== false) {
    if (modelPath !== MODEL_ENTRY) files.push({ path: MODEL_ENTRY, content: json })
    warnings.push(uiText("core.advanced.totem.totemOfUndyingJsonWillReplaceOld"))
  } else warnings.push(uiText("core.advanced.totem.aNameModelOnlyWithOriginalTotem"))
  return { files, warnings, model: options.model, pose: options.pose, poseSource: options.pose === 'sitting' ? 'sample' : 'derived', modelPath, texturePath }
}

function safeHttps(input: string, expectedHost: string, upgradeTexture = false): URL {
  let url: URL
  try { url = new URL(input) } catch { throw new Error(uiText("core.advanced.totem.mojangReturnsInvalidUrl")) }
  if (upgradeTexture && url.protocol === 'http:' && url.hostname === 'textures.minecraft.net') url.protocol = 'https:'
  if (url.protocol !== 'https:' || url.hostname !== expectedHost || url.username || url.password
    || (url.port && url.port !== '443') || url.hash || url.search) throw new Error(uiText("core.advanced.totem.mojangSRequestThatUrlIsNot"))
  return url
}

async function boundedResponse(fetcher: typeof fetch, url: URL, signal: AbortSignal, limit: number, label: string): Promise<Buffer> {
  if (signal.aborted) throw new Error(uiText("core.advanced.totem.mojangSRequestCancelled"))
  const response = await fetcher(url.toString(), { signal, redirect: 'manual', headers: { Accept: label === uiText("core.advanced.totem.skin") ? 'image/png' : 'application/json' } })
  if (signal.aborted) {
    void response.body?.cancel().catch(() => undefined)
    throw new Error(uiText("core.advanced.totem.mojangSRequestCancelled"))
  }
  if (!response.ok || response.status === 204) void response.body?.cancel().catch(() => undefined)
  if (response.status >= 300 && response.status < 400) throw new Error(uiText("core.advanced.totem.requestToRejectHttpRedirection", label))
  if (response.status === 204 || response.status === 404) throw new Error(uiText("core.advanced.totem.noThePlayerMayNotExistOr", label))
  if (response.status === 429) throw new Error(uiText("core.advanced.totem.requestRestrictedByMojangPleaseTryAgain", label))
  if (!response.ok) throw new Error(uiText("core.advanced.totem.requestFailedHttp", label, response.status))
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(uiText("core.advanced.totem.responseExceededBytesLimit", label, limit))
  }
  if (!response.body) throw new Error(uiText("core.advanced.totem.responseIsEmpty", label))
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      if (signal.aborted) throw new Error(uiText("core.advanced.totem.mojangSRequestCancelled"))
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > limit) throw new Error(uiText("core.advanced.totem.responseExceededBytesLimit", label, limit))
      chunks.push(Buffer.from(chunk.value))
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined)
    throw error
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks, total)
}

function jsonObject(bytes: Buffer, label: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error(uiText("core.advanced.totem.returnInvalidJson", label)) }
  if (!record(value)) throw new Error(uiText("core.advanced.totem.returnValueIsNotAnObject", label))
  return value
}

export async function fetchMojangSkin(playerName: string, options: MojangSkinFetchOptions = {}): Promise<MojangSkinResult> {
  if (typeof playerName !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(playerName)) throw new Error(uiText("core.advanced.totem.thePlayerSNameMustBeTo"))
  const timeoutMs = options.timeoutMs ?? 10000
  const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error(uiText("core.advanced.totem.timeoutmsMustBeBetweenAndMilliseconds"))
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_SKIN) throw new Error(uiText("core.advanced.totem.maxresponseBytesMustBeToBytes"))
  const controller = new AbortController()
  let timedOut = false
  let rejectGuard: (error: Error) => void = () => undefined
  const guard = new Promise<never>((_, reject) => { rejectGuard = reject })
  const onAbort = (): void => {
    controller.abort()
    rejectGuard(new Error(uiText("core.advanced.totem.mojangSSkinRequestCancelled")))
  }
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
    rejectGuard(new Error(uiText("core.advanced.totem.mojangSkinRequestTimeoutBudgetMilliseconds", timeoutMs)))
  }, timeoutMs)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const run = async (): Promise<MojangSkinResult> => {
    if (options.signal?.aborted) { onAbort(); throw new Error(uiText("core.advanced.totem.mojangSSkinRequestCancelled")) }
    const fetcher = options.fetchImpl ?? globalThis.fetch
    if (typeof fetcher !== 'function') throw new Error(uiText("core.advanced.totem.theOperatingEnvironmentDoesNotProvideA"))
    const profile = jsonObject(await boundedResponse(fetcher,
      safeHttps(`https://api.mojang.com/users/profiles/minecraft/${playerName}`, 'api.mojang.com'), controller.signal,
      Math.min(maxResponseBytes, 128 * 1024), uiText("core.advanced.totem.playerProfile")), uiText("core.advanced.totem.playerProfile"))
    if (typeof profile.id !== 'string' || !/^[a-fA-F0-9]{32}$/.test(profile.id) || typeof profile.name !== 'string'
      || profile.name.toLowerCase() !== playerName.toLowerCase()) throw new Error(uiText("core.advanced.totem.uuidOrPlayerNameInvalidInMojang"))
    const uuid = profile.id.toLowerCase()
    const session = jsonObject(await boundedResponse(fetcher,
      safeHttps(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`, 'sessionserver.mojang.com'), controller.signal,
      Math.min(maxResponseBytes, 128 * 1024), uiText("core.advanced.totem.skinSession")), uiText("core.advanced.totem.skinSession"))
    if (typeof session.id !== 'string' || session.id.toLowerCase() !== uuid || !Array.isArray(session.properties)) throw new Error(uiText("core.advanced.totem.dermalSessionsAreInvalidUudOrProperties"))
    const textures = session.properties.filter(p => record(p) && p.name === 'textures')
    if (textures.length !== 1 || typeof textures[0].value !== 'string' || textures[0].value.length > 64 * 1024
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(textures[0].value)) throw new Error(uiText("core.advanced.totem.thePlayerHasNoValidCustomSkin"))
    const payload = jsonObject(Buffer.from(textures[0].value, 'base64'), uiText("core.advanced.totem.skinTextures"))
    if (typeof payload.profileId !== 'string' || payload.profileId.toLowerCase() !== uuid
      || !record(payload.textures) || !record(payload.textures.SKIN) || typeof payload.textures.SKIN.url !== 'string') throw new Error(uiText("core.advanced.totem.skinTexturesMissingSkinMatchingPlayer"))
    const skinInfo = payload.textures.SKIN
    const skinUrl = safeHttps(skinInfo.url as string, 'textures.minecraft.net', true)
    if (!/^\/texture\/[a-fA-F0-9]{32,128}$/.test(skinUrl.pathname)) throw new Error(uiText("core.advanced.totem.mojangSkinUrlPathInvalid"))
    const metadata = skinInfo.metadata
    if (metadata !== undefined && (!record(metadata) || (metadata.model !== undefined && metadata.model !== 'slim'))) throw new Error(uiText("core.advanced.totem.mojangSkinModelMetadataInvalid"))
    const model: TotemModel = record(metadata) && metadata.model === 'slim' ? 'alex' : 'steve'
    const skinPng = await boundedResponse(fetcher, skinUrl, controller.signal, maxResponseBytes, uiText("core.advanced.totem.skin"))
    decodeSkin(skinPng, model)
    return { playerName: profile.name, uuid, model, skinPng: Uint8Array.from(skinPng), skinUrl: skinUrl.toString() }
  }
  try { return await Promise.race([run(), guard]) }
  catch (error) {
    if (timedOut) throw new Error(uiText("core.advanced.totem.mojangSkinRequestTimeoutBudgetMilliseconds", timeoutMs))
    if (options.signal?.aborted) throw new Error(uiText("core.advanced.totem.mojangSSkinRequestCancelled"))
    throw new Error(uiText("core.advanced.totem.mojangSkinAcquisitionFailed", error instanceof Error ? error.message : String(error)))
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}



