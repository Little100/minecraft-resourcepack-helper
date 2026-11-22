import { uiText } from '../i18n/messages'
import { onWebviewMessage } from './webviewDiagnostics'
import { randomUUID, createHash } from 'node:crypto'
import { animationFrameHeight, updateAnimationMetadata } from '../core/pixelAnimation'
import { canMarkTexture } from '../core/mcrhMark'
import { PixelTimeline } from '../core/pixelTimeline'
import { resizeSnapshot, resizeAnimatedSnapshot, arrangeFrames, insertPixels, transformLayers } from '../core/pixelTransforms'
import { PixelEditingHost } from './pixelEditingHost'
import { GitWorkbenchHost } from './gitWorkbench'
import { TodoHost } from './todoHost'
import { ReferenceImagesHost, referenceStorageKey } from './referenceImagesHost'
import { editRandomVariant } from '../core/randomVariantEdits'
import { PixelRandomVariantsHost } from './pixelRandomVariantsHost'
import * as vscode from 'vscode'
import { previewPathKey, texturePreviewState, type TexturePreviewRegistration } from '../core/texturePreviewState'
import { validateBindings } from '../webview/paint/bindings'
import { PixelDocument, isRectInside, type DocumentSnapshot, type Layer, type PixelRect } from '../core/document'
import { LIVE_PREVIEW_INTERVAL, MAX_LIVE_PREVIEW_BYTES } from '../webview/messages'
import { isArrayBuffer } from '../core/pixelCodec'
import { LAYER_NAME_MAX } from '../core/pixelCodec'
import { parsePixelCommand } from '../core/pixelCommands'
import { buildBackupText, parseBackupText } from '../core/pixelBackup'
import { prepareProjectWrite, readProject } from '../core/project'
import type { LayerInfo, LayerPixels, LayersMessage, NoticeMessage, PatchMessage, PixelHostMessage, SnapshotMessage } from '../webview/messages'
import { getHtml } from './htmlShell'
import { CONTEXT_KEYS, setContext } from './contextKeys'

const pendingSaves = new Map<string, Promise<void>>()

export interface PanelLike {
  webview: { postMessage(message: unknown): Thenable<boolean> | PromiseLike<boolean> }
}

// 复制成独立 ArrayBuffer, 避免与模型内部缓冲共享内存; 结构化克隆还会再复制一次, 属已知的两次拷贝, 转移所有权需改 postMessage 签名, 暂不实施
function toArrayBuffer(source: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(source.byteLength)
  copy.set(source)
  return copy.buffer as ArrayBuffer
}

function nextLayerName(doc: PixelDocument): string {
  const template = uiText('ui.pixelEditor.layer')
  const names = new Set(doc.layers.map(layer => layer.name))
  for (let number = 1; ; number++) {
    const name = template.includes('{0}') ? template.replaceAll('{0}', String(number)) : template + ' ' + number
    if (!names.has(name)) return name
  }
}

// 这里应用像素修改，撤销历史由 VS Code 管理
export class PixelDocumentModel implements vscode.CustomDocument {
  readonly timeline: PixelTimeline
  private panel?: PanelLike
  private readonly panels = new Set<PanelLike>()
  private previewRegistration?: TexturePreviewRegistration
  private live?: { layerId: string; pixels: Uint8Array }
  private previewVariantId?: string
  private readonly warnedExternalTargets = new Set<string>()
  private liveSequence = 0
  private liveStamp = -Infinity
  private liveNotifyTimer?: ReturnType<typeof setTimeout>
  private readonly editEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<PixelDocumentModel>>()
  private readonly appliedEmitter = new vscode.EventEmitter<void>()
  private readonly disposedEmitter = new vscode.EventEmitter<void>()
  readonly onDidDispose = this.disposedEmitter.event

  readonly onDidChange = this.editEmitter.event
  readonly onDidApply = this.appliedEmitter.event

  constructor(readonly uri: vscode.Uri, public document: PixelDocument) {
    this.timeline = new PixelTimeline(document.snapshot())
    if (document.historyText) { try { this.timeline.restore(document.historyText) } catch {} }
    this.registerPreview()
  }

  private registerPreview(): void {
    this.previewRegistration ??= texturePreviewState.register(this.uri.fsPath, () => ({ width: this.document.width, height: this.document.height, pixels: this.previewPixels() }), () => ({ width: this.document.width, height: this.document.height }))
  }

  // 临时图层仅在同步合成期间替换引用，真实文档与撤销栈保持不变
  private previewPixels(): Uint8Array {
    const live = this.live
    if (!live) return this.document.flatten(false, this.document.findLayer(this.document.activeLayerId ?? '')?.randomVariant ? this.document.activeLayerId : this.previewVariantId)
    const layers = this.document.layers
    this.document.layers = layers.map(layer => layer.id === live.layerId ? { ...layer, pixels: live.pixels } : layer)
    try { return this.document.flatten(false, this.document.findLayer(this.document.activeLayerId ?? '')?.randomVariant ? this.document.activeLayerId : this.previewVariantId) } finally { this.document.layers = layers }
  }

  previewStroke(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') return false
    const data = raw as { sequence?: unknown; layerId?: unknown; rect?: unknown; pixels?: unknown }
    if (!Number.isSafeInteger(data.sequence) || Number(data.sequence) <= this.liveSequence || typeof data.layerId !== 'string' || !isArrayBuffer(data.pixels) || data.pixels.byteLength > MAX_LIVE_PREVIEW_BYTES || !data.rect || typeof data.rect !== 'object') return false
    const layer = this.document.findLayer(data.layerId), rect = data.rect as PixelRect
    if (!layer || !isRectInside(rect, this.document.width, this.document.height) || data.pixels.byteLength !== rect.width * rect.height * 4) return false
    const stamp = performance.now()
    this.liveSequence = Number(data.sequence)
    if (this.live?.layerId !== layer.id) this.live = { layerId: layer.id, pixels: layer.pixels.slice() }
    const pixels = new Uint8Array(data.pixels), target = this.live!.pixels, stride = rect.width * 4
    for (let row = 0; row < rect.height; row++) target.set(pixels.subarray(row * stride, (row + 1) * stride), ((rect.y + row) * this.document.width + rect.x) * 4)
    const notify = (): void => {
      this.liveNotifyTimer = undefined
      this.liveStamp = performance.now()
      this.previewRegistration?.changed()
    }
    if (stamp - this.liveStamp >= LIVE_PREVIEW_INTERVAL) {
      if (this.liveNotifyTimer) clearTimeout(this.liveNotifyTimer)
      notify()
    } else this.liveNotifyTimer ??= setTimeout(notify, LIVE_PREVIEW_INTERVAL - (stamp - this.liveStamp))
    return true
  }

  resetPreviewSession(): void {
    this.endPreviewStroke()
    this.liveSequence = 0
  }

  endPreviewStroke(sequence?: number): boolean {
    if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence <= this.liveSequence)) return false
    if (sequence !== undefined) this.liveSequence = sequence
    this.liveStamp = -Infinity
    if (this.liveNotifyTimer) clearTimeout(this.liveNotifyTimer)
    this.liveNotifyTimer = undefined
    if (!this.live) return true
    this.live = undefined
    this.previewRegistration?.changed()
    return true
  }

  private applied(): void {
    if (this.liveNotifyTimer) clearTimeout(this.liveNotifyTimer)
    this.liveNotifyTimer = undefined
    this.live = undefined
    texturePreviewState.changed(this.uri.fsPath)
    this.appliedEmitter.fire()
  }

  get hasLivePreview(): boolean { return Boolean(this.live) }

  get frameCount(): number {
    return this.document.frameCount
  }

  activatePreview(): void { this.previewRegistration?.activate() }

  attach(panel: PanelLike): void {
    this.panels.add(panel)
    this.panel = panel
    this.registerPreview()
  }

  detach(panel?: PanelLike): void {
    if (panel) this.panels.delete(panel)
    else this.panels.clear()
    if (this.panels.size) {
      if (!this.panel || !this.panels.has(this.panel)) this.panel = [...this.panels].at(-1)
      return
    }
    if (this.liveNotifyTimer) clearTimeout(this.liveNotifyTimer)
    this.liveNotifyTimer = undefined
    this.live = undefined
    this.panel = undefined
    this.previewRegistration?.dispose()
    this.previewRegistration = undefined
  }

  sendPaintSettings(keybindings: Record<string, string>): void {
    this.post({ command: 'paintSettings', keybindings })
  }

  notify(level: NoticeMessage['level'], text: string): void {
    this.post({ command: 'notice', level, text })
  }

  sendSnapshot(): void {
    this.post(this.snapshotMessage())
    this.sendHistory()
    this.applied()
  }

  sendHistory(): void {
    this.post({ command: 'paintHistory', entries: this.timeline.entries.map(({ id, label, at }) => ({ id, label, at })), current: this.timeline.entries[this.timeline.current]?.id ?? -1 })
  }

  changeDocument(label: string, mutate: () => void): void {
    const before = this.document.snapshot()
    try { mutate() } catch (error) { this.document.restore(before); throw error }
    const after = this.document.snapshot()
    this.sendSnapshot()
    this.record(label, () => this.restoreDocument(before, 'snapshot'), () => this.restoreDocument(after, 'snapshot'))
  }

  resize(width: number, height: number, scale: boolean): void {
    this.changeDocument(scale ? uiText("ui.pixelEditor.scaleImage") : uiText("ui.pixelEditor.adjustCanvas"), () => this.document.restore(resizeSnapshot(this.document.snapshot(), width, height, scale)))
  }

  resizeFrames(width: number, frameHeight: number, scale: boolean): void {
    this.changeDocument(scale ? uiText("ui.pixelEditor.frameToSizeImage") : uiText("ui.pixelEditor.frameByFrameAdjustmentCanvass"), () => this.document.restore(resizeAnimatedSnapshot(this.document.snapshot(), width, frameHeight, scale)))
  }

  transformLayers(ids: string[], x: number, y: number, width: number, height: number, rotation = 0): void {
    this.changeDocument(ids.length > 1 ? uiText("ui.pixelEditor.changeSelectedLayer") : uiText("ui.pixelEditor.transformLayer"), () => this.document.restore(transformLayers(this.document.snapshot(), ids, x, y, width, height, rotation)))
  }

  frames(frameHeight: number, order: number[]): void {
    this.changeDocument(uiText("ui.pixelEditor.adjustAnimationFrames"), () => this.document.restore(arrangeFrames(this.document.snapshot(), frameHeight, order)))
  }

  insertImage(pixels: Uint8Array, width: number, height: number, x: number, y: number, targetWidth: number, targetHeight: number, name: string, rotation = 0): void {
    this.changeDocument(uiText("ui.pixelEditor.insertLayer"), () => this.document.restore(insertPixels(this.document.snapshot(), pixels, width, height, x, y, targetWidth, targetHeight, name, rotation)))
  }

  restoreHistory(id: number): void {
    try {
      const snapshot = this.timeline.read(id)
      this.changeDocument(uiText("ui.pixelEditor.restorePaintingHistory"), () => this.document.restore(snapshot))
    } catch (error) { this.notify('warn', error instanceof Error ? error.message : String(error)) }
  }

  // 从磁盘还原时重新建立绘画时间线

  replaceDocument(document: PixelDocument): void {
    this.document = document
    this.timeline.reset(document.snapshot(), document.historyText)
    this.sendSnapshot()
  }

  commit(layerId: string, rect: PixelRect, pixels: Uint8Array): boolean {
    if (!this.document.findLayer(layerId)) return this.reject(uiText("ui.pixelEditor.targetLayerNotFound"))
    if (!isRectInside(rect, this.document.width, this.document.height)) return this.reject(uiText("ui.mcpOperations.pixelsBeyondCanvas"))
    if (pixels.length !== rect.width * rect.height * 4) return this.reject(uiText("ui.pixelEditor.thePixelDataLengthDoesNotMatch"))
    const before = this.document.readRect(layerId, rect)
    const after = new Uint8Array(pixels)
    // webview 提交的编辑其本地像素已是权威, 静默写入模型即可, 回显会与用户后续笔画竞态并静默丢像素
    this.writeRectSilently(layerId, rect, after)
    this.record(uiText("ui.pixelEditor.pixelsEdit"),
      () => this.applyRect(layerId, rect, before),
      () => this.applyRect(layerId, rect, after))
    return true
  }

  addLayer(): boolean {
    const doc = this.document
    const previousActive = doc.activeLayerId
    const name = nextLayerName(doc)
    const { id } = doc.insertLayer(0, name)
    doc.setActiveLayer(id)
    this.sendLayers()
    this.record(uiText("ui.pixelEditor.addLayer"),
      () => {
        doc.removeLayer(id)
        if (previousActive !== undefined && doc.findLayer(previousActive)) doc.setActiveLayer(previousActive)
        this.sendLayers()
      },
      () => {
        doc.insertLayer(0, name, undefined, id)
        doc.setActiveLayer(id)
        this.sendLayers()
      })
    return true
  }

  removeLayer(layerId: string): boolean {
    const doc = this.document
    if (!doc.findLayer(layerId)) return this.reject(uiText("ui.pixelEditor.targetLayerNotFound"))
    if (doc.layers.length <= 1) return this.reject(uiText("core.document.keepAtLeastOneLayer"))
    const before = doc.snapshot()
    doc.removeLayer(layerId)
    const after = doc.snapshot()
    this.sendLayers()
    this.record(uiText("ui.pixelEditor.removeLayer"),
      () => this.restoreDocument(before, 'snapshot'),
      () => this.restoreDocument(after, 'layers'))
    return true
  }

  renameLayer(layerId: string, name: string): boolean {
    const next = name.trim()
    if (next.length < 1 || next.length > LAYER_NAME_MAX) return this.reject(uiText("ui.pixelEditor.layerNameToToCharacters", LAYER_NAME_MAX))
    return this.editProperty(layerId, uiText("ui.pixelEditor.renameLayer"), next, layer => layer.name, (doc, value) => doc.renameLayer(layerId, value))
  }

  setLayerVisible(layerId: string, visible: boolean): boolean {
    return this.editProperty(layerId, uiText("ui.pixelEditor.toggleLayerVisibility"), visible, layer => layer.visible, (doc, value) => doc.setVisible(layerId, value))
  }

  setLayerOpacity(layerId: string, opacity: number): boolean {
    if (!Number.isFinite(opacity)) return this.reject(uiText("ui.pixelEditor.opacityMustBeLimited"))
    const next = Math.min(1, Math.max(0, opacity))
    return this.editProperty(layerId, uiText("ui.pixelEditor.aligningLayersWithOpacity"), next, layer => layer.opacity, (doc, value) => doc.setOpacity(layerId, value))
  }

  moveLayer(layerId: string, toIndex: number): boolean {
    const doc = this.document
    const fromIndex = doc.layers.findIndex(layer => layer.id === layerId)
    if (fromIndex < 0) return this.reject(uiText("ui.pixelEditor.targetLayerNotFound"))
    if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= doc.layers.length) return this.reject(uiText("core.document.targetPositionCrossedTheLine"))
    if (fromIndex === toIndex) return true
    this.applyMeta(d => d.moveLayer(layerId, toIndex))
    this.record(uiText("ui.pixelEditor.moveLayer"),
      () => this.applyMeta(d => d.moveLayer(layerId, fromIndex)),
      () => this.applyMeta(d => d.moveLayer(layerId, toIndex)))
    return true
  }

  setActiveLayer(layerId: string): boolean {
    if (!this.document.findLayer(layerId)) return this.reject(uiText("ui.pixelEditor.targetLayerNotFound"))
    this.document.setActiveLayer(layerId)
    if (this.document.findLayer(layerId)?.randomVariant) this.previewVariantId = layerId
    this.sendLayers()
    this.previewRegistration?.changed()
    return true
  }

  crop(rect: PixelRect): boolean {
    const doc = this.document
    if (!isRectInside(rect, doc.width, doc.height)) return this.reject(uiText("ui.pixelEditor.cropAreaBeyondCanvas"))
    const before = doc.snapshot()
    doc.cropTo(rect)
    const after = doc.snapshot()
    if (after.width === before.width && after.height === before.height) return true
    this.sendSnapshot()
    this.record(uiText("ui.pixelEditor.cropCanvas"),
      () => this.restoreDocument(before, 'snapshot'),
      () => this.restoreDocument(after, 'snapshot'))
    return true
  }

  warnIfOutsideWorkspace(target = this.uri): void {
    if (vscode.workspace.getWorkspaceFolder(target) || this.warnedExternalTargets.has(target.toString())) return
    this.warnedExternalTargets.add(target.toString())
    void vscode.window.showWarningMessage(uiText("ui.pixelEditor.thisImageIsOutsideTheCurrentWorking"))
  }

  async writeTo(target: vscode.Uri): Promise<void> {
    const png = this.document.toPng(canMarkTexture(target.path))
    const { width, frameHeight, frameCount } = this.document
    let writeSidecar: (() => Promise<void>) | undefined
    let sidecarFailed = false
    try {
      writeSidecar = prepareProjectWrite(target, this.document, png, this.timeline.serialize())
    } catch { sidecarFailed = true }
    const key = target.scheme === 'file' ? previewPathKey(target.fsPath) : target.toString()
    const work = (pendingSaves.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      try {
        await vscode.workspace.fs.writeFile(target, png)
      } catch (error) {
        void vscode.window.showErrorMessage(uiText("ui.pixelEditor.pngWritingFailedCheckIfTheFile"))
        throw error
      }
      this.warnIfOutsideWorkspace(target)
      try { await writeSidecar?.() } catch { sidecarFailed = true }
      if (sidecarFailed) void vscode.window.showWarningMessage(uiText("ui.pixelEditor.pasteSavedButTheLayerProjectFile"))
      try {
        if (frameHeight !== undefined) await this.writeAnimation(target, width, frameHeight, frameCount)
      } catch (error) {
        void vscode.window.showWarningMessage(uiText("ui.pixelEditor.pastePngSavedButTheAnimationMetadata", (error instanceof Error ? error.message : String(error))))
      }
    })
    pendingSaves.set(key, work)
    try {
      await work
    } finally {
      if (pendingSaves.get(key) === work) pendingSaves.delete(key)
    }
  }

  private async writeAnimation(target: vscode.Uri, width: number, frameHeight: number, frameCount: number): Promise<void> {
    const metadataUri = target.with({ path: target.path + '.mcmeta' })
    let original: unknown
    try { original = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(metadataUri)).toString('utf8')) }
    catch (error) {
      if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) throw new Error(uiText("ui.pixelEditor.existingPngMetadataCannotBeReadOr"))
    }
    const metadata = updateAnimationMetadata(original, width, frameHeight, frameCount)
    if (!metadata) return
    const temporary = metadataUri.with({ path: metadataUri.path + '.' + randomUUID() + '.tmp' })
    try {
      await vscode.workspace.fs.writeFile(temporary, Buffer.from(JSON.stringify(metadata, null, 2) + '\n'))
      await vscode.workspace.fs.rename(temporary, metadataUri, { overwrite: true })
    } finally {
      try { await vscode.workspace.fs.delete(temporary, { recursive: false, useTrash: false }) } catch {}
    }
  }

  dispose(): void {
    this.disposedEmitter.fire()
    this.disposedEmitter.dispose()
    this.detach()
    this.editEmitter.dispose()
    this.appliedEmitter.dispose()
  }

  private editProperty<T>(
    layerId: string,
    label: string,
    next: T,
    read: (layer: Layer) => T,
    write: (doc: PixelDocument, value: T) => void
  ): boolean {
    const layer = this.document.findLayer(layerId)
    if (!layer) return this.reject(uiText("ui.pixelEditor.targetLayerNotFound"))
    const previous = read(layer)
    if (previous === next) return true
    this.applyMeta(doc => write(doc, next))
    this.record(label,
      () => this.applyMeta(doc => write(doc, previous)),
      () => this.applyMeta(doc => write(doc, next)))
    return true
  }

  private writeRectSilently(layerId: string, rect: PixelRect, pixels: Uint8Array): void {
    this.document.writeRect(layerId, rect, pixels)
    this.applied()
  }

  private applyRect(layerId: string, rect: PixelRect, pixels: Uint8Array): void {
    this.document.writeRect(layerId, rect, pixels)
    this.post(this.patchMessage(layerId, rect, pixels))
    this.applied()
  }

  private applyMeta(mutate: (doc: PixelDocument) => void): void {
    mutate(this.document)
    this.sendLayers()
  }

  private restoreDocument(snapshot: DocumentSnapshot, mode: 'snapshot' | 'layers'): void {
    this.document.restore(snapshot)
    if (mode === 'snapshot') this.sendSnapshot()
    else this.sendLayers()
  }

  private sendLayers(): void {
    this.post(this.layersMessage())
    this.applied()
  }

  private record(label: string, undo: () => void, redo: () => void): void {
    const before = this.timeline.entries[this.timeline.current]?.id ?? -1
    const after = this.timeline.add(label, this.document.snapshot())
    this.sendHistory()
    this.editEmitter.fire({ document: this, label,
      undo: () => { undo(); this.timeline.point(before); this.sendHistory() },
      redo: () => { redo(); this.timeline.point(after); this.sendHistory() }
    })
  }

  private reject(text: string): false {
    this.notify('warn', text)
    return false
  }

  private post(message: PixelHostMessage): void {
    for (const panel of this.panels) void panel.webview.postMessage(message)
  }

  private snapshotMessage(): SnapshotMessage {
    const doc = this.document
    const layers: LayerPixels[] = doc.layers.map(layer => ({
      id: layer.id,
      name: layer.name,
      visible: layer.visible,
      opacity: layer.opacity,
      randomVariant: layer.randomVariant,
      pixels: toArrayBuffer(layer.pixels)
    }))
    return {
      command: 'snapshot',
      width: doc.width,
      height: doc.height,
      frameCount: doc.frameCount,
      frameHeight: doc.frameHeight,
      activeLayerId: doc.activeLayerId,
      layers
    }
  }

  private layersMessage(): LayersMessage {
    const doc = this.document
    const layers: LayerInfo[] = doc.layers.map(layer => ({
      id: layer.id,
      name: layer.name,
      visible: layer.visible,
      opacity: layer.opacity,
      randomVariant: layer.randomVariant
    }))
    return { command: 'layers', activeLayerId: doc.activeLayerId, layers }
  }

  private patchMessage(layerId: string, rect: PixelRect, pixels: Uint8Array): PatchMessage {
    return {
      command: 'patch',
      layerId,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      pixels: toArrayBuffer(pixels)
    }
  }
}

export async function loadPixelDocument(uri: vscode.Uri, options: { bytes?: Uint8Array; silent?: boolean } = {}): Promise<PixelDocument> {
  const bytes = options.bytes ?? new Uint8Array(await vscode.workspace.fs.readFile(uri))
  const base = PixelDocument.fromPng(bytes)
  base.layers[0].id = 'disk-' + createHash('sha256').update(uri.toString()).digest('hex').slice(0, 32)
  base.activeLayerId = base.layers[0].id
  try {
    const metadata = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri.with({ path: uri.path + '.mcmeta' }))).toString('utf8'))
    base.frameHeight = animationFrameHeight(metadata, base.width, base.height) ?? base.height
  } catch (error) {
    if (!options.silent && !(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) void vscode.window.showWarningMessage(uiText("ui.pixelEditor.pngOpenedButCouldNotRecognizeAnimated"))
  }
  const restored = await readProject(uri, bytes, base.width, base.height)
  if (!restored) return base
  const doc = PixelDocument.fromLayers(base.width, base.height, restored.layers, restored.activeLayerId)
  doc.frameHeight = restored.frameHeight ?? base.frameHeight; doc.historyText = restored.history
  return doc
}

async function deleteBackup(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false })
  } catch {
    // 备份不存在或无权限时跳过
  }
}

export class PixelEditorProvider implements vscode.CustomEditorProvider<PixelDocumentModel>, vscode.Disposable {
  public static readonly viewType = 'mcrh.pixelEditor'
  private readonly openModels = new Map<string, PixelDocumentModel>()
  private static settingsSaveQueue: Promise<void> = Promise.resolve()

  private readonly editEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<PixelDocumentModel>>()
  readonly onDidChangeCustomDocument = this.editEmitter.event

  private static registered?: PixelEditorProvider

  static listOpenModels(): PixelDocumentModel[] { return [...(this.registered?.openModels.values() ?? [])] }

  static findOpenModel(uri: vscode.Uri): PixelDocumentModel | undefined { return this.registered?.openModels.get(uri.toString()) }

  static create(context?: vscode.ExtensionContext): PixelEditorProvider {
    return new PixelEditorProvider(context as vscode.ExtensionContext)
  }

  // 注册时必须传入真实 context, 否则解析 webview 资源地址会失败
  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new PixelEditorProvider(context)
    PixelEditorProvider.registered = provider
    const registration = vscode.window.registerCustomEditorProvider(
      PixelEditorProvider.viewType,
      provider,
      { supportsMultipleEditorsPerDocument: false, webviewOptions: { retainContextWhenHidden: true } }
    )
    const random = vscode.commands.registerCommand('mcrh.addRandomTextures', async (uri: vscode.Uri) => {
      const model = uri?.scheme === 'file' ? provider.openModels.get(uri.toString()) : undefined
      if (!model) throw new Error(uiText("ui.pixelEditor.pleaseOpenTheCorrespondingPixelEditorFirst"))
      const host = new PixelRandomVariantsHost(context, model)
      try { await host.addImages() } finally { host.dispose() }
    })
    return vscode.Disposable.from(registration, random, provider, { dispose() { if (PixelEditorProvider.registered === provider) PixelEditorProvider.registered = undefined } })
  }

  private constructor(private readonly context: vscode.ExtensionContext) {}

  async openModel(uri: vscode.Uri, backupId?: string): Promise<PixelDocumentModel> {
    const model = new PixelDocumentModel(uri, await this.loadDocument(uri, backupId))
    model.warnIfOutsideWorkspace()
    model.onDidChange(event => this.editEmitter.fire(event))
    this.openModels.set(uri.toString(), model)
    model.onDidDispose(() => { if (this.openModels.get(uri.toString()) === model) this.openModels.delete(uri.toString()) })
    return model
  }

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<PixelDocumentModel> {
    return this.openModel(uri, openContext.backupId)
  }

  async resolveCustomEditor(
    model: PixelDocumentModel,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    }
    webviewPanel.webview.html = getHtml(webviewPanel.webview, this.context.extensionUri, 'paint', webviewPanel)
    model.attach(webviewPanel)
    const follow = webviewPanel.onDidChangeViewState(event => {
      if (event.webviewPanel.active) model.activatePreview()
    })
    if (webviewPanel.active) model.activatePreview()

    const settings = vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('mcrh.paintKeybindings')) this.sendSettings(model)
    })
    const applied = model.onDidApply(() => void this.syncContext(model))
    const git = new GitWorkbenchHost(webviewPanel.webview, model.uri)
    const editing = new PixelEditingHost(model, webviewPanel.webview)
    const todos = new TodoHost(webviewPanel.webview, model.uri)
    const references = new ReferenceImagesHost(webviewPanel.webview, { state: this.context.workspaceState, key: referenceStorageKey(model.uri) })
    const variants = new PixelRandomVariantsHost(this.context, model)
    const messages = onWebviewMessage(webviewPanel.webview, (raw: unknown) => {
      if (raw && typeof raw === 'object' && (raw as { command?: unknown }).command === 'randomVariants') { void variants.handle(raw); return }
      if (raw && typeof raw === 'object' && (raw as { command?: unknown }).command === 'referenceImages') { void references.handle(raw); return }
      if (raw && typeof raw === 'object' && (raw as { command?: unknown }).command === 'gitWorkbench') { void git.handle(raw); return }
      if (raw && typeof raw === 'object' && (raw as { command?: unknown }).command === 'pixelTools') { void editing.handle(raw); return }
      if (raw && typeof raw === 'object' && (raw as { command?: unknown }).command === 'todo') { void todos.handle(raw); return }
      if (raw && typeof raw === 'object' && (raw as { command?: unknown }).command === 'openTextureInBlockbench') { void vscode.commands.executeCommand('mcrh.openTextureInBlockbench', model.uri); return }
      if (raw && typeof raw === 'object' && (raw as { command?: unknown }).command === 'openGuiPreview') { void vscode.commands.executeCommand('mcrh.previewGui', model.uri); return }
      if (raw && typeof raw === 'object' && (raw as { command?: unknown }).command === 'open3dPreview') { void vscode.commands.executeCommand('mcrh.previewVanillaModel', model.uri); return }
      this.dispatch(model, raw)
    })
    webviewPanel.onDidDispose(() => {
      follow.dispose()
      applied.dispose()
      settings.dispose()
      messages.dispose()
      references.dispose()
      variants.dispose()
      editing.dispose()
      git.dispose()
      todos.dispose()
      model.detach(webviewPanel)
      void setContext(CONTEXT_KEYS.currentIsAnimatedTexture, false)
      void setContext(CONTEXT_KEYS.currentIsPng, false)
    })
    await this.syncContext(model)
  }

  async saveCustomDocument(model: PixelDocumentModel, _token: vscode.CancellationToken): Promise<void> {
    await model.writeTo(model.uri)
  }

  async saveCustomDocumentAs(
    model: PixelDocumentModel,
    destination: vscode.Uri,
    _token: vscode.CancellationToken
  ): Promise<void> {
    await model.writeTo(destination)
  }

  async revertCustomDocument(model: PixelDocumentModel, _token: vscode.CancellationToken): Promise<void> {
    model.replaceDocument(await loadPixelDocument(model.uri))
  }

  async backupCustomDocument(
    model: PixelDocumentModel,
    context: vscode.CustomDocumentBackupContext,
    _token: vscode.CancellationToken
  ): Promise<vscode.CustomDocumentBackup> {
    const destination = context.destination
    await vscode.workspace.fs.writeFile(destination, Buffer.from(buildBackupText(model.document), 'utf8'))
    return {
      id: destination.toString(),
      delete: () => deleteBackup(destination)
    }
  }

  dispose(): void {
    this.editEmitter.dispose()
  }

  private async loadDocument(uri: vscode.Uri, backupId?: string): Promise<PixelDocument> {
    if (backupId) {
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(backupId))
        return parseBackupText(Buffer.from(bytes).toString('utf8'))
      } catch {
        void vscode.window.showWarningMessage(uiText("ui.pixelEditor.couldNotRestoreUnsavedPixelBrushFrom"))
      }
    }
    return loadPixelDocument(uri)
  }

  private async syncContext(model: PixelDocumentModel): Promise<void> {
    await setContext(CONTEXT_KEYS.currentIsPng, model.uri.fsPath.toLowerCase().endsWith('.png'))
    await setContext(CONTEXT_KEYS.currentIsAnimatedTexture, model.frameCount > 1)
  }

  private sendSettings(model: PixelDocumentModel): void {
    const inspected = vscode.workspace.getConfiguration('mcrh').inspect<unknown>('paintKeybindings')
    const raw = inspected?.globalValue ?? inspected?.defaultValue ?? {}
    model.sendPaintSettings(validateBindings(raw).bindings)
  }

  private async saveKeybindings(model: PixelDocumentModel, raw: Record<string, string>): Promise<void> {
    const operation = () => this.commitKeybindings(model, raw)
    const pending = PixelEditorProvider.settingsSaveQueue.then(operation, operation)
    PixelEditorProvider.settingsSaveQueue = pending.catch(() => undefined)
    await pending
  }

  private async commitKeybindings(model: PixelDocumentModel, raw: Record<string, string>): Promise<void> {
    const existing = vscode.workspace.getConfiguration('mcrh').inspect<unknown>('paintKeybindings')?.globalValue ?? {}
    const current = validateBindings(existing).bindings
    const result = validateBindings({ ...current, ...raw })
    if (!result.valid) { model.notify('warn', uiText("ui.pixelEditor.shortcutConflictOrGroupingNotSaved")); return }
    try {
      await vscode.workspace.getConfiguration('mcrh').update('paintKeybindings', result.bindings, vscode.ConfigurationTarget.Global)
      this.sendSettings(model)
      model.notify('info', uiText("ui.pixelEditor.shortcutsSavedToGlobalSettingsAndThe"))
    } catch (error) { model.notify('error', uiText("ui.pixelEditor.failedToSaveShortcutKey", String(error))); this.sendSettings(model) }
  }

  private dispatch(model: PixelDocumentModel, raw: unknown): void {
    if (raw && typeof raw === 'object') {
      const data = raw as { command?: unknown; sequence?: unknown }
      if (data.command === 'previewStroke') { model.previewStroke(raw); return }
      if (data.command === 'previewStrokeEnd') { if (typeof data.sequence === 'number') model.endPreviewStroke(data.sequence); return }
    }
    const command = parsePixelCommand(raw)
    if (!command) {
      model.notify('warn', uiText("ui.pixelEditor.receivedUnrecognizedBrushCommandIgnored"))
      return
    }
    switch (command.command) {
      case 'ready':
        model.resetPreviewSession()
        this.sendSettings(model)
        model.sendSnapshot()
        break
      case 'setKeybindings':
        void this.saveKeybindings(model, command.bindings)
        break
      case 'commit':
        model.commit(command.layerId, command.rect, new Uint8Array(command.pixels))
        break
      case 'addLayer':
        model.addLayer()
        break
      case 'removeLayer':
        model.removeLayer(command.layerId)
        break
      case 'renameLayer':
        model.renameLayer(command.layerId, command.name)
        break
      case 'moveLayer':
        model.moveLayer(command.layerId, command.toIndex)
        break
      case 'setLayerVisible':
        model.setLayerVisible(command.layerId, command.visible)
        break
      case 'setLayerOpacity':
        model.setLayerOpacity(command.layerId, command.opacity)
        break
      case 'editRandomVariant':
        try { model.changeDocument(uiText("ui.pixelEditor.modifyRandomCandidate"), () => editRandomVariant(model.document, command)) } catch (error) { model.notify('warn', String(error)) }
        break
      case 'setActiveLayer':
        model.setActiveLayer(command.layerId)
        break
      case 'crop':
        model.crop(command.rect)
        break
      case 'restoreHistory':
        model.restoreHistory(command.id)
        break
      case 'undo':
        void vscode.commands.executeCommand('undo')
        break
      case 'redo':
        void vscode.commands.executeCommand('redo')
        break
    }
  }
}


