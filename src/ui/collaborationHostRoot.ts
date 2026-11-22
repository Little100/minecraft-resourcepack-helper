import { uiText } from '../i18n/messages'
import * as vscode from 'vscode'

export async function selectCollaborationHostRoot(customDirectory = false): Promise<string | undefined> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file')
  if (!customDirectory && folders.length === 1) return folders[0].uri.fsPath
  if (!customDirectory && folders.length > 1) {
    const selected = await vscode.window.showQuickPick([
      ...folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, root: folder.uri.fsPath })),
      { label: uiText("ui.collaborationHostRoot.customServiceDirectory"), description: uiText("ui.collaborationHostRoot.selectADirectoryOutsideTheCurrentWorking"), root: undefined }
    ], { title: uiText("ui.collaborationHostRoot.selectTheWorkspaceRootDirectoryUsedAs") })
    if (!selected) return undefined
    if (selected.root) return selected.root
  }
  return (await vscode.window.showOpenDialog({ title: uiText("ui.collaborationHostRoot.selectTheServiceEndResourcePackDirectory"), canSelectFolders: true, canSelectFiles: false, canSelectMany: false }))?.[0]?.fsPath
}
