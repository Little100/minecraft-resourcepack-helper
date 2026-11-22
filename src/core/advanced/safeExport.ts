import { uiText } from '../../i18n/messages'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

export interface GeneratedFile { path: string; content: string | Uint8Array }
export interface ExportPlan { root: string; files: GeneratedFile[]; conflicts: string[] }
const MAX_FILES = 4096
const MAX_BYTES = 128 * 1024 * 1024

export function safeRelativePath(value: string): string {
  if (!value || value.length > 1024 || /[\\\u0000-\u001f:]/.test(value) || value.startsWith('/')) throw new Error(uiText("core.advanced.safeExport.theOutputPathMustBeASafe"))
  const parts = value.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /[<>"|?*]/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new Error(uiText("core.advanced.safeExport.outputPathContainsAnUnsafeName"))
  return parts.join('/')
}

async function rejectLinks(root: string, relative: string): Promise<void> {
  const volume = path.parse(root).root
  let cursor = volume
  const parts = [...root.slice(volume.length).split(path.sep).filter(Boolean), ...relative.split('/').filter(Boolean)]
  for (const part of ['', ...parts]) {
    if (part) cursor = path.join(cursor, part)
    try {
      const stat = await fs.lstat(cursor)
      if (stat.isSymbolicLink()) throw new Error(uiText("core.advanced.exportPolicy.exportPathCannotGoThroughASymbol"))
      if (cursor !== path.join(root, relative) && !stat.isDirectory()) throw new Error(uiText("core.advanced.safeExport.theParentDirectoryOfTheOutputPath"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

export async function prepareExport(root: string, files: GeneratedFile[]): Promise<ExportPlan> {
  if (!path.isAbsolute(root) || !files.length || files.length > MAX_FILES) throw new Error(uiText("core.advanced.safeExport.invalidNumberOfExportedDirectoriesOrFiles"))
  const resolved = path.resolve(root)
  await rejectLinks(resolved, '')
  if (!(await fs.lstat(resolved)).isDirectory()) throw new Error(uiText("core.advanced.safeExport.exportRootPathMustBeTheActual"))
  const names = new Set<string>()
  const conflicts: string[] = []
  let size = 0
  for (const file of files) {
    const relative = safeRelativePath(file.path)
    const key = relative.toLowerCase()
    if (names.has(key)) throw new Error(uiText("core.advanced.safeExport.outputFilePathDuplicated"))
    names.add(key)
    if (typeof file.content !== 'string' && !(file.content instanceof Uint8Array)) throw new Error(uiText("core.advanced.safeExport.outputFileContentInvalid"))
    size += typeof file.content === 'string' ? Buffer.byteLength(file.content) : file.content.byteLength
    if (size > MAX_BYTES) throw new Error(uiText("core.advanced.safeExport.outputContentAboveSecurityLimit"))
    await rejectLinks(resolved, relative)
    try {
      const stat = await fs.lstat(path.join(resolved, relative))
      if (!stat.isFile()) throw new Error(uiText("core.advanced.safeExport.targetNameOccupiedByDirectoryOrSpecial"))
      conflicts.push(relative)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return { root: resolved, files, conflicts }
}

export async function commitExport(plan: ExportPlan, overwrite = false, signal?: AbortSignal, assertUnchanged?: (relative: string, root: string) => Promise<void>): Promise<{ written: string[]; backup?: string }> {
  const checkAbort = () => { if (signal?.aborted) throw new Error(uiText("core.advanced.safeExport.exportCancelledGeneratedFileKeptInThe")) }
  checkAbort()
  const fresh = await prepareExport(plan.root, plan.files)
  if (fresh.conflicts.some(name => !plan.conflicts.includes(name))) throw new Error(uiText("core.advanced.safeExport.newConflictDocumentsHaveEmergedDuringConfirmation"))
  checkAbort()
  if (fresh.conflicts.length && !overwrite) throw new Error(uiText("core.advanced.safeExport.documentWithTheSameNameNotAuthorized"))
  const staging = path.join(plan.root, `.mcrh-export-${randomUUID()}`)
  const backup = path.join(plan.root, '.mcrh-backups', randomUUID())
  const written: string[] = []
  const moved: string[] = []
  await fs.mkdir(staging, { recursive: true })
  try {
    for (const file of fresh.files) {
      checkAbort()
      const staged = path.join(staging, file.path)
      await fs.mkdir(path.dirname(staged), { recursive: true })
      await fs.writeFile(staged, file.content)
    }
    for (const file of fresh.files) {
      checkAbort()
      await rejectLinks(plan.root, file.path)
      const target = path.join(plan.root, file.path)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await assertUnchanged?.(file.path, plan.root)
      if (fresh.conflicts.includes(file.path)) {
        await rejectLinks(plan.root, path.relative(plan.root, backup).replace(/\\/g, '/'))
        await fs.mkdir(path.dirname(path.join(backup, file.path)), { recursive: true })
        await fs.rename(target, path.join(backup, file.path))
        moved.push(file.path)
        await assertUnchanged?.(file.path, backup)
      } else {
        try { await fs.lstat(target); throw new Error(uiText("core.advanced.safeExport.aNewSameNameFileAppearedDuring")) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      await fs.rename(path.join(staging, file.path), target)
      written.push(file.path)
    }
    checkAbort()
    return { written, backup: moved.length ? backup : undefined }
  } catch (error) {
    const recoveryErrors: string[] = []
    for (const name of [...written].reverse()) {
      try {
        const recovered = path.join(staging, 'recovered', name)
        await fs.mkdir(path.dirname(recovered), { recursive: true })
        await fs.rename(path.join(plan.root, name), recovered)
      } catch (recovery) { recoveryErrors.push(String(recovery)) }
    }
    for (const name of moved) {
      try { await fs.rename(path.join(backup, name), path.join(plan.root, name)) }
      catch (recovery) { recoveryErrors.push(String(recovery)) }
    }
    if (recoveryErrors.length) throw new Error(uiText("core.advanced.safeExport.exportFailedAndPartialRecoveryFailedAll", staging, backup, String(error), recoveryErrors.join('; ')))
    throw error
  }
}
