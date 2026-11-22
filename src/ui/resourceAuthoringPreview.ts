import { uiText } from '../i18n/messages'
import { randomUUID } from 'node:crypto'
import * as vscode from 'vscode'

const contents = new Map<string, string>()
const registered = new WeakSet<vscode.ExtensionContext>()
export async function showResourceDiff(context: vscode.ExtensionContext, name: string, before: string, after: string): Promise<void> {
  if (!registered.has(context)) {
    registered.add(context)
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('mcrh-authoring', { provideTextDocumentContent: uri => contents.get(uri.toString()) ?? uiText("ui.resourceAuthoringPreview.thePreviewSnapshotIsInvalidPleaseRe") }))
    context.subscriptions.push({ dispose: () => contents.clear() })
  }
  const id = randomUUID(), left = vscode.Uri.parse('mcrh-authoring:/' + id + '/before.json'), right = vscode.Uri.parse('mcrh-authoring:/' + id + '/after.json')
  contents.set(left.toString(), before); contents.set(right.toString(), after)
  while (contents.size > 64) contents.delete(contents.keys().next().value!)
  await vscode.commands.executeCommand('vscode.diff', left, right, name + uiText("ui.resourceAuthoringPreview.batchPreview"), { preview: true })
}
