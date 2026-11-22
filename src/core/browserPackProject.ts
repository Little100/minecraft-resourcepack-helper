import { uiText } from '../i18n/messages'
import { canExportPackFile, filterMcrhEditorData, isForbiddenPackExportPath, isMcrhEditorDataPath, validateMcrhEditorDataExportOptions, type McrhEditorDataExportOptions } from './advanced/editorDataExportPolicy'
import { Unzip, UnzipInflate, strFromU8, strToU8, zipSync, type Zippable } from 'fflate'
import { z } from 'zod'

export type BrowserPackOrigin = 'user' | 'vanilla'
export type BrowserPackFormat = number | { readonly major: number; readonly minor: number } | readonly [number, number]
export type BrowserPackJson = null | boolean | number | string | BrowserPackJson[] | { [key: string]: BrowserPackJson }

export interface BrowserPackLimits {
  maxArchiveBytes: number
  maxCompressedBytes: number
  maxUncompressedBytes: number
  maxFileBytes: number
  maxFiles: number
  maxCompressionRatio: number
}

export const DEFAULT_BROWSER_PACK_LIMITS: Readonly<BrowserPackLimits> = Object.freeze({
  maxArchiveBytes: 256 * 1024 * 1024,
  maxCompressedBytes: 256 * 1024 * 1024,
  maxUncompressedBytes: 1024 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  maxFiles: 60_000,
  maxCompressionRatio: 1000
})

export interface BrowserPackMetadata {
  readonly name: string
  readonly version?: string
  readonly packFormat?: BrowserPackFormat
  readonly description?: BrowserPackJson
}

export interface BrowserPackProjectOptions extends BrowserPackMetadata {
  readonly limits?: Partial<BrowserPackLimits>
}

export interface BrowserPackEntry {
  readonly path: string
  readonly data: Uint8Array
  readonly origin: BrowserPackOrigin
  readonly modified: boolean
}

export interface BrowserPackImportResult {
  readonly files: number
  readonly skippedFiles: number
  readonly rootPrefix: string
  readonly origin: BrowserPackOrigin
  readonly importedBytes: number
}

export interface BrowserPackExportOptions extends McrhEditorDataExportOptions {
  readonly includeVanillaTextures?: boolean
}

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const formatSchema = z.union([integer, z.tuple([integer, integer]), z.object({ major: integer, minor: integer }).strict()])
const metadataSchema = z.object({
  name: z.string().trim().min(1).max(256).optional(),
  version: z.string().trim().min(1).max(128).optional(),
  packFormat: formatSchema.optional(),
  description: z.json().optional()
}).strict()
const packSchema = z.object({
  pack: z.object({
    description: z.json(),
    pack_format: integer.optional(),
    min_format: z.union([integer, z.tuple([integer, integer])]).optional(),
    max_format: z.union([integer, z.tuple([integer, integer])]).optional()
  }).passthrough()
}).passthrough()
const limitsSchema = z.object({
  maxArchiveBytes: integer.positive(),
  maxCompressedBytes: integer.positive(),
  maxUncompressedBytes: integer.positive(),
  maxFileBytes: integer.positive(),
  maxFiles: integer.positive().max(65_534),
  maxCompressionRatio: z.number().finite().min(1)
}).strict()
const MIN_RANGE_RESOURCE_FORMAT = 65
const STREAM_CHUNK_BYTES = 4096
const forbiddenExtension = /\.(?:class|java|jar|exe|dll|com|bat|cmd|ps1|sh|so|dylib|js|mjs|cjs|html?|wasm)$/i
const rootDocument = /^(?:licen[cs]e|copying|notice|readme|authors|credits|changelog)(?:[._-].*)?$/i
const regularRootFile = /\.(?:txt|md|markdown|json|jsonc|properties|mcmeta|png|ogg|ttf|otf|lang|fsh|vsh|glsl)$/i
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1
  return value >>> 0
})

type PackDocument = z.infer<typeof packSchema>
interface ArchiveEntry {
  path: string
  directory: boolean
  compression: number
  flags: number
  compressedBytes: number
  uncompressedBytes: number
  checksum: number
  offset: number
  dataOffset: number
}

function fail(message: string): never { throw new Error(`(${message})`) }
function cloneJson<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
function folded(path: string): string { return path.normalize('NFC').toLowerCase() }
function utf8(data: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { return fail(uiText("core.browserPackProject.zipPathOrPackMcmetaContainsInvalid")) }
}

function checkedPath(path: string, allowDirectory = false): string {
  if (typeof path !== 'string' || !path || path.length > 4096 || /[\\\x00-\x1f\x7f<>:"|?*]/.test(path) || path.startsWith('/')) fail(uiText("core.advanced.packToolsProtocol.insecureResourcePaths"))
  const directory = path.endsWith('/')
  if (directory && !allowDirectory) fail(uiText("core.browserPackProject.thisOperationRequiresAFilePath"))
  const parts = (directory ? path.slice(0, -1) : path).split('/')
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[.\s]$/.test(part) || part.length > 255 || /^\s*(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\s*\.|\s*$)/i.test(part)) fail(uiText("core.browserPackProject.unsafeResourcePathOrWindowsKeepName"))
  }
  return path
}

function validateTree(entries: Iterable<{ path: string; directory?: boolean }>): void {
  const nodes = new Map<string, { path: string; directory: boolean; explicit: boolean }>()
  for (const entry of entries) {
    checkedPath(entry.path, true)
    const parts = entry.path.replace(/\/$/, '').split('/')
    for (let index = 0; index < parts.length; index++) {
      const path = parts.slice(0, index + 1).join('/')
      const directory = index < parts.length - 1 || Boolean(entry.directory)
      const explicit = index === parts.length - 1
      const key = folded(path)
      const previous = nodes.get(key)
      if (previous && (previous.path !== path || previous.directory !== directory || (explicit && previous.explicit))) fail(uiText("core.browserPackProject.thereIsADuplicationCaseOrFile"))
      nodes.set(key, { path, directory, explicit: explicit || Boolean(previous?.explicit) })
    }
  }
}

function formatParts(format: BrowserPackFormat): { major: number; minor: number } {
  if (typeof format === 'number') return { major: format, minor: 0 }
  if ('major' in format) return { major: format.major, minor: format.minor }
  return { major: format[0], minor: format[1] }
}

function parsePack(data: Uint8Array): PackDocument {
  let parsed: unknown
  try { parsed = JSON.parse(utf8(data).replace(/^\uFEFF/, '')) } catch { return fail(uiText("core.browserPackProject.itSNotAValidUtfJson")) }
  const result = packSchema.safeParse(parsed)
  if (!result.success) fail(uiText("core.browserPackProject.packMcmetaLacksAValidPackDescription"))
  const pack = result.data.pack
  if ((pack.min_format === undefined) !== (pack.max_format === undefined)) fail(uiText("core.browserPackProject.packMcmetaMustSpecifyTheMinFormat"))
  if (pack.pack_format === undefined && pack.min_format === undefined) fail(uiText("core.browserPackProject.packMcmetaDoesNotProvideAClear"))
  if (pack.min_format !== undefined && pack.max_format !== undefined) {
    const min = formatParts(pack.min_format)
    const max = formatParts(pack.max_format)
    if (min.major > max.major || (min.major === max.major && typeof pack.max_format !== 'number' && min.minor > max.minor)) fail(uiText("core.browserPackProject.packMcmetaPackageRangeInvert"))
  }
  return result.data
}

function metadataFromPack(document: PackDocument): Pick<BrowserPackMetadata, 'packFormat' | 'description'> {
  const pack = document.pack
  const max = pack.max_format
  const min = pack.min_format
  const packFormat = typeof max === 'number' && min !== undefined && formatParts(min).major === max ? min : max ?? pack.pack_format
  return { packFormat, description: pack.description as BrowserPackJson }
}

function updatePack(document: PackDocument | undefined, metadata: BrowserPackMetadata, changeFormat: boolean): PackDocument {
  const result = document ? cloneJson(document) : { pack: { description: metadata.description ?? metadata.name } }
  if (changeFormat || !document) {
    if (metadata.packFormat === undefined) fail(uiText("core.browserPackProject.lackOfPackMcmetaPleaseProvideA"))
    const format = formatParts(metadata.packFormat)
    delete result.pack.pack_format
    delete result.pack.min_format
    delete result.pack.max_format
    delete result.pack.supported_formats
    if (format.major >= MIN_RANGE_RESOURCE_FORMAT) {
      const value = typeof metadata.packFormat === 'number' ? format.major : [format.major, format.minor] as [number, number]
      result.pack.min_format = value
      result.pack.max_format = value
    } else {
      if (format.minor !== 0) fail(uiText("core.browserPackProject.theOldPackageFormatDoesNotRepresent"))
      result.pack.pack_format = format.major
    }
  }
  if (metadata.description !== undefined) result.pack.description = cloneJson(metadata.description)
  return result
}

function checkExtra(view: DataView, bytes: Uint8Array, start: number, length: number, name: string): void {
  const end = start + length
  for (let offset = start; offset < end;) {
    if (offset + 4 > end) fail(uiText("core.browserPackProject.zipExtensionInterrupted"))
    const kind = view.getUint16(offset, true)
    const size = view.getUint16(offset + 2, true)
    const value = offset + 4
    if (value + size > end) fail(uiText("core.browserPackProject.invalidZipExtensionFieldLength"))
    if (kind === 1) fail(uiText("core.browserPackProject.doNotSupportZip64UseNormalZip"))
    if ((kind === 0x000d && size > 12) || (kind === 0x756e && (size < 14 || (view.getUint16(value + 4, true) & 0xf000) === 0xa000 || size > 14))) fail(uiText("core.browserPackProject.zipDoesNotAllowSymbolicOrHard"))
    if (kind === 0x7075) {
      if (size < 5 || bytes[value] !== 1 || utf8(bytes.subarray(value + 5, value + size)) !== name) fail(uiText("core.browserPackProject.unnicodePathForZip"))
    }
    offset = value + size
  }
}

// ZIP 目录和文件头通过检查后才解压
function inspectArchive(bytes: Uint8Array, limits: BrowserPackLimits): ArchiveEntry[] {
  if (!(bytes instanceof Uint8Array) || bytes.length > limits.maxArchiveBytes) fail(uiText("core.browserPackProject.zipCompressedArchiveExcessOrInvalidInput"))
  if (bytes.length < 22) fail(uiText("core.browserPackProject.zipArchiveBlocked"))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) { end = offset; break }
  }
  if (end < 0) fail(uiText("core.browserPackProject.zipMissingEffectiveCentralDirectory"))
  const count = view.getUint16(end + 10, true)
  const directorySize = view.getUint32(end + 12, true)
  const directoryOffset = view.getUint32(end + 16, true)
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0 || view.getUint16(end + 8, true) !== count) fail(uiText("core.browserPackProject.doNotSupportMultipleZips"))
  if (count === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff || (end >= 20 && view.getUint32(end - 20, true) === 0x07064b50)) fail(uiText("core.browserPackProject.zip64NotSupported"))
  if (count > limits.maxFiles) fail(uiText("core.browserPackProject.zipFileExcess"))
  if (directoryOffset + directorySize !== end) fail(uiText("core.browserPackProject.zipCentralDirectoryBoundaryInvalid"))
  const entries: ArchiveEntry[] = []
  let offset = directoryOffset
  let compressedTotal = 0
  let uncompressedTotal = 0
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) fail(uiText("core.browserPackProject.zipCentralDirectoryDamage"))
    const flags = view.getUint16(offset + 8, true)
    const compression = view.getUint16(offset + 10, true)
    const checksum = view.getUint32(offset + 16, true)
    const compressedBytes = view.getUint32(offset + 20, true)
    const uncompressedBytes = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const next = offset + 46 + nameLength + extraLength + view.getUint16(offset + 32, true)
    if (next > end || !nameLength) fail(uiText("core.browserPackProject.invalidZipCentralDirectoryFieldLength"))
    if (flags & 0x2041) fail(uiText("core.browserPackProject.encryptionZipNotSupported"))
    if (compression !== 0 && compression !== 8) fail(uiText("core.browserPackProject.zipUsesUnsupportedCompressionAlgorithms"))
    if (view.getUint16(offset + 34, true) !== 0) fail(uiText("core.browserPackProject.doNotSupportMultipleZips"))
    if (compressedBytes === 0xffffffff || uncompressedBytes === 0xffffffff) fail(uiText("core.browserPackProject.zip64NotSupported"))
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength)
    const path = checkedPath(flags & 0x800 ? utf8(nameBytes) : strFromU8(nameBytes, true), true)
    const directory = path.endsWith('/')
    const attributes = view.getUint32(offset + 38, true)
    const type = (attributes >>> 16) & 0xf000
    if ((type !== 0 && type !== 0x8000 && type !== 0x4000) || (attributes & 0x400)) fail(uiText("core.browserPackProject.zipDoesNotAllowSymbolicLinksOr"))
    if ((type === 0x4000 || Boolean(attributes & 0x10)) && !directory) fail(uiText("core.browserPackProject.theZipDirectoryPropertiesAreNotConsistent"))
    if (directory && uncompressedBytes !== 0) fail(uiText("core.browserPackProject.zipDirectoryContainsFileData"))
    checkExtra(view, bytes, offset + 46 + nameLength, extraLength, path)
    compressedTotal += compressedBytes
    uncompressedTotal += uncompressedBytes
    if (compressedTotal > limits.maxCompressedBytes) fail(uiText("core.browserPackProject.zipTotalCompressedDataExcess"))
    if (uncompressedTotal > limits.maxUncompressedBytes) fail(uiText("core.browserPackProject.zipTotalDecompressionVolumeExceedingLimit"))
    if (uncompressedBytes > limits.maxFileBytes) fail(uiText("core.browserPackProject.zipSingleFileDecompressionVolumeExceedingLimit"))
    if (uncompressedBytes > Math.max(1, compressedBytes) * limits.maxCompressionRatio) fail(uiText("core.browserPackProject.zipCompressionIsBeyondLimitSuspectedTo"))
    if (compression === 0 && compressedBytes !== uncompressedBytes) fail(uiText("core.browserPackProject.zipUncompressedFileLengthInconsistent"))
    const local = view.getUint32(offset + 42, true)
    if (local + 30 > directoryOffset || view.getUint32(local, true) !== 0x04034b50) fail(uiText("core.browserPackProject.invalidZipLocalFileHeader"))
    const localNameLength = view.getUint16(local + 26, true)
    const localExtraLength = view.getUint16(local + 28, true)
    const dataOffset = local + 30 + localNameLength + localExtraLength
    if (dataOffset + compressedBytes > directoryOffset || localNameLength !== nameLength || view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== compression) fail(uiText("core.browserPackProject.zipLocalHeaderDoesNotMatchCentral"))
    for (let char = 0; char < nameLength; char++) if (bytes[local + 30 + char] !== bytes[offset + 46 + char]) fail(uiText("core.browserPackProject.zipLocalPathDoesNotMatchCentral"))
    if (!(flags & 8) && (view.getUint32(local + 14, true) !== checksum || view.getUint32(local + 18, true) !== compressedBytes || view.getUint32(local + 22, true) !== uncompressedBytes)) fail(uiText("core.browserPackProject.zipLocalLengthOrValidationUnconsistent"))
    checkExtra(view, bytes, local + 30 + localNameLength, localExtraLength, path)
    entries.push({ path, directory, compression, flags, compressedBytes, uncompressedBytes, checksum, offset: local, dataOffset })
    offset = next
  }
  if (offset !== end) fail(uiText("core.browserPackProject.zipCentralDirectoryContainsUndeclaredEntries"))
  validateTree(entries)
  const ordered = [...entries].sort((a, b) => a.offset - b.offset)
  let nextOffset = 0
  for (const entry of ordered) {
    if (entry.offset !== nextOffset) fail(uiText("core.browserPackProject.zipContainsOverlappingFilesOrUndeclaredData"))
    nextOffset = entry.dataOffset + entry.compressedBytes
    if (entry.flags & 8) {
      if (nextOffset + 12 > directoryOffset) fail(uiText("core.browserPackProject.zipDataDescriptorInterrupted"))
      if (view.getUint32(nextOffset, true) === 0x08074b50) nextOffset += 4
      if (nextOffset + 12 > directoryOffset || view.getUint32(nextOffset, true) !== entry.checksum || view.getUint32(nextOffset + 4, true) !== entry.compressedBytes || view.getUint32(nextOffset + 8, true) !== entry.uncompressedBytes) fail(uiText("core.browserPackProject.theZipDataDescriptorDoesNotMatch"))
      nextOffset += 12
    }
  }
  if (nextOffset !== directoryOffset) fail(uiText("core.browserPackProject.zipContainsUndeclaredFileData"))
  return entries
}

// 分小块解压，避免虚报大小时内存突然增长
function extractEntry(bytes: Uint8Array, entry: ArchiveEntry): Uint8Array {
  const output = new Uint8Array(entry.uncompressedBytes)
  const header = new Uint8Array(bytes.subarray(entry.offset, entry.dataOffset))
  const view = new DataView(header.buffer)
  view.setUint16(6, entry.flags & ~8, true)
  view.setUint32(18, entry.compressedBytes, true)
  view.setUint32(22, entry.uncompressedBytes, true)
  let length = 0
  let checksum = 0xffffffff
  let finished = false
  let error: Error | undefined
  const unzip = new Unzip(file => {
    if (file.name !== entry.path || file.size !== entry.compressedBytes || file.originalSize !== entry.uncompressedBytes) fail(uiText("core.browserPackProject.zipFlowHeaderInconsistent"))
    file.ondata = (cause, chunk, final) => {
      if (error) return
      if (cause) { error = cause; return }
      if (length + chunk.length > entry.uncompressedBytes) { error = new Error(uiText("core.browserPackProject.zipRealDecompressionVolumeInExcessOf")); return }
      output.set(chunk, length)
      length += chunk.length
      for (const byte of chunk) checksum = crcTable[(checksum ^ byte) & 255]! ^ (checksum >>> 8)
      if (final) finished = true
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  unzip.push(header, false)
  for (let offset = entry.dataOffset; offset < entry.dataOffset + entry.compressedBytes; offset += STREAM_CHUNK_BYTES) {
    const end = Math.min(offset + STREAM_CHUNK_BYTES, entry.dataOffset + entry.compressedBytes)
    unzip.push(bytes.subarray(offset, end), false)
    if (error) throw error
  }
  unzip.push(new Uint8Array(1), true)
  if (error) throw error
  if (!finished || length !== entry.uncompressedBytes || ((checksum ^ 0xffffffff) >>> 0) !== entry.checksum) fail(uiText("core.browserPackProject.zipFileActualLengthOrCrcVerification"))
  return output
}

export interface BrowserArchiveReader {
  readonly files: readonly { readonly path: string; readonly size: number }[]
  read(path: string, maxBytes?: number): Uint8Array | undefined
}

// 只解压明确请求的条目，模组代码不会被读取或加入工程
export function openBrowserArchive(bytes: Uint8Array, options: Partial<BrowserPackLimits> = {}): BrowserArchiveReader {
  const limits = limitsSchema.parse({ ...DEFAULT_BROWSER_PACK_LIMITS, ...options })
  const entries = inspectArchive(bytes, limits).filter(entry => !entry.directory)
  const byPath = new Map(entries.map(entry => [entry.path, entry]))
  return {
    files: entries.map(entry => ({ path: entry.path, size: entry.uncompressedBytes })),
    read(path, maxBytes = limits.maxFileBytes) {
      const entry = byPath.get(path)
      if (!entry) return undefined
      if (entry.uncompressedBytes > maxBytes) fail(uiText("core.browserPackProject.archivingEntriesExceedTheReadBudget", path))
      return extractEntry(bytes, entry)
    }
  }
}

export interface BrowserArchiveResource { readonly path: string; readonly data: Uint8Array; readonly modifiedAt?: number }

// 保留通过检查的普通文件
export function readBrowserPackArchive(bytes: Uint8Array, options: Partial<BrowserPackLimits> = {}): BrowserArchiveResource[] {
  const limits = limitsSchema.parse({ ...DEFAULT_BROWSER_PACK_LIMITS, ...options })
  const archive = inspectArchive(bytes, limits), files = archive.filter(entry => !entry.directory)
  const roots = files.filter(entry => !isMcrhEditorDataPath(entry.path) && !isForbiddenPackExportPath(entry.path) && (entry.path === 'pack.mcmeta' || entry.path.endsWith('/pack.mcmeta'))).map(entry => entry.path.slice(0, -'pack.mcmeta'.length))
  const prefix = roots.includes('') ? '' : roots.length === 1 && files.every(entry => entry.path.startsWith(roots[0]!)) ? roots[0]! : undefined
  if (prefix === undefined) fail(uiText("core.browserPackProject.zipLacksASingleResourcePackDirectory"))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return files.map(entry => {
    const time = view.getUint16(entry.offset + 10, true), date = view.getUint16(entry.offset + 12, true)
    const year = 1980 + (date >>> 9), month = (date >>> 5) & 15, day = date & 31, hour = time >>> 11, minute = (time >>> 5) & 63, second = (time & 31) * 2
    // ZIP DOS 时间无时区，按 UTC 字段解释以稳定比较
    const stamp = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
    const valid = month >= 1 && month <= 12 && day >= 1 && hour < 24 && minute < 60 && second < 60 && stamp.getUTCDate() === day
    return { path: entry.path.slice(prefix.length), data: extractEntry(bytes, entry), ...(valid ? { modifiedAt: stamp.getTime() } : {}) }
  })
}

// 读取压缩包中的 JSON，不把它加进项目
export function readBrowserArchiveFile(bytes: Uint8Array, path: string, options: Partial<BrowserPackLimits> = {}): Uint8Array | undefined {
  checkedPath(path)
  if (!/\.json$/i.test(path)) fail(uiText("core.browserPackProject.archiveMetadataReadingOnlyAllowedJsonFiles"))
  const limits = limitsSchema.parse({ ...DEFAULT_BROWSER_PACK_LIMITS, ...options })
  const archive = inspectArchive(bytes, limits)
  const entry = archive.find(file => file.path === path && !file.directory)
  if (!entry) return undefined
  const data = extractEntry(bytes, entry)
  try { JSON.parse(utf8(data)) } catch { return fail(uiText("core.browserPackProject.archiveMetadataIsNotValidUtfJson")) }
  return data
}

function rootCandidate(path: string): string | undefined {
  if (isMcrhEditorDataPath(path) || isForbiddenPackExportPath(path)) return undefined
  const parts = path.split('/')
  const assets = parts.indexOf('assets')
  if (assets >= 0 && assets < parts.length - 1) return parts.slice(0, assets).join('/') + (assets ? '/' : '')
  if (parts.at(-1) === 'pack.mcmeta' || parts.at(-1) === 'pack.png') return parts.slice(0, -1).join('/') + (parts.length > 1 ? '/' : '')
  return undefined
}

function resourceFile(path: string, overlays: readonly string[] = []): boolean {
  if (isForbiddenPackExportPath(path)) return false
  if (isMcrhEditorDataPath(path)) return true
  if (path === 'version.json' || forbiddenExtension.test(path) || /^(?:META-INF|data|\.git|\.mcrh-backups)(?:\/|$)/i.test(path)) return false
  if (path.startsWith('assets/')) return true
  if (overlays.some(directory => path.startsWith(`${directory}/assets/`))) return true
  if (path.includes('/')) return false
  return path === 'pack.mcmeta' || path === 'pack.png' || rootDocument.test(path) || regularRootFile.test(path)
}

function overlayDirectories(document: PackDocument | undefined): string[] {
  const overlays = document?.overlays
  if (!overlays || typeof overlays !== 'object' || !('entries' in overlays) || !Array.isArray(overlays.entries)) return []
  return overlays.entries.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || !('directory' in entry) || typeof entry.directory !== 'string') return []
    const directory = checkedPath(entry.directory)
    return [directory]
  })
}

export class BrowserPackProject {
  private fileMap = new Map<string, BrowserPackEntry>()
  private readonly limits: BrowserPackLimits
  private details: BrowserPackMetadata
  private totalBytes = 0
  private document?: PackDocument

  constructor(options: BrowserPackProjectOptions = { name: 'Resource Pack' }) {
    const { limits, ...metadata } = options
    const parsed = metadataSchema.parse(metadata)
    this.details = cloneJson({ ...parsed, name: parsed.name ?? 'Resource Pack' }) as BrowserPackMetadata
    this.limits = limitsSchema.parse({ ...DEFAULT_BROWSER_PACK_LIMITS, ...limits })
  }

  get metadata(): BrowserPackMetadata { return cloneJson(this.details) }

  setMetadata(patch: Partial<BrowserPackMetadata>): void {
    const parsed = Object.fromEntries(Object.entries(metadataSchema.parse(patch)).filter(([, value]) => value !== undefined)) as Partial<BrowserPackMetadata>
    if (parsed.version !== undefined && parsed.version !== this.details.version && parsed.packFormat === undefined) fail(uiText("core.browserPackProject.toggleTargetVersionsMustAlsoProvideA"))
    const next = cloneJson({ ...this.details, ...parsed }) as BrowserPackMetadata
    if (this.document || next.packFormat !== undefined) {
      const document = updatePack(this.document, next, parsed.packFormat !== undefined)
      this.write('pack.mcmeta', strToU8(JSON.stringify(document, null, 2) + '\n'))
    }
    this.details = next
  }

  importZip(bytes: Uint8Array, origin: BrowserPackOrigin = 'user'): BrowserPackImportResult {
    if (origin !== 'user' && origin !== 'vanilla') fail(uiText("core.browserPackProject.unknownSource"))
    const archive = inspectArchive(bytes, this.limits)
    // 原版客户端的顶层 assets 优先，内嵌数据包和代码目录不作为资源包根
    const vanillaRoot = origin === 'vanilla' && archive.some(entry => !entry.directory && entry.path.startsWith('assets/'))
    const roots = vanillaRoot ? new Set(['']) : new Set(archive.map(entry => rootCandidate(entry.path)).filter(root => root !== undefined))
    const archiveMap = new Map(archive.map(entry => [entry.path, entry]))
    const metadataRoots = [...roots].filter(root => archiveMap.has(root + 'pack.mcmeta'))
    if (metadataRoots.length > 1 || (metadataRoots.length === 0 && roots.size > 1)) fail(uiText("core.browserPackProject.zipContainsMultipleResourcePackDirectoriesPlease"))
    let importedDocument: PackDocument | undefined
    let importedMetadata: Uint8Array | undefined
    if (metadataRoots.length === 1) {
      const root = metadataRoots[0]!
      importedMetadata = extractEntry(bytes, archiveMap.get(root + 'pack.mcmeta')!)
      importedDocument = parsePack(importedMetadata)
      for (const overlay of overlayDirectories(importedDocument)) roots.delete(root + overlay + '/')
    }
    if (roots.size > 1) fail(uiText("core.browserPackProject.zipContainsMultipleResourcePackDirectoriesPlease"))
    if (roots.size === 0) fail(uiText("core.browserPackProject.zipFailedToFindAsetsPackMcmeta"))
    const rootPrefix = [...roots][0]!
    if (rootPrefix.split('/').filter(Boolean).length > 1) fail(uiText("core.browserPackProject.resourcePackBaseDirectoryOnlySupportsSingle"))
    const overlays = overlayDirectories(importedDocument)
    const paths = new Map([...this.fileMap.keys()].map(path => [path, { path }]))
    const pending = new Map<string, ArchiveEntry>()
    let skippedFiles = 0
    let importedBytes = 0
    let totalBytes = this.totalBytes
    for (const entry of archive) {
      if (entry.directory) continue
      const path = entry.path.startsWith(rootPrefix) ? entry.path.slice(rootPrefix.length) : ''
      if (!path || !resourceFile(path, overlays)) { skippedFiles++; continue }
      if ((folded(path) === 'pack.mcmeta' || folded(path) === 'pack.png') && path !== folded(path)) fail(uiText("core.browserPackProject.unstandardizedCaseForPackageRootMetadataOr"))
      const existing = this.fileMap.get(path)
      if (origin === 'vanilla' && existing && (existing.origin === 'user' || existing.modified)) { skippedFiles++; continue }
      if (!existing && paths.size >= this.limits.maxFiles) fail(uiText("core.browserPackProject.projectFileExceedingLimit"))
      totalBytes += entry.uncompressedBytes - (existing?.data.length ?? 0)
      if (totalBytes > this.limits.maxUncompressedBytes) fail(uiText("core.browserPackProject.projectTotalDecompressionDataExceedingLimit"))
      paths.set(path, { path })
      pending.set(path, entry)
      importedBytes += entry.uncompressedBytes
    }
    validateTree(paths.values())
    const candidate = new Map(this.fileMap)
    let nextMetadata = this.details
    for (const [path, entry] of pending) {
      const data = path === 'pack.mcmeta' ? importedMetadata! : extractEntry(bytes, entry)
      if (!canExportPackFile({ path, content: data }, { includeMcrhEditorData: true })) { totalBytes -= data.byteLength; importedBytes -= data.byteLength; pending.delete(path); skippedFiles++; continue }
      candidate.set(path, { path, data, origin, modified: false })
      if (path === 'pack.mcmeta') nextMetadata = { ...nextMetadata, ...metadataFromPack(importedDocument!) }
    }
    this.fileMap.clear()
    for (const [path, entry] of candidate) this.fileMap.set(path, entry)
    this.totalBytes = totalBytes
    this.details = cloneJson(nextMetadata)
    if (pending.has('pack.mcmeta')) this.document = importedDocument
    return { files: pending.size, skippedFiles, rootPrefix, origin, importedBytes }
  }

  read(path: string): Uint8Array | undefined { return this.fileMap.get(checkedPath(path))?.data.slice() }

  entries(): BrowserPackEntry[] {
    return [...this.fileMap.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(entry => ({ ...entry, data: entry.data.slice() }))
  }

  write(path: string, data: Uint8Array): void { this.writeBatch([{ path, data }]) }

  // 只复制修改项，检查通过后一起更新项目
  writeBatch(files: readonly { path: string; data: Uint8Array }[]): void {
    if (!Array.isArray(files)) fail(uiText("core.browserPackProject.batchResourcesMustBeInFileArrays"))
    if (!files.length) return
    if (files.length > this.limits.maxFiles) fail(uiText("core.browserPackProject.batchFileExcess"))
    const candidate = new Map(this.fileMap)
    const changed = new Map<string, BrowserPackEntry>()
    const paths = new Set<string>()
    let totalBytes = this.totalBytes
    for (const file of files) {
      if (!file || typeof file !== 'object') fail(uiText("core.browserPackProject.batchResourceEntryInvalid"))
      const { path, data } = file
      checkedPath(path)
      const key = folded(path)
      if (paths.has(key)) fail(uiText("core.browserPackProject.thereIsADuplicationOrCaseConflict"))
      paths.add(key)
      if ((key === 'pack.mcmeta' || key === 'pack.png') && path !== key) fail(uiText("core.browserPackProject.unstandardizedCaseForPackageRootMetadataOr"))
      if (!(data instanceof Uint8Array) || data.length > this.limits.maxFileBytes) fail(uiText("core.browserPackProject.resourceSingleFileSizeOverLimitOr"))
      const existing = this.fileMap.get(path)
      totalBytes += data.length - (existing?.data.length ?? 0)
      const entry: BrowserPackEntry = { path, data, origin: existing?.origin ?? 'user', modified: true }
      candidate.set(path, entry)
      changed.set(path, entry)
    }
    if (candidate.size > this.limits.maxFiles) fail(uiText("core.browserPackProject.projectFileExceedingLimit"))
    if (totalBytes > this.limits.maxUncompressedBytes) fail(uiText("core.browserPackProject.projectTotalDecompressionDataExceedingLimit"))
    let document = this.document
    let details = this.details
    const metadata = changed.get('pack.mcmeta')
    if (metadata) {
      const data = new Uint8Array(metadata.data)
      document = parsePack(data)
      details = cloneJson({ ...this.details, ...metadataFromPack(document) })
      const entry = { ...metadata, data }
      changed.set(entry.path, entry)
      candidate.set(entry.path, entry)
    }
    const overlays = overlayDirectories(document)
    for (const entry of metadata ? candidate.values() : changed.values()) {
      if (!resourceFile(entry.path, overlays)) fail(uiText("core.browserPackProject.unsupportedWritingToNonResourcePackFile"))
    }
    validateTree(candidate.values())
    for (const entry of changed.values()) {
      if (entry.path !== 'pack.mcmeta') candidate.set(entry.path, { ...entry, data: new Uint8Array(entry.data) })
    }
    this.fileMap = candidate
    this.totalBytes = totalBytes
    this.document = document
    this.details = details
  }

  remove(path: string): boolean {
    checkedPath(path)
    const existing = this.fileMap.get(path)
    if (!existing) return false
    this.fileMap.delete(path)
    this.totalBytes -= existing.data.length
    if (path === 'pack.mcmeta') this.document = undefined
    return true
  }

  // 子目录以斜线结尾，返回值可直接用于后续读取或导航
  list(path = ''): string[] {
    const prefix = path ? checkedPath(path.endsWith('/') ? path : `${path}/`, true) : ''
    const result = new Set<string>()
    for (const file of this.fileMap.keys()) {
      if (!file.startsWith(prefix)) continue
      const rest = file.slice(prefix.length)
      const slash = rest.indexOf('/')
      result.add(slash < 0 ? file : prefix + rest.slice(0, slash + 1))
    }
    return [...result].sort()
  }

  exportZip(options: BrowserPackExportOptions = {}): Uint8Array {
    validateMcrhEditorDataExportOptions(options)
    if (options.includeVanillaTextures !== undefined && typeof options.includeVanillaTextures !== 'boolean') fail(uiText("core.browserPackProject.includevanillatexturesMustHaveABooleanValue"))
    const files: Zippable = Object.create(null) as Zippable
    for (const entry of this.fileMap.values()) {
      const unchangedVanilla = entry.origin === 'vanilla' && !entry.modified && entry.path !== 'pack.mcmeta'
      if (options.includeVanillaTextures || !unchangedVanilla) files[entry.path] = entry.data
    }
    // PNG 和动画设置一起导出，避免动画失效
    for (const path of Object.keys(files)) {
      if (/\.png$/i.test(path)) {
        const metadata = this.fileMap.get(path + '.mcmeta')
        if (metadata) files[metadata.path] = metadata.data
      } else if (/\.png\.mcmeta$/i.test(path)) {
        const image = this.fileMap.get(path.slice(0, -7))
        if (!image) fail(uiText("core.browserPackProject.pngMetadataLackMatchingTabsPleaseImport"))
        files[image.path] = image.data
      }
    }
    if (!this.fileMap.has('pack.mcmeta')) files['pack.mcmeta'] = strToU8(JSON.stringify(updatePack(undefined, this.details, true), null, 2) + '\n')
    const policy = filterMcrhEditorData(Object.entries(files).map(([path, content]) => ({ path, content: content as Uint8Array })), options)
    for (const omitted of policy.omitted) delete files[omitted]
    validateTree(Object.keys(files).map(path => ({ path })))
    // 选了完整导出才保留未修改的原版资源
    const dataFiles = Object.values(files) as Uint8Array[]
    if (dataFiles.length > this.limits.maxFiles) fail(uiText("core.browserPackProject.exportOfFilesExceedingLimitWithRequired"))
    if (dataFiles.some(data => data.length > this.limits.maxFileBytes) || dataFiles.reduce((size, data) => size + data.length, 0) > this.limits.maxUncompressedBytes) fail(uiText("core.browserPackProject.exportResourceSizeExceedingLimitWithRequired"))
    const output = zipSync(files, { level: 6 })
    if (output.length > this.limits.maxArchiveBytes) fail(uiText("core.browserPackProject.exportZipCompressedArchiveOverwrite"))
    return output
  }

  // 项目信息不包含资源文件内容
  toJSON(): BrowserPackMetadata { return this.metadata }
}

