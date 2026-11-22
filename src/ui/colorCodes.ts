import { uiText } from '../i18n/messages'
import * as vscode from 'vscode'
import { COLOR_CODE_HEX, COLOR_CODE_NAME, FORMAT_CODE_NAME, scanColorRuns } from '../core/mcText'

function isColorHost(document: vscode.TextDocument): boolean {
  if (document.uri.scheme !== 'file') return false
  const name = document.uri.fsPath.replace(/\\/g, '/').toLowerCase()
  return name.endsWith('.mcmeta') || name.endsWith('.json') || document.languageId === 'json' || document.languageId === 'jsonc'
}

export class ColorCodeDecorator implements vscode.Disposable {
  private readonly colorTypes = new Map<string, vscode.TextEditorDecorationType>()
  private readonly boldType = vscode.window.createTextEditorDecorationType({ fontWeight: 'bold' })
  private readonly italicType = vscode.window.createTextEditorDecorationType({ fontStyle: 'italic' })
  private readonly underlineType = vscode.window.createTextEditorDecorationType({ textDecoration: 'underline' })
  private readonly strikeType = vscode.window.createTextEditorDecorationType({ textDecoration: 'line-through' })
  private readonly disposables: vscode.Disposable[] = []
  private timer: ReturnType<typeof setTimeout> | undefined

  private constructor() {
    for (const [code, hex] of Object.entries(COLOR_CODE_HEX)) {
      this.colorTypes.set(hex, vscode.window.createTextEditorDecorationType({ color: hex }))
      void code
    }
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(editor => this.apply(editor)),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (vscode.window.activeTextEditor?.document === event.document) this.schedule()
      })
    )
    this.apply(vscode.window.activeTextEditor)
  }

  static register(context: vscode.ExtensionContext): ColorCodeDecorator {
    const instance = new ColorCodeDecorator()
    context.subscriptions.push(instance)
    return instance
  }

  // 频繁输入时合并刷新, 避免每次按键都整篇重算
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.apply(vscode.window.activeTextEditor), 120)
  }

  apply(editor: vscode.TextEditor | undefined): void {
    if (!editor) return
    const clear = () => {
      for (const type of this.colorTypes.values()) editor.setDecorations(type, [])
      editor.setDecorations(this.boldType, [])
      editor.setDecorations(this.italicType, [])
      editor.setDecorations(this.underlineType, [])
      editor.setDecorations(this.strikeType, [])
    }
    if (!isColorHost(editor.document)) { clear(); return }

    const text = editor.document.getText()
    const runs = scanColorRuns(text)
    const byColor = new Map<string, vscode.Range[]>()
    const bold: vscode.Range[] = []
    const italic: vscode.Range[] = []
    const underline: vscode.Range[] = []
    const strike: vscode.Range[] = []

    for (const run of runs) {
      const range = new vscode.Range(editor.document.positionAt(run.start), editor.document.positionAt(run.end))
      if (run.color) {
        const list = byColor.get(run.color) ?? []
        list.push(range)
        byColor.set(run.color, list)
      }
      if (run.bold) bold.push(range)
      if (run.italic) italic.push(range)
      if (run.underline) underline.push(range)
      if (run.strikethrough) strike.push(range)
    }

    for (const [hex, type] of this.colorTypes) editor.setDecorations(type, byColor.get(hex) ?? [])
    editor.setDecorations(this.boldType, bold)
    editor.setDecorations(this.italicType, italic)
    editor.setDecorations(this.underlineType, underline)
    editor.setDecorations(this.strikeType, strike)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    for (const type of this.colorTypes.values()) type.dispose()
    this.boldType.dispose()
    this.italicType.dispose()
    this.underlineType.dispose()
    this.strikeType.dispose()
    for (const item of this.disposables) item.dispose()
  }
}

export class ColorCodeCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
    if (!isColorHost(document)) return []
    const prefix = document.lineAt(position.line).text.slice(0, position.character)
    if (!/[§&]$/.test(prefix)) return []
    if ((prefix.match(/"/g)?.length ?? 0) % 2 === 0) return []

    const items: vscode.CompletionItem[] = []
    for (const [code, hex] of Object.entries(COLOR_CODE_HEX)) {
      const item = new vscode.CompletionItem(`${code}  ${COLOR_CODE_NAME[code]}`, vscode.CompletionItemKind.Color)
      item.detail = hex.toUpperCase()
      item.insertText = code
      item.filterText = `${code}${COLOR_CODE_NAME[code]}`
      item.sortText = `0${code}`
      items.push(item)
    }
    for (const [code, label] of Object.entries(FORMAT_CODE_NAME)) {
      const item = new vscode.CompletionItem(`${code}  ${label}`, vscode.CompletionItemKind.Keyword)
      item.detail = uiText("ui.colorCodes.formatCode", label)
      item.insertText = code
      item.filterText = `${code}${label}`
      item.sortText = `1${code}`
      items.push(item)
    }
    return items
  }
}

export function registerColorCodes(context: vscode.ExtensionContext): vscode.Disposable {
  const selector: vscode.DocumentSelector = [
    { language: 'json', scheme: 'file' },
    { language: 'jsonc', scheme: 'file' },
    { pattern: '**/*.mcmeta', scheme: 'file' }
  ]
  const completion = vscode.languages.registerCompletionItemProvider(selector, new ColorCodeCompletionProvider(), '§', '&')
  const decorator = ColorCodeDecorator.register(context)
  context.subscriptions.push(completion)
  return vscode.Disposable.from(completion, decorator)
}
