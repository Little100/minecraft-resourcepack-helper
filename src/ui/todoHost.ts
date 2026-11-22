import { uiText } from '../i18n/messages'
import { onWebviewMessage } from './webviewDiagnostics'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as vscode from 'vscode'
import { isTodoResource, type TodoItem } from '../core/todos'
import { TodoStore } from '../core/todoStore'
import { safeTarget } from '../collaboration/files'
import { texturePreviewState } from '../core/texturePreviewState'
import { getHtml } from './htmlShell'

export class TodoHost {
  private selectedRoot?: string
  private source?: vscode.Uri
  private disposed = false
  private ready = false
  private busy = false
  private generation = 0
  private readonly subscriptions: vscode.Disposable[] = []

  constructor(private readonly webview: vscode.Webview, source?: vscode.Uri) {
    this.source = source
    const watcher = vscode.workspace.createFileSystemWatcher('**/.mcrh/todos.json')
    this.subscriptions.push(watcher)
    for (const event of [watcher.onDidCreate, watcher.onDidChange, watcher.onDidDelete]) this.subscriptions.push(event(() => { if (this.ready) void this.refresh() }))
    if (!source) {
      const observe = () => {
        const input = vscode.window.tabGroups?.activeTabGroup.activeTab?.input as { uri?: vscode.Uri } | undefined
        const current = input?.uri ?? vscode.window.activeTextEditor?.document.uri
        if (current?.scheme === 'file' && isTodoResource(this.relativeAsset(current.fsPath))) this.setSource(current)
      }
      this.subscriptions.push(texturePreviewState.subscribe(event => { if (event.type === 'active') this.setSource(vscode.Uri.file(event.uri)) }))
      this.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(observe))
      if (vscode.window.tabGroups?.onDidChangeTabs) this.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(observe), vscode.window.tabGroups.onDidChangeTabGroups(observe))
      observe()
      if (!this.source && texturePreviewState.activeUri) this.source = vscode.Uri.file(texturePreviewState.activeUri)
    }
  }

  static register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('mcrh.todos', { resolveWebviewView(view) {
      view.webview.options = { enableScripts: true, localResourceRoots: [context.extensionUri] }
      const host = new TodoHost(view.webview)
      const listener = onWebviewMessage(view.webview, raw => { void host.handle(raw) })
      view.onDidDispose(() => { host.dispose(); listener.dispose() })
      view.webview.html = getHtml(view.webview, context.extensionUri, 'todos', view)
    } }))
  }

  setSource(source: vscode.Uri): void {
    if (source.scheme !== 'file' || this.source?.toString() === source.toString()) return
    this.source = source; this.selectedRoot = undefined; this.generation++
    if (this.ready) void this.refresh()
  }

  private relativeAsset(file: string): string { return file.replace(/\\/g, '/').match(/(?:^|\/)(assets\/.+)$/)?.[1] ?? '' }
  private post(value: unknown): void { if (!this.disposed) void this.webview.postMessage(value) }

  private async directory(): Promise<string> {
    if (this.selectedRoot) return this.selectedRoot
    const folder = this.source ? vscode.workspace.getWorkspaceFolder(this.source) : vscode.workspace.workspaceFolders?.[0]
    if (!folder || folder.uri.scheme !== 'file') throw new Error(uiText("ui.todoHost.pleaseOpenTheLocalResourcePackArea"))
    let current = this.source ? path.dirname(this.source.fsPath) : folder.uri.fsPath
    while (!path.relative(folder.uri.fsPath, current).startsWith('..')) {
      try { if ((await fs.stat(path.join(current, 'pack.mcmeta'))).isFile()) return current } catch {}
      if (current === folder.uri.fsPath) break
      const parent = path.dirname(current); if (parent === current) break; current = parent
    }
    return folder.uri.fsPath
  }

  private resource(root: string): string | undefined {
    const relative = this.source && path.relative(root, this.source.fsPath).replace(/\\/g, '/')
    return relative && isTodoResource(relative) ? relative : undefined
  }

  private async refresh(): Promise<void> {
    const generation = ++this.generation
    try {
      const root = await this.directory(), state = await new TodoStore(root).read()
      if (generation === this.generation) this.post({ command: 'todoState', ...state, root, resource: this.resource(root) })
    } catch (error) { if (generation === this.generation) this.error(error) }
  }

  private error(error: unknown): void { this.post({ command: 'todoError', error: error instanceof Error ? error.message : String(error) }) }

  private async chooseResource(root: string, current?: string): Promise<string | undefined | false> {
    const active = this.resource(root)
    const choice = await vscode.window.showQuickPick([
      { label: uiText("ui.todoHost.globalTasks"), description: uiText("ui.todoHost.otherOrganiser"), value: 'global' },
      ...(active ? [{ label: uiText("ui.todoHost.currentResources"), description: active, value: 'active' }] : []),
      ...(current ? [{ label: uiText("ui.todoHost.retentionAssociation"), description: current, value: 'keep' }] : []),
      { label: uiText("ui.todoHost.selectResourceFile"), description: uiText("ui.todoHost.associatedWithTheStickersModelsOrSquares"), value: 'file' }
    ], { title: uiText("ui.todoHost.taskLink"), placeHolder: uiText("ui.todoHost.selectionOfMissionOwnedResources") })
    if (!choice) return false
    if (choice.value === 'global') return undefined
    if (choice.value === 'active') return active
    if (choice.value === 'keep') return current
    const target = (await vscode.window.showOpenDialog({ title: uiText("ui.todoHost.selectAssociatedResources"), defaultUri: vscode.Uri.file(path.join(root, 'assets')), canSelectMany: false }))?.[0]
    if (!target) return false
    const resource = path.relative(root, target.fsPath).replace(/\\/g, '/')
    if (!isTodoResource(resource)) throw new Error(uiText("ui.todoHost.pleaseSelectTheFilesInTheCurrent"))
    await safeTarget(root, resource)
    return resource
  }

  async handle(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object' || this.disposed) return
    const input = raw as Record<string, unknown>
    if (input.command !== 'todo') return
    this.ready = true
    if (input.action === 'refresh') { await this.refresh(); return }
    if (this.busy) return
    this.busy = true
    try {
      if (input.action === 'selectRoot') {
        const target = (await vscode.window.showOpenDialog({ title: uiText("ui.todoHost.selectTheResourcePackDirectoryOfTodo"), canSelectFiles: false, canSelectFolders: true, canSelectMany: false }))?.[0]
        if (target?.scheme === 'file') this.selectedRoot = target.fsPath
      } else {
        const root = await this.directory(), store = new TodoStore(root), state = await store.read()
        if (input.root !== root || input.revision !== state.revision) throw new Error(uiText("ui.todoHost.couldNotCloseTemporaryFolderS"))
        const old = state.items.find(item => item.id === input.id)
        if (input.action === 'open') {
          if (old?.resource) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(await safeTarget(root, old.resource)))
          return
        }
        if (!vscode.workspace.isTrusted) throw new Error(uiText("ui.todoHost.modifyTodoRequiresATrustWorkspace"))
        let replacement: TodoItem | undefined
        if (input.action === 'add' || input.action === 'edit') {
          if (input.action === 'edit' && !old) throw new Error(uiText("ui.todoHost.missionNoLongerExists"))
          const title = await vscode.window.showInputBox({ title: old ? uiText("ui.todoHost.modifyTask") : uiText("ui.todoHost.addTask"), value: old?.title, validateInput: value => value.trim() && value.trim().length <= 200 ? undefined : uiText("ui.todoHost.headersNeedToWords") })
          if (title === undefined) return
          const detail = await vscode.window.showInputBox({ title: uiText("ui.todoHost.missionStatement"), value: old?.detail ?? '', validateInput: value => value.length <= 4000 ? undefined : uiText("ui.todoHost.descriptionMaximumWords") })
          if (detail === undefined) return
          const resource = await this.chooseResource(root, old?.resource)
          if (resource === false) return
          replacement = { id: old?.id ?? randomUUID(), title: title.trim(), detail, resource, done: old?.done ?? false, updatedAt: new Date().toISOString() }
        } else if (input.action === 'remove') {
          if (!old) throw new Error(uiText("ui.todoHost.missionNoLongerExists"))
          if (await vscode.window.showWarningMessage(uiText("ui.todoHost.deleteTheTaskTheCollaborativeWorkspaceNeeds"), { modal: true }, uiText("ui.todoHost.deleteTask")) !== uiText("ui.todoHost.deleteTask")) return
        } else if (input.action !== 'toggle') return
        if (root !== await this.directory()) throw new Error(uiText("ui.todoHost.thePackageHasBeenSwitchedAndNot"))
        await store.update(state.revision, items => {
          if (replacement) return old ? items.map(item => item.id === old.id ? replacement! : item) : [...items, replacement]
          if (!old) throw new Error(uiText("ui.todoHost.missionNoLongerExists"))
          return input.action === 'remove' ? items.filter(item => item.id !== old.id) : items.map(item => item.id === old.id ? { ...item, done: !item.done, updatedAt: new Date().toISOString() } : item)
        })
      }
    } catch (error) { this.error(error) }
    finally { this.busy = false; await this.refresh() }
  }

  dispose(): void { this.disposed = true; this.generation++; this.subscriptions.forEach(value => value.dispose()) }
}
