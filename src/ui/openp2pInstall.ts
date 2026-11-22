import { uiText } from '../i18n/messages'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { ensureBundledOpenP2P } from '../collaboration/p2pBundle'
import { verifyOpenP2PExecutable } from '../collaboration/openp2p'

export async function selectOpenP2PExecutable(context: vscode.ExtensionContext): Promise<string> {
  const custom = vscode.workspace.getConfiguration('mcrh').get<string>('collaboration.openp2pExecutable', '').trim()
  if (custom) {
    if (!path.isAbsolute(custom)) throw new Error(uiText("ui.openp2pInstall.customOpenp2pApplicationMustUseAbsolutePath"))
    await verifyOpenP2PExecutable(custom)
    return custom
  }
  const directory = path.join(context.globalStorageUri.fsPath, 'collaboration')
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: uiText("ui.openp2pInstall.mrchPrepareToEmbedOpenp2pClient") }, () => ensureBundledOpenP2P(directory, path.join(context.extensionPath, 'out', 'data', 'openp2p')))
}
