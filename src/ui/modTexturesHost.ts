import { uiText } from '../i18n/messages'
import * as vscode from 'vscode'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { assertExportPathWithoutLinks, readSafeExportFile } from '../core/advanced/exportPolicy'
import { prepareExport, commitExport } from '../core/advanced/safeExport'
import { MOD_TEXTURE_LIMITS, ModTextureRequest, readModTextures, resolveModDuplicates, planModTextures, modFiles, type ModTexturePack, type ModConflictChoice } from '../core/advanced/modTextures'

export class ModTexturesHost implements vscode.Disposable {
  private controller?: AbortController
  private disposed = false
  get busy(): boolean { return Boolean(this.controller) }
  constructor(private readonly webview: vscode.Webview, private readonly available: () => boolean = () => true) {}
  dispose(): void { this.disposed = true; this.controller?.abort() }
  private post(message: object): void { if (!this.disposed) void this.webview.postMessage(message) }
  async handle(raw: unknown): Promise<boolean> {
    if (!raw || typeof raw !== 'object' || !('command' in raw) || typeof raw.command !== 'string' || !raw.command.startsWith('modTextures')) return false
    const parsed = ModTextureRequest.safeParse(raw)
    const requestId = 'requestId' in raw && typeof raw.requestId === 'string' ? raw.requestId.slice(0, 128) : 'invalid'
    const done = (ok: boolean, text: string, canceled = false) => this.post({ type: 'modTexturesResult', requestId, ok, text, canceled })
    if (!parsed.success) { done(false, uiText("browser.modTexturesBridge.modularImportRequestInvalid")); return true }
    if (parsed.data.command === 'modTexturesCancel') { this.controller?.abort(); return true }
    if (this.busy || !this.available()) { done(false, uiText("browser.modTexturesBridge.otherFilesAreNotFinishedPleaseTry")); return true }
    const controller = this.controller = new AbortController(), signal = controller.signal
    const check = () => { signal.throwIfAborted(); if (this.disposed) throw new Error(uiText("ui.modTexturesHost.pageClosed")) }
    const notes: string[] = []
    let committing = false
    const choose = async (paths: string[], title: string): Promise<ModConflictChoice> => {
      check(); this.post({ type: 'modTexturesProgress', requestId, text: title + '\n' + paths.join('\n') })
      const choice = await vscode.window.showWarningMessage(title, { modal: true, detail: uiText("ui.modTexturesHost.keepExistingMetadataWhenThePasteAnd", paths.slice(0, 60).join('\n'), (paths.length > 60 ? uiText("ui.modTexturesHost.fullListInDesktopImportReport") : '')) }, uiText("browser.modTexturesBridge.replaceMatchingPaths"), uiText("browser.modTexturesBridge.keepExistingFiles"))
      check(); return choice === uiText("browser.modTexturesBridge.replaceMatchingPaths") ? 'replace' : choice === uiText("browser.modTexturesBridge.keepExistingFiles") ? 'keep' : 'cancel'
    }
    try {
      const selected = await vscode.window.showOpenDialog({ title: uiText("ui.modTexturesHost.selectModuleJarStrikePasteOnlyDo"), canSelectFiles: true, canSelectFolders: false, canSelectMany: true, filters: { JAR: ['jar'] } }); check()
      if (!selected?.length) { done(true, uiText("ui.modTexturesHost.cancelledProjectUnchanged"), true); return true }
      let compressed = 0
      const packs: ModTexturePack[] = []
      for (const uri of selected) {
        check()
        if (uri.scheme !== 'file' || !/\.jar$/i.test(uri.fsPath)) { notes.push(uiText("ui.modTexturesHost.skippedNonLocalJar")); continue }
        try {
          await assertExportPathWithoutLinks(uri.fsPath)
          const stat = await fs.lstat(uri.fsPath)
          compressed += stat.size
          if (compressed > MOD_TEXTURE_LIMITS.archiveBytes) throw new Error(uiText("ui.modTexturesHost.selectedJarTotalsMoreThanMibImport"))
          const bytes = await readSafeExportFile(path.dirname(uri.fsPath), path.basename(uri.fsPath), MOD_TEXTURE_LIMITS.archiveBytes)
          const pack = await readModTextures(bytes, path.basename(uri.fsPath), check)
          modFiles([...packs.flatMap(value => value.groups), ...pack.groups]); packs.push(pack)
          notes.push(path.basename(uri.fsPath) + uiText("browser.modTexturesBridge.modular") + pack.ids.join(', ') + uiText("browser.modTexturesBridge.namespace") + pack.namespaces.join(', ') + '; ' + pack.groups.length + uiText("browser.modTexturesBridge.poster"), ...pack.warnings)
        } catch (error) { check(); notes.push(path.basename(uri.fsPath) + uiText("browser.modTexturesBridge.discarded") + String(error) + ')') }
      }
      check()
      if (compressed > MOD_TEXTURE_LIMITS.archiveBytes) throw new Error(uiText("ui.modTexturesHost.theSelectedJarTotalExceededMibAnd"))
      const groups = await resolveModDuplicates(packs, paths => choose(paths, uiText("ui.modTexturesHost.thereSSomethingBetweenTheSelectedModules", paths.length)))
      check()
      if (!groups) { done(true, uiText("ui.modTexturesHost.cancelledProjectUnchanged_7fecd8", notes.join('\n')), true); return true }
      modFiles(groups)
      if (!groups.length) { done(false, uiText("browser.modTexturesBridge.noValidModTexturesToImport", notes.join('\n'))); return true }
      const selectedRoot = await vscode.window.showOpenDialog({ title: uiText("ui.modTexturesHost.selectTheResourcePackBaseThatYou"), canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri }); check()
      if (!selectedRoot?.[0]) { done(true, uiText("ui.modTexturesHost.cancelledProjectUnchanged"), true); return true }
      if (selectedRoot[0].scheme !== 'file') throw new Error(uiText("ui.modTexturesHost.onlySupportLocalResourcePackDirectories"))
      const root = selectedRoot[0].fsPath
      const meta = await readSafeExportFile(root, 'pack.mcmeta')
      if (!JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(meta).replace(/^\uFEFF/, '')).pack) throw new Error(uiText("ui.modTexturesHost.theSelectedDirectoryIsNotAResource"))
      const fingerprints = new Map<string, string | undefined>()
      const fingerprint = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
      const read = async (relative: string): Promise<Uint8Array | undefined> => {
        check()
        try { const bytes = await readSafeExportFile(root, relative); if (!fingerprints.has(relative)) fingerprints.set(relative, fingerprint(bytes)); return bytes }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; if (!fingerprints.has(relative)) fingerprints.set(relative, undefined); return undefined }
      }
      const plan = await planModTextures(groups, read); check()
      let choice: ModConflictChoice = 'keep'
      if (plan.conflicts.length) choice = await choose(plan.conflicts.map(group => group.path), uiText("ui.modTexturesHost.projectsAlreadyExistASideMapOf", plan.conflicts.length))
      if (choice === 'cancel') { done(true, uiText("ui.modTexturesHost.cancelledProjectUnchanged"), true); return true }
      const files = modFiles([...plan.additions, ...(choice === 'replace' ? plan.conflicts : [])])
      if (!files.length) { done(true, uiText("ui.modTexturesHost.noDocumentToWriteReserveExistingOr", notes.join('\n'))); return true }
      const exportPlan = await prepareExport(root, files)
      const confirm = await vscode.window.showInformationMessage(uiText("ui.modTexturesHost.addToResourcePackAPosterResource", files.length, (exportPlan.conflicts.length ? uiText("ui.modTexturesHost.originalsThatHaveBeenAuthorizedForReplacement") : '')), { modal: true, detail: root + '\n' + plan.warnings.join('\n') }, uiText("ui.modTexturesHost.confirmImport")); check()
      if (confirm !== uiText("ui.modTexturesHost.confirmImport")) { done(true, uiText("ui.modTexturesHost.cancelledProjectUnchanged"), true); return true }
      for (const [relative, expected] of fingerprints) {
        const current = await read(relative)
        if ((current ? fingerprint(current) : undefined) !== expected) throw new Error(uiText("ui.modTexturesHost.pleaseReImportTheProjectFileDuring", relative))
      }
      check()
      committing = true
      const result = await commitExport(exportPlan, choice === 'replace', signal, async (relative, candidateRoot) => {
        const expected = fingerprints.get(relative)
        let current: Uint8Array | undefined
        try { current = await readSafeExportFile(candidateRoot, relative) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if ((current ? fingerprint(current) : undefined) !== expected) throw new Error(uiText("ui.modTexturesHost.projectDocumentsChangedDuringSubmissionStoppedAnd", relative))
      })
      done(true, uiText("ui.modTexturesHost.importedResourceFileTo", result.written.length, root, notes.join('\n'), plan.warnings.join('\n'), (result.backup ? uiText("ui.modTexturesHost.originalBackup", result.backup) : ''), result.written.join('\n')))
    } catch (error) { done(false, signal.aborted && !committing ? uiText("ui.modTexturesHost.canceledNotStartedWritingItems") : String(error), signal.aborted) }
    finally { if (this.controller === controller) this.controller = undefined }
    return true
  }
}
