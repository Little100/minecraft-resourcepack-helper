import { uiText } from '../i18n/messages'
import * as vscode from 'vscode'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { profileRootFromGlobalStorage, WEBVIEW_REPAIR_LIFETIME_MS, type WebviewRepairPlan, type WebviewRepairState } from '../core/webviewRepair'
import { extensionLog } from './extensionLog'

export function automaticWebviewRepairAvailable(context: vscode.ExtensionContext): boolean {
  const defaultProfile = path.basename(path.dirname(path.dirname(context.globalStorageUri.fsPath))).toLowerCase() === 'user'
  return defaultProfile && vscode.env.appHost === 'desktop' && !vscode.env.remoteName && ['win32', 'linux'].includes(process.platform) &&
    context.extensionMode === vscode.ExtensionMode.Production && Number.isSafeInteger(Number(process.env.VSCODE_PID)) && Number(process.env.VSCODE_PID) > 0
}

export async function startAutomaticWebviewRepair(context: vscode.ExtensionContext, resetCache: boolean, shouldProceed: () => boolean = () => true): Promise<void> {
  if (!automaticWebviewRepairAvailable(context)) throw new Error(uiText("ui.webviewRecovery.theCurrentExtensionEnvironmentCannotBeRestarted"))
  const userDataDir = profileRootFromGlobalStorage(context.globalStorageUri.fsPath)
  const helper = vscode.Uri.joinPath(context.extensionUri, 'out', 'webview-repair.cjs').fsPath
  if (!(await fs.stat(helper)).isFile()) throw new Error(uiText("ui.webviewRecovery.couldNotCloseTemporaryFolderS"))
  const directory = path.join(context.globalStorageUri.fsPath, 'webview-repair')
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const plan: WebviewRepairPlan = {
    id: randomUUID(), mainPid: Number(process.env.VSCODE_PID), expiresAt: Date.now() + WEBVIEW_REPAIR_LIFETIME_MS,
    executable: process.execPath, userDataDir, extensionsDir: path.dirname(context.extensionUri.fsPath), resetCache,
    workspaces: vscode.workspace.workspaceFile?.scheme === 'file' ? [vscode.workspace.workspaceFile.fsPath] :
      vscode.workspace.workspaceFolders?.length === 1 && vscode.workspace.workspaceFolders[0].uri.scheme === 'file' ? [vscode.workspace.workspaceFolders[0].uri.fsPath] : []
  }
  const job = path.join(directory, plan.id + '.json')
  await fs.writeFile(job, JSON.stringify(plan), { flag: 'wx', mode: 0o600 })
  const child = spawn(process.execPath, [helper, job], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, detached: true, stdio: 'ignore' })
  let launchError: Error | undefined
  child.on('error', error => { launchError = error })
  child.unref()
  const cancel = () => fs.writeFile(job + '.cancel', '', { mode: 0o600 })
  const readState = async (): Promise<WebviewRepairState | undefined> => {
    try { const state = JSON.parse(await fs.readFile(job + '.state.json', 'utf8')) as WebviewRepairState; return state.id === plan.id ? state : undefined }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  }
  try {
    const readyDeadline = Date.now() + 5000
    let readyState: WebviewRepairState | undefined
    while (!(readyState = await readState())) {
      if (launchError) throw launchError
      if (Date.now() >= readyDeadline) throw new Error(uiText("ui.webviewRecovery.backstageRepairNotReadyNotExitedVs"))
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (Date.now() >= plan.expiresAt) throw new Error(uiText("ui.webviewRecovery.backstageRepairRequestExpiredNotQuitVs"))
    if (readyState.phase !== 'waiting') throw new Error(readyState.error ?? uiText("ui.webviewRecovery.backstageRepairRequestCancelledOrExpiredAnd"))
    if (!shouldProceed()) { await cancel(); await vscode.window.showInformationMessage(uiText("ui.webviewRecovery.pagesRestoredClosedOrEditedChangedAnd")); return }
    extensionLog('info', uiText("ui.webviewRecovery.automaticallyFixesPreparedWaitingForVsCode", (resetCache ? uiText("ui.webviewRecovery.backupServiceWorkerCacheAfterExit") : uiText("ui.webviewRecovery.closeCache"))))
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true, title: uiText("ui.webviewRecovery.tryingToFixWebviewWaitingForVs") }, async (_progress, token) => {
      const subscription = token.onCancellationRequested(() => { void cancel().catch(error => extensionLog('warn', uiText("ui.webviewRecovery.undoAutofixFailed", String(error)))) })
      try {
        if (Date.now() >= plan.expiresAt || token.isCancellationRequested || !shouldProceed()) { await cancel(); return }
        await vscode.commands.executeCommand('workbench.action.quit')
        while (Date.now() < plan.expiresAt && !token.isCancellationRequested) {
          const state = await readState()
          if (state?.phase === 'started') return
          if (state && state.phase !== 'waiting') {
            if (state.phase === 'failed') throw new Error(uiText("ui.webviewRecovery.autostartNotCompletedSeeTheDiagnosisAnd"))
            break
          }
          await new Promise(resolve => setTimeout(resolve, 250))
        }
        await cancel()
        extensionLog('info', uiText("ui.webviewRecovery.vsCodeDidNotExitThisAutomatic"))
      } finally { subscription.dispose() }
    })
  } catch (error) { await cancel().catch(() => undefined); throw error }
}
