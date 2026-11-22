import { uiText } from '../i18n/messages'
import { TODO_RESOURCE, parseTodoBytes } from '../core/todos'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { constants } from 'node:fs'
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { fail, tokenPrefix, type Manifest, type ServerConfig } from './types'

export const hash = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')
export const secret = (): string => tokenPrefix + Array.from({ length: 64 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'[randomInt(52)]).join('')
export const secureEqual = (a: string, b: string): boolean => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)))
export const now = (): string => new Date().toISOString()
export async function exists(file: string): Promise<boolean> { try { await fs.lstat(file); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
export async function atomic(file: string, data: Buffer | string, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = file + '.' + randomBytes(12).toString('hex') + '.tmp'
  try { await fs.writeFile(temporary, data, { mode, flag: 'wx' }); await fs.rename(temporary, file) } finally { await fs.rm(temporary, { force: true }) }
}
export function resourcePath(value: string): string {
  if (value === TODO_RESOURCE) return value
  if (value.length > 1024 || value.includes('\\') || !/^(?:pack\.(?:mcmeta|png)|assets\/.+)$/.test(value)) fail(uiText("collaboration.files.onlyPackMcmetaPackPngAndAssets"))
  const parts = value.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || /[\x00-\x1f<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) || /^\.(?:git|mcrh)(?:$|[-.])/i.test(part))) fail(uiText("collaboration.files.filePathsAreUnsafeOrIncompatibleWindows"))
  return value
}
export async function safeTarget(root: string, relative: string, writing = false): Promise<string> {
  resourcePath(relative)
  const resolved = path.resolve(root), stat = await fs.lstat(resolved)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(uiText("collaboration.files.resourcePackDirectoryCannotBeALink"))
  let target = resolved
  const parts = relative.split('/')
  for (let index = 0; index < parts.length; index++) {
    target = path.join(target, parts[index])
    try {
      const item = await fs.lstat(target)
      if (item.isSymbolicLink() || (writing && item.isFile() && item.nlink > 1)) fail(uiText("collaboration.files.denyLinksOrHardLinkFiles", relative))
      if (index < parts.length - 1 && !item.isDirectory()) fail(uiText("collaboration.files.fatherPathIsNotADirectory", relative))
      const real = await fs.realpath(target), rel = path.relative(resolved, real)
      if (rel.startsWith('..') || path.isAbsolute(rel)) fail(uiText("collaboration.files.fileBeyondResourcePackerDirectory"))
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return target
}
export class Objects {
  constructor(readonly directory: string) {}
  async put(data: Buffer): Promise<string> { const id = hash(data), file = path.join(this.directory, id); if (!await exists(file)) await atomic(file, data); return id }
  async get(id: string): Promise<Buffer> { if (!/^[a-f0-9]{64}$/.test(id)) fail(uiText("collaboration.files.objectIdInvalid")); const data = await fs.readFile(path.join(this.directory, id)); if (hash(data) !== id) fail(uiText("collaboration.files.resourceObjectVerificationFailed"), 500); return data }
}
export async function scanFiles(root: string, objects: Objects, limits: ServerConfig['limits'], signal?: AbortSignal): Promise<Manifest> {
  signal?.throwIfAborted()
  const files: Manifest = Object.create(null), folded = new Set<string>(); let bytes = 0, count = 0
  const visit = async (relative: string, depth: number): Promise<void> => {
    signal?.throwIfAborted()
    if (depth > 64) fail(uiText("collaboration.files.resourceCatalogueLevelOverwrite"))
    const target = await safeTarget(root, relative)
    let stat
    try { stat = await fs.lstat(target) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (stat.isDirectory()) { for (const name of (await fs.readdir(target)).sort()) await visit(relative + '/' + name, depth + 1); return }
    if (!stat.isFile() || stat.nlink > 1) fail(uiText("collaboration.files.specialFilesOrHardLinksAreNot", relative))
    if (++count > limits.files || stat.size > limits.fileBytes || (bytes += stat.size) > limits.packBytes) fail(uiText("collaboration.files.resourcePacksExceedingTheNumberOrSize"))
    const key = relative.toLowerCase(); if (folded.has(key)) fail(uiText("collaboration.files.thereIsACaseConflictPath", relative)); folded.add(key)
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let data: Buffer
    try { data = await handle.readFile({ signal }); const after = await handle.stat(); if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || data.length !== stat.size) fail(uiText("collaboration.files.forChangesDuringDocumentScanningPleaseTry", relative), 409) } finally { await handle.close() }
    signal?.throwIfAborted()
    if (relative === TODO_RESOURCE) parseTodoBytes(data)
    files[relative] = { hash: await objects.put(data), size: data.length }
  }
  for (const name of ['pack.mcmeta', 'pack.png', 'assets', TODO_RESOURCE]) if (await exists(path.join(root, name))) {
    if (name === 'assets') { const stat = await fs.lstat(path.join(root, name)); if (!stat.isDirectory() || stat.isSymbolicLink()) fail(uiText("collaboration.files.assetsMustBeANormalDirectory")); for (const child of (await fs.readdir(path.join(root, name))).sort()) await visit('assets/' + child, 0) }
    else await visit(name, 0)
  }
  signal?.throwIfAborted()
  return files
}
export const sameFiles = (a: Manifest, b: Manifest): boolean => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([name, entry]) => b[name]?.hash === entry.hash)
export function assertManifest(files: Manifest, limits: ServerConfig['limits']): void {
  const names = Object.keys(files), folded = names.map(name => name.toLowerCase())
  if (names.length > limits.files || Object.values(files).some(file => file.size > limits.fileBytes) || Object.values(files).reduce((sum, file) => sum + file.size, 0) > limits.packBytes) fail(uiText("collaboration.files.theConsolidationOfTheResourcePackExceeded"), 413)
  if (new Set(folded).size !== folded.length) fail(uiText("collaboration.files.thereIsACaseConflictPath_040b38"), 409)
  const set = new Set(folded); for (const name of folded) { const parts = name.split('/'); while (parts.length > 1) { parts.pop(); if (set.has(parts.join('/'))) fail(uiText("collaboration.files.fileConflictWithDirectoryStructure"), 409) } }
}
export function assertLayout(before: Manifest, after: Manifest): void {
  const oldNames = Object.keys(before).map(name => name.toLowerCase()), newNames = Object.keys(after).map(name => name.toLowerCase())
  for (const name of oldNames) if (newNames.some(next => next.startsWith(name + '/') || name.startsWith(next + '/'))) fail(uiText("collaboration.files.theStructuralReplacementOfFilesAndDirectories"), 409)
}
export type FileIdentity = { device: string; inode: string; modified: string }
export type WriteReceipt = { backup?: string; replacement?: FileIdentity; deletion?: boolean; installed?: boolean }
async function identity(file: string): Promise<FileIdentity | undefined> {
  try { const stat = await fs.lstat(file, { bigint: true }); if (!stat.isFile() || stat.isSymbolicLink()) return undefined; return { device: String(stat.dev), inode: String(stat.ino), modified: String(stat.mtimeNs) } } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
const sameIdentity = (a?: FileIdentity, b?: FileIdentity): boolean => !!a && !!b && a.device === b.device && a.inode === b.inode && a.modified === b.modified
export async function assertDiskLayout(root: string, names: string[]): Promise<void> {
  for (const name of names) { const target = await safeTarget(root, name, true); try { const stat = await fs.lstat(target); if (!stat.isFile()) fail(uiText("collaboration.files.targetLocationIsNotANormalFile", name), 409) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
}
export async function currentHash(root: string, relative: string): Promise<string | null> { const target = await safeTarget(root, relative, true); try { return hash(await fs.readFile(target)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error } }
export async function rollbackResource(root: string, relative: string, before: Buffer | null, after: string | null, receipt: WriteReceipt | undefined, objects: Objects): Promise<boolean> {
  if (!receipt) return false
  let target: string
  try { target = await safeTarget(root, relative, true); const stat = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return undefined; throw error }); if (stat && !stat.isFile()) return false } catch (error) { if ((error as { statusCode?: number }).statusCode === 400) return false; throw error }
  if (receipt.replacement) {
    const actual = await identity(target)
    if (!actual && !await exists(target) && !receipt.installed && receipt.backup && before) {
      const backup = path.resolve(receipt.backup), recovery = path.resolve(root, '.mcrh-recovery')
      if (path.dirname(backup) !== recovery || !await exists(backup) || hash(await fs.readFile(backup)) !== hash(before)) return false
      await writeResource(root, relative, before, { expected: null, objects }); return true
    }
    if (!sameIdentity(actual, receipt.replacement) || await currentHash(root, relative) !== after) return false
  }
  else {
    if (!receipt.deletion || await exists(target) || !receipt.backup) return false
    const recovery = path.resolve(root, '.mcrh-recovery'), backup = path.resolve(receipt.backup)
    if (path.dirname(backup) !== recovery || !before || !await exists(backup) || hash(await fs.readFile(backup)) !== hash(before)) return false
  }
  await writeResource(root, relative, before, { expected: after, expectedIdentity: receipt.replacement, objects }); return true
}
export async function writeResource(root: string, relative: string, data: Buffer | null, guard?: { expected: string | null; expectedIdentity?: FileIdentity; objects: Objects; record?: (receipt: WriteReceipt) => Promise<void> }): Promise<void> {
  const target = await safeTarget(root, relative, true)
  if (guard) {
    const actual = await currentHash(root, relative)
    if (actual !== guard.expected || guard.expectedIdentity && !sameIdentity(await identity(target), guard.expectedIdentity)) { if (actual) await guard.objects.put(await fs.readFile(target)); fail(uiText("collaboration.files.beforeWritingNewChangesWereDiscoveredAnd", relative), 409) }
    const recovery = path.join(root, '.mcrh-recovery')
    await fs.mkdir(recovery, { recursive: true }); const recoveryStat = await fs.lstat(recovery); if (!recoveryStat.isDirectory() || recoveryStat.isSymbolicLink()) fail(uiText("collaboration.files.restoreDirectoryIsNotANormalDirectory"))
    const backup = path.join(recovery, randomBytes(16).toString('hex')), temporary = path.join(recovery, randomBytes(16).toString('hex') + '.new')
    let claimed = false
    try {
      if (data !== null) await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o644 })
      const replacement = data === null ? undefined : await identity(temporary)
      const receipt: WriteReceipt = { backup: actual === null ? undefined : backup, replacement, deletion: data === null, installed: false }
      await guard.record?.(receipt)
      if (actual !== null) {
        await fs.rename(target, backup); claimed = true
        const previous = await fs.readFile(backup); await guard.objects.put(previous)
        await atomic(backup + '.json', JSON.stringify({ path: relative, at: now(), hash: hash(previous) }))
        if (hash(previous) !== guard.expected || guard.expectedIdentity && !sameIdentity(await identity(backup), guard.expectedIdentity)) fail(uiText("collaboration.files.newChangesWereFoundDuringReplacementAnd", relative), 409)
      }
      if (data === null) { if (await exists(target)) fail(uiText("collaboration.files.duringTheDeletionPeriodFilesWereRecreated", relative), 409); return }
      await fs.mkdir(path.dirname(target), { recursive: true }); await safeTarget(root, relative, true); await fs.link(temporary, target); await guard.record?.({ ...receipt, installed: true })
    } catch (error) { if (claimed) { try { await fs.copyFile(backup, target, constants.COPYFILE_EXCL) } catch {} } throw error }
    finally { await fs.rm(temporary, { force: true }) }
    return
  }
  if (data === null) { await fs.rm(target, { force: true }); return }
  await fs.mkdir(path.dirname(target), { recursive: true }); await safeTarget(root, relative, true); await atomic(target, data, 0o644)
}
