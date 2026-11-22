import { uiText } from '../i18n/messages'
import { onWebviewMessage } from './webviewDiagnostics'
import * as path from 'node:path'
import * as vscode from 'vscode'
import type { PackDiagnosticReport } from '../core/advanced/packDiagnostics'
import { assertExportPathWithoutLinks } from '../core/advanced/exportPolicy'
import { safeRelativePath } from '../core/advanced/safeExport'
import { getHtml } from './htmlShell'

export interface DiagnosisScanResult { report: PackDiagnosticReport; baseRoot?: string }
type Rescan = () => Promise<DiagnosisScanResult>
export class PackDiagnosisPanel {
  private static readonly panels = new Map<string, PackDiagnosisPanel>()
  private readonly disposables: vscode.Disposable[] = []
  private report?: PackDiagnosticReport
  private baseRoot?: string
  private reportId = 0
  private generation = 0
  private busy = false
  private closed = false
  private ready = false
  private lastStatus = { message: uiText("ui.packDiagnosisPanel.preparingToCheck"), error: false }
  private constructor(private readonly panel: vscode.WebviewPanel, private readonly root: string, private rescan: Rescan, context: vscode.ExtensionContext) {
    onWebviewMessage(panel.webview, value => { void this.receive(value).catch(error => this.status(error instanceof Error ? error.message : String(error), true)) }, undefined, this.disposables)
    panel.onDidDispose(() => { this.closed = true; PackDiagnosisPanel.panels.delete(root); for (const disposable of this.disposables) disposable.dispose() }, undefined, this.disposables)
    panel.webview.html = getHtml(panel.webview, context.extensionUri, 'diagnosis', panel)
  }
  static show(context: vscode.ExtensionContext, root: string, rescan: Rescan): PackDiagnosisPanel {
    root = path.resolve(root)
    const current = this.panels.get(root)
    if (current) { current.rescan = rescan; current.panel.reveal(); return current }
    const panel = vscode.window.createWebviewPanel('mcrh.packDiagnosis', uiText("ui.packDiagnosisPanel.resourceKitIssue", path.basename(root)), vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')] })
    const instance = new PackDiagnosisPanel(panel, root, rescan, context)
    this.panels.set(root, instance); return instance
  }
  private send(): void {
    if (this.ready && !this.closed && this.report) void this.panel.webview.postMessage({ command: 'diagnosisReport', reportId: this.reportId, report: this.report, name: path.basename(this.root), root: this.root, busy: this.busy })
  }
  private status(message: string, error = false): void {
    this.lastStatus = { message, error }
    if (this.ready && !this.closed) void this.panel.webview.postMessage({ command: 'diagnosisStatus', ...this.lastStatus, root: this.root, busy: this.busy })
  }
  async run(): Promise<void> {
    if (this.closed) return
    const generation = ++this.generation, scan = this.rescan
    this.busy = true
    this.status(this.report ? uiText("ui.packDiagnosisPanel.recheckingKeepingLastResultInTheCurrent") : uiText("ui.packDiagnosisPanel.checkingResourcePack"))
    try {
      const result = await scan()
      if (!this.closed && generation === this.generation) {
        this.report = result.report; this.baseRoot = result.baseRoot; this.reportId++
        this.lastStatus = { message: uiText("ui.packDiagnosisPanel.checkCompletedRecheckIfYouChangeThe"), error: false }; this.send()
      }
    } catch (error) {
      if (!this.closed && generation === this.generation) this.status(uiText("ui.packDiagnosisPanel.checkNotCompleted", (this.report ? uiText("ui.packDiagnosisPanel.theCurrentListIsStillTheLast") : ''), (error instanceof Error ? error.message : String(error))), true)
    } finally {
      if (generation === this.generation) { this.busy = false; if (!this.closed && this.ready) void this.panel.webview.postMessage({ command: 'diagnosisBusy', busy: false }) }
    }
  }
  private async receive(value: unknown): Promise<void> {
    if (this.closed || !value || typeof value !== 'object') return
    const request = value as { command?: unknown; reportId?: unknown; index?: unknown }
    if (request.command === 'diagnosisReady') { this.ready = true; this.send(); this.status(this.lastStatus.message, this.lastStatus.error); return }
    if (request.command === 'diagnosisRerun') { if (!this.busy) await this.run(); return }
    if (request.command !== 'diagnosisOpenIssue' || request.reportId !== this.reportId || !Number.isSafeInteger(request.index) || Number(request.index) < 0) return
    const issue = this.report?.issues[Number(request.index)]
    if (!issue?.path || issue.severity === 'info') return
    const root = issue.source === 'base' ? this.baseRoot : this.root
    if (!root) { this.status(uiText("ui.packDiagnosisPanel.theProblemComesFromBasicResourcesAnd"), true); return }
    const relative = safeRelativePath(issue.path), file = path.resolve(root, ...relative.split('/'))
    if (!file.startsWith(path.resolve(root) + path.sep)) return
    await assertExportPathWithoutLinks(file)
    const uri = vscode.Uri.file(file)
    if (!/\.(?:json|mcmeta|properties|txt)$/i.test(file)) { await vscode.commands.executeCommand('vscode.open', uri); return }
    const document = await vscode.workspace.openTextDocument(uri)
    const line = Math.min(Math.max(0, (issue.line ?? 1) - 1), document.lineCount - 1), column = Math.min(Math.max(0, (issue.column ?? 1) - 1), document.lineAt(line).text.length)
    const position = new vscode.Position(line, column)
    await vscode.window.showTextDocument(document, { preview: false, selection: new vscode.Range(position, position) })
  }
}
