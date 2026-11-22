import { uiText } from '../i18n/messages'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { checkLang, isLangFile, toDiagnostics } from '../core/langCheck'

// 语言键缺失只在包内自查, 触发时机为保存与切换文件, 避免编辑过程中反复告警
export class LangDiagnostics implements vscode.Disposable {
  private static readonly collection = vscode.languages.createDiagnosticCollection('mcrh-lang')

  private readonly disposables: vscode.Disposable[] = []

  private constructor() {
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument(document => void this.run(document)),
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) void this.run(editor.document)
      })
    )
  }

  static register(context: vscode.ExtensionContext): LangDiagnostics {
    const instance = new LangDiagnostics()
    context.subscriptions.push(instance)
    return instance
  }

  private async run(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== 'file') return
    if (!isLangFile(document.uri.fsPath)) return

    const report = await checkLang({ file: document.uri.fsPath, content: document.getText() })
    if (!report) {
      LangDiagnostics.collection.clear()
      return
    }

    const grouped = toDiagnostics(report)
    LangDiagnostics.collection.clear()
    for (const [file, diagnostics] of grouped) {
      LangDiagnostics.collection.set(vscode.Uri.file(file), diagnostics)
    }

    if (report.missing.length > 0) {
      const name = path.basename(document.uri.fsPath)
      void vscode.window.setStatusBarMessage(
        uiText("ui.langDiagnostics.mcrhTheDirectoryContainsLanguageKeysDid", name, report.missing.length), 5000
      )
    }
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose()
    this.disposables.length = 0
    LangDiagnostics.collection.dispose()
  }
}
