import { uiText } from '../i18n/messages'
import * as vscode from 'vscode'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { startMcpBridge } from '../mcp/bridge'
import { buildMcpInstallPrompt, ensureMcpRuntime, type McpRuntime } from '../mcp/runtime'
import type { McpProject } from '../mcp/contracts'
import { invokeMcpOperation } from './mcpOperations'
import { extensionLog } from './extensionLog'

const ENABLED_KEY = 'mcp.workspaceEnabled'

class McpHost implements vscode.Disposable {
  private bridge?: Awaited<ReturnType<typeof startMcpBridge>>
  private runtime?: McpRuntime
  private disposed = false
  private enabled: boolean
  private queue: Promise<void> = Promise.resolve()
  private lastError?: string
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 5)

  constructor(private readonly context: vscode.ExtensionContext) {
    const stored = context.workspaceState.get<boolean>(ENABLED_KEY)
    this.enabled = stored ?? (vscode.workspace.workspaceFolders ?? []).some(folder => vscode.workspace.getConfiguration('mcrh', folder.uri).get<boolean>('mcp.enabled', true))
    this.status.command = 'mcrh.configureMcp'
    this.status.tooltip = uiText("ui.mcpHost.clickToOpenOrCloseTheCurrent")
    context.subscriptions.push(this.status, this,
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.backgroundRefresh()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.backgroundRefresh()),
      vscode.commands.registerCommand('mcrh.configureMcp', (enabled?: boolean) => this.configure(enabled)),
      vscode.commands.registerCommand('mcrh.copyMcpSetup', () => this.copySetup()),
      vscode.commands.registerCommand('mcrh.getMcpStatus', async () => { await this.queue.catch(() => undefined); return this.snapshot() }))
    this.backgroundRefresh()
  }

  private projects(): McpProject[] {
    if (!this.enabled || !vscode.workspace.isTrusted) return []
    return (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => ({
      id: createHash('sha256').update(process.platform === 'win32' ? folder.uri.fsPath.toLowerCase() : folder.uri.fsPath).digest('hex').slice(0, 32),
      name: folder.name, root: folder.uri.fsPath, editable: true
    }))
  }

  private isProjectEnabled(project: McpProject): boolean {
    return this.projects().some(value => path.resolve(value.root) === path.resolve(project.root))
  }

  private snapshot() {
    return { enabled: this.enabled, ready: Boolean(this.bridge), projectCount: this.projects().length,
      launcher: this.runtime?.launcher, registry: this.runtime?.registry, port: this.bridge?.port, error: this.lastError }
  }

  private refresh(): Promise<void> {
    this.queue = this.queue.catch(() => undefined).then(async () => {
      if (this.disposed) return
      if (!this.projects().length) {
        const running = Boolean(this.bridge)
        await this.bridge?.close()
        this.bridge = undefined
        this.status.text = this.enabled ? uiText("ui.mcpHost.mcpWaitingProject") : uiText("ui.mcpHost.mcpClose")
        this.status.show()
        this.lastError = undefined
        if (running) extensionLog('info', uiText("ui.mcpHost.mcpClosedProjectConnectionRemoved"))
        this.runtime ??= await ensureMcpRuntime(this.context.extensionUri.fsPath, this.context.globalStorageUri.fsPath)
        return
      }
      this.runtime = await ensureMcpRuntime(this.context.extensionUri.fsPath, this.context.globalStorageUri.fsPath)
      if (!this.bridge) {
        this.bridge = await startMcpBridge({ registry: this.runtime.registry, projects: () => this.projects(), invoke: async (project, operation, args) => {
          this.status.text = 'MCP: ' + operation
          try { return await invokeMcpOperation(project, operation, args, () => this.isProjectEnabled(project), this.context) }
          finally { this.status.text = this.enabled ? uiText("ui.mcpHost.mcpOpenItem", this.projects().length) : uiText("ui.mcpHost.mcpClose") }
        } })
      }
      await this.bridge.publish()
      this.lastError = undefined
      this.status.text = uiText("ui.mcpHost.mcpOpenItem", this.projects().length)
      this.status.show()
      extensionLog('info', uiText("ui.mcpHost.mcpStartedPortItemsRegistrationDirectory", this.bridge.port, this.projects().length, this.runtime.registry))
    })
    return this.queue
  }

  private report(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error)
    this.status.text = uiText("ui.mcpHost.mcpStartFailed")
    this.status.show()
    extensionLog('error', uiText("ui.mcpHost.mcpOperationFailed", this.lastError))
    void vscode.window.showErrorMessage(uiText("ui.mcpHost.mcpOperationFailedForMoreInformationSee", this.lastError))
  }

  private backgroundRefresh(): void { void this.refresh().catch(error => this.report(error)) }

  private async configure(desired?: boolean) {
    const next = typeof desired === 'boolean' ? desired : !this.enabled
    if (next && !vscode.workspace.isTrusted) { void vscode.window.showWarningMessage(uiText("ui.mcpHost.pleaseTrustThisWorkspaceBeforeOpeningMcp")); return this.snapshot() }
    if (next && !(vscode.workspace.workspaceFolders ?? []).some(folder => folder.uri.scheme === 'file')) { void vscode.window.showWarningMessage(uiText("ui.mcpHost.openLocalProjectFoldersFirst")); return this.snapshot() }
    try {
      await this.context.workspaceState.update(ENABLED_KEY, next)
      this.enabled = next
      extensionLog('info', uiText("ui.mcpHost.mcpUserRequest", (next ? uiText("mcp.runtime.open") : uiText("browser.resources.close"))))
      await this.refresh()
      void vscode.window.showInformationMessage(next ? uiText("ui.mcpHost.mcpIsOpenToCopyTheInstalled") : uiText("ui.mcpHost.mcpClosed"))
    } catch (error) { this.report(error) }
    return this.snapshot()
  }

  private async copySetup(): Promise<void> {
    try {
      await this.refresh()
      if (!this.runtime) throw new Error(uiText("ui.mcpHost.mcpStarterNotReadyYet"))
      await vscode.env.clipboard.writeText(buildMcpInstallPrompt(this.runtime, this.enabled))
      void vscode.window.showInformationMessage(this.enabled ? uiText("ui.mcpHost.mcpInstallationHintCopied") : uiText("ui.mcpHost.mcpInstallationHintsCopiedCurrentWorkingArea"))
    } catch (error) { this.report(error) }
  }

  dispose(): void {
    this.disposed = true
    void this.queue.catch(() => undefined).then(() => this.bridge?.close()).catch(error => extensionLog('error', uiText("ui.mcpHost.mcpCleanupFailed", String(error))))
  }
}

export function registerMcpHost(context: vscode.ExtensionContext): void { new McpHost(context) }
