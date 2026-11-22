import { uiText } from '../i18n/messages'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { pathKey } from '../core/packScanner'
import { assertExportPathWithoutLinks } from '../core/advanced/exportPolicy'

export interface ResourceChange { relative: string; content: string | Uint8Array; expected: Uint8Array | undefined }
const MAX_FILE_BYTES = 8 * 1024 * 1024

export function resourceTarget(root: string, relative: string): string {
  if (!relative || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(relative)) throw new Error(uiText("ui.resourceAuthoringFiles.resourcePathInvalid"))
  const target = path.resolve(root, relative), inside = path.relative(path.resolve(root), target)
  if (!inside || inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) throw new Error(uiText("ui.resourceAuthoringFiles.resourcePathBeyondResourcePackDirectory"))
  return target
}

export async function savedResource(root: string, relative: string): Promise<Uint8Array | undefined> {
  const target = resourceTarget(root, relative), uri = vscode.Uri.file(target)
  await assertExportPathWithoutLinks(target, true)
  if (vscode.workspace.textDocuments.some(document => document.uri.scheme === 'file' && pathKey(document.uri.fsPath) === pathKey(uri.fsPath) && document.isDirty)) throw new Error(uiText("ui.resourceAuthoringFiles.couldNotCloseTemporaryFolderS", relative))
  try {
    const stat = await fs.lstat(target)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) throw new Error(uiText("ui.resourceAuthoringFiles.targetsAreNotSupportedGeneralFilesOr", relative))
    const bytes = await fs.readFile(target)
    if (bytes.length > MAX_FILE_BYTES) throw new Error(uiText("ui.resourceAuthoringFiles.fileExceedingSizeLimitDuringReading", relative))
    return bytes
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

export async function applyResourceChanges(root: string, files: readonly ResourceChange[], directories: readonly string[] = [], validateSource: () => void = () => {}): Promise<void> {
  if (!files.length || files.length > 256) throw new Error(uiText("ui.resourceAuthoringFiles.oneOperationRequiresToFiles"))
  const seen = new Set<string>()
  for (const file of files) {
    const target = resourceTarget(root, file.relative).toLowerCase()
    if (seen.has(target)) throw new Error(uiText("ui.resourceAuthoringFiles.writeTargetDuplicate", file.relative))
    seen.add(target)
  }
  const validate = async (): Promise<void> => {
    for (const file of files) {
      const current = await savedResource(root, file.relative)
      if ((current === undefined) !== (file.expected === undefined) || current && file.expected && !Buffer.from(current).equals(Buffer.from(file.expected))) throw new Error(uiText("ui.resourceAuthoringFiles.theTargetHasChangedDuringTheConfirmation", file.relative))
    }
  }
  await validate()
  for (const relative of new Set([...directories, ...files.map(file => path.posix.dirname(file.relative))])) {
    const target = resourceTarget(root, relative)
    await assertExportPathWithoutLinks(target, true)
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(target))
  }
  const edit = new vscode.WorkspaceEdit()
  const snapshots = new Map<string, { document: vscode.TextDocument; version: number; text: string }>()
  for (const file of files) {
    const uri = vscode.Uri.file(resourceTarget(root, file.relative))
    if (file.expected === undefined) edit.createFile(uri, { overwrite: false, contents: typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content })
    else {
      if (typeof file.content !== 'string') throw new Error(uiText("ui.resourceAuthoringFiles.aBinaryAlreadyExistsDoesNotSupport"))
      const document = await vscode.workspace.openTextDocument(uri)
      if (document.isDirty) throw new Error(uiText("ui.resourceAuthoringFiles.targetHasUnsavedChanges", file.relative))
      const savedText = new TextDecoder('utf-8', { fatal: true }).decode(file.expected).replace(/^\uFEFF/, '')
      if (document.getText() !== savedText) throw new Error(uiText("ui.resourceAuthoringFiles.theEditorContentDoesNotMatchThe", file.relative))
      snapshots.set(pathKey(uri.fsPath), { document, version: document.version, text: document.getText() })
      edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), file.content)
    }
  }
  await validate()
  validateSource()
  for (const file of files) {
    const key = pathKey(resourceTarget(root, file.relative)), snapshot = snapshots.get(key)
    const current = vscode.workspace.textDocuments.find(document => document.uri.scheme === 'file' && pathKey(document.uri.fsPath) === key)
    if (snapshot && (snapshot.document.isClosed || snapshot.document.isDirty || snapshot.document.version !== snapshot.version || snapshot.document.getText() !== snapshot.text) || current?.isDirty) throw new Error(uiText("ui.resourceAuthoringFiles.theTargetProducesANewEditorBefore", file.relative))
  }
  if (!await vscode.workspace.applyEdit(edit, { isRefactoring: true })) throw new Error(uiText("ui.resourceAuthoringFiles.vsCodeFailedToApplyAllChanges"))
}
