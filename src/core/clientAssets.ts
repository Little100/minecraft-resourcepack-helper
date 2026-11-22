import { activeLanguage } from '../i18n/messages'
import { uiText } from '../i18n/messages'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { previewClientStoragePath, type PreviewStorageContext } from './previewClientStorage'
import { inflateRawSync } from 'node:zlib'
import { Worker } from 'node:worker_threads'
import { resizeClientReleaseTextures, VANILLA_TEXTURE_RESOLUTION, type ClientTextureResizeReport } from './clientTextureResolution'
import type { ClientAssetsWorkerMessage, ClientAssetsWorkerOperation, ClientAssetsWorkerResults, ClientAssetsWorkerTask } from './clientAssetsWorkerProtocol'
import { safeRelativePath } from './advanced/safeExport'
import packFormatTable from './data/packFormats.json'
import { createPackMetadata, getVersionCapabilities, metadataSchemaForFormat, type PackFormat } from './advanced/versionCapabilities'

export interface ExtractProgress { message: string; increment?: number }
export interface ExtractResult { targetDir: string; fileCount: number; skipped: string[]; failedCount: number }
export interface ReleaseTarget { fsPath: string }
export interface ReleaseFile { target: ReleaseTarget; data: Uint8Array }
export interface ClientSourceManifest { version: string; sha1: string; size: number }
export interface ClientReleaseOptions { textureResolution?: number }
export interface ReleasePlan {
  root: string
  source: string
  version: string
  files: ReleaseFile[]
  skipped: string[]
  failedCount: number
  versionConfirmed: boolean
  sourceManifest?: ClientSourceManifest
  textureResize?: ClientTextureResizeReport
}

declare const __MCRH_CLIENT_ASSETS_WORKER_PATH__: string | undefined

// 打包版和直接编译版的后台脚本位置不同
async function runClientAssetsWorker<Operation extends ClientAssetsWorkerOperation>(operation: Operation, jarFile: string, targetDir: string, version: string, onProgress?: (progress: ExtractProgress) => void, sourceManifest?: ClientSourceManifest, signal?: AbortSignal, options?: ClientReleaseOptions): Promise<ClientAssetsWorkerResults[Operation]> {
  signal?.throwIfAborted()
  const entry = typeof __MCRH_CLIENT_ASSETS_WORKER_PATH__ === 'undefined' ? 'clientAssetsWorker.js' : __MCRH_CLIENT_ASSETS_WORKER_PATH__
  const task: ClientAssetsWorkerTask = { operation, jarFile: path.resolve(jarFile), targetDir: path.resolve(targetDir), version, sourceManifest, options }
  const worker = new Worker(path.join(__dirname, entry), { workerData: { ...task, interfaceLanguage: activeLanguage() }, execArgv: [] })
  let abort: (() => void) | undefined
  let result: ClientAssetsWorkerResults[Operation]
  try {
    result = await new Promise<ClientAssetsWorkerResults[Operation]>((resolve, reject) => {
      let settled = false
      const fail = (error: unknown): void => { if (!settled) { settled = true; reject(error) } }
      abort = () => fail(signal?.reason)
      worker.on('message', (message: ClientAssetsWorkerMessage) => {
        if (settled) return
        try {
          signal?.throwIfAborted()
          if (message.type === 'progress') onProgress?.(message.progress)
          else if (message.type === 'error') {
            const error: NodeJS.ErrnoException = new Error(message.error.message)
            error.name = message.error.name; error.code = message.error.code
            if (message.error.stack) error.stack = message.error.stack
            fail(error)
          } else if (message.operation !== operation) fail(new Error(uiText("core.clientAssets.invalidReturnTypeOfClientResourceBack")))
          else { settled = true; resolve(message.result as ClientAssetsWorkerResults[Operation]) }
        } catch (error) { fail(error) }
      })
      worker.once('error', fail)
      worker.once('exit', code => fail(new Error(uiText("core.clientAssets.clientResourceBackOfficeJobQuitEarly", code))))
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  } finally {
    if (abort) signal?.removeEventListener('abort', abort)
    try { await worker.terminate() } finally { worker.removeAllListeners() }
  }
  signal?.throwIfAborted()
  return result
}

// 在后台准备文件，转交数据时不复制
export function planClientReleaseAsync(jarFile: string, targetDir: string, version: string, onProgress?: (progress: ExtractProgress) => void, sourceManifest?: ClientSourceManifest, signal?: AbortSignal, options?: ClientReleaseOptions): Promise<ReleasePlan> {
  return runClientAssetsWorker('plan', jarFile, targetDir, version, onProgress, sourceManifest, signal, options)
}

// 后台检查并写入预览缓存，调用方负责启用缓存目录
export function extractClientReleaseAsync(jarFile: string, targetDir: string, version: string, onProgress?: (progress: ExtractProgress) => void, sourceManifest?: ClientSourceManifest, signal?: AbortSignal): Promise<ExtractResult> {
  return runClientAssetsWorker('extract', jarFile, targetDir, version, onProgress, sourceManifest, signal)
}

export const CLIENT_ASSETS_MANIFEST = '.mcrh-vanilla.json'
export const CLIENT_ASSETS_EXTRACTION_SCHEMA = 2
export const CLIENT_ASSETS_POLICY = 'all-safe-assets'
export const CLIENT_ASSETS_LIMITS = Object.freeze({ maxArchiveBytes: 512 * 1024 * 1024, maxEntries: 100_000, maxEntryBytes: 256 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024 })
const EXECUTABLE = /\.(?:class|jar|war|ear|zip|7z|rar|exe|dll|com|msi|scr|sys|cpl|ocx|so|dylib|app|deb|rpm|apk|dex|wasm|bat|cmd|ps1|psm1|psd1|sh|bash|zsh|fish|vbs|vbe|wsf|wsh|hta|js|jsx|mjs|cjs|ts|tsx|py|pyc|pyo|rb|pl|pm|php|lua|luac|groovy|kts|jsh)(?:\.|$)/i
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  return value >>> 0
})

export function validateClientVersion(version: string): void {
  if (typeof version !== 'string' || !version || version.length > 128 || version !== version.trim() || version.includes('/') || version.includes('\\')) throw new Error(uiText("core.clientAssets.minecraftVersionIdentificationInvalid"))
  safeRelativePath(version)
}

// 资源目录采用开放分类，路径和运行内容仍受独立校验
function isAsset(name: string): boolean {
  const parts = name.split('/')
  return parts[0] === 'assets' && ((parts.length === 2 && !!parts[1]) || (parts.length >= 3 && /^[a-z0-9_.-]+$/.test(parts[1])))
}

function executableBytes(data: Uint8Array): boolean {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const magic = bytes.length >= 4 ? bytes.readUInt32BE(0) : 0
  return (bytes[0] === 0x4d && bytes[1] === 0x5a) || (bytes[0] === 0x23 && bytes[1] === 0x21) || [0xcafebabe, 0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0x504b0304, 0x0061736d].includes(magic)
}

function checksum(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255]
  return (crc ^ 0xffffffff) >>> 0
}

interface ArchiveFile { size: number; crc: number; compressed: number; dataStart: number; method: number; flags: number }

// 解压前检查 ZIP 目录和大小，避免把不完整的包当成完整包
function inspectArchive(buffer: Buffer, skipped: string[]): Map<string, ArchiveFile> {
  let end = -1
  for (let cursor = buffer.length - 22; cursor >= Math.max(0, buffer.length - 65557); cursor--) {
    if (buffer.readUInt32LE(cursor) === 0x06054b50 && cursor + 22 + buffer.readUInt16LE(cursor + 20) === buffer.length) { end = cursor; break }
  }
  if (end < 0) throw new Error(uiText("core.clientAssets.theClientSZipEndRecordIs"))
  const count = buffer.readUInt16LE(end + 10)
  const centralSize = buffer.readUInt32LE(end + 12)
  const centralOffset = buffer.readUInt32LE(end + 16)
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || buffer.readUInt16LE(end + 8) !== count) throw new Error(uiText("core.clientAssets.doNotSupportMultivolumeClientZip"))
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error(uiText("core.clientAssets.unsupportedZip64ClientArchive"))
  if (count > CLIENT_ASSETS_LIMITS.maxEntries || centralOffset + centralSize !== end) throw new Error(uiText("core.clientAssets.invalidClientZipCentralDirectoryOrEntry"))
  const selected = new Map<string, ArchiveFile>()
  const identities = new Set<string>()
  let total = 0
  let cursor = centralOffset
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error(uiText("core.clientAssets.clientZipCentralDirectoryCorrupted"))
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const crc = buffer.readUInt32LE(cursor + 16)
    const compressed = buffer.readUInt32LE(cursor + 20)
    const size = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const next = cursor + 46 + nameLength + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32)
    const attributes = buffer.readUInt32LE(cursor + 38)
    const local = buffer.readUInt32LE(cursor + 42)
    if (next > end || buffer.readUInt16LE(cursor + 34) || [compressed, size, local].includes(0xffffffff)) throw new Error(uiText("core.clientAssets.clientZipEntriesCrossedBordersOrIn"))
    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameLength)
    const name = (flags & 0x800) ? new TextDecoder('utf-8', { fatal: true }).decode(rawName) : rawName.toString('latin1')
    cursor = next
    if (!isAsset(name) && name !== 'pack.mcmeta' && name !== 'version.json') continue
    const directory = name.endsWith('/')
    try { safeRelativePath(directory ? name.slice(0, -1) : name) } catch { skipped.push(name); continue }
    if (((attributes >>> 16) & 0xf000) === 0xa000) throw new Error(uiText("core.clientAssets.clientZipResourcesCannotContainSymbolLinks"))
    if (directory) { if (size) throw new Error(uiText("core.clientAssets.invalidClientZipDirectoryContent")); continue }
    if (EXECUTABLE.test(name)) { skipped.push(name); continue }
    const identity = name.normalize('NFC').toLowerCase()
    if (identities.has(identity)) throw new Error(uiText("core.clientAssets.clientZipResourcePathDuplicate"))
    identities.add(identity)
    if (size > CLIENT_ASSETS_LIMITS.maxEntryBytes || (total += size) > CLIENT_ASSETS_LIMITS.maxTotalBytes) throw new Error(uiText("core.clientAssets.clientResourceReleaseBudgetExcess"))
    if (method !== 0 && method !== 8) throw new Error(uiText("core.clientAssets.clientZipCompressionMethodNotSupported"))
    if (local + 30 > centralOffset || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error(uiText("core.clientAssets.couldNotCloseTemporaryFolderS"))
    const localNameLength = buffer.readUInt16LE(local + 26)
    const dataStart = local + 30 + localNameLength + buffer.readUInt16LE(local + 28)
    if (dataStart + compressed > centralOffset || buffer.readUInt16LE(local + 6) !== flags || buffer.readUInt16LE(local + 8) !== method || !buffer.subarray(local + 30, local + 30 + localNameLength).equals(rawName)) throw new Error(uiText("core.clientAssets.clientZipLocalFileHeaderDoesNot"))
    if (!(flags & 8) && (buffer.readUInt32LE(local + 14) !== crc || buffer.readUInt32LE(local + 18) !== compressed || buffer.readUInt32LE(local + 22) !== size)) throw new Error(uiText("core.clientAssets.clientZipLocalSizeOrValidationUnconsistent"))
    selected.set(name, { size, crc, compressed, dataStart, method, flags })
  }
  if (cursor !== end) throw new Error(uiText("core.clientAssets.clientZipDeclaredEntriesIncomplete"))
  for (const name of identities) {
    const parts = name.split('/')
    for (let index = 1; index < parts.length; index++) if (identities.has(parts.slice(0, index).join('/'))) throw new Error(uiText("core.clientAssets.clientResourceFileConflictWithDirectory"))
  }
  return selected
}

// 缺失元数据时使用客户端自身声明的格式，保留主次格式并兼容旧客户端
export function clientPackMetadata(version: string, metadata?: unknown): Uint8Array {
  validateClientVersion(version)
  let packFormat: PackFormat | null | undefined
  if (metadata && typeof metadata === 'object' && 'pack_version' in metadata) {
    const raw = metadata.pack_version
    if (raw && typeof raw === 'object') {
      const major = 'resource_major' in raw ? raw.resource_major : 'resource' in raw ? raw.resource : undefined
      const minor = 'resource_minor' in raw ? raw.resource_minor : 0
      if (typeof major !== 'number' || !Number.isSafeInteger(major) || major < 1 || typeof minor !== 'number' || !Number.isSafeInteger(minor) || minor < 0) throw new Error(uiText("core.clientAssets.invalidMetadataForClientResourcePackFormat"))
      packFormat = { major, minor }
    }
  }
  packFormat ??= getVersionCapabilities(version)?.resourcePackFormat
  if (!packFormat) {
    const entry = packFormatTable.versions.find(entry => entry.id === version)
    if (entry && Number.isSafeInteger(entry.rpk) && entry.rpk > 0) packFormat = { major: entry.rpk, minor: entry.rpkMinor ?? 0 }
  }
  if (!packFormat) throw new Error(uiText("core.clientAssets.iCanTTellResourcePackFormat", version))
  return Buffer.from(JSON.stringify(createPackMetadata(packFormat, metadataSchemaForFormat('resource', packFormat), 'Minecraft ' + version + ' vanilla resources'), null, 2) + '\n')
}

export function planClientRelease(jarFile: string, targetDir: string, version: string, onProgress?: (progress: ExtractProgress) => void, sourceManifest?: ClientSourceManifest, options?: ClientReleaseOptions): ReleasePlan {
  validateClientVersion(version)
  if (sourceManifest && (sourceManifest.version !== version || !/^[a-f0-9]{40}$/i.test(sourceManifest.sha1) || !Number.isSafeInteger(sourceManifest.size) || sourceManifest.size <= 0)) throw new Error(uiText("core.clientAssets.invalidClientSourceList"))
  const stat = fs.lstatSync(jarFile)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > CLIENT_ASSETS_LIMITS.maxArchiveBytes) throw new Error(uiText("core.clientAssets.clientJarInvalidOrOversizedBudget"))
  onProgress?.({ message: uiText("core.clientAssets.readJar") })
  const skipped: string[] = []
  const buffer = fs.readFileSync(jarFile)
  const selected = inspectArchive(buffer, skipped)
  const failed: string[] = []
  if (!selected.size) throw new Error(uiText("core.clientAssets.noResourceParsedInClientJar"))
  const root = path.resolve(targetDir, `minecraft-${version}`)
  const files: ReleaseFile[] = []
  let versionConfirmed = sourceManifest?.version === version
  let versionMetadata: unknown
  onProgress?.({ message: uiText("core.clientAssets.parsingEntry", selected.size) })
  for (const [name, meta] of selected) {
    if (meta.flags & 1) { failed.push(name); continue }
    let data: Buffer
    try {
      const raw = buffer.subarray(meta.dataStart, meta.dataStart + meta.compressed)
      data = meta.method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.min(CLIENT_ASSETS_LIMITS.maxEntryBytes, meta.size + 1) })
      if (data.length !== meta.size || checksum(data) !== meta.crc) { failed.push(name); continue }
    } catch { failed.push(name); continue }
    const entry = { name, data }
    if (entry.name === 'version.json') {
      const metadata: unknown = JSON.parse(entry.data.toString('utf8'))
      if (typeof metadata !== 'object' || metadata === null || !('id' in metadata) || typeof metadata.id !== 'string') throw new Error(uiText("core.clientAssets.clientVersionMetadataInvalid"))
      if (metadata.id !== version) throw new Error(uiText("core.clientAssets.clientVersionInconsistentWithRequestedVersion"))
      versionConfirmed = true
      versionMetadata = metadata
      continue
    }
    if (executableBytes(entry.data)) { skipped.push(entry.name); continue }
    const target = path.join(root, entry.name)
    if (!isInside(root, target)) { skipped.push(entry.name); continue }
    files.push({ target: { fsPath: target }, data: entry.data })
  }
  if (files.some(file => path.relative(root, file.target.fsPath).split(path.sep)[0] === 'assets') && !files.some(file => file.target.fsPath === path.join(root, 'pack.mcmeta'))) {
    files.push({ target: { fsPath: path.join(root, 'pack.mcmeta') }, data: clientPackMetadata(version, versionMetadata) })
  }
  const plan: ReleasePlan = { root, source: path.basename(jarFile), version, files, skipped, failedCount: failed.length, versionConfirmed, sourceManifest }
  if (options?.textureResolution !== undefined) {
    const report = resizeClientReleaseTextures(plan, options.textureResolution, CLIENT_ASSETS_LIMITS.maxTotalBytes, message => onProgress?.({ message }))
    if (report.resolution !== VANILLA_TEXTURE_RESOLUTION) plan.textureResize = report
  }
  return plan
}

// 检查现有祖先和最终文件，拒绝通过链接触及缓存或释放目录之外的内容
export async function assertClientAssetsPath(target: string): Promise<void> {
  const absolute = path.resolve(target)
  const volume = path.parse(absolute).root
  let cursor = volume
  for (const part of absolute.slice(volume.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    try {
      const stat = await fs.promises.lstat(cursor)
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (cursor !== absolute || !stat.isFile() || stat.nlink !== 1))) throw new Error(uiText("core.clientAssets.resourcePathContainsSymbolicLinksConnectDirectory"))
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}

export function clientAssetCategories(names: readonly string[]): { includedCategories: string[]; includedNamespaces: string[] } {
  const assets = names.filter(isAsset).map(name => name.split('/'))
  return { includedCategories: [...new Set(assets.map(parts => parts.length > 3 ? parts[2] : '(root)'))].sort(), includedNamespaces: [...new Set(assets.filter(parts => parts.length >= 3).map(parts => parts[1]))].sort() }
}

export async function writeClientRelease(plan: ReleasePlan, targets: Set<string> | 'all', onProgress?: (progress: ExtractProgress) => void, signal?: AbortSignal): Promise<ExtractResult> {
  const checkAbort = () => signal?.throwIfAborted()
  checkAbort()
  const marker = path.join(plan.root, CLIENT_ASSETS_MANIFEST)
  await assertClientAssetsPath(marker)
  await fs.promises.mkdir(plan.root, { recursive: true })
  await fs.promises.rm(marker, { force: true })
  const selectedFiles = plan.files.filter(file => targets === 'all' || targets.has(file.target.fsPath))
  const total = selectedFiles.length
  let fileCount = 0
  let nextFile = 0
  let failed = false
  let writeError: unknown
  let latestCompletedPath = ''
  let lastReportedAt = 0
  let reportedPercentage = 0
  const activeFiles = new Map<number, string>()
  const reportProgress = (force = false, complete = false): void => {
    const now = Date.now()
    if (!force && now - lastReportedAt < 100) return
    lastReportedAt = now
    const currentPath = Array.from(activeFiles.values()).pop() ?? (latestCompletedPath || selectedFiles[0]?.target.fsPath)
    const relativePath = currentPath ? path.relative(plan.root, currentPath).split(path.sep).join('/') : ''
    const displayPath = relativePath.length > 36 ? '…' + relativePath.slice(-35) : relativePath
    const percentage = complete ? 100 : total ? fileCount / total * 99 : 0
    const increment = percentage - reportedPercentage
    reportedPercentage = percentage
    try { onProgress?.({ message: uiText("core.clientAssets.writing", fileCount, total, displayPath ? ' · ' + displayPath : uiText("core.clientAssets.entry")), increment }) } catch {}
  }
  reportProgress(true)
  const writeNext = async (workerId: number): Promise<void> => {
    while (!failed) {
      const file = selectedFiles[nextFile++]
      if (!file) return
      const fsPath = file.target.fsPath
      try {
        checkAbort()
        if (!isInside(plan.root, fsPath)) throw new Error(uiText("core.clientAssets.resourceWritingPathsBeyondReleaseDirectory"))
        activeFiles.set(workerId, fsPath)
        reportProgress()
        await assertClientAssetsPath(fsPath)
        await fs.promises.mkdir(path.dirname(fsPath), { recursive: true })
        await assertClientAssetsPath(fsPath)
        const handle = await fs.promises.open(fsPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | (targets === 'all' ? 0 : fs.constants.O_EXCL))
        try {
          const stat = await handle.stat()
          if (!stat.isFile() || stat.nlink !== 1) throw new Error(uiText("core.clientAssets.theResourceTargetIsNotASeparate"))
          await handle.truncate(0)
          await handle.writeFile(file.data)
        } finally { await handle.close() }
        fileCount++
        latestCompletedPath = fsPath
        activeFiles.delete(workerId)
        if (!failed) reportProgress()
      } catch (error) {
        if (!failed) writeError = error
        failed = true
      } finally {
        activeFiles.delete(workerId)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, total) }, (_, workerId) => writeNext(workerId)))
  if (failed) throw writeError
  reportProgress(true)
  checkAbort()
  const names = plan.files.map(file => path.relative(plan.root, file.target.fsPath).split(path.sep).join('/'))
  const manifest = {
    version: plan.version, source: plan.source, extractedAt: new Date().toISOString(), fileCount: plan.files.length, assetsRoot: 'assets',
    extractionSchema: CLIENT_ASSETS_EXTRACTION_SCHEMA, assetPolicy: CLIENT_ASSETS_POLICY, ...clientAssetCategories(names),
    versionConfirmed: plan.versionConfirmed, complete: !plan.textureResize && plan.versionConfirmed && !plan.failedCount && fileCount === plan.files.length && names.some(isAsset),
    totalBytes: plan.files.reduce((total, file) => total + file.data.byteLength, 0), failedCount: plan.failedCount, sourceManifest: plan.sourceManifest, textureResolution: plan.textureResize?.resolution
  }
  await assertClientAssetsPath(marker)
  await fs.promises.writeFile(marker, JSON.stringify(manifest, null, 2), { encoding: 'utf8', flag: 'wx' })
  reportProgress(true, true)
  return { targetDir: plan.root, fileCount, skipped: plan.skipped, failedCount: plan.failedCount }
}

export function selectReleaseTargets(plan: ReleasePlan, existing: readonly ReleaseTarget[], choice: 'overwrite' | 'skip'): Set<string> | 'all' {
  if (choice === 'overwrite') return 'all'
  const taken = new Set(existing.map(uri => uri.fsPath))
  const selected = new Set(plan.files.map(file => file.target.fsPath).filter(fsPath => !taken.has(fsPath)))
  if (plan.textureResize) {
    for (const file of plan.files) {
      const png = file.target.fsPath
      if (png.endsWith('.png') && (taken.has(png) || taken.has(png + '.mcmeta'))) {
        selected.delete(png)
        selected.delete(png + '.mcmeta')
      }
    }
  }
  return selected
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export function cacheDir(context: PreviewStorageContext): string {
  return path.join(previewClientStoragePath(context), 'client-cache')
}

export async function removeCachedJar(file: string): Promise<void> {
  try { await fs.promises.rm(file, { force: true }) } catch {
    // 清理缓存失败时仍返回结果
  }
}
