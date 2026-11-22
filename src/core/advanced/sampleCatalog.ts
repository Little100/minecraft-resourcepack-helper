import { uiText } from '../../i18n/messages'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { TextDecoder } from 'node:util'
import type { GeneratedFile } from './textures'

export type SampleSourceType = 'directory' | 'zip' | 'jar'
export type SampleRuntime = 'vanilla' | 'optifine' | 'shader-mod' | 'mod'

export interface SampleMechanism {
  id: string
  label: string
  runtime: SampleRuntime
  evidence: string[]
  notes: string
}

export interface SampleSkippedFile {
  path: string
  reason: string
}

export interface SampleRepair {
  path: string
  replacements: number
  description: string
}

export interface SampleImportPlan {
  sourceName: string
  files: GeneratedFile[]
  skipped: SampleSkippedFile[]
  repairs: SampleRepair[]
  warnings: string[]
  mechanisms: SampleMechanism[]
  license: SampleLicense
  packRoots: string[]
}

export interface SampleLicense {
  restricted: boolean
  evidence: string[]
  requiresAcknowledgement: boolean
}

export interface SampleDescriptor {
  id: string
  label: string
  sourcePath: string
  sourceType: SampleSourceType
  entryCount: number
  importableFileCount: number
  mechanisms: SampleMechanism[]
  warnings: string[]
  license: SampleLicense
  packRoots: string[]
  packMetadata?: unknown
  error?: string
}

export interface SampleCatalog {
  root: string
  samples: SampleDescriptor[]
  warnings: string[]
}

export interface SampleLimits {
  maxArchiveBytes: number
  maxEntryBytes: number
  maxTotalBytes: number
  maxEntries: number
  maxCompressionRatio: number
}

export interface SampleImportOptions {
  sourceName?: string
  acknowledgeLicense?: boolean
  repairTotemModels?: boolean
  packRoot?: string
  includePackMetadata?: boolean
  limits?: Partial<SampleLimits>
}

export interface SampleInputEntry {
  path: string
  content: string | Uint8Array
  symlink?: boolean
}

export const DEFAULT_SAMPLE_LIMITS: Readonly<SampleLimits> = Object.freeze({
  maxArchiveBytes: 128 * 1024 * 1024,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxEntries: 20000,
  maxCompressionRatio: 1000
})

interface SourceEntry {
  path: string
  content?: Uint8Array
  skipReason?: string
}

interface SourceRead {
  entries: SourceEntry[]
  warnings: string[]
}

const EMPTY_LICENSE: SampleLicense = { restricted: false, evidence: [], requiresAcknowledgement: false }
const RESOURCE_EXTENSIONS = new Set(['.png', '.json', '.mcmeta', '.properties', '.vsh', '.fsh', '.glsl', '.ogg', '.wav', '.lang', '.txt', '.md', '.jem', '.jpm', '.obj', '.mtl', '.ttf', '.otf'])
const EXECUTABLE_EXTENSIONS = /\.(?:class|jar|zip|exe|dll|com|scr|msi|bat|cmd|ps1|sh|bash|py|pyc|js|cjs|mjs|vbs|vbe|wsf|hta|lnk|url|so|dylib|wasm)$/i
const UTF8 = new TextDecoder('utf-8', { fatal: true })
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = index
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  return crc >>> 0
})

function invalid(message: string): never {
  throw new Error(`(${message})`)
}

function limitsOf(value?: Partial<SampleLimits>): SampleLimits {
  const limits = { ...DEFAULT_SAMPLE_LIMITS, ...value }
  for (const [key, limit] of Object.entries(limits)) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > DEFAULT_SAMPLE_LIMITS[key as keyof SampleLimits]) {
      invalid(uiText("core.advanced.sampleCatalog.safetyLimitMustBePositiveAndNot", key))
    }
  }
  return limits
}

// 同时拒绝 Windows 别名、ADS 和跨平台路径穿越
export function validateSampleEntryPath(value: string, directory = false): string {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x1f\x7f\\:<>"|?*]/.test(value) || value.startsWith('/')) {
    invalid(uiText("core.advanced.sampleCatalog.unsafeExampleEntryPath", value))
  }
  const candidate = directory && value.endsWith('/') ? value.slice(0, -1) : value
  const parts = candidate.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    invalid(uiText("core.advanced.sampleCatalog.examplePathContainsAFileNameThat", value))
  }
  return candidate
}

function normalizedIdentity(value: string): string {
  return value.normalize('NFC').toLowerCase()
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255]
  return (crc ^ 0xffffffff) >>> 0
}

function skipExecutable(name: string): string | undefined {
  if (EXECUTABLE_EXTENSIONS.test(name)) return uiText("core.advanced.sampleCatalog.moduleCodeExecutableFileScriptOrEmbedded")
  if (name.split('/').some(part => part.toLowerCase() === 'meta-inf')) return uiText("core.advanced.sampleCatalog.moduleLoadMetadataWithoutImportingResourcePacks")
  return undefined
}

function executableContentReason(bytes: Uint8Array): string | undefined {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = buffer.length >= 4 ? buffer.readUInt32BE(0) : 0
  if ((buffer[0] === 0x4d && buffer[1] === 0x5a) || [0xcafebabe, 0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0x504b0304].includes(magic)) {
    return uiText("core.advanced.sampleCatalog.contentSignedAsClassBinaryOrNested")
  }
  if (buffer[0] === 0x23 && buffer[1] === 0x21) return uiText("core.advanced.sampleCatalog.contentIsAnEnforceableScriptWithoutImporting")
  return undefined
}

function bound(buffer: Buffer, offset: number, size: number, label: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > buffer.length) invalid(uiText("core.advanced.sampleCatalog.beyondTheZipBorder", label))
}

function decodeZipName(bytes: Buffer, flags: number): string {
  if ((flags & 0x800) !== 0) {
    try { return UTF8.decode(bytes) } catch { return invalid(uiText("core.advanced.sampleCatalog.zipFilenameIsNotAValidUtf")) }
  }
  // 旧中文封装目录不参与输出路径，保留原始字节以避免有损重名
  return bytes.toString('latin1')
}

function readArchive(bytes: Uint8Array, limits: SampleLimits): SourceRead {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > limits.maxArchiveBytes) invalid(uiText("core.advanced.sampleCatalog.invalidArchiveContentOrExceedingTheSize"))
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) invalid(uiText("core.advanced.sampleCatalog.missingValidZipCentralDirectoryEndRecord"))
  const disk = buffer.readUInt16LE(eocd + 4)
  const centralDisk = buffer.readUInt16LE(eocd + 6)
  const count = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (disk || centralDisk || buffer.readUInt16LE(eocd + 8) !== count) invalid(uiText("core.advanced.sampleCatalog.nonStandardZipToRejectMultipleRolls"))
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) invalid(uiText("core.advanced.sampleCatalog.zip64DoesNotSupportSecurityExampleImport"))
  if (count > limits.maxEntries) invalid(uiText("core.advanced.sampleCatalog.theNumberOfArchivedEntriesExceededThe"))
  bound(buffer, centralOffset, centralSize, uiText("core.advanced.sampleCatalog.centralDirectory"))
  if (centralOffset + centralSize !== eocd) invalid(uiText("core.advanced.sampleCatalog.theZipCentralDirectoryDoesNotMatch"))
  let offset = centralOffset
  let total = 0
  const identities = new Set<string>()
  const fileNames = new Set<string>()
  const entries: SourceEntry[] = []
  for (let index = 0; index < count; index++) {
    bound(buffer, offset, 46, uiText("core.advanced.sampleCatalog.centralDirectoryEntry"))
    if (buffer.readUInt32LE(offset) !== 0x02014b50) invalid(uiText("core.advanced.sampleCatalog.incorrectSignatureOfCentralDirectoryEntry"))
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const checksum = buffer.readUInt32LE(offset + 16)
    const compressed = buffer.readUInt32LE(offset + 20)
    const uncompressed = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const diskStart = buffer.readUInt16LE(offset + 34)
    const attributes = buffer.readUInt32LE(offset + 38)
    const localOffset = buffer.readUInt32LE(offset + 42)
    bound(buffer, offset + 46, nameLength + extraLength + commentLength, uiText("core.advanced.sampleCatalog.centralDirectoryNameAndExtraData"))
    if (offset + 46 + nameLength + extraLength + commentLength > eocd) invalid(uiText("core.advanced.sampleCatalog.theZipEntryCrossesTheCentralDirectory"))
    if (diskStart || [compressed, uncompressed, localOffset].includes(0xffffffff)) invalid(uiText("core.advanced.sampleCatalog.rejectMultipleVolumesOrZip64Entries"))
    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength)
    const name = decodeZipName(rawName, flags)
    const directory = name.endsWith('/')
    const safeName = validateSampleEntryPath(name, directory)
    const identity = normalizedIdentity(safeName)
    if (identities.has(identity)) invalid(uiText("core.advanced.sampleCatalog.archiveContainsDuplicateOrCaseConflictPaths", name))
    identities.add(identity)
    if (((attributes >>> 16) & 0xf000) === 0xa000) invalid(uiText("core.advanced.sampleCatalog.rejectedZipSymbolLink", name))
    if ((flags & 0x41) !== 0) invalid(uiText("core.advanced.sampleCatalog.denyEncryptionOfZipEntries", name))
    if (![0, 8].includes(method)) invalid(uiText("core.advanced.sampleCatalog.unsupportedZipCompressionMethod", method))
    if (uncompressed > limits.maxEntryBytes || (total += uncompressed) > limits.maxTotalBytes) invalid(uiText("core.advanced.sampleCatalog.zipDecompressionVolumeAboveSafetyLimit"))
    if (uncompressed > Math.max(1, compressed) * limits.maxCompressionRatio) invalid(uiText("core.advanced.sampleCatalog.zipCompressionRatioAboveSecurityLimit"))
    if (directory && uncompressed !== 0) invalid(uiText("core.advanced.sampleCatalog.theZipDirectoryEntriesAreDisguisedAs", name))
    bound(buffer, localOffset, 30, uiText("core.advanced.sampleCatalog.localFileHeader"))
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) invalid(uiText("core.advanced.sampleCatalog.localZipHeadMissing"))
    const localFlags = buffer.readUInt16LE(localOffset + 6)
    const localMethod = buffer.readUInt16LE(localOffset + 8)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    bound(buffer, localOffset + 30, localNameLength + localExtraLength, uiText("core.advanced.sampleCatalog.localEntryName"))
    if (localFlags !== flags || localMethod !== method || !buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(rawName)) {
      invalid(uiText("core.advanced.sampleCatalog.zipLocalHeaderDoesNotMatchThe", name))
    }
    if ((flags & 8) === 0 && (buffer.readUInt32LE(localOffset + 14) !== checksum || buffer.readUInt32LE(localOffset + 18) !== compressed || buffer.readUInt32LE(localOffset + 22) !== uncompressed)) {
      invalid(uiText("core.advanced.sampleCatalog.zipLocalSizeOrValidationValuesAre", name))
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    bound(buffer, dataStart, compressed, uiText("core.advanced.sampleCatalog.compressedData"))
    if (dataStart + compressed > centralOffset) invalid(uiText("core.advanced.sampleCatalog.zipDataOverlapWithCentralDirectory"))
    if (!directory) {
      fileNames.add(identity)
      const skipReason = skipExecutable(safeName)
      if (skipReason && !/\/(?:mods\.toml|manifest\.mf)$/i.test(safeName)) entries.push({ path: safeName, skipReason })
      else {
        const raw = buffer.subarray(dataStart, dataStart + compressed)
        let content: Buffer
        try { content = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.min(limits.maxEntryBytes, uncompressed + 1) }) }
        catch { return invalid(uiText("core.advanced.sampleCatalog.zipDecompressionFailed", name)) }
        if (content.length !== uncompressed || crc32(content) !== checksum) invalid(uiText("core.advanced.sampleCatalog.zipUnpressureLengthOrCrcVerificationFailed", name))
        entries.push({ path: safeName, content, skipReason: skipReason ?? executableContentReason(content) })
      }
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
  if (offset !== eocd) invalid(uiText("core.advanced.sampleCatalog.theZipDeclaredNumberOfEntriesDoes"))
  for (const name of fileNames) {
    const parts = name.split('/')
    for (let i = 1; i < parts.length; i++) {
      if (fileNames.has(parts.slice(0, i).join('/'))) invalid(uiText("core.advanced.sampleCatalog.zipFilePathConflictWithDirectoryPath"))
    }
  }
  return { entries, warnings: [] }
}

function textOf(entry: SourceEntry): string | undefined {
  if (!entry.content) return undefined
  try { return UTF8.decode(entry.content).replace(/^\uFEFF/, '') } catch { return undefined }
}

function licenseOf(entries: readonly SourceEntry[]): SampleLicense {
  const evidence = entries.filter(e => /(?:license|copying|readme|mods\.toml|读我|说明|许可)/i.test(e.path))
    .filter(e => /all rights reserved|保留所有权利|禁止.*(?:提取|改写|转载)|不可以做|不得.*(?:提取|转载)/i.test(textOf(e) ?? ''))
    .map(e => e.path)
  const metadataRestricted = entries.some(e => /pack\.mcmeta$/i.test(e.path) && /\bARR\b|all rights reserved|保留所有权利/i.test(textOf(e) ?? ''))
  return { restricted: evidence.length > 0 || metadataRestricted, evidence, requiresAcknowledgement: evidence.length > 0 || metadataRestricted }
}

export function detectSampleMechanisms(paths: readonly string[]): SampleMechanism[] {
  const mechanisms: SampleMechanism[] = []
  const add = (id: string, label: string, runtime: SampleRuntime, pattern: RegExp, notes: string) => {
    const evidence = paths.filter(p => pattern.test(p))
    if (evidence.length) mechanisms.push({ id, label, runtime, evidence, notes })
  }
  add('vanilla-model', uiText("core.advanced.sampleCatalog.originalModelAndSticker"), 'vanilla', /(?:^|\/)assets\/[^/]+\/(?:models|blockstates|items)\/|(?:^|\/)assets\/[^/]+\/textures\//i, uiText("core.advanced.sampleCatalog.modelsStickersCanBeUsedAsResources"))
  add('texture-animation', uiText("core.advanced.sampleCatalog.animationOfOriginalFrame"), 'vanilla', /\.png\.mcmeta$/i, uiText("core.advanced.sampleCatalog.animationMcendaControlFrameWhichIsNot"))
  add('vanilla-core-shader', uiText("core.advanced.sampleCatalog.originalCoreColorsOverride"), 'vanilla', /(?:^|\/)assets\/minecraft\/shaders\/(?:core|include|post|program)\//i, uiText("core.advanced.sampleCatalog.needForStrictMatchingOfTargetVersions"))
  add('optifine-ctm', uiText("core.advanced.sampleCatalog.optifineContinuousOrRandomSquareTexture"), 'optifine', /(?:^|\/)optifine\/ctm\/.*\.properties$/i, uiText("core.advanced.sampleCatalog.originalAndIrisBodyDoesNotResolve"))
  add('optifine-natural', uiText("core.advanced.sampleCatalog.optifineNaturalTexture"), 'optifine', /(?:^|\/)optifine\/natural\.properties$/i, uiText("core.advanced.sampleCatalog.naturalRotationAndFlipIsAnOptifine"))
  add('optifine-random-entity', uiText("core.advanced.sampleCatalog.optifineRandomEntity"), 'optifine', /(?:^|\/)optifine\/(?:random|mob)\/.*\.properties$/i, uiText("core.advanced.sampleCatalog.entityPropertiesAreExtendedSyntaxIrisDoes"))
  add('optifine-cit', uiText("core.advanced.sampleCatalog.optifineCustomTextureOfItems"), 'optifine', /(?:^|\/)optifine\/cit\//i, uiText("core.advanced.sampleCatalog.citIsOptifineExtensionAndCannotMislabel"))
  add('shader-pack', uiText("core.advanced.sampleCatalog.photopackageProgram"), 'shader-mod', /(?:^|\/)shaders\/(?:shaders\.properties|(?:world-?\d+\/)?(?:gbuffers_|composite|deferred|final))/i, uiText("core.advanced.sampleCatalog.optifineIrisPhotoloaderDoesNotRepresentAny"))
  add('mod-renderer', uiText("core.advanced.sampleCatalog.modularCodeAndSpecializedRendering"), 'mod', /\.class$|(?:^|\/)mods\.toml$|mixins.*\.json$|\.mixins\.json$/i, uiText("core.advanced.sampleCatalog.onlyAllowResourceImportClassMixinPrimary"))
  add('mod-shader', uiText("core.advanced.sampleCatalog.modelGroupNameSpaceColoursner"), 'mod', /(?:^|\/)assets\/(?!minecraft\/)[^/]+\/shaders\//i, uiText("core.advanced.sampleCatalog.copyShadowFilesWillNotRegisterShaderinstance"))
  return mechanisms
}

function auditMechanisms(entries: readonly SourceEntry[]): SampleMechanism[] {
  const mechanisms = detectSampleMechanisms(entries.map(e => e.path))
  const evidence: string[] = []
  for (const entry of entries) {
    if (!/(?:^|\/)models\/.*\.json$/.test(entry.path)) continue
    try {
      const model = JSON.parse(textOf(entry) ?? '') as { loader?: unknown }
      if (model && typeof model.loader === 'string') evidence.push(entry.path)
    } catch { continue }
  }
  if (evidence.length) mechanisms.push({ id: 'mod-model-loader', label: uiText("core.advanced.sampleCatalog.modelGroupCustomModelLoader"), runtime: 'mod', evidence, notes: uiText("core.advanced.sampleCatalog.modelLoaderExtensionRequiresCorrespondingModuleRegistration") })
  return mechanisms
}

function packRootsOf(entries: readonly SourceEntry[]): string[] {
  const roots = entries.filter(e => /(?:^|\/)pack\.mcmeta$/i.test(e.path)).map(e => e.path.slice(0, -'pack.mcmeta'.length))
  if (!roots.length && entries.some(e => e.path.startsWith('assets/'))) roots.push('')
  return Array.from(new Set(roots)).sort()
}

function importablePath(value: string): boolean {
  if (value === 'pack.mcmeta' || value === 'pack.png') return true
  if (/^(?:license|copying|readme|notice)(?:[._ -][^/]*)?\.(?:txt|md)$/i.test(value)) return true
  if (/^(?:读我|说明|许可)[^/]*\.(?:txt|md)$/.test(value)) return true
  if (!value.startsWith('assets/') && !value.startsWith('shaders/')) return false
  if (value.startsWith('assets/') && !/^assets\/[a-z0-9_.-]+\/[a-z0-9_./-]+$/.test(value)) return false
  return RESOURCE_EXTENSIONS.has(path.posix.extname(value).toLowerCase()) && !skipExecutable(value)
}

// 替换 JSON 字符串值，不改写其他文本、键名或格式
export function repairTotemModelJson(content: string): { content: string; replacements: number } {
  let parsed: unknown
  try { parsed = JSON.parse(content.replace(/^\uFEFF/, '')) } catch { return invalid(uiText("core.advanced.sampleCatalog.totemModelJsonIsInvalidAndCannot")) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid(uiText("core.advanced.sampleCatalog.totemModelMustBeAJsonObject"))
  let replacements = 0
  const repaired = content.replace(/"(?:\\.|[^"\\])*"/g, (token: string, offset: number) => {
    if (JSON.parse(token) !== '#missing' || /^\s*:/.test(content.slice(offset + token.length))) return token
    replacements++
    return '"#layer0"'
  })
  return { content: repaired, replacements }
}

function buildPlan(read: SourceRead, options: SampleImportOptions, enforceLicense: boolean): SampleImportPlan {
  const roots = packRootsOf(read.entries)
  let root: string
  if (options.packRoot !== undefined) {
    root = options.packRoot
    if (root && !root.endsWith('/')) root += '/'
    if (root) validateSampleEntryPath(root, true)
    if (!roots.includes(root)) invalid(uiText("core.advanced.sampleCatalog.selectedPackrootIsNotInTheScanned"))
  } else {
    if (roots.length > 1) invalid(uiText("core.advanced.sampleCatalog.exampleContainsMultipleRootsSelectExplicitlyBy"))
    root = roots[0] ?? ''
  }
  const selected = read.entries.filter(e => e.path.startsWith(root))
  const license = licenseOf(selected)
  if (enforceLicense && license.requiresAcknowledgement && !options.acknowledgeLicense) invalid(uiText("core.advanced.sampleCatalog.samplesContainingReservedRightsOrWithdrawalRestrictions"))
  const files: GeneratedFile[] = []
  const skipped: SampleSkippedFile[] = []
  const repairs: SampleRepair[] = []
  const warnings = [...read.warnings]
  if (license.restricted) warnings.push(uiText("core.advanced.sampleCatalog.thisSampleContainsReservedRightsOrWithdrawal"))
  if (!read.entries.some(e => e.path === `${root}pack.mcmeta`)) warnings.push(uiText("core.advanced.sampleCatalog.samplesAreMissingPackMcmetaGuiIs"))
  const identities = new Set<string>()
  for (const entry of read.entries) {
    if (!entry.path.startsWith(root)) {
      skipped.push({ path: entry.path, reason: uiText("core.advanced.sampleCatalog.isOutsideTheSelectedResourceBase") })
      continue
    }
    const target = validateSampleEntryPath(entry.path.slice(root.length))
    if (entry.skipReason || !importablePath(target) || (options.includePackMetadata === false && target === 'pack.mcmeta')) {
      skipped.push({ path: entry.path, reason: entry.skipReason ?? (target === 'pack.mcmeta' ? uiText("core.advanced.sampleCatalog.keepTargetPackageMetadata") : uiText("core.advanced.sampleCatalog.nonPermissibleResourceOrNarrativeDocuments")) })
      continue
    }
    const identity = normalizedIdentity(target)
    if (identities.has(identity)) invalid(uiText("core.advanced.sampleCatalog.importOutputPathRepeat"))
    identities.add(identity)
    const bytes = entry.content!
    let content: string | Uint8Array = new Uint8Array(bytes)
    if (options.repairTotemModels !== false && /(?:^|\/)models\/item\/totem_of_undying\.json$/.test(target)) {
      const source = textOf(entry)
      if (source === undefined) invalid(uiText("core.advanced.sampleCatalog.totemModelIsNotAValidUtf"))
      const result = repairTotemModelJson(source)
      if (result.replacements) {
        content = result.content
        repairs.push({ path: target, replacements: result.replacements, description: uiText("core.advanced.sampleCatalog.jsonStringValueMissingIsPreciselyReplaced") })
      }
    }
    files.push({ path: target, content })
  }
  const mechanisms = auditMechanisms(selected)
  if (mechanisms.some(m => m.id === 'vanilla-core-shader')) warnings.push(uiText("core.advanced.sampleCatalog.coreShadowCoversBoundToSpecificGame"))
  if (mechanisms.some(m => m.runtime === 'mod')) warnings.push(uiText("core.advanced.sampleCatalog.modelGroupResourcesCanBeUsedAs"))
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'))
  return { sourceName: options.sourceName ?? 'sample', files, skipped, repairs, warnings, mechanisms, license, packRoots: roots }
}

export function planSampleImportFromZip(bytes: Uint8Array, options: SampleImportOptions = {}): SampleImportPlan {
  return buildPlan(readArchive(bytes, limitsOf(options.limits)), options, true)
}

export function planSampleImportEntries(entries: readonly SampleInputEntry[], options: SampleImportOptions = {}): SampleImportPlan {
  const limits = limitsOf(options.limits)
  if (entries.length > limits.maxEntries) invalid(uiText("core.advanced.sampleCatalog.numberOfExampleEntriesAboveSafetyLimit"))
  let total = 0
  const identities = new Set<string>()
  const source: SourceEntry[] = entries.map(entry => {
    const name = validateSampleEntryPath(entry.path)
    if (entry.symlink) invalid(uiText("core.advanced.sampleCatalog.exampleCannotContainSymbolLinks"))
    const identity = normalizedIdentity(name)
    if (identities.has(identity)) invalid(uiText("core.advanced.sampleCatalog.exampleEntryPathDuplicatesOrThereIs"))
    identities.add(identity)
    const content = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content
    if (!(content instanceof Uint8Array) || content.length > limits.maxEntryBytes || (total += content.length) > limits.maxTotalBytes) invalid(uiText("core.advanced.sampleCatalog.exampleInvalidContentOrSizeExceedingSafety"))
    return { path: name, content: new Uint8Array(content), skipReason: skipExecutable(name) ?? executableContentReason(content) }
  })
  for (const name of identities) {
    const parts = name.split('/')
    for (let i = 1; i < parts.length; i++) {
      if (identities.has(parts.slice(0, i).join('/'))) invalid(uiText("core.advanced.sampleCatalog.exampleFilePathConflictsWithDirectoryPath"))
    }
  }
  return buildPlan({ entries: source, warnings: [] }, options, true)
}

async function readDirectory(root: string, limits: SampleLimits): Promise<SourceRead> {
  const entries: SourceEntry[] = []
  let total = 0
  let count = 0
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      const relative = path.relative(root, full).split(path.sep).join('/')
      validateSampleEntryPath(relative)
      const stat = await fs.lstat(full)
      if (stat.isSymbolicLink()) invalid(uiText("core.advanced.sampleCatalog.denyCatalogLink", relative))
      if (++count > limits.maxEntries) invalid(uiText("core.advanced.sampleCatalog.numberOfDirectoryEntriesAboveSecurityLimit"))
      if (stat.isDirectory()) await visit(full)
      else if (stat.isFile()) {
        if (stat.size > limits.maxEntryBytes || (total += stat.size) > limits.maxTotalBytes) invalid(uiText("core.advanced.sampleCatalog.tableOfContentsExampleSizeAboveSafety"))
        const skipReason = skipExecutable(relative)
        if (skipReason && !/\/(?:mods\.toml|manifest\.mf)$/i.test(relative)) entries.push({ path: relative, skipReason })
        else {
          const content = await fs.readFile(full)
          if (content.length > limits.maxEntryBytes || content.length !== stat.size) invalid(uiText("core.advanced.sampleCatalog.theDirectoryFileChangesDuringReadingOr"))
          entries.push({ path: relative, content, skipReason: skipReason ?? executableContentReason(content) })
        }
      } else invalid(uiText("core.advanced.sampleCatalog.theDirectoryContainsSpecialFiles", relative))
    }
  }
  await visit(root)
  return { entries, warnings: [] }
}

async function readSource(sourcePath: string, limits: SampleLimits): Promise<SourceRead> {
  const stat = await fs.lstat(sourcePath)
  if (stat.isSymbolicLink()) invalid(uiText("core.advanced.sampleCatalog.exampleSourceCannotBeASymbolLink"))
  if (stat.isDirectory()) return readDirectory(sourcePath, limits)
  if (!stat.isFile() || !/\.(zip|jar)$/i.test(sourcePath)) invalid(uiText("core.advanced.sampleCatalog.exampleSourceMustBeAResourceDirectory"))
  if (stat.size > limits.maxArchiveBytes) invalid(uiText("core.advanced.sampleCatalog.archiveExceededTheSizeLimit"))
  return readArchive(await fs.readFile(sourcePath), limits)
}

export async function planSampleImport(sourcePath: string, options: SampleImportOptions = {}): Promise<SampleImportPlan> {
  const resolved = path.resolve(sourcePath)
  return buildPlan(await readSource(resolved, limitsOf(options.limits)), { ...options, sourceName: options.sourceName ?? path.basename(resolved) }, true)
}

export async function scanSampleCatalog(root: string, options: { limits?: Partial<SampleLimits> } = {}): Promise<SampleCatalog> {
  const resolved = path.resolve(root)
  const limits = limitsOf(options.limits)
  const samples: SampleDescriptor[] = []
  const warnings: string[] = []
  let visited = 0
  const inspect = async (sourcePath: string, sourceType: SampleSourceType): Promise<void> => {
    const descriptor: SampleDescriptor = {
      id: path.relative(resolved, sourcePath).split(path.sep).join('/') || '.', label: path.basename(sourcePath), sourcePath, sourceType,
      entryCount: 0, importableFileCount: 0, mechanisms: [], warnings: [], license: { ...EMPTY_LICENSE, evidence: [] }, packRoots: []
    }
    try {
      const read = await readSource(sourcePath, limits)
      descriptor.entryCount = read.entries.length
      descriptor.packRoots = packRootsOf(read.entries)
      descriptor.license = licenseOf(read.entries)
      descriptor.mechanisms = auditMechanisms(read.entries)
      descriptor.warnings = [...read.warnings]
      for (const packRoot of descriptor.packRoots.length ? descriptor.packRoots : ['']) {
        const plan = buildPlan(read, { acknowledgeLicense: true, repairTotemModels: false, ...(descriptor.packRoots.length ? { packRoot } : {}) }, false)
        descriptor.importableFileCount += plan.files.length
        descriptor.warnings.push(...plan.warnings)
      }
      const metadata = read.entries.find(e => /(?:^|\/)pack\.mcmeta$/.test(e.path))
      if (metadata) {
        try { descriptor.packMetadata = JSON.parse(textOf(metadata) ?? '') }
        catch { descriptor.warnings.push(uiText("core.advanced.sampleCatalog.notValidUtfJson")) }
      }
      descriptor.warnings = Array.from(new Set(descriptor.warnings))
    } catch (error) {
      descriptor.error = error instanceof Error ? error.message : String(error)
      descriptor.warnings.push(uiText("core.advanced.sampleCatalog.thisExampleDoesNotPassASecure"))
    }
    samples.push(descriptor)
  }
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    if (entries.some(e => e.isFile() && e.name === 'pack.mcmeta')) {
      await inspect(directory, 'directory')
      return
    }
    for (const entry of entries) {
      if (++visited > limits.maxEntries) invalid(uiText("core.advanced.sampleCatalog.numberOfExampleDirectoriesRunningThroughAbove"))
      const full = path.join(directory, entry.name)
      const stat = await fs.lstat(full)
      if (stat.isSymbolicLink()) { warnings.push(uiText("core.advanced.sampleCatalog.symbolicLinkIgnored", path.relative(resolved, full))); continue }
      if (stat.isDirectory()) await visit(full)
      else if (stat.isFile() && /\.(zip|jar)$/i.test(entry.name)) await inspect(full, /\.jar$/i.test(entry.name) ? 'jar' : 'zip')
    }
  }
  const stat = await fs.lstat(resolved)
  if (!stat.isDirectory() || stat.isSymbolicLink()) invalid(uiText("core.advanced.sampleCatalog.scanRootMustBeAPhysicalDirectory"))
  await visit(resolved)
  samples.sort((a, b) => a.id.localeCompare(b.id, 'en'))
  return { root: resolved, samples, warnings }
}
