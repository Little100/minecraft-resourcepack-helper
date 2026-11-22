import { uiText } from '../i18n/messages'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { diagnoseResourcePack, inferPackVersion, type DiagnosticFile } from '../core/advanced/packDiagnostics'
import { listPackConversionTargets } from '../core/advanced/packConversion'
import { assertExportPathWithoutLinks, readSafeExportFile } from '../core/advanced/exportPolicy'
import { findPreviewClientAssets } from './previewClientAssets'
import { AdvancedPanel } from './advancedPanel'
import { PackDiagnosisPanel } from './packDiagnosisPanel'

export type PackCommandSource = vscode.Uri | { resourceUri?: vscode.Uri }
export async function packCommandRoot(source?: PackCommandSource): Promise<string | undefined> {
  const uri = source instanceof vscode.Uri ? source : source?.resourceUri
  if (uri?.scheme === 'file') {
    let directory = uri.fsPath
    if (!(await fs.lstat(directory)).isDirectory()) directory = path.dirname(directory)
    while (path.dirname(directory) !== directory) {
      try { if ((await fs.lstat(path.join(directory, 'pack.mcmeta'))).isFile()) return directory } catch {}
      directory = path.dirname(directory)
    }
    if ((await fs.lstat(uri.fsPath)).isDirectory()) return uri.fsPath
  }
  const selected = await vscode.window.showOpenDialog({ title: uiText("ui.packDiagnosisCommand.selectTheResourcePackRootDirectoryTo"), canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri })
  return selected?.[0]?.scheme === 'file' ? selected[0].fsPath : undefined
}
async function snapshot(root: string, canceled: () => boolean, modelsOnly = false): Promise<DiagnosticFile[]> {
  await assertExportPathWithoutLinks(root)
  const files: DiagnosticFile[] = []
  let total = 0, entries = 0
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 64) throw new Error(uiText("ui.packDiagnosisCommand.theLevelOfTheDirectoryExceedsThe"))
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      if (canceled()) throw new Error(uiText("core.advanced.packDiagnostics.diagnosisCancelled"))
      if (++entries > 200000) throw new Error(uiText("ui.packDiagnosisCommand.catalogueEntriesExceedTheDiagnosticBudget"))
      const relative = prefix + item.name
      if (item.isSymbolicLink()) throw new Error(uiText("ui.packDiagnosisCommand.diagnosisDoesNotFollowADocumentOr", relative))
      if (item.isDirectory()) {
        if (!prefix && /^(?:node_modules|\.git|\.mcrh-|\.vscode|tmp|out|web-dist)/i.test(item.name)) continue
        await walk(path.join(directory, item.name), relative + '/', depth + 1)
      } else if (item.isFile()) {
        if (files.length >= 100000) throw new Error(uiText("ui.packDiagnosisCommand.resourceDocumentsExceededTheDiagnosticBudget"))
        const needed = !modelsOnly || /\.(?:json|mcmeta)$/.test(relative)
        const content = needed ? await readSafeExportFile(root, relative, 32 * 1024 * 1024) : new Uint8Array()
        total += content.length
        if (total > 256 * 1024 * 1024) throw new Error(uiText("ui.packDiagnosisCommand.diagnosisOverMibBudget"))
        files.push({ path: relative, content })
      }
    }
  }
  await walk(root, '', 0)
  return files
}
export function registerPackDiagnosisCommands(context: vscode.ExtensionContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('mcrh.diagnosePack', async (source?: PackCommandSource) => {
      try {
        const root = await packCommandRoot(source); if (!root) return
        let meta: unknown
        try { meta = JSON.parse(new TextDecoder().decode(await readSafeExportFile(root, 'pack.mcmeta', 4 * 1024 * 1024))) } catch {}
        const configured = vscode.workspace.getConfiguration('mcrh').get<string>('previewMinecraftVersion', '').trim()
        const targets = listPackConversionTargets()
        const target = targets.find(entry => entry.id === configured)?.id ?? (await vscode.window.showQuickPick(targets.map(entry => ({ label: entry.id, description: uiText("ui.packDiagnosisCommand.javaEditionPackageFormat", entry.format.major, entry.format.minor, (entry.id === inferPackVersion(meta) ? uiText("ui.packDiagnosisCommand.thePackageVersionPleaseConfirmThatIt") : '')) })), { title: uiText("ui.packDiagnosisCommand.selectTheActuallyRunningMinecraftJavaVersion"), placeHolder: uiText("ui.packDiagnosisCommand.theDiagnosisWillCheckIfThisVersion") }))?.label
        if (!target) return
        const scan = async () => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: uiText("ui.packDiagnosisCommand.mcrhDiagnosticResourceKit"), cancellable: true }, async (_progress, token) => {
          const files = await snapshot(root, () => token.isCancellationRequested)
          const configuredBase = vscode.workspace.getConfiguration('mcrh').get<string>('previewBaseAssetsPath', '').trim()
          let base = await findPreviewClientAssets(context, target, [path.dirname(root)]), baseWarning: string | undefined
          if (configuredBase) {
            let baseVersion: string | undefined
            try { const marker = JSON.parse(new TextDecoder().decode(await readSafeExportFile(configuredBase, '.mcrh-vanilla.json', 64 * 1024))); if (typeof marker.version === 'string') baseVersion = marker.version } catch {}
            if (!baseVersion) { try { baseVersion = inferPackVersion(JSON.parse(new TextDecoder().decode(await readSafeExportFile(configuredBase, 'pack.mcmeta', 4 * 1024 * 1024)))) } catch {} }
            if (baseVersion === target) base = configuredBase
            else baseWarning = uiText("ui.packDiagnosisCommand.versionOfBasicResourcesAllocatedICan", (baseVersion ? uiText("ui.packDiagnosisCommand.yes", baseVersion) : uiText("ui.packDiagnosisCommand.unconfirmable")), target)
          }
          const baseFiles = base && path.resolve(base) !== path.resolve(root) ? await snapshot(base, () => token.isCancellationRequested, true) : undefined
          const result = await diagnoseResourcePack(files, { targetVersion: target, baseFiles, canceled: () => token.isCancellationRequested })
          if (baseWarning) { result.issues.unshift({ severity: 'warning', code: 'base-version', path: '', message: baseWarning, suggestion: uiText("ui.packDiagnosisCommand.configureOriginalDirectoriesThatClearlyMatchTarget") }); result.warnings++ }
          return { report: result, baseRoot: baseFiles ? base : undefined }
        })
        await PackDiagnosisPanel.show(context, root, scan).run()
      } catch (error) { await vscode.window.showErrorMessage(uiText("ui.packDiagnosisCommand.theDiagnosisOfTheResourceKitWas", (error instanceof Error ? error.message : String(error)))) }
    }),
    vscode.commands.registerCommand('mcrh.convertPackVersion', async (source?: PackCommandSource) => {
      try { const root = source ? await packCommandRoot(source) : undefined; AdvancedPanel.show(context).openPackTools('conversion', root) }
      catch (error) { await vscode.window.showErrorMessage(uiText("ui.packDiagnosisCommand.couldNotCloseTemporaryFolderS", (error instanceof Error ? error.message : String(error)))) }
    })
  ]
}
