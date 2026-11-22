import { uiText } from '../i18n/messages'
import { onWebviewMessage } from './webviewDiagnostics'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { UserGit } from '../git/workbench'
import { getHtml } from './htmlShell'
const revisions = new Map<string, { git: UserGit; hash?: string; file: string }>()
class GitFiles implements vscode.FileSystemProvider {
  readonly onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>().event
  watch(): vscode.Disposable { return new vscode.Disposable(() => {}) }
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> { return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: (await this.readFile(uri)).length } }
  async readFile(uri: vscode.Uri): Promise<Uint8Array> { const value = revisions.get(uri.toString()); if (!value) throw vscode.FileSystemError.FileNotFound(); return value.hash ? value.git.read(value.hash, value.file) : new Uint8Array() }
  readDirectory(): [string, vscode.FileType][] { return [] }
  createDirectory(): never { throw vscode.FileSystemError.NoPermissions() }
  writeFile(): never { throw vscode.FileSystemError.NoPermissions() }
  delete(): never { throw vscode.FileSystemError.NoPermissions() }
  rename(): never { throw vscode.FileSystemError.NoPermissions() }
}
export class GitWorkbenchHost {
  private git?: UserGit
  private disposed = false
  private busy = false
  private timer?: ReturnType<typeof setTimeout>
  private readonly watcher?: vscode.FileSystemWatcher
  private readonly subscriptions: vscode.Disposable[] = []
  constructor(private readonly webview: vscode.Webview, private readonly source?: vscode.Uri) {
    const folder = source ? vscode.workspace.getWorkspaceFolder(source) : vscode.workspace.workspaceFolders?.[0]
    if (folder) {
      this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'))
      const changed = () => { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => { void this.handle({ action: 'refresh' }) }, 400) }
      this.subscriptions.push(this.watcher.onDidChange(changed), this.watcher.onDidCreate(changed), this.watcher.onDidDelete(changed))
    }
  }
  static register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.workspace.registerFileSystemProvider('mcrh-git', new GitFiles(), { isReadonly: true }), vscode.commands.registerCommand('mcrh.openGit', async () => {
      const panel = vscode.window.createWebviewPanel('mcrh.git', uiText("ui.gitWorkbench.mcrhGitHistoryAndChange"), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] })
      panel.webview.html = getHtml(panel.webview, context.extensionUri, 'gitWorkbench', panel)
      const host = new GitWorkbenchHost(panel.webview)
      const listener = onWebviewMessage(panel.webview, raw => { void host.handle(raw) })
      panel.onDidDispose(() => { host.dispose(); listener.dispose() })
    }))
  }
  private post(value: unknown): void { if (!this.disposed) void this.webview.postMessage(value) }
  private async directory(): Promise<string> {
    const folder = this.source ? vscode.workspace.getWorkspaceFolder(this.source) : vscode.workspace.workspaceFolders?.[0]
    if (!folder || folder.uri.scheme !== 'file') throw new Error(uiText("ui.gitWorkbench.pleaseOpenTheLocalWorkspaceDirectoryFirst"))
    return folder.uri.fsPath
  }
  private uri(hash: string | undefined, file: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: 'mcrh-git', path: '/' + file, query: encodeURIComponent(this.git!.root + ':' + (hash ?? 'empty')) })
    revisions.set(uri.toString(), { git: this.git!, hash, file }); return uri
  }
  private async state(): Promise<void> {
    const directory = await this.directory()
    try { this.git = await UserGit.detect(directory) } catch { this.post({ command: 'gitState', installed: false, root: directory, changes: [], commits: [] }); return }
    if (!this.git) { this.post({ command: 'gitState', installed: true, root: directory, changes: [], commits: [] }); return }
    const file = this.source ? this.git.relative(this.source.fsPath) : undefined
    const [changes, commits] = await Promise.all([this.git.changes(), this.git.log(file)])
    this.post({ command: 'gitState', installed: true, repository: true, root: this.git.root, file, changes: file ? changes.filter(change => change.path === file || change.previous === file) : changes, commits })
  }
  async handle(raw: unknown): Promise<void> {
    if (this.disposed || this.busy || !raw || typeof raw !== 'object') return
    const input = raw as Record<string, unknown>; this.busy = true
    try {
      if (!vscode.workspace.isTrusted && input.action !== 'refresh') throw new Error(uiText("ui.gitWorkbench.gitOperationRequiresTrustInTheCurrent"))
      if (input.action === 'install') { await vscode.env.openExternal(vscode.Uri.parse('https://git-scm.com/install/')); return }
      if (input.action === 'init') {
        const directory = await this.directory(), git = new UserGit(directory)
        const identity = await Promise.all(['user.name', 'user.email'].map(key => git.text(['config', '--get', key]).catch(() => '')))
        const warning = identity.every(Boolean) ? uiText("ui.gitWorkbench.externalGithubAuthenticationDoesNotVerifyThat") : uiText("ui.gitWorkbench.couldNotCreateAGitIdentityFor")
        if (await vscode.window.showWarningMessage(warning, { modal: true }, uiText("ui.gitWorkbench.continueInitializing")) !== uiText("ui.gitWorkbench.continueInitializing")) return
        if (await UserGit.detect(directory)) throw new Error(uiText("ui.gitWorkbench.thisDirectoryIsAlreadyInTheGit"))
        await git.run(['init'])
      } else if (input.action !== 'refresh' && input.action !== 'openPanel') {
        this.git ??= await UserGit.detect(await this.directory())
        if (!this.git) throw new Error(uiText("ui.gitWorkbench.theCurrentDirectoryDoesNotYetHave"))
        const git = this.git, file = typeof input.path === 'string' ? git.path(input.path) : undefined, hash = typeof input.hash === 'string' ? git.revision(input.hash) : undefined
        if (input.action === 'stage' || input.action === 'unstage') { if (!Array.isArray(input.paths) || !input.paths.every(value => typeof value === 'string') || input.paths.length > 16384) throw new Error(uiText("ui.gitWorkbench.pleaseSelectAValidFile")); await git.stage(input.paths, input.action === 'unstage') }
        else if (input.action === 'commit') { if (typeof input.message !== 'string') throw new Error(uiText("ui.gitWorkbench.pleaseEnterTheSubmissionInstructions")); await git.commit(input.message) }
        else if (input.action === 'files' && hash) { this.post({ command: 'gitCommitFiles', hash, files: await git.commitFiles(hash) }); return }
        else if (input.action === 'diff' && file) {
          const selected = hash ?? (await git.log())[0]?.hash
          let left = this.uri(undefined, file)
          if (selected) { try { await git.read(selected, file); left = this.uri(selected, file) } catch {} }
          let right = vscode.Uri.file(path.join(git.root, file)); try { await vscode.workspace.fs.stat(right) } catch { right = this.uri(undefined, file) }
          await vscode.commands.executeCommand('vscode.diff', left, right, file + uiText("ui.gitWorkbench.historyWorkspaceQualifier")); return
        } else if (input.action === 'openRevision' && file && hash) { await vscode.commands.executeCommand('vscode.open', this.uri(hash, file)); return }
        else if (input.action === 'restore' && file && hash) {
          const target = vscode.Uri.file(path.join(git.root, file))
          if (vscode.workspace.textDocuments.some(document => document.uri.toString() === target.toString() && document.isDirty)) throw new Error(uiText("ui.gitWorkbench.pleaseSaveOrCloseUnsavedEditingOf"))
          if (await vscode.window.showWarningMessage(uiText("ui.gitWorkbench.writeAHistoricalVersionAsNewUnsubmitted"), { modal: true }, uiText("ui.gitWorkbench.restoreFile")) !== uiText("ui.gitWorkbench.restoreFile")) return
          if (vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === target.toString()))) throw new Error(uiText("ui.gitWorkbench.pleaseSaveAndCloseThePictureEditor"))
          await git.restore(hash, file)
        } else if (input.action === 'revert' && hash) {
          if (await vscode.window.showWarningMessage(uiText("ui.gitWorkbench.applyThisSubmissionInReverseToCreate"), { modal: true }, uiText("ui.gitWorkbench.withdrawal")) !== uiText("ui.gitWorkbench.withdrawal")) return
          await git.revert(hash)
        }
      } else if (input.action === 'openPanel') { await vscode.commands.executeCommand('mcrh.openGit'); return }
      await this.state()
    } catch (error) { this.post({ command: 'gitError', error: error instanceof Error ? error.message : String(error) }) }
    finally { this.busy = false }
  }
  dispose(): void { this.disposed = true; if (this.timer) clearTimeout(this.timer); this.watcher?.dispose(); this.subscriptions.forEach(item => item.dispose()) }
}
