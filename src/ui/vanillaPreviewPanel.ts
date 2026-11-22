import { uiText } from '../i18n/messages'
import { postPreviewSession, type PreviewSession } from '../core/previewSession'
import { onWebviewMessage } from './webviewDiagnostics'
import { tryShowGuiPreview } from './guiPreviewPanel'
import { createHash } from 'node:crypto'
import { addPreviewGeneratedBase, compactPreviewGeneratedBase, optimizePreviewAlphaModel, openPreviewModel, openPreviewModelInBlockbench } from './modelPreviewDocuments'
import { completeCurrentClientPack } from './clientPackCompletion'
import { sourceOf } from './previewResourceContext'
import { textureModelFallback } from '../core/previewFallback'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { PNG } from 'pngjs'
import { texturePreviewKind, vehicleIdFromTexture, vehiclePreview } from '../core/previewContexts'
import { isPreviewResource, previewPathKey, texturePreviewState } from '../core/texturePreviewState'
import { readPreview, previewMessageFromMemory, watchPreviewEditors } from './previewPanel'
import type { PreviewMessage } from '../webview/messages'
import { ModelPreviewAssets, ModelPreviewAssetsError, type ModelPreviewCandidate } from '../core/modelPreviewAssets'
import { isSafePackDirectory } from '../core/packDetector'
import type { VanillaAssetRequest, VanillaAssetResponse, VanillaPreviewInit, VanillaPreviewTarget } from '../webview/vanillaPreviewProtocol'
import { getHtml } from './htmlShell'
import { ensurePreviewClientAssets } from './previewClientAssets'
import { previewResourceContext } from './previewResourceContext'
import { isPreviewLanguageFile, watchPreviewLanguages } from './previewLanguageWatcher'
import { previewClientStoragePath } from '../core/previewClientStorage'
import { ResourceNameResolver, resourceFromAssetPath } from '../core/resourceNames'

interface PreviewDiagnostics { warnings: string[]; missingPaths?: string[]; repairVersion?: string }
interface PreparedPreview { assets: ModelPreviewAssets; names: ResourceNameResolver; candidates: ModelPreviewCandidate[]; relative?: string; exhaustive?: boolean; init: Omit<VanillaPreviewInit, 'sessionId'> }

async function chooseBase(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    title: uiText("ui.vanillaPreviewPanel.selectTheOriginalResourceDirectoryForMinecraft"),
    canSelectFolders: true, canSelectFiles: false, canSelectMany: false
  })
  const root = picked?.[0]
  if (!root || root.scheme !== 'file') return undefined
  if (!await isSafePackDirectory(root.fsPath) || !await isSafePackDirectory(path.join(root.fsPath, 'assets'))) {
    await vscode.window.showWarningMessage(uiText("ui.vanillaPreviewPanel.theSelectedDirectoryNeedsToContainThe"))
    return undefined
  }
  await vscode.workspace.getConfiguration('mcrh').update('previewBaseAssetsPath', root.fsPath, vscode.ConfigurationTarget.Global)
  return root.fsPath
}

function previewChoices(candidates: ModelPreviewCandidate[], relative: string): ModelPreviewCandidate[] {
  const choices = new Map<string, ModelPreviewCandidate>()
  const categories = relative.split('/')
  const itemSource = categories[2] === 'items' || categories[2] === 'models' && categories[3] === 'item' || texturePreviewKind(relative) === 'item'
  const order = itemSource ? ['item', 'model', 'block'] : ['block', 'model', 'item']
  const representedModels = new Set(candidates.filter(value => value.kind !== 'model').flatMap(value => value.models))
  const modelRank = (value: ModelPreviewCandidate) => value.id.includes(itemSource ? ':item/' : ':block/') ? 0 : 1
  const visible = candidates.filter(value => value.kind !== 'model' || !representedModels.has(value.id) || value.path === relative)
  for (const candidate of visible.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || modelRank(a) - modelRank(b) || a.id.localeCompare(b.id))) {
    const key = candidate.kind + ':' + candidate.id
    if (!choices.has(key)) choices.set(key, candidate)
  }
  return [...choices.values()]
}

async function preparePreview(uri: vscode.Uri, allowChooseBase: boolean, preferred?: VanillaPreviewTarget, context?: vscode.ExtensionContext): Promise<PreparedPreview | undefined> {
  const resource = await previewResourceContext(uri, context)
  if (!resource) {
    if (allowChooseBase) await vscode.window.showWarningMessage(uiText("ui.vanillaPreviewPanel.modelPreviewRequiresResourcesInAsetsNamespace"))
    return undefined
  }
  const { source, assets, names } = resource, roots = assets.roots
  const detectedVersion = { version: resource.version, warning: resource.warnings[0] }
  const baseWarning = resource.warnings.slice(1).join('；') || undefined
  const categories = source.relative.split('/')
  if (!['textures', 'models', 'blockstates', 'items'].includes(categories[2])) return undefined
  const entityId = vehicleIdFromTexture(source.relative)
  const directEntity = entityId && vehiclePreview(entityId)
  if (directEntity) {
    const version = { version: resource.version, warning: resource.warnings[0] }
    const target = { kind: 'entity' as const, id: entityId!, ...await names.resolve({ kind: 'entity', id: entityId! }) }
    return { assets, names, candidates: [], init: { command: 'vanillaInit', target, targets: [target], vehicle: directEntity,
      version: version.version, repairVersion: version.version, properties: {}, initialProperties: {}, supportsTallBlock: false,
      packLabel: path.basename(source.root), layers: roots.map(root => path.basename(root)),
      warnings: [version.warning, baseWarning, ...(target.nameWarnings ?? []), uiText("ui.vanillaPreviewPanel.entitiesUseClientModelStructuresAndStand")].filter((value): value is string => Boolean(value)) } }
  }
  let candidates: ModelPreviewCandidate[]
  let missingModelWarning: string | undefined
  let missingModelPaths: readonly string[] = []
  let exhaustive = false
  try {
    candidates = await assets.candidates(source.relative, { discovery: 'direct' })
    if (!candidates.length || preferred && !candidates.some(value => value.kind === preferred.kind && value.id === preferred.id)) {
      candidates = await assets.candidates(source.relative)
      exhaustive = true
    }
  }
  catch (error) {
    if (!(error instanceof ModelPreviewAssetsError) || error.code !== 'MISSING_ASSET') throw error
    const fallback = textureModelFallback(source.relative)
    if (fallback) { candidates = []; missingModelWarning = error.message; missingModelPaths = error.missingPaths ?? [] }
    else { if (!allowChooseBase) throw error
    const selection = await vscode.window.showWarningMessage(uiText("ui.vanillaPreviewPanel.modelReferencesMissingOriginalParentModelOr"), uiText("ui.vanillaPreviewPanel.selectOriginalResourceDirectory"))
    if (selection && await chooseBase()) return preparePreview(uri, false, preferred, context)
    throw error
    }
  }
  const values = previewChoices(candidates, source.relative)
  const chosen = preferred && values.find(value => value.kind === preferred.kind && value.id === preferred.id) || values[0]
  const target: VanillaPreviewTarget | undefined = chosen && { kind: chosen.kind, id: chosen.id, ...await names.resolve(chosen) }
  const initialProperties = chosen?.properties ?? {}
  if (!target) {
    const fallback = textureModelFallback(source.relative)
    if (fallback) {
      const parts = source.relative.split('/'), kind = parts[3]!, id = parts[1] + ':' + kind + '/' + parts.slice(4).join('/').replace(/\.png$/, '')
      const missingPaths = [...new Set([...missingModelPaths, ...await Promise.all(fallback.missingPaths.map(async path => await assets.read(path) ? undefined : path))].filter((value): value is string => Boolean(value)))]
      const fallbackTarget = { kind: 'model' as const, id, ...await names.resolve({ kind: 'model', id }) }
      return { assets, names, candidates: [], relative: source.relative, exhaustive, init: {
        command: 'vanillaInit', target: fallbackTarget, version: detectedVersion.version, repairVersion: detectedVersion.version,
        properties: {}, initialProperties: {}, supportsTallBlock: false, packLabel: path.basename(source.root), layers: roots.map(root => path.basename(root)),
        fallbackModel: fallback.model, missingPaths,
        warnings: [detectedVersion.warning, baseWarning, missingModelWarning, fallback.warning, ...(fallbackTarget.nameWarnings ?? [])].filter((value): value is string => Boolean(value))
      } }
    }
    if (allowChooseBase) {
      const selection = await vscode.window.showWarningMessage(uiText("ui.vanillaPreviewPanel.cannotFindModelAndFullTextureReferences"), uiText("ui.vanillaPreviewPanel.selectOriginalResourceDirectory"))
      if (selection && await chooseBase()) return preparePreview(uri, false, undefined, context)
    }
    return undefined
  }
  const properties = target.kind === 'block' ? await assets.blockstateValues(target.id) : {}
  const supportsTallBlock = target.kind === 'block' && properties.half?.includes('lower') === true && properties.half?.includes('upper') === true
  const version = { version: resource.version, warning: resource.warnings[0] }
  return { assets, names, candidates: values, relative: source.relative, exhaustive, init: {
    command: 'vanillaInit', target, repairVersion: version.version, targets: await names.targets(values.map(({ kind, id }) => ({ kind, id }))), version: version.version, vehicle: target.kind === 'item' ? vehiclePreview(target.id) : undefined,
    properties, initialProperties, supportsTallBlock,
    packLabel: path.basename(source.root), layers: roots.map(root => path.basename(root)),
    warnings: [version.warning, baseWarning, ...(target.nameWarnings ?? []), ...(roots.length > 1 ? [uiText("ui.vanillaPreviewPanel.modelsObjectDefinitionsAndParentModelsNot")] : []), uiText("ui.vanillaPreviewPanel.independentModelPreviewDoesNotRunThe")].filter((value): value is string => Boolean(value))
  } }
}

async function withModelFile(prepared: PreparedPreview): Promise<PreparedPreview> {
  prepared = { ...prepared, init: { ...prepared.init, modelContext: createHash('sha256').update(JSON.stringify(prepared.assets.roots)).digest('hex') } }
  const target = prepared.init.target
  if (target.kind === 'entity') return prepared
  const candidate = prepared.candidates.find(value => value.kind === target.kind && value.id === target.id)
  const model = target.kind === 'model' ? target.id : candidate?.models[0] ?? target.id.replace(':', target.kind === 'block' ? ':block/' : ':item/')
  const [namespace, location] = model.includes(':') ? model.split(':') : ['minecraft', model]
  if (!namespace || !location || location.startsWith('builtin/')) return prepared
  const relative = 'assets/' + namespace + '/models/' + location + '.json'
  const exists = Boolean(await prepared.assets.read(relative, 0))
  const models = [...new Set([relative, ...(candidate?.models ?? []).map(id => {
    const [namespace, location] = id.includes(':') ? id.split(':') : ['minecraft', id]
    return 'assets/' + namespace + '/models/' + location + '.json'
  })])]
  const modelFiles = await Promise.all(models.map(async path => ({ path, exists: Boolean(await prepared.assets.read(path, 0)) })))
  return { ...prepared, init: { ...prepared.init, modelFile: { path: relative, exists }, modelFiles } }
}

type PreparedContent = { prepared?: PreparedPreview; flat?: PreviewMessage; diagnostics?: PreviewDiagnostics; resourceRoots?: readonly string[] }

async function prepareContent(uri: vscode.Uri, interactive: boolean, preferred?: VanillaPreviewTarget, quickFlat?: ReturnType<typeof readPreview>, context?: vscode.ExtensionContext): Promise<PreparedContent> {
  let failure: unknown
  try {
    const prepared = await preparePreview(uri, interactive, preferred, context)
    if (prepared) return { prepared: await withModelFile(prepared) }
  } catch (error) {
    if (!uri.fsPath.toLowerCase().endsWith('.png')) throw error
    failure = error
  }
  if (uri.fsPath.toLowerCase().endsWith('.png')) {
    const result = await (quickFlat ?? readPreview(uri, async () => ({})))
    if (!result.ok) throw new Error(result.error)
    const resource = await previewResourceContext(uri, context)
    const diagnostics: PreviewDiagnostics = {
      warnings: [failure instanceof Error ? failure.message : uiText("ui.vanillaPreviewPanel.noReadableObjectDefinitionModelOrBlock"), ...(resource?.warnings ?? [])],
      missingPaths: failure instanceof ModelPreviewAssetsError ? [...(failure.missingPaths ?? [])] : [],
      repairVersion: resource?.version
    }
    const namedResource = resource && resourceFromAssetPath(resource.source.relative)
    if (namedResource && resource) {
      Object.assign(result.message, await resource.names.resolve(namedResource))
      diagnostics.warnings.push(...(result.message.nameWarnings ?? []))
    }
    if (resource && texturePreviewKind(resource.source.relative) === 'item') {
      const parts = resource.source.relative.split('/'), id = parts.slice(4).join('/').replace(/\.png$/, '')
      const references = ['assets/' + parts[1] + '/items/' + id + '.json', 'assets/' + parts[1] + '/models/item/' + id + '.json']
      for (const reference of references) if (!await resource.assets.read(reference)) diagnostics.missingPaths!.push(reference)
      diagnostics.warnings.push(uiText("ui.vanillaPreviewPanel.handheldModelsAndPlacementBehaviourOfItems"))
    }
    return { flat: result.message, diagnostics, resourceRoots: resource?.assets.roots }
  }
  throw new Error(uiText("ui.vanillaPreviewPanel.theCurrentResourceDoesNotHaveA"))
}

export class VanillaPreviewPanel implements vscode.Disposable {
  private static current?: VanillaPreviewPanel
  private static ticket = 0
  private static readonly cacheJobs = new Map<string, Promise<string | undefined>>()
  private readonly cachedVersions = new Set<string>()
  private readonly cacheSubscriptions = new Set<string>()
  private readonly cacheRefreshVersions = new Set<string>()
  private readonly disposables: vscode.Disposable[] = []
  private watchers: vscode.Disposable[] = []
  private languageRoots: readonly string[] = []
  private ready = false
  private closed = false
  private following = true
  private explicitLoad = true
  private pendingFocus?: vscode.Uri
  private sessionId = 0
  private prepared?: PreparedPreview
  private flat?: PreviewMessage
  private diagnostics?: PreviewDiagnostics
  private readonly repairs = new Set<number>()
  private flatMetadataDirty = false
  private failure?: string
  private loadingName?: string
  private persistedSource?: vscode.Uri
  private source?: vscode.Uri
  private loadedSource?: string
  private target?: VanillaPreviewTarget
  private loadRevision = 0
  private textureRevision = 0
  private readonly lists = new Map<string, Promise<string[]>>()
  private addingGenerated = false
  private readonly reads = new Map<string, Promise<Uint8Array | undefined>>()
  private readonly invalidations = new Map<string, { layer: number; path: string; revision: number }>()
  private readonly pendingBySession = new Map<number, number>()
  private nameRevision = 0
  private namesDirty = false
  private nameTimer?: ReturnType<typeof setTimeout>
  private refreshTimer?: ReturnType<typeof setTimeout>
  private textureTimer?: ReturnType<typeof setTimeout>
  private discoveryTimer?: ReturnType<typeof setTimeout>
  private discovering?: ModelPreviewAssets

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly context: vscode.ExtensionContext) {
    panel.webview.html = getHtml(panel.webview, context.extensionUri, 'vanillaPreview', panel)
    onWebviewMessage(panel.webview, (value: unknown) => { void this.receive(value).catch(error => this.report(error)) }, undefined, this.disposables)
    panel.onDidDispose(() => this.dispose(), undefined, this.disposables)
    this.disposables.push(texturePreviewState.subscribe(event => {
      if (event.type === 'active' && this.following && this.source) {
        const uri = vscode.Uri.file(event.uri)
        if (this.explicitLoad) this.pendingFocus = uri
        else if (previewPathKey(event.uri) !== previewPathKey(this.source.fsPath)) void this.load(uri)
      } else if (event.type === 'texture') this.invalidateFile(event.uri)
    }), watchPreviewEditors())
    const modelChanges = vscode.workspace.onDidChangeTextDocument?.(event => {
      const file = event.document.uri
      if (file.scheme !== 'file' || !/[/\\](?:models|items)[/\\].+\.json$/i.test(file.fsPath)) return
      if (this.prepared?.assets.roots.some(root => { const relative = path.relative(root, file.fsPath); return !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) })) this.queueAssetRefresh()
    })
    if (modelChanges) this.disposables.push(modelChanges)
  }

  static async followFromOrdinary(context: vscode.ExtensionContext, uri: vscode.Uri, valid: () => boolean): Promise<boolean> {
    if (!valid()) return false
    const existing = this.current
    if (existing) {
      if (!existing.following) return false
      if (!existing.source || previewPathKey(existing.source.fsPath) !== previewPathKey(uri.fsPath)) await existing.load(uri)
      if (valid() && !existing.closed && existing.source && previewPathKey(existing.source.fsPath) === previewPathKey(uri.fsPath)) existing.panel.reveal(vscode.ViewColumn.Beside, true)
      return true
    }
    return this.show(context, uri, false, valid)
  }

  static async show(context: vscode.ExtensionContext, uri: vscode.Uri, allowChooseBase = true, valid: () => boolean = () => true): Promise<boolean> {
    if (!valid()) return false
    if (tryShowGuiPreview(context, uri)) return true
    const ticket = ++this.ticket
    let instance = this.current
    if (!instance) {
      const panel = vscode.window.createWebviewPanel('mcrh.vanillaPreview', uiText("ui.htmlShell.mcrhOriginalModelPreview"), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
        enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri]
      })
      instance = new VanillaPreviewPanel(panel, context)
      this.current = instance
    }
    instance.explicitLoad = true
    instance.pendingFocus = undefined
    instance.panel.reveal(vscode.ViewColumn.Beside, true)
    try {
      return await instance.load(uri, allowChooseBase, () => valid() && ticket === this.ticket, true)
    } finally {
      if (ticket === this.ticket) instance.finishExplicit(instance.loadRevision)
    }
  }

  static async restore(context: vscode.ExtensionContext, panel: vscode.WebviewPanel, session: PreviewSession): Promise<void> {
    this.current?.dispose()
    panel.webview.options = { enableScripts: true, localResourceRoots: [context.extensionUri] }
    const instance = new VanillaPreviewPanel(panel, context)
    this.current = instance
    instance.following = session.following !== false
    try { await instance.load(vscode.Uri.file(session.source)) }
    finally { instance.finishExplicit(instance.loadRevision) }
  }

  private persist(): void {
    if (this.persistedSource) postPreviewSession(this.panel.webview, { kind: 'model', source: this.persistedSource.fsPath, following: this.following })
  }

  private finishExplicit(revision: number): void {
    if (this.closed || revision !== this.loadRevision) return
    this.explicitLoad = false
    const pending = this.pendingFocus
    this.pendingFocus = undefined
    if (this.following && pending && this.source && previewPathKey(pending.fsPath) !== previewPathKey(this.source.fsPath)) void this.load(pending)
  }

  private cancelRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    if (this.textureTimer) clearTimeout(this.textureTimer)
    if (this.nameTimer) clearTimeout(this.nameTimer)
    this.nameRevision++
    this.nameTimer = undefined
    this.refreshTimer = undefined; this.textureTimer = undefined
    this.invalidations.clear(); this.flatMetadataDirty = false
  }

  private report(error: unknown): void {
    if (!this.closed) void vscode.window.showErrorMessage(uiText("ui.vanillaPreviewPanel.synchronisingS", String(error)))
  }

  private applyContent(content: PreparedContent): void {
    this.cancelRefresh()
    this.loadedSource = this.source?.fsPath
    if (content.resourceRoots) this.languageRoots = content.resourceRoots
    else if (content.prepared?.assets !== this.prepared?.assets) this.languageRoots = content.prepared?.assets.roots ?? []
    this.prepared = content.prepared
    this.flat = content.flat
    this.diagnostics = content.diagnostics
    this.flatMetadataDirty = false
    this.target = content.prepared?.init.target
    this.failure = undefined
    this.loadingName = undefined
    this.sessionId++
    this.lists.clear(); this.reads.clear(); this.invalidations.clear()
    this.panel.title = content.prepared ? uiText("ui.vanillaPreviewPanel.mcrhDPreview", (content.prepared.init.target.displayName ?? content.prepared.init.target.id)) : uiText("ui.vanillaPreviewPanel.mcrhPlane", (content.flat?.displayName ?? content.flat?.name))
    this.watchAssets()
    if (this.namesDirty) this.queueNames()
  }

  private queueAssetRefresh(): void {
    if (this.closed) return
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      if (this.closed) return
      if (this.source) void this.load(this.source)
    }, 300)
  }

  private watchAssets(): void {
    for (const watcher of this.watchers) watcher.dispose()
    this.watchers = []
    const changed = (uri: vscode.Uri): void => {
      if (isPreviewLanguageFile(uri.fsPath)) { this.queueNames(); return }
      if (/\.png(?:\.mcmeta)?$/i.test(uri.fsPath)) { this.invalidateFile(uri.fsPath); return }
      this.queueAssetRefresh()
    }
    const patterns = this.prepared ? this.prepared.assets.roots.map(root => new vscode.RelativePattern(root, 'assets/**'))
      : this.source ? [new vscode.RelativePattern(path.dirname(this.source.fsPath), '*')] : []
    if (this.source) this.watchers.push(watchPreviewLanguages(this.source, this.context, () => this.queueNames(), this.languageRoots))
    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern)
      this.watchers.push(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed))
    }
  }

  private async load(uri: vscode.Uri, interactive = false, valid: () => boolean = () => true, throwErrors = false): Promise<boolean> {
    if (this.closed || !isPreviewResource(uri.fsPath) || !valid()) return false
    if (tryShowGuiPreview(this.context, uri)) {
      this.cancelRefresh(); this.loadRevision++; this.source = uri; this.prepared = undefined; this.flat = undefined; this.target = undefined; this.loadingName = undefined; this.diagnostics = undefined; this.languageRoots = []
      this.sessionId++; this.reads.clear(); this.lists.clear(); this.watchAssets()
      await this.sendInit()
      return true
    }
    const same = this.source && previewPathKey(this.source.fsPath) === previewPathKey(uri.fsPath)
    const preferred = same ? this.target : undefined
    this.cancelRefresh()
    this.source = uri
    this.persistedSource = uri
    this.persist()
    this.prepared = undefined; this.flat = undefined; this.failure = undefined; this.diagnostics = undefined; this.languageRoots = []
    this.loadingName = path.basename(uri.fsPath)
    this.sessionId++
    this.reads.clear(); this.lists.clear()
    const revision = ++this.loadRevision
    const current = () => !this.closed && revision === this.loadRevision && valid()
    this.panel.title = uiText("ui.vanillaPreviewPanel.mcrhPreview", this.loadingName)
    await this.sendInit()
    if (!current()) return false
    const quickFlat = uri.fsPath.toLowerCase().endsWith('.png') ? readPreview(uri, async () => ({})) : undefined
    if (quickFlat) void quickFlat.then(async result => {
      if (!current() || !this.loadingName || !result.ok) return
      this.flat = result.message
      this.loadedSource = uri.fsPath
      this.watchAssets()
      await this.sendInit()
    }).catch(error => this.report(error))
    try {
      const content = await prepareContent(uri, interactive, preferred, quickFlat, this.context)
      if (!current()) return false
      if (content.flat) content.flat = { ...content.flat, ...(this.latestFlatFor(uri) ?? {}), displayName: content.flat.displayName, translationKey: content.flat.translationKey, translationLocale: content.flat.translationLocale, translationSource: content.flat.translationSource, nameWarnings: content.flat.nameWarnings }
      this.applyContent(content)
    } catch (error) {
      if (!current()) return false
      this.prepared = undefined; this.flat = undefined; this.loadingName = undefined; this.sessionId++
      this.lists.clear(); this.reads.clear(); this.invalidations.clear()
      this.failure = error instanceof Error ? error.message : String(error)
      this.watchAssets()
      if (throwErrors) { await this.sendInit(); throw error }
    }
    await this.sendInit()
    if (current()) { this.discoverRelated(); this.warmCache() }
    return current()
  }

  private warmCache(): void {
    if (!vscode.workspace.getConfiguration('mcrh').get<boolean>('previewAutoCacheVanilla', true)) return
    const version = this.prepared?.init.repairVersion ?? this.diagnostics?.repairVersion
    if (!version || !this.source) return
    if (this.cacheRefreshVersions.delete(version)) { void this.load(this.source); return }
    if (this.cachedVersions.has(version) || this.cacheSubscriptions.has(version)) return
    let key: string
    try { key = previewClientStoragePath(this.context) + ':' + version } catch { return }
    let work = VanillaPreviewPanel.cacheJobs.get(key)
    if (!work) {
      work = ensurePreviewClientAssets(this.context, version, { throwOnError: true, nearbyRoots: this.prepared?.assets.roots }).finally(() => VanillaPreviewPanel.cacheJobs.delete(key))
      VanillaPreviewPanel.cacheJobs.set(key, work)
    }
    this.cacheSubscriptions.add(version)
    void work.then(async root => {
      if (!root || this.closed) return
      this.cachedVersions.add(version)
      this.cacheRefreshVersions.add(version)
      const currentVersion = this.prepared?.init.repairVersion ?? this.diagnostics?.repairVersion
      if (this.source && currentVersion === version) { this.cacheRefreshVersions.delete(version); await this.load(this.source) }
    }).catch(error => {
      if (!this.closed) void vscode.window.showWarningMessage(uiText("ui.vanillaPreviewPanel.theOriginalPreviewCacheIsNotReady", (error instanceof Error ? error.message : String(error))))
    }).finally(() => this.cacheSubscriptions.delete(version))
  }

  private queueNames(): void {
    if (this.closed || !this.source) return
    this.namesDirty = true
    if (this.nameTimer) clearTimeout(this.nameTimer)
    this.nameTimer = setTimeout(() => {
      this.nameTimer = undefined
      void this.refreshNames().catch(error => this.report(error))
    }, 120)
  }

  private async refreshNames(): Promise<void> {
    const source = this.source, revision = this.loadRevision, nameRevision = ++this.nameRevision
    if (!source || this.closed) return
    const resource = await previewResourceContext(source, this.context)
    const valid = () => !this.closed && revision === this.loadRevision && nameRevision === this.nameRevision
    if (!resource || !valid()) return
    this.languageRoots = resource.assets.roots
    this.watchAssets()
    const prepared = this.prepared
    if (prepared) {
      const name = await resource.names.resolve(prepared.init.target)
      const targets = await resource.names.targets(prepared.init.targets ?? [prepared.init.target])
      if (!valid() || this.prepared?.assets !== prepared.assets) return
      const latest = this.prepared
      if (latest.init.targets !== prepared.init.targets) { this.queueNames(); return }
      const warnings = [...latest.init.warnings.filter(value => !(latest.init.target.nameWarnings ?? []).includes(value)), ...(name.nameWarnings ?? [])]
      const target = { ...latest.init.target, ...name }
      this.prepared = { ...latest, names: resource.names, init: { ...latest.init, target, targets, warnings } }
      this.target = target
      this.panel.title = uiText("ui.vanillaPreviewPanel.mcrhDPreview", name.displayName)
      this.namesDirty = false
      if (this.ready) await this.panel.webview.postMessage({ command: 'vanillaNames', sessionId: this.sessionId, name, targets, warnings })
    } else if (this.flat) {
      const target = resourceFromAssetPath(resource.source.relative)
      if (!target) return
      const name = await resource.names.resolve(target)
      if (!valid() || !this.flat) return
      const warnings = [...(this.diagnostics?.warnings ?? []).filter(value => !(this.flat?.nameWarnings ?? []).includes(value)), ...(name.nameWarnings ?? [])]
      this.flat = { ...this.flat, ...name }
      if (this.diagnostics) this.diagnostics = { ...this.diagnostics, warnings }
      this.panel.title = uiText("ui.vanillaPreviewPanel.mcrhPlane", name.displayName)
      this.namesDirty = false
      if (this.ready) await this.panel.webview.postMessage({ command: 'vanillaNames', sessionId: this.sessionId, name, warnings })
    }
  }

  private latestFlatFor(uri: vscode.Uri): PreviewMessage | undefined {
    if (this.flat?.sourceUri !== uri.fsPath) return undefined
    return previewMessageFromMemory(uri, this.flat) ?? this.flat
  }

  private discoverRelated(): void {
    const prepared = this.prepared
    if (!prepared?.relative || prepared.exhaustive || this.discovering === prepared.assets) return
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer)
    const assets = prepared.assets, relative = prepared.relative
    this.discovering = assets
    this.discoveryTimer = setTimeout(() => {
      this.discoveryTimer = undefined
      if (this.closed || this.prepared?.assets !== assets) { if (this.discovering === assets) this.discovering = undefined; return }
      void assets.candidates(relative).then(async candidates => {
        while (!this.closed) {
          const current = this.prepared
          if (current?.assets !== assets) return
          const combined = previewChoices([...candidates, ...current.candidates], relative)
          const targets = await current.names.targets(combined.map(({ kind, id }) => ({ kind, id })))
          const latest = this.prepared
          if (this.closed || latest?.assets !== assets) return
          if (latest.names !== current.names) continue
          this.prepared = { ...latest, candidates: combined, exhaustive: true, init: { ...latest.init, targets } }
          if (this.ready) await this.panel.webview.postMessage({ command: 'vanillaTargets', sessionId: this.sessionId, targets })
          return
        }
      }).catch(async error => {
        const current = this.prepared
        if (this.closed || current?.assets !== assets) return
        const warning = uiText("ui.vanillaPreviewPanel.otherAssociatedResourcesAreNotAllRead", (error instanceof Error ? error.message : String(error)))
        this.prepared = { ...current, exhaustive: true, init: { ...current.init, warnings: [...new Set([...current.init.warnings, warning])] } }
        if (this.ready) await this.panel.webview.postMessage({ command: 'vanillaTargets', sessionId: this.sessionId, targets: this.prepared.init.targets, warnings: this.prepared.init.warnings })
      }).catch(error => this.report(error)).finally(() => { if (this.discovering === assets) this.discovering = undefined })
    }, 120)
  }

  private async selectTarget(value: unknown, sessionId: unknown): Promise<void> {
    if (!this.prepared || this.closed || sessionId !== this.sessionId || !value || typeof value !== 'object') return
    const requested = value as Partial<VanillaPreviewTarget>
    const prepared = this.prepared
    const candidate = prepared.candidates.find(item => item.kind === requested.kind && item.id === requested.id)
    if (!candidate || candidate.kind === prepared.init.target.kind && candidate.id === prepared.init.target.id) return
    const revision = ++this.loadRevision
    try {
      const properties = candidate.kind === 'block' ? await prepared.assets.blockstateValues(candidate.id) : {}
      while (!this.closed && revision === this.loadRevision) {
        const current: PreparedPreview | undefined = this.prepared
        if (current?.assets !== prepared.assets) return
        const target: VanillaPreviewTarget = { kind: candidate.kind, id: candidate.id, ...await current.names.resolve(candidate) }
        const latest: PreparedPreview | undefined = this.prepared
        if (this.closed || revision !== this.loadRevision || latest?.assets !== prepared.assets) return
        if (latest.names !== current.names) continue
        const next = await withModelFile({ ...latest, init: { ...latest.init, target, warnings: [...latest.init.warnings.filter(value => !(latest.init.target.nameWarnings ?? []).includes(value)), ...(target.nameWarnings ?? [])],
          fallbackModel: undefined, missingPaths: undefined,
          vehicle: candidate.kind === 'item' ? vehiclePreview(candidate.id) : undefined,
          properties, initialProperties: candidate.properties,
          supportsTallBlock: candidate.kind === 'block' && properties.half?.includes('lower') === true && properties.half?.includes('upper') === true
        } })
        if (this.closed || revision !== this.loadRevision || this.prepared?.assets !== prepared.assets) return
        if (this.prepared.names !== current.names) continue
        this.applyContent({ prepared: next })
        break
      }
    } catch (error) {
      const current: PreparedPreview | undefined = this.prepared
      if (this.closed || revision !== this.loadRevision || current?.assets !== prepared.assets) return
      const warning = uiText("ui.vanillaPreviewPanel.couldNotInitialiseBonobo", candidate.id, (error instanceof Error ? error.message : String(error)))
      this.applyContent({ prepared: { ...current, init: { ...current.init, warnings: [...new Set([...current.init.warnings, warning])] } } })
    }
    await this.sendInit()
  }

  // 贴图改动时只刷新这张图，不重新找模型
  private invalidateFile(file: string): void {
    if (this.closed) return
    if (this.flat && this.source && this.flat.sourceUri === this.source.fsPath && (previewPathKey(file) === previewPathKey(this.source.fsPath) || previewPathKey(file) === previewPathKey(this.source.fsPath + '.mcmeta'))) {
      this.flatMetadataDirty ||= file.endsWith('.mcmeta')
      if (this.textureTimer) clearTimeout(this.textureTimer)
      this.textureTimer = setTimeout(() => { void this.reloadFlat().catch(error => this.report(error)) }, 60)
      return
    }
    for (const [layer, root] of this.prepared?.assets.roots.entries() ?? []) {
      const relative = path.relative(root, file).split(path.sep).join('/')
      if (relative.startsWith('../') || path.isAbsolute(relative) || !/^assets\/[^/]+\/textures\/.+\.png(?:\.mcmeta)?$/i.test(relative)) continue
      const key = layer + ':' + relative
      this.reads.delete(key)
      this.invalidations.set(key, { layer, path: relative, revision: ++this.textureRevision })
    }
    if (this.invalidations.size && !this.textureTimer) this.textureTimer = setTimeout(() => { void this.flushTextures() }, 60)
  }

  private async reloadFlat(): Promise<void> {
    this.textureTimer = undefined
    const source = this.source, revision = this.loadRevision
    if (!source || !this.flat || this.closed || this.loadedSource !== source.fsPath) return
    const memory = !this.flatMetadataDirty && previewMessageFromMemory(source, this.flat)
    this.flatMetadataDirty = false
    const result = memory ? { ok: true as const, message: memory } : await readPreview(source, undefined, this.context)
    if (this.closed || revision !== this.loadRevision || !this.flat) return
    if (result.ok) {
      this.failure = undefined; this.flat = result.message
      if ('resourceRoots' in result && result.resourceRoots) { this.languageRoots = result.resourceRoots; this.watchAssets() }
      await this.sendInit()
    }
    else { this.failure = result.error; await this.sendInit() }
  }

  private async flushTextures(): Promise<void> {
    this.textureTimer = undefined
    const sessionId = this.sessionId, revision = this.loadRevision
    const updates = [...this.invalidations.values()]
    this.invalidations.clear()
    if (!this.ready || this.closed || !this.prepared) return
    for (const update of updates) {
      if (this.closed || sessionId !== this.sessionId || revision !== this.loadRevision) return
      await this.panel.webview.postMessage({ command: 'vanillaTexture', sessionId, ...update })
    }
  }

  private async sendInit(): Promise<void> {
    this.persist()
    if (!this.ready || this.closed) return
    const sessionId = this.sessionId, revision = this.loadRevision
    const message = this.failure ? { command: 'vanillaError', sessionId, error: this.failure }
      : this.prepared ? { ...this.prepared.init, sessionId } satisfies VanillaPreviewInit
      : this.flat ? { command: 'vanillaFlat', sessionId, preview: this.flat, ...this.diagnostics }
      : this.loadingName ? { command: 'vanillaLoading', sessionId, name: this.loadingName } : undefined
    await this.panel.webview.postMessage({ command: 'previewFollow', following: this.following })
    if (!this.closed && revision === this.loadRevision && sessionId === this.sessionId && message) await this.panel.webview.postMessage(message)
  }

  private async receive(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object') return
    const command = (value as { command?: unknown }).command
    const message = value as Partial<VanillaAssetRequest> & { following?: unknown }
    if (command === 'vanillaCreateCmd') { await vscode.commands.executeCommand('mcrh.createCustomModelData', this.source); return }
    if (command === 'vanillaReady') { this.ready = true; await this.sendInit(); return }
    if (command === 'setPreviewFollow' && typeof message.following === 'boolean') {
      const revision = this.loadRevision
      this.following = message.following
      this.persist()
      await this.panel.webview.postMessage({ command: 'previewFollow', following: this.following })
      const followTarget = texturePreviewState.activeUri
      if (!this.closed && this.following && revision === this.loadRevision && followTarget && (!this.source || previewPathKey(followTarget) !== previewPathKey(this.source.fsPath))) await this.load(vscode.Uri.file(followTarget))
      return
    }
    if (command === 'vanillaRepairClient') {
      if (this.closed || message.sessionId !== this.sessionId || this.repairs.has(this.sessionId) || !this.source) return
      const version = this.prepared?.init.repairVersion ?? this.diagnostics?.repairVersion
      if (!version) return
      const source = this.source, revision = this.loadRevision, repairSession = this.sessionId
      this.repairs.add(repairSession)
      try {
        const root = await ensurePreviewClientAssets(this.context, version, { throwOnError: true, includeLanguages: false })
        if (root && !this.closed && revision === this.loadRevision && this.source === source) {
          const pack = sourceOf(source.fsPath)
          if (pack) await completeCurrentClientPack(this.context, pack.root, version, root)
          if (!this.closed && revision === this.loadRevision && this.source === source) await this.load(source)
        }
      } catch (error) {
        if (!this.closed && revision === this.loadRevision) {
          const warning = uiText("ui.vanillaPreviewPanel.clientResourcesAreNotComplete", (error instanceof Error ? error.message : String(error)))
          if (this.prepared) this.applyContent({ prepared: { ...this.prepared, init: { ...this.prepared.init, warnings: [...this.prepared.init.warnings, warning] } } })
          else { this.diagnostics = { ...this.diagnostics, warnings: [...(this.diagnostics?.warnings ?? []), warning] }; this.sessionId++ }
          await this.sendInit()
        }
      } finally { this.repairs.delete(repairSession); if (!this.closed && revision === this.loadRevision) { this.sessionId++; await this.sendInit() } }
      return
    }
    if (command === 'vanillaOpenBlockbench') {
      try {
        if (this.closed) return
        if (message.sessionId !== this.sessionId || !this.source) {
          await vscode.window.showInformationMessage(uiText("ui.vanillaPreviewPanel.previewIsBeingUpdatedPleaseOpenBlockbench"))
          return
        }
        if (!this.prepared && /\.json$/i.test(this.source.fsPath) && /[/\\]models[/\\]/i.test(this.source.fsPath)) {
          await vscode.commands.executeCommand('mcrh.openInBlockbench', this.source)
          return
        }
        const prepared = this.prepared
        const files = prepared?.init.modelFiles ?? (prepared?.init.modelFile ? [prepared.init.modelFile] : [])
        if (prepared && files.length) {
          const chosen = files.length === 1 ? files[0] : await vscode.window.showQuickPick(files.map(file => ({ label: path.posix.basename(file.path), description: file.path, file })), { title: uiText("ui.vanillaPreviewPanel.selectTheModelThatWasOpenedIn"), placeHolder: uiText("ui.vanillaPreviewPanel.includeTheCurrentPackageModelAndThe") }).then(value => value?.file)
          if (chosen) await openPreviewModelInBlockbench(this.context, prepared.assets, chosen.path, chosen.path === prepared.init.modelFile?.path ? prepared.init.fallbackModel : undefined)
          return
        }
        if (await vscode.window.showWarningMessage(uiText("ui.vanillaPreviewPanel.currentPreviewDoesNotHaveAnOpen"), uiText("ui.vanillaPreviewPanel.selectModelFile")) === uiText("ui.vanillaPreviewPanel.selectModelFile")) await vscode.commands.executeCommand('mcrh.openInBlockbench')
      } catch (error) {
        if (!this.closed) await vscode.window.showErrorMessage(uiText("ui.blockbenchCommand.openBlockbenchNotFinished", (error instanceof Error ? error.message : String(error))))
      } finally {
        if (!this.closed) void this.panel.webview.postMessage({ command: 'vanillaBlockbenchResult', sessionId: message.sessionId })
      }
      return
    }
    if (command === 'vanillaAddGenerated' || command === 'vanillaCompactGenerated' || command === 'vanillaOptimizeAlpha') {
      const requested = value as { path?: unknown }
      const prepared = this.prepared, source = this.source, sessionId = this.sessionId
      const allowed = prepared?.init.modelFiles ?? (prepared?.init.modelFile ? [prepared.init.modelFile] : [])
      const relative = typeof requested.path === 'string' && allowed.find(file => file.path === requested.path && file.exists)?.path
      if (this.closed || this.addingGenerated || message.sessionId !== sessionId || !prepared || !source || !relative) {
        if (!this.closed) void this.panel.webview.postMessage({ command: 'vanillaGeneratedResult', sessionId: message.sessionId, message: uiText("ui.vanillaPreviewPanel.theCurrentModelIsNotAvailablePlease") })
        return
      }
      this.addingGenerated = true
      const revision = this.loadRevision
      try {
        const valid = () => !this.closed && this.loadRevision === revision && this.source === source
        let rebuildSides = false
        if (command === 'vanillaOptimizeAlpha') {
          const choice = await vscode.window.showWarningMessage(uiText("ui.vanillaPreviewPanel.retainTheWholeFaceAndBackCreate"), { modal: true }, uiText("ui.vanillaPreviewPanel.rebuildOutlineSide"), uiText("ui.vanillaPreviewPanel.keepOriginalSide"))
          if (!choice) { await this.panel.webview.postMessage({ command: 'vanillaGeneratedResult', sessionId, message: uiText("ui.vanillaPreviewPanel.deactivatedModelOptimization") }); return }
          rebuildSides = choice === uiText("ui.vanillaPreviewPanel.rebuildOutlineSide")
        }
        const result = command === 'vanillaOptimizeAlpha' ? await optimizePreviewAlphaModel(this.context, prepared.assets, relative, valid, rebuildSides) : command === 'vanillaCompactGenerated' ? await compactPreviewGeneratedBase(this.context, prepared.assets, relative, valid) : await addPreviewGeneratedBase(this.context, prepared.assets, relative, valid)
        if (!this.closed && this.source === source) {
          await this.panel.webview.postMessage({ command: 'vanillaGeneratedResult', sessionId, message: result.message })
          if (result.changed && this.loadRevision === revision) await this.load(source)
          void vscode.window.showInformationMessage(result.message)
        }
      } catch (error) {
        if (!this.closed) {
          const text = uiText("ui.vanillaPreviewPanel.otherOrganiser", (error instanceof Error ? error.message : String(error)))
          void this.panel.webview.postMessage({ command: 'vanillaGeneratedResult', sessionId, message: text })
          void vscode.window.showWarningMessage(text)
        }
      } finally { this.addingGenerated = false }
      return
    }
    if (command === 'vanillaApplyFamily') {
      if (this.closed || message.sessionId !== this.sessionId || !this.prepared) return
      const relative = (value as { path?: unknown }).path
      if (typeof relative !== 'string' || !/^assets\/[a-z0-9_.-]+\/models\/[a-z0-9_./-]+\.json$/.test(relative) || relative.split('/').some(part => part === '.' || part === '..')) return
      try {
        const uri = await openPreviewModel(this.context, this.prepared.assets, relative, false, undefined, false)
        if (uri?.scheme === 'file') await vscode.commands.executeCommand('mcrh.applyJsonFamily', uri)
        else void vscode.window.showInformationMessage(uiText("ui.vanillaPreviewPanel.pleaseAddTheOriginalModelToYour"))
      } catch (error) { if (!this.closed) void vscode.window.showWarningMessage(uiText("ui.vanillaPreviewPanel.batchMatchIncomplete", (error instanceof Error ? error.message : String(error)))) }
      return
    }
    if (command === 'vanillaOpenModel') {
      if (this.closed || message.sessionId !== this.sessionId || !this.prepared) return
      const requested = value as { path?: unknown; create?: unknown }
      const relative = typeof requested.path === 'string' ? requested.path : this.prepared.init.modelFile?.path
      if (!relative) return
      const prepared = this.prepared
      try { await openPreviewModel(this.context, prepared.assets, relative, requested.create === true, relative === prepared.init.modelFile?.path ? prepared.init.fallbackModel : undefined) }
      catch (error) { if (!this.closed) void vscode.window.showWarningMessage(uiText("ui.vanillaPreviewPanel.modelFileOperationNotCompleted", (error instanceof Error ? error.message : String(error)))) }
      return
    }
    if (command === 'vanillaSelectTarget') { await this.selectTarget((value as { target?: unknown }).target, message.sessionId); return }
    if (command === 'vanillaChooseBase') { if (await chooseBase() && this.source) await this.load(this.source); return }
    if (message.command !== 'vanillaAssetRequest' || !this.prepared || this.closed) return
    if (message.sessionId !== this.sessionId || !Number.isSafeInteger(message.requestId) || typeof message.path !== 'string' || message.path.length > 2048 || !Number.isInteger(message.layer) || Number(message.layer) < 0 || Number(message.layer) >= this.prepared.assets.roots.length || !['read', 'list'].includes(String(message.operation))) return
    const sessionId = this.sessionId
    const response: VanillaAssetResponse = { command: 'vanillaAssetResponse', requestId: message.requestId!, sessionId }
    const assets = this.prepared.assets, layer = message.layer!
    const pending = (this.pendingBySession.get(sessionId) ?? 0) + 1
    this.pendingBySession.set(sessionId, pending)
    try {
      if (pending > 64) throw new Error(uiText("ui.vanillaPreviewPanel.resourceRequestsPendingExceedPreviewLimits"))
      const key = layer + ':' + message.path
      if (message.operation === 'read') {
        let read = this.reads.get(key)
        if (!read) {
          const safeTexture = /^assets\/[a-z0-9_.-]+\/textures\/[a-z0-9_./-]+\.png$/.test(message.path) && !message.path.split('/').some(part => part === '.' || part === '..')
          const memory = safeTexture ? texturePreviewState.read(path.join(assets.roots[layer], ...message.path.split('/'))) : undefined
          if (memory) {
            const png = new PNG({ width: memory.width, height: memory.height })
            png.data.set(memory.pixels)
            read = Promise.resolve(PNG.sync.write(png))
          } else read = assets.read(message.path, layer)
          this.reads.set(key, read)
        }
        const data = await read
        if (data) response.data = Array.from(data)
        else response.missing = true
      } else {
        let list = this.lists.get(key)
        if (!list) { list = assets.listEntries(message.path.replace(/\/$/, ''), layer); this.lists.set(key, list) }
        response.entries = await list
      }
    } catch (error) { response.error = error instanceof Error ? error.message : String(error) }
    finally { const remaining = (this.pendingBySession.get(sessionId) ?? 1) - 1; if (remaining > 0) this.pendingBySession.set(sessionId, remaining); else this.pendingBySession.delete(sessionId) }
    if (!this.closed && sessionId === this.sessionId) await this.panel.webview.postMessage(response)
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.loadRevision++
    this.cancelRefresh()
    if (VanillaPreviewPanel.current === this) { VanillaPreviewPanel.current = undefined; VanillaPreviewPanel.ticket++ }
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    if (this.textureTimer) clearTimeout(this.textureTimer)
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer)
    for (const item of [...this.disposables, ...this.watchers]) item.dispose()
    this.reads.clear(); this.lists.clear(); this.invalidations.clear(); this.pendingBySession.clear()
    this.panel.dispose()
  }
}

export async function previewVanillaFromCommand(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  const target = uri ?? (await vscode.window.showOpenDialog({ title: uiText("ui.vanillaPreviewPanel.selectPngModelOrBlockstateJson"), canSelectMany: false, filters: { [uiText("ui.vanillaPreviewPanel.originalResources")]: ['png', 'json'] } }))?.[0]
  if (!target) return
  if (target.scheme !== 'file') { await vscode.window.showWarningMessage(uiText("ui.vanillaPreviewPanel.readOnlyLocalResourceDirectoriesForOriginal")); return }
  try { await VanillaPreviewPanel.show(context, target) }
  catch (error) { await vscode.window.showErrorMessage(uiText("ui.vanillaPreviewPanel.synchronisingS_2c3b65", error instanceof Error ? error.message : String(error))) }
}

export async function openTextureInBlockbench(context: vscode.ExtensionContext, uri: vscode.Uri): Promise<void> {
  if (uri.scheme !== 'file' || !/\.png$/i.test(uri.fsPath)) { await vscode.window.showWarningMessage(uiText("ui.vanillaPreviewPanel.selectLocalPngPaste")); return }
  try {
    const preview = await preparePreview(uri, false, undefined, context)
    const prepared = preview && await withModelFile(preview)
    const files = prepared?.init.modelFiles ?? []
    if (!prepared || !files.length) {
      if (await vscode.window.showWarningMessage(uiText("ui.vanillaPreviewPanel.noModelAssociatedWithThisPosterFound"), uiText("ui.vanillaPreviewPanel.selectModelFile")) === uiText("ui.vanillaPreviewPanel.selectModelFile")) await vscode.commands.executeCommand('mcrh.openInBlockbench')
      return
    }
    const chosen = files.length === 1 ? files[0] : await vscode.window.showQuickPick(files.map(file => ({ label: path.posix.basename(file.path), description: file.path, file })), { title: uiText("ui.vanillaPreviewPanel.selectTheModelForWhichThisPoster") }).then(value => value?.file)
    if (chosen) await openPreviewModelInBlockbench(context, prepared.assets, chosen.path, chosen.path === prepared.init.modelFile?.path ? prepared.init.fallbackModel : undefined)
  } catch (error) { await vscode.window.showErrorMessage(uiText("ui.vanillaPreviewPanel.openFromPasteBlockbenchNotFinished", (error instanceof Error ? error.message : String(error)))) }
}
