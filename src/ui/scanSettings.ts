import { uiText } from '../i18n/messages'
import * as vscode from 'vscode'
import { mergeCustomScanPaths, resolveScanSettings, type ScanSettings } from '../core/scanRoots'
import { workspaceRoots } from '../core/packDetector'

export function configuredScanSettings(): ScanSettings {
  const settings = vscode.workspace.getConfiguration('mcrh')
  return resolveScanSettings(workspaceRoots(), settings.get<unknown>('scanExtraPaths', []), settings.get<unknown>('scanDepth', 2))
}

export function registerScanCommands(rescan: () => Promise<void>): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('mcrh.addScanFolder', async () => {
      const selected = await vscode.window.showOpenDialog({ title: uiText("ui.scanSettings.addCustomPackageScanDirectoryDefaultCheck"), canSelectFiles: false, canSelectFolders: true, canSelectMany: true })
      if (!selected?.length) return
      if (selected.some(uri => uri.scheme !== 'file')) { await vscode.window.showWarningMessage(uiText("ui.scanSettings.scanCurrentSupportLocalFolders")); return }
      const config = vscode.workspace.getConfiguration('mcrh')
      const current = config.get<unknown>('scanExtraPaths', [])
      const mergedPaths = mergeCustomScanPaths(current, selected.map(uri => uri.fsPath))
      const target = config.inspect('scanExtraPaths')?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global
      await config.update('scanExtraPaths', mergedPaths, target)
      await rescan()
      await vscode.window.showInformationMessage(uiText("ui.scanSettings.customScanDirectoryAddedAndScanned"))
    }),
    vscode.commands.registerCommand('mcrh.configureScan', async () => { await vscode.commands.executeCommand('workbench.action.openSettings', 'mcrh.scan') })
  ]
}
