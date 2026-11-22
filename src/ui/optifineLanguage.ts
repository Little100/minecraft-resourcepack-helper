import { uiText } from '../i18n/messages'
import * as vscode from 'vscode'
import { validate, schemaForPath } from '../core/optifine/properties'

export const LANGUAGE_ID = 'mcrh-optifine'

export function isOptiFineDocument(document: vscode.TextDocument): boolean {
  const normalized = document.uri.fsPath.replace(/\\/g, '/').toLowerCase()
  if (!/\.(properties|txt)$/.test(normalized)) return false
  return normalized.includes('/optifine/') || schemaForPath(vscode.workspace.asRelativePath(document.uri.fsPath)) !== undefined
}

export class OptiFineDiagnostics implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection
  private readonly disposables: vscode.Disposable[] = []

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection('mcrh-optifine')
  }

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const instance = new OptiFineDiagnostics()
    const provider = new FlowDiagnostics(instance.collection)

    context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument(document => provider.report(document)),
      vscode.workspace.onDidChangeTextDocument(event => provider.report(event.document)),
      vscode.workspace.onDidCloseTextDocument(document => instance.collection.delete(document.uri))
    )

    for (const document of vscode.workspace.textDocuments) provider.report(document)
    context.subscriptions.push(instance)
    return instance
  }

  dispose(): void {
    this.collection.dispose()
    this.disposables.forEach(item => item.dispose())
  }
}

class FlowDiagnostics {
  constructor(private readonly collection: vscode.DiagnosticCollection) {}

  report(document: vscode.TextDocument): void {
    if (!isOptiFineDocument(document)) {
      this.collection.delete(document.uri)
      return
    }
    const diagnostics = validate(vscode.workspace.asRelativePath(document.uri.fsPath), document.getText())
    this.collection.set(document.uri, diagnostics.map(item => {
      const range = new vscode.Range(item.line - 1, 0, item.line - 1, Number.MAX_SAFE_INTEGER)
      const target = new vscode.Diagnostic(range, item.message, item.severity === 'error'
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning)
      target.source = 'MCRH'
      return target
    }))
  }
}

export class OptiFineHoverProvider implements vscode.HoverProvider, vscode.Disposable {
  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (!isOptiFineDocument(document)) return undefined
    const schema = schemaForPath(vscode.workspace.asRelativePath(document.uri.fsPath))
    if (!schema) return undefined
    const range = document.getWordRangeAtPosition(position, /[.\w]+/)
    if (!range) return undefined
    const word = document.getText(range)
    const spec = schema.props.find(candidate => candidate.name === word)
    if (!spec) return undefined
    const parts = [`**${spec.name}**`, '', spec.doc, '']
    parts.push(uiText("ui.optifineLanguage.toBeCompleted", spec.required ? uiText("ui.optifineLanguage.yes") : uiText("ui.optifineLanguage.no")))
    if (spec.values) parts.push(uiText("ui.optifineLanguage.optionalValue", spec.values.join(', ')))
    if (spec.default) parts.push(uiText("ui.optifineLanguage.defaultValue", spec.default))
    return new vscode.Hover(new vscode.MarkdownString(parts.join('\n')), range)
  }

  dispose(): void { /* 说明: 无托管资源 */ }
}
