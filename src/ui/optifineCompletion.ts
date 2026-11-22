import { uiText } from '../i18n/messages'
import * as vscode from 'vscode'
import { parseProperties, completionsFor, resolveSchema } from '../core/optifine/properties'
import { SCHEMAS } from '../core/optifine/schema'
import { LANGUAGE_ID } from './optifineLanguage'

export class OptiFineCompletionProvider implements vscode.CompletionItemProvider, vscode.Disposable {
  static readonly selector: vscode.DocumentSelector = { language: LANGUAGE_ID, scheme: 'file' }

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
    const relativePath = vscode.workspace.asRelativePath(document.uri.fsPath)
    // 路径无法识别时按内容补全
    const schema = resolveSchema(relativePath, document.getText())
    const line = document.lineAt(position.line).text
    const eq = line.indexOf('=')
    const afterEq = eq >= 0 && position.character > eq
    if (afterEq && !schema) {
      return valueCompletions(line.slice(0, eq).trim(), position, enumsFor(line.slice(0, eq).trim()))
    }
    if (!schema) return []
    const existing = parseProperties(document.getText()).props.map(prop => prop.name)
    const candidates = completionsFor(relativePath, existing, document.getText())

    const wordRange = document.getWordRangeAtPosition(position, /[.\w]+/)
    if (afterEq) {
      return valueCompletions(line.slice(0, eq).trim(), position, candidates)
    }

    return candidates.map(candidate => {
      const item = new vscode.CompletionItem(candidate.name, candidate.required
        ? vscode.CompletionItemKind.Variable
        : vscode.CompletionItemKind.Field)
      item.detail = candidate.required ? uiText("ui.optifineCompletion.shallBeFilled") : uiText("ui.optifineCompletion.optional", candidate.default ? uiText("ui.optifineCompletion.default", candidate.default) : '')
      item.documentation = new vscode.MarkdownString(candidate.doc)
      item.range = wordRange
      item.insertText = `${candidate.name}=${placeholderFor(candidate)}`
      return item
    })
  }

  dispose(): void { /* 说明: 无托管资源 */ }
}

function placeholderFor(candidate: { type: string; values?: readonly string[] }): string {
  switch (candidate.type) {
    case 'int': return '0'
    case 'float': return '1'
    case 'bool': return 'false'
    case 'list': return '0-3'
    case 'tile-list': return '0-3'
    case 'enum': return candidate.values?.[0] ?? ''
    default: return ''
  }
}

function valueCompletions(name: string, position: vscode.Position, candidates: Array<{ name: string; values?: readonly string[]; doc: string }>): vscode.CompletionItem[] {
  const spec = candidates.find(candidate => candidate.name === name)
  const values = spec?.values ?? []
  const wordRange = new vscode.Range(position, position)
  return values.map(value => {
    const item = new vscode.CompletionItem(value, vscode.CompletionItemKind.EnumMember)
    item.range = wordRange
    item.documentation = new vscode.MarkdownString(spec?.doc ?? '')
    return item
  })
}

// 文件类型未知时按属性名查找可选值
function enumsFor(name: string): Array<{ name: string; values?: readonly string[]; doc: string }> {
  const found: Array<{ name: string; values?: readonly string[]; doc: string }> = []
  for (const schema of SCHEMAS) {
    for (const prop of schema.props) {
      if (prop.name === name && prop.type === 'enum' && prop.values) found.push(prop)
    }
  }
  return found
}

export function register(_context: vscode.ExtensionContext): vscode.Disposable {
  const provider = new OptiFineCompletionProvider()
  return vscode.languages.registerCompletionItemProvider(OptiFineCompletionProvider.selector, provider, '.', '=')
}
