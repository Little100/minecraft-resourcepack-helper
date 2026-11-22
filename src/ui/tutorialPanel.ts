import { uiText } from '../i18n/messages'
import { extensionLog } from './extensionLog'
import { onWebviewMessage } from './webviewDiagnostics'
import * as vscode from 'vscode'
import { getHtml } from './htmlShell'
import { isAllowedTutorialCommand } from './tutorialCards'

export class TutorialPanel {
  public static readonly viewType = 'mcrh.tutorialPage'

  private static current: TutorialPanel | undefined

  private readonly disposables: vscode.Disposable[] = []

  private constructor(private readonly panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel.webview.html = getHtml(this.panel.webview, context.extensionUri, 'tutorial', this.panel)
    onWebviewMessage(this.panel.webview, message => {
      void this.handle(message as { command?: string; id?: string }).catch(error => {
        const text = error instanceof Error ? error.message : String(error)
        extensionLog('error', uiText("ui.tutorialPanel.theTutorialCommandFailed", text))
        void vscode.window.showErrorMessage(uiText("ui.tutorialPanel.theProgramCommandFailed", text))
      })
    }, undefined, this.disposables)
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables)
  }

  static show(context: vscode.ExtensionContext): TutorialPanel {
    if (TutorialPanel.current) {
      TutorialPanel.current.panel.reveal(vscode.ViewColumn.One)
      return TutorialPanel.current
    }
    const panel = vscode.window.createWebviewPanel(
      TutorialPanel.viewType,
      uiText("ui.htmlShell.mcrhMaterialPackageAssistant"),
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri]
      }
    )
    const instance = new TutorialPanel(panel, context)
    TutorialPanel.current = instance
    return instance
  }

  private async handle(message: { command?: string; id?: string }): Promise<void> {
    switch (message?.command) {
      case 'dismissForever':
        await vscode.workspace.getConfiguration('mcrh').update('hideTutorialOnStart', true, vscode.ConfigurationTarget.Global)
        this.panel.dispose()
        break
      case 'close':
        this.panel.dispose()
        break
      case 'run':
        if (!isAllowedTutorialCommand(message.id)) {
          break
        }
        await vscode.commands.executeCommand(message.id)
        break
      default:
        break
    }
  }

  dispose(): void {
    TutorialPanel.current = undefined
    this.panel.dispose()
    for (const item of this.disposables) item.dispose()
    this.disposables.length = 0
  }
}
