import { uiText } from '../../i18n/messages'
import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import * as path from 'node:path'
import { safeRelativePath, type GeneratedFile } from './safeExport'

export const PACK_EXPORT_LIMITS = Object.freeze({ bytes: 256 * 1024 * 1024, fileBytes: 64 * 1024 * 1024, files: 16384, entries: 32768, depth: 64 })
export interface VanillaExportOptions { includeVanillaTextures?: boolean; scope?: 'textures' | 'resources' }
export interface VanillaExportResult { files: GeneratedFile[]; omitted: string[] }

function bytesOf(content: GeneratedFile['content']): Uint8Array {
  if (typeof content === 'string') return new TextEncoder().encode(content)
  if (!(content instanceof Uint8Array)) throw new Error(uiText("core.advanced.exportPolicy.exportFileContentsToUtfTextOr"))
  return content
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false
  return true
}

function isTexture(relative: string): boolean { return /\.png$/i.test(relative) }
function isVanillaResource(relative: string): boolean { return relative.startsWith('assets/') || relative === 'pack.png' }

export function applyVanillaExportPolicy(files: Array<GeneratedFile>, vanilla: ReadonlyMap<string, Uint8Array>, options: VanillaExportOptions = {}): VanillaExportResult {
  if (options.includeVanillaTextures !== undefined && typeof options.includeVanillaTextures !== 'boolean') throw new Error(uiText("core.advanced.exportPolicy.theOriginalPosterExportOptionMustBe"))
  if (options.scope !== undefined && !['textures', 'resources'].includes(options.scope)) throw new Error(uiText("core.advanced.exportPolicy.invalidOriginalResourceFilterRange"))
  const indexed = new Map<string, GeneratedFile>()
  for (const file of files) {
    const relative = safeRelativePath(file.path)
    if (indexed.has(relative.toLowerCase())) throw new Error(uiText("core.advanced.exportPolicy.exportFilePathDuplicated"))
    if (typeof file.content !== 'string' && !(file.content instanceof Uint8Array)) throw new Error(uiText("core.advanced.exportPolicy.exportFileContentsToUtfTextOr"))
    indexed.set(relative.toLowerCase(), file)
  }
  for (const relative of indexed.keys()) {
    const parts = relative.split('/')
    for (let length = 1; length < parts.length; length++) if (indexed.has(parts.slice(0, length).join('/'))) throw new Error(uiText("core.advanced.exportPolicy.exportFileConflictWithDirectoryPath"))
  }
  for (const [relative, bytes] of vanilla) {
    safeRelativePath(relative)
    if (!(bytes instanceof Uint8Array)) throw new Error(uiText("core.advanced.exportPolicy.originalReferencesMustBeOriginalBytesOf"))
  }
  const omitted = new Set<string>()
  if (!options.includeVanillaTextures) {
    for (const file of files) {
      if (!isTexture(file.path)) {
        if (options.scope === 'resources' && isVanillaResource(file.path) && !/\.png\.mcmeta$/i.test(file.path)) {
          const original = vanilla.get(file.path)
          if (original && sameBytes(bytesOf(file.content), original)) omitted.add(file.path)
        }
        continue
      }
      const original = vanilla.get(file.path)
      if (!original || !sameBytes(bytesOf(file.content), original)) continue
      const metadata = indexed.get((file.path + '.mcmeta').toLowerCase())
      if (metadata) {
        const originalMetadata = vanilla.get(metadata.path)
        if (!originalMetadata || !sameBytes(bytesOf(metadata.content), originalMetadata)) continue
        omitted.add(metadata.path)
      }
      omitted.add(file.path)
    }
  }
  return { files: files.filter(file => !omitted.has(file.path)), omitted: files.filter(file => omitted.has(file.path)).map(file => file.path) }
}

export function isInsideExportDirectory(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

export async function assertExportPathWithoutLinks(target: string, allowMissing = false): Promise<boolean> {
  if (!path.isAbsolute(target)) throw new Error(uiText("core.advanced.exportPolicy.exportPathMustBeAbsolute"))
  const resolved = path.resolve(target), volume = path.parse(resolved).root
  let cursor = volume
  const parts = resolved.slice(volume.length).split(path.sep).filter(Boolean)
  for (let index = 0; index <= parts.length; index++) {
    if (index) cursor = path.join(cursor, parts[index - 1])
    try {
      const stat = await fs.lstat(cursor)
      if (stat.isSymbolicLink()) throw new Error(uiText("core.advanced.exportPolicy.exportPathCannotGoThroughASymbol"))
      if (index < parts.length && !stat.isDirectory()) throw new Error(uiText("core.advanced.exportPolicy.theParentOfTheExportPathMust"))
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  return true
}

export async function readSafeExportFile(root: string, relative: string, maxBytes: number = PACK_EXPORT_LIMITS.fileBytes): Promise<Uint8Array> {
  safeRelativePath(relative)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 256 * 1024 * 1024) throw new Error(uiText("core.advanced.exportPolicy.theFileReadsTheBudgetInvalid"))
  if (!path.isAbsolute(root)) throw new Error(uiText("core.advanced.exportPolicy.exportRootDirectoryMustBeAbsolutePath"))
  const file = path.resolve(root, ...relative.split('/'))
  if (!isInsideExportDirectory(root, file)) throw new Error(uiText("core.advanced.exportPolicy.exportFileOverRootDirectory"))
  await assertExportPathWithoutLinks(file)
  const before = await fs.lstat(file)
  if (!before.isFile() || before.size > maxBytes) throw new Error(uiText("core.advanced.exportPolicy.readingFilesIsNotNormalOrMore", Math.round(maxBytes / 1024 / 1024)))
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error(uiText("core.advanced.exportPolicy.fileChangedDuringReadingExportStopped"))
    const bytes = new Uint8Array(before.size + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    const after = await handle.stat()
    await assertExportPathWithoutLinks(file)
    const current = await fs.lstat(file)
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.dev !== before.dev || current.ino !== before.ino) throw new Error(uiText("core.advanced.exportPolicy.fileChangedDuringReadingExportStopped"))
    return bytes.subarray(0, length)
  } finally { await handle.close() }
}

export async function readVanillaExportBase(baseRoot: string | undefined, files: ReadonlyArray<Pick<GeneratedFile, 'path'>>, options: Pick<VanillaExportOptions, 'scope'> = {}): Promise<ReadonlyMap<string, Uint8Array>> {
  if (options.scope !== undefined && !['textures', 'resources'].includes(options.scope)) throw new Error(uiText("core.advanced.exportPolicy.invalidOriginalResourceFilterRange"))
  const vanilla = new Map<string, Uint8Array>()
  if (!baseRoot?.trim()) return vanilla
  if (!path.isAbsolute(baseRoot)) throw new Error(uiText("core.advanced.exportPolicy.theOriginalReferenceDirectoryMustBeAbsolute"))
  const root = path.resolve(baseRoot)
  if (!await assertExportPathWithoutLinks(root, true)) return vanilla
  if (!(await fs.lstat(root)).isDirectory()) throw new Error(uiText("core.advanced.exportPolicy.theOriginalReferenceMustBeADepressed"))
  const candidates = new Set<string>()
  for (const file of files) {
    safeRelativePath(file.path)
    if (isTexture(file.path) || isTexture(file.path.replace(/\.mcmeta$/i, '')) || options.scope === 'resources' && isVanillaResource(file.path)) candidates.add(file.path)
  }
  if (candidates.size > PACK_EXPORT_LIMITS.files) throw new Error(uiText("core.advanced.exportPolicy.theNumberOfOriginalReferenceFilesExceeded"))
  let total = 0
  for (const relative of candidates) {
    try {
      const target = path.join(root, ...relative.split('/'))
      if (!await assertExportPathWithoutLinks(target, true)) continue
      const stat = await fs.lstat(target)
      if (!stat.isFile() || stat.size > PACK_EXPORT_LIMITS.fileBytes || total + stat.size > PACK_EXPORT_LIMITS.bytes) throw new Error(uiText("core.advanced.exportPolicy.theOriginalReferenceFileIsNotA"))
      const content = await readSafeExportFile(root, relative)
      total += content.byteLength
      if (total > PACK_EXPORT_LIMITS.bytes) throw new Error(uiText("core.advanced.exportPolicy.theOriginalReferenceExceedsTheMibLimit"))
      vanilla.set(relative, content)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return vanilla
}
