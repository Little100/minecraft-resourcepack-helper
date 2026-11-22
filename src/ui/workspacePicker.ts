import { uiText } from '../i18n/messages'
import * as vscode from 'vscode'
import { workspaceRoots } from '../core/packDetector'

export async function pickWorkspaceRoot(): Promise<string | undefined> {
  const roots = workspaceRoots()
  if (roots.length === 0) {
    await vscode.window.showWarningMessage(uiText("ui.workspacePicker.synchronisingFolderFailedSS"))
    return undefined
  }
  if (roots.length === 1) return roots[0]
  return vscode.window.showQuickPick(roots, { placeHolder: uiText("ui.workspacePicker.selectAFolderForTheTargetArea") })
}
