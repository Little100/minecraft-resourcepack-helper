import { uiText } from '../i18n/messages'
import { postPreviewSession, type PreviewSession } from '../core/previewSession'
import { onWebviewMessage } from './webviewDiagnostics'
import { tryShowGuiPreview } from './guiPreviewPanel'
import { previewResourceContext } from './previewResourceContext'
import { watchPreviewLanguages } from './previewLanguageWatcher'
import { resourceFromAssetPath } from '../core/resourceNames'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { PNG } from 'pngjs'
import { isPreviewResource, previewPathKey, texturePreviewState } from '../core/texturePreviewState'
import { buildSchedule, parseAnimationMeta } from '../core/animationTimeline'
import { assertPngDimensionsWithinLimit } from '../core/document'
import { sniffFormat, stripFrameCount } from '../core/frameSource'
import { detectPack } from '../core/packDetector'
import { loadVanillaSprites, type VanillaSprites } from '../core/vanillaAssets'
import type { PreviewAnimation, PreviewMessage } from '../webview/messages'
import { createDebounced } from './debounce'
import { getHtml } from './htmlShell'

export type PreviewOutcome =
  | { ok: true; message: PreviewMessage; warnings: string[]; resourceRoots?: readonly string[] }
  | { ok: false; error: string }

export interface PreviewLoader {
  load(uri: vscode.Uri): Promise<void>
  reload(): Promise<void>
  cancel?(): void
}

export function computeFrameCount(width: number, height: number): number {
  return height > width ? stripFrameCount(width, height) : 1
}

export function createTicketGate(): { begin(): number; isLatest(ticket: number): boolean } {
  let latest = 0
  return {
    begin: () => ++latest,
    isLatest: ticket => ticket === latest
  }
}

// 只显示当前请求的结果，忽略晚到的旧结果
export function createPreviewLoader<T>(read: (uri: vscode.Uri) => Promise<T>, deliver: (value: T) => void): PreviewLoader {
  const gate = createTicketGate()
  let target: vscode.Uri | undefined
  const reload = async (): Promise<void> => {
    const uri = target
    if (!uri) return
    const ticket = gate.begin()
    const value = await read(uri)
    if (gate.isLatest(ticket)) deliver(value)
  }
  return {
    async load(uri) {
      target = uri
      await reload()
    },
    reload,
    cancel() { target = undefined; gate.begin() }
  }
}

// 读取失败时返回原因，不抛异常
export async function readPreview(
  uri: vscode.Uri,
  loadSprites: () => Promise<VanillaSprites> = () => loadVanillaSprites(),
  context?: vscode.ExtensionContext
): Promise<PreviewOutcome> {
  const name = path.basename(uri.fsPath)
  try {
    const memory = texturePreviewState.read(uri.fsPath)
    let png: { width: number; height: number; data: Uint8Array }
    if (memory) png = { width: memory.width, height: memory.height, data: memory.pixels }
    else {
      const bytes = new Uint8Array(await vscode.workspace.fs.readFile(uri))
      if (sniffFormat(bytes) !== 'png') return { ok: false, error: uiText("ui.previewPanel.thePreviewOnlySupportsThePngPoster", name) }
      // 解码前限制声明尺寸，避免超量分配
      assertPngDimensionsWithinLimit(bytes)
      png = PNG.sync.read(Buffer.from(bytes))
    }
    const frameCount = computeFrameCount(png.width, png.height)
    const warnings: string[] = []
    const animation = await readAnimation(uri, frameCount, warnings)
    const sprites = await loadSprites().catch((error: unknown): VanillaSprites => {
      warnings.push(uiText("ui.previewPanel.theOriginalInterfacePosterFailedToRead", errorText(error)))
      return {}
    })
    const pixels = new Uint8Array(png.data.byteLength)
    pixels.set(png.data)
    const message: PreviewMessage = {
      command: 'preview',
      sourceUri: uri.fsPath,
      name,
      width: png.width,
      height: png.height,
      frameCount,
      packLabel: await packLabelOf(uri),
      data: pixels.buffer,
      animation,
      sprites
    }
    let resourceRoots: readonly string[] | undefined
    if (context) {
      const resource = await previewResourceContext(uri, context).catch(() => undefined)
      resourceRoots = resource?.assets.roots
      const target = resource && resourceFromAssetPath(resource.source.relative)
      if (target && resource) { Object.assign(message, await resource.names.resolve(target)); warnings.push(...(message.nameWarnings ?? [])) }
    }
    return { ok: true, message, warnings, resourceRoots }
  } catch (error) {
    return { ok: false, error: uiText("ui.previewPanel.readFailed", name, errorText(error)) }
  }
}

export function previewMessageFromMemory(uri: vscode.Uri, previous: PreviewMessage): PreviewMessage | undefined {
  if (previous.sourceUri !== uri.fsPath) return undefined
  const memory = texturePreviewState.read(uri.fsPath)
  if (!memory) return undefined
  return { ...previous, width: memory.width, height: memory.height, frameCount: computeFrameCount(memory.width, memory.height), data: memory.pixels.buffer as ArrayBuffer }
}

// 没有可用的动画设置时按静态图显示
async function readAnimation(uri: vscode.Uri, frameCount: number, warnings: string[]): Promise<PreviewAnimation | undefined> {
  let text: string
  try {
    text = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(`${uri.fsPath}.mcmeta`))).toString('utf8')
  } catch {
    return undefined
  }
  const parsed = parseAnimationMeta(text)
  if (parsed.error) return staticFallback(warnings, parsed.error)
  if (!parsed.animation) return undefined
  try {
    if (buildSchedule(frameCount, parsed.animation).frames.length === 0) return staticFallback(warnings, uiText("ui.previewPanel.animatedFrameListIsEmpty"))
    return parsed.animation
  } catch (error) {
    return staticFallback(warnings, errorText(error))
  }
}

function staticFallback(warnings: string[], reason: string): undefined {
  warnings.push(uiText("ui.previewPanel.animationInformationIsNotValidAsShown", reason))
  return undefined
}

export function isRelatedChange(previewPath: string, changedPath: string): boolean {
  const name = path.basename(previewPath)
  const changed = path.basename(changedPath)
  return changed === name || changed === `${name}.mcmeta`
}

async function packLabelOf(uri: vscode.Uri): Promise<string> {
  const folder = (vscode.workspace.workspaceFolders ?? []).find(item => isInside(item.uri.fsPath, uri.fsPath))
  if (!folder) return ''
  const info = await detectPack(folder.uri.fsPath).catch(() => undefined)
  if (info?.kind !== 'resourcepack') return folder.name
  return `${folder.name}${info.packFormat ? ` (format ${info.packFormat})` : ''}`
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}


// 同时观察文本与自定义图片页签，预览自身和无关文本保持原目标
export function watchPreviewEditors(): vscode.Disposable {
  const focused = (editor?: vscode.TextEditor): { key: string; uri?: vscode.Uri } => {
    const group = vscode.window.tabGroups?.activeTabGroup
    const tab = group?.activeTab
    const input = tab?.input as { uri?: vscode.Uri } | undefined
    const uri = tab ? input?.uri : editor?.document.uri
    const key = String(group?.viewColumn ?? '') + ':' + (uri ? uri.scheme + ':' + previewPathKey(uri.fsPath) : 'non-resource')
    return { key, uri }
  }
  // 只跟随之后切换的文件
  let lastFocus = focused(vscode.window.activeTextEditor).key
  const observe = (editor?: vscode.TextEditor): void => {
    const focus = focused(editor)
    if (focus.key === lastFocus) return
    lastFocus = focus.key
    if (focus.uri?.scheme === 'file') texturePreviewState.activate(focus.uri.fsPath)
  }
  const text = vscode.window.onDidChangeActiveTextEditor(editor => observe(editor))
  const tabs = vscode.window.tabGroups?.onDidChangeTabs(() => observe(vscode.window.activeTextEditor))
  const groups = vscode.window.tabGroups?.onDidChangeTabGroups(() => observe(vscode.window.activeTextEditor))
  return vscode.Disposable.from(...[text, tabs, groups].filter((item): item is vscode.Disposable => Boolean(item)))
}

// 预览面板是独立编辑器页, 推送整幅像素与动画信息, 由 webview 负责 WebGL 渲染
export class PreviewPanel {
  public static readonly viewType = 'mcrh.preview'

  private static current: PreviewPanel | undefined

  private readonly disposables: vscode.Disposable[] = []
  private followRevision = 0
  private readonly loader: PreviewLoader
  private latestMessage?: PreviewMessage
  private readonly memoryRefresh = createDebounced(() => this.deliverMemory(), 60)
  private readonly refresh = createDebounced(() => void this.loader.reload(), 60)
  private watcher: vscode.FileSystemWatcher | undefined
  private languageWatcher?: vscode.Disposable
  private lastTexture?: vscode.Uri
  private target?: vscode.Uri
  private following = true
  private explicitLoad = true
  private pendingFocus?: vscode.Uri
  private ready = false
  private closed = false

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly context: vscode.ExtensionContext) {
    this.loader = createPreviewLoader(uri => readPreview(uri, undefined, context), outcome => this.deliver(outcome))
    this.panel.webview.html = getHtml(this.panel.webview, context.extensionUri, 'preview', this.panel)
    this.disposables.push(texturePreviewState.subscribe(event => {
      if (event.type === 'active' && this.following && this.target) {
        const uri = vscode.Uri.file(event.uri)
        if (this.explicitLoad) this.pendingFocus = uri
        else void this.follow(uri, context).catch(error => this.reportFollowError(error))
      }
      if (event.type === 'texture' && this.target && previewPathKey(event.uri) === previewPathKey(this.target.fsPath)) {
        if (event.reason === 'close') this.refresh.trigger()
        else this.memoryRefresh.trigger()
      }
    }), watchPreviewEditors())
    onWebviewMessage(this.panel.webview, (message: unknown) => {
      const data = message as { command?: unknown; following?: unknown } | undefined
      if (data?.command === 'openTextureInBlockbench') { if (this.target) void vscode.commands.executeCommand('mcrh.openTextureInBlockbench', this.target); return }
      if (data?.command === 'setPreviewFollow' && typeof data.following === 'boolean') {
        this.following = data.following
        this.persist()
        void this.panel.webview.postMessage({ command: 'previewFollow', following: this.following })
        if (this.following && texturePreviewState.activeUri) void this.follow(vscode.Uri.file(texturePreviewState.activeUri), context).catch(error => this.reportFollowError(error))
        return
      }
      // 面板加载完才发送预览数据
      if ((message as { command?: string } | undefined)?.command !== 'previewReady') return
      this.ready = true
      this.persist()
      void this.panel.webview.postMessage({ command: 'previewFollow', following: this.following })
      void this.loader.reload()
    }, undefined, this.disposables)
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables)
  }

  static show(context: vscode.ExtensionContext, uri: vscode.Uri): PreviewPanel {
    if (PreviewPanel.current) {
      void PreviewPanel.current.load(uri, true)
      PreviewPanel.current.panel.reveal(vscode.ViewColumn.Beside, true)
      return PreviewPanel.current
    }
    const panel = vscode.window.createWebviewPanel(
      PreviewPanel.viewType,
      uiText("ui.htmlShell.mcrhPastePreview"),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri]
      }
    )
    const instance = new PreviewPanel(panel, context)
    PreviewPanel.current = instance
    void instance.load(uri, true)
    return instance
  }

  static async restore(context: vscode.ExtensionContext, panel: vscode.WebviewPanel, session: PreviewSession): Promise<void> {
    this.current?.dispose()
    panel.webview.options = { enableScripts: true, localResourceRoots: [context.extensionUri] }
    const instance = new PreviewPanel(panel, context)
    this.current = instance
    instance.following = session.following !== false
    await instance.load(vscode.Uri.file(session.source), true)
  }

  private persist(): void {
    if (this.lastTexture) postPreviewSession(this.panel.webview, { kind: 'texture', source: this.lastTexture.fsPath, following: this.following })
  }

  async load(uri: vscode.Uri, explicit = false): Promise<void> {
    if (explicit) { this.explicitLoad = true; this.pendingFocus = undefined }
    this.followRevision++
    this.refresh.dispose(); this.memoryRefresh.dispose()
    this.target = uri
    this.latestMessage = undefined
    if (tryShowGuiPreview(this.context, uri)) {
      this.loader.cancel?.(); this.watcher?.dispose(); this.watcher = undefined; this.languageWatcher?.dispose(); this.languageWatcher = undefined
      this.finishExplicit()
      return
    }
    if (uri.fsPath.toLowerCase().endsWith('.png')) this.lastTexture = uri
    this.persist()
    this.watchFiles(uri)
    this.languageWatcher?.dispose()
    this.languageWatcher = watchPreviewLanguages(uri, this.context, () => this.refresh.trigger())
    await this.loader.load(uri)
  }

  private finishExplicit(): void {
    this.explicitLoad = false
    const pending = this.pendingFocus
    this.pendingFocus = undefined
    if (this.following && pending && this.target && previewPathKey(pending.fsPath) !== previewPathKey(this.target.fsPath)) void this.follow(pending, this.context).catch(error => this.reportFollowError(error))
  }

  private deliverMemory(): void {
    if (this.closed || !this.target || !this.ready) return
    try {
      const message = this.latestMessage && previewMessageFromMemory(this.target, this.latestMessage)
      if (message) this.deliver({ ok: true, message, warnings: [] })
      else void this.loader.reload()
    } catch (error) { this.reportFollowError(error) }
  }

  private reportFollowError(error: unknown): void {
    if (!this.closed) void this.panel.webview.postMessage({ command: 'notice', level: 'warn', text: errorText(error) })
  }

  private async follow(uri: vscode.Uri, context: vscode.ExtensionContext): Promise<void> {
    if (this.closed || !isPreviewResource(uri.fsPath) || this.target && previewPathKey(this.target.fsPath) === previewPathKey(uri.fsPath)) return
    if (uri.fsPath.toLowerCase().endsWith('.png')) await this.load(uri)
    else {
      const revision = ++this.followRevision
      this.target = uri
    this.persist()
      this.latestMessage = undefined
      this.loader.cancel?.(); this.refresh.dispose(); this.memoryRefresh.dispose(); this.watcher?.dispose(); this.watcher = undefined; this.languageWatcher?.dispose(); this.languageWatcher = undefined
      void this.panel.webview.postMessage({ command: 'previewClear', sourceUri: uri.fsPath, notice: uiText("ui.previewPanel.switchingToActualJsonModelPreview") })
      const { VanillaPreviewPanel } = await import('./vanillaPreviewPanel')
      if (this.closed || revision !== this.followRevision || this.target !== uri) return
      try {
        const followed = await VanillaPreviewPanel.followFromOrdinary(context, uri, () => !this.closed && this.following && revision === this.followRevision && this.target === uri)
        if (!followed && !this.closed && revision === this.followRevision) void this.panel.webview.postMessage({ command: 'notice', level: 'info', text: uiText("ui.previewPanel.theOriginalModelPreviewIsFixedAnd") })
      } catch (error) {
        if (!this.closed && this.following && revision === this.followRevision && this.target === uri) this.reportFollowError(error)
      }
    }
  }

  // 切换后按文件名监听新目录，不拼接匹配表达式
  private watchFiles(uri: vscode.Uri): void {
    this.watcher?.dispose()
    const folder = vscode.Uri.file(path.dirname(uri.fsPath))
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '*'))
    const onChange = (changed: vscode.Uri): void => {
      if (isRelatedChange(uri.fsPath, changed.fsPath)) this.refresh.trigger()
    }
    watcher.onDidChange(onChange)
    watcher.onDidCreate(onChange)
    watcher.onDidDelete(onChange)
    this.watcher = watcher
  }

  private deliver(outcome: PreviewOutcome): void {
    if (this.closed) return
    if (outcome.ok && outcome.resourceRoots && this.target && outcome.message.sourceUri === this.target.fsPath) {
      this.languageWatcher?.dispose()
      this.languageWatcher = watchPreviewLanguages(this.target, this.context, () => this.refresh.trigger(), outcome.resourceRoots)
    }
    if (!this.ready) return
    if (!outcome.ok) {
      this.latestMessage = undefined
      void this.panel.webview.postMessage({ command: 'previewError', sourceUri: this.target?.fsPath, error: outcome.error })
      void vscode.window.showErrorMessage(outcome.error)
      this.finishExplicit()
      return
    }
    this.latestMessage = outcome.message
    this.panel.title = uiText("ui.previewPanel.mcrhPreview", outcome.message.displayName ?? outcome.message.name)
    for (const text of outcome.warnings) void vscode.window.showWarningMessage(text)
    void this.panel.webview.postMessage(outcome.message)
    this.finishExplicit()
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.followRevision++
    if (PreviewPanel.current === this) PreviewPanel.current = undefined
    this.memoryRefresh.dispose()
    this.refresh.dispose()
    this.watcher?.dispose()
    this.languageWatcher?.dispose()
    this.panel.dispose()
    for (const item of this.disposables) item.dispose()
    this.disposables.length = 0
  }
}

export async function previewFromCommand(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  let target = uri
  if (!target) {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 贴图: ['png'] }
    })
    target = picked?.[0]
  }
  if (!target) return
  if (!target.fsPath.toLowerCase().endsWith('.png')) {
    void vscode.window.showWarningMessage(uiText("ui.previewPanel.previewOnlySupportsPngPaste"))
    return
  }
  if (tryShowGuiPreview(context, target)) return
  if (/\/textures\/(?:block|item|entity)\//.test(target.fsPath.replace(/\\/g, '/'))) {
    try {
      const { VanillaPreviewPanel } = await import('./vanillaPreviewPanel')
      if (await VanillaPreviewPanel.show(context, target, false)) return
    }
    catch (error) { await vscode.window.showWarningMessage(uiText("ui.previewPanel.couldNotCloseTemporaryFolderS", errorText(error))) }
  }
  PreviewPanel.show(context, target)
}
