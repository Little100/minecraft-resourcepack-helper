import { uiText } from '../i18n/messages'
import { postPreviewSession, type PreviewSession } from '../core/previewSession'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { guiSceneForPath, isGuiScene, isGuiTexturePath, type GuiPreviewData, type GuiScene } from '../core/guiPreview'
import { loadGuiPreview } from '../core/guiPreviewAssets'
import { scanForPacks, pathKey } from '../core/packScanner'
import { texturePreviewState, previewPathKey } from '../core/texturePreviewState'
import { assertExportPathWithoutLinks } from '../core/advanced/exportPolicy'
import { createDebounced } from './debounce'
import { getHtml } from './htmlShell'
import { onWebviewMessage } from './webviewDiagnostics'
import { previewResourceContext, sourceOf } from './previewResourceContext'
import { ensurePreviewClientAssets } from './previewClientAssets'
import { extensionLog } from './extensionLog'

export class GuiPreviewPanel {
  private static readonly panels = new Map<string, GuiPreviewPanel>()
  private readonly disposables: vscode.Disposable[] = []
  private watchers: vscode.FileSystemWatcher[] = []
  private watchedRoots = ''
  private roots: readonly string[] = []
  private scene: GuiScene
  private selected?: string
  private ready = false
  private closed = false
  private loading = false
  private pending = false
  private preparing = false
  private generation = 0
  private revision = 0
  private data?: GuiPreviewData
  private readonly refresh = createDebounced(() => { void this.drain() }, 180)
  private constructor(private readonly panel: vscode.WebviewPanel, private readonly root: string, private readonly context: vscode.ExtensionContext, selected?: string) {
    this.selected = selected
    this.scene = guiSceneForPath(selected)
    onWebviewMessage(panel.webview, raw => { void this.receive(raw).catch(error => this.status(error instanceof Error ? error.message : String(error), true)) }, undefined, this.disposables)
    panel.onDidDispose(() => {
      this.closed = true; this.generation++; this.refresh.dispose()
      if (GuiPreviewPanel.panels.get(pathKey(root)) === this) GuiPreviewPanel.panels.delete(pathKey(root))
      for (const watcher of this.watchers) watcher.dispose()
      for (const disposable of this.disposables) disposable.dispose()
    }, undefined, this.disposables)
    panel.onDidChangeViewState(() => { if (panel.visible && this.pending) this.refresh.trigger() }, undefined, this.disposables)
    this.disposables.push(texturePreviewState.subscribe(event => {
      if (event.type === 'texture' && this.relevant(event.uri)) this.schedule()
      if (event.type === 'active') {
        const source = sourceOf(event.uri)
        if (source && pathKey(source.root) === pathKey(this.root) && isGuiTexturePath(source.relative) && source.relative !== this.selected) this.select(source.relative)
      }
    }))
    this.disposables.push(vscode.workspace.onDidChangeTextDocument(event => { if (this.relevant(event.document.uri.fsPath)) this.schedule() }))
    this.disposables.push(vscode.workspace.onDidCloseTextDocument(document => { if (this.relevant(document.uri.fsPath)) this.schedule() }))
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('mcrh.previewMinecraftVersion') || event.affectsConfiguration('mcrh.previewFallbackMinecraftVersion') || event.affectsConfiguration('mcrh.previewBaseAssetsPath')) this.schedule() }))
    panel.webview.html = getHtml(panel.webview, context.extensionUri, 'guiPreview', panel)
  }
  static show(context: vscode.ExtensionContext, root: string, selected?: string, preserveFocus = false): GuiPreviewPanel {
    root = path.resolve(root)
    const current = this.panels.get(pathKey(root))
    if (current) {
      if (selected) current.select(selected)
      current.panel.reveal(vscode.ViewColumn.Beside, preserveFocus); return current
    }
    const panel = vscode.window.createWebviewPanel('mcrh.guiPreview', 'GUI / HUD · ' + path.basename(root), { viewColumn: vscode.ViewColumn.Beside, preserveFocus }, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')] })
    const instance = new GuiPreviewPanel(panel, root, context, selected)
    this.panels.set(pathKey(root), instance); return instance
  }
  static restore(context: vscode.ExtensionContext, panel: vscode.WebviewPanel, session: PreviewSession): void {
    const existing = this.panels.get(pathKey(session.source))
    if (existing && existing.panel !== panel) existing.panel.dispose()
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')] }
    const instance = new GuiPreviewPanel(panel, session.source, context, session.selected)
    if (isGuiScene(session.scene)) instance.scene = session.scene
    this.panels.set(pathKey(session.source), instance)
  }
  private persist(): void {
    postPreviewSession(this.panel.webview, { kind: 'gui', source: this.root, selected: this.selected, scene: this.scene })
  }
  private select(selected: string): void {
    this.selected = selected; this.scene = guiSceneForPath(selected)
    if (this.ready) void this.panel.webview.postMessage({ command: 'guiSelectScene', scene: this.scene })
    this.schedule()
  }
  private relevant(file: string): boolean {
    const source = sourceOf(file)
    return (file.endsWith('pack.mcmeta') && pathKey(path.dirname(file)) === pathKey(this.root)) || !!source && this.roots.some(root => pathKey(root) === pathKey(source.root)) && /^assets\/[^/]+\/textures\/gui\/.+\.(?:png|mcmeta)$/.test(source.relative)
  }
  private status(message: string, error = false): void {
    if (!this.closed && this.ready) void this.panel.webview.postMessage({ command: 'guiStatus', message, error, preparing: this.preparing })
    if (error) extensionLog('warn', uiText("ui.guiPreviewPanel.guiHudPreview", message))
  }
  private schedule(): void {
    this.persist()
    this.pending = true; this.generation++
    if (!this.closed && this.ready && this.panel.visible) this.refresh.trigger()
  }
  private watch(roots: readonly string[]): void {
    this.roots = roots
    const key = roots.map(pathKey).join('\n')
    if (this.watchedRoots === key) return
    this.watchedRoots = key
    for (const watcher of this.watchers) watcher.dispose()
    this.watchers = roots.map(root => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '{pack.mcmeta,assets/*/textures/gui/**}'))
      for (const event of [watcher.onDidChange, watcher.onDidCreate, watcher.onDidDelete]) event(file => { if (this.relevant(file.fsPath)) this.schedule() })
      return watcher
    })
  }
  private async drain(): Promise<void> {
    if (this.closed || !this.ready || !this.panel.visible || this.loading) return
    this.loading = true
    try {
      while (this.pending && !this.closed && this.panel.visible) {
        this.pending = false
        const generation = this.generation, scene = this.scene, selected = this.selected
        this.status(uiText("ui.guiPreviewPanel.readingGuiResource"))
        try {
          const resources = await previewResourceContext(vscode.Uri.file(path.join(this.root, 'assets/minecraft/textures/gui/__preview__.png')), this.context)
          if (!resources) throw new Error(uiText("ui.guiPreviewPanel.cannotDetermineMaterialPackageResourceDirectory"))
          if (generation !== this.generation || this.closed) continue
          this.watch(resources.assets.roots)
          const data = await loadGuiPreview(resources.assets.roots, scene, { version: resources.version, selected, overlay: {
            png: (absolute, remainingPixels) => texturePreviewState.read(absolute, remainingPixels),
            text: absolute => vscode.workspace.textDocuments.find(document => document.uri.scheme === 'file' && !document.isClosed && document.isDirty && previewPathKey(document.uri.fsPath) === previewPathKey(absolute))?.getText()
          } })
          if (generation !== this.generation || this.closed) continue
          this.data = { ...data, name: path.basename(this.root), revision: ++this.revision, warnings: [...resources.warnings, ...data.warnings] }
          void this.panel.webview.postMessage({ command: 'guiData', data: this.data })
          this.status(data.textures.length ? uiText("ui.guiPreviewPanel.automaticallyRefreshedAfterChangingTheStickersTo") : uiText("ui.guiPreviewPanel.thereIsNoAvailablePosterForThe"))
        } catch (error) { if (generation === this.generation && !this.closed) this.status(uiText("ui.guiPreviewPanel.previewNotUpdated", (error instanceof Error ? error.message : String(error))), true) }
      }
    } finally { this.loading = false }
  }
  private async receive(raw: unknown): Promise<void> {
    if (this.closed || !raw || typeof raw !== 'object') return
    const request = raw as { command?: unknown; scene?: unknown; revision?: unknown; key?: unknown }
    if (request.command === 'guiReady') { this.ready = true; if (isGuiScene(request.scene) && !this.selected) this.scene = request.scene; this.schedule(); return }
    if (!this.ready) return
    if (request.command === 'guiScene' && isGuiScene(request.scene)) { this.scene = request.scene; this.schedule(); return }
    if (request.command === 'guiRefresh') { this.schedule(); return }
    if (request.command === 'guiChoosePack') { await previewGuiFromCommand(this.context, undefined, true); return }
    if (request.command === 'guiPrepareVanilla' && !this.preparing) {
      if (!this.data?.version) { this.status(uiText("ui.guiPreviewPanel.pleaseSpecifyMcrhPreviewminecraftversionInSettingsBefore"), true); return }
      this.preparing = true; this.status(uiText("ui.guiPreviewPanel.preparingOriginalResourceCacheForThisVersion"))
      try { await ensurePreviewClientAssets(this.context, this.data.version, { throwOnError: true, includeLanguages: false, nearbyRoots: [path.dirname(this.root)] }); this.schedule() }
      finally { this.preparing = false; this.status(uiText("ui.guiPreviewPanel.originalResourceReadinessOperationCompleted")) }
      return
    }
    if (!this.data || request.command !== 'guiOpenTexture' || request.revision !== this.data.revision || typeof request.key !== 'string') return
    const texture = this.data.textures.find(item => item.key === request.key)
    if (!texture) return
    await assertExportPathWithoutLinks(texture.source)
    const uri = vscode.Uri.file(texture.source)
    if (pathKey(sourceOf(texture.source)!.root) === pathKey(this.root)) await vscode.commands.executeCommand('vscode.openWith', uri, 'mcrh.pixelEditor', { viewColumn: vscode.ViewColumn.One })
    else await vscode.commands.executeCommand('vscode.openWith', uri, 'default', { viewColumn: vscode.ViewColumn.One })
  }
}

export function tryShowGuiPreview(context: vscode.ExtensionContext, uri: vscode.Uri): boolean {
  if (uri.scheme !== 'file') return false
  const source = sourceOf(uri.fsPath)
  if (!source || !isGuiTexturePath(source.relative)) return false
  GuiPreviewPanel.show(context, source.root, source.relative, true)
  return true
}

export async function previewGuiFromCommand(context: vscode.ExtensionContext, value?: vscode.Uri | { resourceUri?: vscode.Uri }, forcePick = false): Promise<void> {
  try {
    const uri = value instanceof vscode.Uri ? value : value?.resourceUri
    const active = forcePick ? undefined : uri ?? (texturePreviewState.activeUri ? vscode.Uri.file(texturePreviewState.activeUri) : vscode.window.activeTextEditor?.document.uri)
    if (active?.scheme === 'file') {
      const source = sourceOf(active.fsPath)
      if (path.basename(active.fsPath) === 'pack.mcmeta') { GuiPreviewPanel.show(context, path.dirname(active.fsPath)); return }
      if (source && (uri || isGuiTexturePath(source.relative))) { GuiPreviewPanel.show(context, source.root, isGuiTexturePath(source.relative) ? source.relative : undefined); return }
      if (uri) {
        const stat = await fs.lstat(uri.fsPath)
        if (stat.isDirectory()) {
          const result = await scanForPacks({ roots: [uri.fsPath], depth: 0 })
          if (result.packs.length) { GuiPreviewPanel.show(context, result.packs[0].root); return }
        }
      }
    }
    const roots = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath)
    const { packs } = await scanForPacks({ roots, depth: 2 })
    const choices = [...packs.map(pack => ({ label: pack.name, description: pack.root, root: pack.root })), { label: uiText("ui.guiPreviewPanel.selectAnotherMaterialPackageDirectory"), description: '', root: '' }]
    const picked = await vscode.window.showQuickPick(choices, { title: uiText("ui.guiPreviewPanel.guiHudPreviewSelectPackage") })
    if (!picked) return
    let root = picked.root
    if (!root) {
      const selected = await vscode.window.showOpenDialog({ title: uiText("ui.guiPreviewPanel.selectTheMaterialPackageRootOfGui"), canSelectFolders: true, canSelectFiles: false, canSelectMany: false })
      if (!selected?.[0] || selected[0].scheme !== 'file') return
      root = selected[0].fsPath
    }
    GuiPreviewPanel.show(context, root)
  } catch (error) { void vscode.window.showErrorMessage(uiText("ui.guiPreviewPanel.guiHudPreviewFailedToOpen", (error instanceof Error ? error.message : String(error)))) }
}
