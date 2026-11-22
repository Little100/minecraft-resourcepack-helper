import * as vscode from 'vscode'
import { generatedModelFold, generatedModelFoldingRanges } from '../core/generatedModelText'
import { JAVA_MODEL_LIMITS } from '../core/javaModelResources'

const folded = new WeakMap<vscode.TextDocument, string>()

export async function foldGeneratedModel(editor: vscode.TextEditor | undefined): Promise<void> {
  if (!editor || vscode.window.activeTextEditor !== editor || !/\.json$/i.test(editor.document.uri.path)) return
  const document = editor.document, text = document.getText()
  if (Buffer.byteLength(text) > JAVA_MODEL_LIMITS.maxBytes) return
  const range = generatedModelFold(text)
  if (!range) return
  const signature = text.split('\n').slice(range.start + 1, range.end + 1).join('\n')
  if (folded.get(document) === signature || vscode.window.activeTextEditor !== editor) return
  await vscode.commands.executeCommand('editor.fold', { levels: 1, direction: 'down', selectionLines: [range.start] })
  folded.set(document, signature)
}

export function registerGeneratedModelFolding(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.languages.registerFoldingRangeProvider([{ language: 'json', scheme: 'file', pattern: '**/assets/*/models/**/*.json' }, { language: 'jsonc', scheme: 'file', pattern: '**/assets/*/models/**/*.json' }], {
    provideFoldingRanges(document) {
      const text = document.getText()
      if (Buffer.byteLength(text) > JAVA_MODEL_LIMITS.maxBytes) return
      return generatedModelFoldingRanges(text)?.map(range => new vscode.FoldingRange(range.start, range.end))
    }
  }))
  const fold = (editor: vscode.TextEditor | undefined): void => { void foldGeneratedModel(editor).catch(() => {}) }
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(fold))
  fold(vscode.window.activeTextEditor)
}
