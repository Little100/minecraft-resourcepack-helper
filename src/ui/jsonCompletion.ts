import * as vscode from 'vscode'
import { jsonCompletionContext, jsonPropertyEdit, type JsonCompletionContext, type JsonSpan } from '../core/jsonCompletion'
import type { ResourceSnippet } from '../core/advanced/resourceSyntax'

export function completionContext(document: vscode.TextDocument, position: vscode.Position): JsonCompletionContext | undefined {
  const text = typeof document.getText === 'function' ? document.getText() : document.lineAt(position.line).text
  const offset = typeof document.offsetAt === 'function' ? document.offsetAt(position) : position.character
  return jsonCompletionContext(text, offset)
}

export function completionRange(document: vscode.TextDocument, span: JsonSpan): vscode.Range {
  const positionAt = (offset: number): vscode.Position => typeof document.positionAt === 'function' ? document.positionAt(offset) : new vscode.Position(0, offset)
  return new vscode.Range(positionAt(span.start), positionAt(span.end))
}

export function contextualFields(document: vscode.TextDocument, context: JsonCompletionContext, fields: readonly ResourceSnippet[]): vscode.CompletionItem[] {
  const key = context.key
  if (!key) return []
  return fields.filter(field => !key.existing.includes(field.name)).flatMap((field, index) => {
    const edit = jsonPropertyEdit(key, field.name, field.snippet)
    const range = completionRange(document, edit.span)
    const position = typeof document.positionAt === 'function' ? document.positionAt(context.offset) : new vscode.Position(0, context.offset)
    if (!range.isSingleLine || !range.contains(position)) return []
    const item = new vscode.CompletionItem(field.name, vscode.CompletionItemKind.Field)
    item.detail = 'MCRH · ' + field.detail
    item.insertText = new vscode.SnippetString(edit.text)
    item.filterText = edit.filterText
    item.range = range
    item.sortText = '00mcrh' + String(index).padStart(4, '0')
    return [item]
  })
}
