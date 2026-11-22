import { uiText } from '../i18n/messages'
import { customModelDataCases, customModelDataCommand, customModelDataSchema, customModelDataState, compareMinecraftVersion, legacyItemOverride } from '../core/customModelData'
import { createHeadReference } from './preview/headReference'
import { dragOrbit, placeOrbitCamera, wrapOrbitDegrees, type OrbitRotation } from './preview/cameraOrbit'
import { enhanceNativeSelects } from './selectControls'
import { createModelInspector, type ModelInspector } from './preview/modelInspector'
import * as THREE from 'three'
import rendererCapabilities from '../core/data/previewRendererCapabilities.json'
import { createVehicleScene, type VehicleScene } from './preview/vehicle'
import { parseItemState, validateItemDefinition, type ItemState } from './preview/itemState'
import { modelDisplay, presentations, type Presentation } from './preview/presentations'
import { createPresentationScene } from './preview/presentationScene'
import { normalizeGeneratedGeometry } from './preview/generatedGeometry'
import type { PreviewMessage } from './messages'
import { sampleFrame } from './preview/frames'
import { modelOf, type PreviewModel } from './preview/model'
import { configure, createScene, disposeCache, loadModel, makeModelScene, parseBlockstate, parseItemDefinition, prepareAssets, readFile, renderModelScene, resolveModelData } from 'block-model-renderer'
import type { ModelReference, Player, PreparedAssets, ResolvedModel, SceneBlock, SceneHandle, VirtualHandler } from 'block-model-renderer'
import type { VanillaAssetResponse, VanillaFlatPreview, VanillaTextureUpdate, VanillaPreviewCommand, VanillaPreviewInit, VanillaPreviewLoading, VanillaPreviewNames, VanillaPreviewTarget, VanillaPreviewTargets } from './vanillaPreviewProtocol'

enhanceNativeSelects()

interface PreviewGlobals { acquireVsCodeApi?: () => { postMessage(message: VanillaPreviewCommand): void; getState?(): unknown; setState?(value: unknown): void }; __MCRH__?: { modelAssets?: string } }
interface View { rotation?: OrbitRotation; yaw: number; pitch: number; zoom: number; panX: number; panY: number }
interface LiveRender { player: Player; canvas: HTMLCanvasElement; animated: boolean; motion: boolean; empty?: boolean; inspector?: ModelInspector; orientation(): OrbitRotation; capture(): Promise<void>; updateView(): void; setPlaying(value: boolean): void; dispose(): void }
type AssetValue = Uint8Array | string[] | undefined
type Pending = { key: string; operation: 'read' | 'list'; resolve(value: AssetValue): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

const globals = globalThis as typeof globalThis & PreviewGlobals
const api = globals.acquireVsCodeApi?.()
const ASSET_TIMEOUT = 20000
const MAX_ASSET_BYTES = 64 * 1024 * 1024
let nextRequest = 0
configure({ THREE, assetsUrl: globals.__MCRH__?.modelAssets || false })

function post(message: VanillaPreviewCommand): void {
  if (!api) throw new Error(uiText("webview.vanillaPreview.theCurrentPageLacksAMaterialPackage"))
  api.postMessage(message)
}

// 每层保持独立，资源覆盖与过滤交由库解析
class AssetSession {
  readonly pending = new Map<number, Pending>()
  readonly cache = new Map<string, Promise<AssetValue>>()
  private readonly textureRevisions = new Map<string, number>()
  readonly missing = new Set<string>()
  readonly faults = new Set<string>()
  readonly handlers: VirtualHandler[]
  readonly filters: Array<Array<{ namespace?: RegExp; path?: RegExp }>> = []
  private filtersReady?: Promise<void>
  closed = false
  usedMissing = false

  constructor(readonly init: VanillaPreviewInit) {
    this.filters = init.layers.map(() => [])
    this.handlers = init.layers.map((_, layer) => ({
      filter: path => {
        const parts = path.split('/')
        if (parts[0] !== 'assets' || parts.length < 3) return false
        return this.filters[layer].some(rule => (!rule.namespace || rule.namespace.test(parts[1])) && (!rule.path || rule.path.test(parts.slice(2).join('/'))))
      },
      read: async path => {
        if (/^assets\/block-model-renderer\/(?:models\/missing\.json|textures\/missing\.png)$/.test(path)) this.usedMissing = true
        const result = await this.request(layer, 'read', path)
        if (result instanceof Uint8Array) this.missing.delete(path)
        else if (path.includes('/models/')) this.missing.add(path)
        if (result instanceof Uint8Array && /^assets\/[^/]+\/models\/.+\.json$/.test(path)) {
          const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result).replace(/^\uFEFF/, ''))
          if (raw && typeof raw === 'object' && !Array.isArray(raw)) return new TextEncoder().encode(JSON.stringify({ ...raw, __mcrhSource: path.replace(/^assets\/([^/]+)\/models\//, '$1:').replace(/\.json$/, '') }))
        }
        return result instanceof Uint8Array ? result : undefined
      },
      list: async path => {
        const result = await this.request(layer, 'list', path)
        return Array.isArray(result) ? result : []
      }
    }))
  }

  async inspectPath(path: string): Promise<{ bytes: Uint8Array; source: string } | undefined> {
    const parts = path.split('/')
    for (let layer = 0; layer < this.init.layers.length; layer++) {
      const blocked = this.filters.slice(0, layer).some(rules => rules.some(rule => (!rule.namespace || rule.namespace.test(parts[1]!)) && (!rule.path || rule.path.test(parts.slice(2).join('/')))))
      if (blocked) return undefined
      const bytes = await this.request(layer, 'read', path)
      if (bytes instanceof Uint8Array) return { bytes, source: (layer === 0 ? uiText("webview.vanillaPreview.currentPackage") : uiText("webview.vanillaPreview.basicResources")) + this.init.layers[layer] }
    }
    return undefined
  }
  prepareFilters(): Promise<void> {
    return this.filtersReady ??= Promise.all(this.init.layers.map(async (label, layer) => {
      const bytes = await this.request(layer, 'read', 'pack.mcmeta')
      if (!(bytes instanceof Uint8Array)) return
      try {
        const metadata = JSON.parse(new TextDecoder().decode(bytes)) as { filter?: { block?: Array<{ namespace?: string; path?: string }> } }
        const rules = metadata.filter?.block ?? []
        if (!Array.isArray(rules)) throw new Error(uiText("webview.vanillaPreview.filterBlockMustBeAnArray"))
        this.filters[layer] = rules.map(rule => {
          if (!rule || typeof rule !== 'object' || (rule.namespace !== undefined && typeof rule.namespace !== 'string') || (rule.path !== undefined && typeof rule.path !== 'string')) throw new Error(uiText("webview.vanillaPreview.resourceFilterConditionsMustUseStringExpression"))
          return { namespace: rule.namespace !== undefined ? new RegExp(`^(?:${rule.namespace})$`) : undefined, path: rule.path !== undefined ? new RegExp(`^(?:${rule.path})$`) : undefined }
        })
      } catch { throw new Error(uiText("webview.vanillaPreview.resourceLayerMcmetaOrFilterExpressionCannot", label)) }
    })).then(() => undefined)
  }

  request(layer: number, operation: 'read' | 'list', path: string): Promise<AssetValue> {
    if (this.closed) return Promise.reject(new Error(uiText("webview.vanillaPreview.resourceSessionUpdated")))
    if (/\\|\0|^\/|^[a-z]:|(?:^|\/)\.\.(?:\/|$)/i.test(path)) return Promise.reject(new Error(uiText("ui.resourceAuthoringFiles.resourcePathInvalid")))
    const key = `${layer}:${operation}:${path}`
    const cached = this.cache.get(key)
    if (cached) return cached
    const requestId = ++nextRequest
    const promise = new Promise<AssetValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        this.faults.add(uiText("webview.vanillaPreview.resourceReadTimeout", path))
        reject(new Error(uiText("webview.vanillaPreview.resourceReadTimeout", path)))
      }, ASSET_TIMEOUT)
      this.pending.set(requestId, { key, operation, resolve, reject, timer })
      try { post({ command: 'vanillaAssetRequest', sessionId: this.init.sessionId, requestId, operation, layer, path }) }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(asError(error)) }
    })
    this.cache.set(key, promise)
    void promise.catch(() => { if (this.cache.get(key) === promise) this.cache.delete(key) })
    return promise
  }

  invalidate(update: VanillaTextureUpdate): boolean {
    if (this.closed || update.sessionId !== this.init.sessionId || !Number.isSafeInteger(update.layer) || update.layer < 0 || update.layer >= this.init.layers.length || typeof update.path !== 'string' || !/^assets\/[^/]+\/textures\/.+\.png(?:\.mcmeta)?$/.test(update.path) || update.path.split('/').includes('..') || !Number.isSafeInteger(update.revision) || update.revision < 0) return false
    const key = update.layer + ':read:' + update.path
    if ((this.textureRevisions.get(key) ?? -1) >= update.revision) return false
    this.textureRevisions.set(key, update.revision)
    const changed = this.cache.delete(key)
    for (const [id, pending] of this.pending) {
      if (pending.key !== key) continue
      clearTimeout(pending.timer); this.pending.delete(id)
      pending.resolve(undefined)
    }
    return changed
  }

  accept(response: VanillaAssetResponse): void {
    if (this.closed || response.sessionId !== this.init.sessionId) return
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.pending.delete(response.requestId)
    clearTimeout(pending.timer)
    if (response.error) {
      this.faults.add(response.error)
      pending.reject(new Error(response.error))
    } else if (response.missing) pending.resolve(pending.operation === 'list' ? [] : undefined)
    else if (pending.operation === 'list' && Array.isArray(response.entries) && response.entries.every(value => typeof value === 'string')) pending.resolve(response.entries)
    else if (pending.operation === 'read' && Array.isArray(response.data) && response.data.length <= MAX_ASSET_BYTES && response.data.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) pending.resolve(Uint8Array.from(response.data))
    else {
      const message = uiText("webview.vanillaPreview.resourceDataReturnedByHostIsInvalid")
      this.faults.add(message)
      pending.reject(new Error(message))
    }
  }

  close(): void {
    this.closed = true
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(uiText("webview.vanillaPreview.resourceSessionUpdated"))) }
    this.pending.clear()
    this.cache.clear()
    this.textureRevisions.clear()
  }
}

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)) }
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  element.className = className
  if (text !== undefined) element.textContent = text
  return element
}
function button(text: string, className = 'vp-button'): HTMLButtonElement {
  const element = node('button', className, text)
  element.type = 'button'
  return element
}
function resourcePath(category: string, id: string): string {
  if (!/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(id) || id.split('/').includes('..')) throw new Error(uiText("webview.vanillaPreview.resourceIdentifierInvalid"))
  const colon = id.indexOf(':')
  return `assets/${colon < 0 ? 'minecraft' : id.slice(0, colon)}/${category}/${colon < 0 ? id : id.slice(colon + 1)}.json`
}

async function requireJson(path: string, assets: PreparedAssets): Promise<unknown> {
  const bytes = await readFile(path, assets)
  if (!bytes) throw new Error(uiText("webview.vanillaPreview.lackOfResourcesPleaseSelectTheOriginal", path))
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown }
  catch { throw new Error(uiText("webview.vanillaPreview.resourceJsonCannotParse", path)) }
}

async function checkSpecial(assets: PreparedAssets, reference: ModelReference): Promise<void> {
  const special = reference.special as Record<string, unknown> | undefined
  if (!special) return
  const type = typeof special.type === 'string' ? special.type.replace(/^minecraft:/, '') : ''
  if (!/^[a-z0-9_]+$/.test(type) || !rendererCapabilities.specialTypes.includes(type)) throw new Error(uiText("webview.vanillaPreview.currentRenderLibraryDoesNotSupportSpecial", String(special.type)))
  if ((type === 'chest' || type === 'shulker_box' || type === 'bed') && typeof special.texture === 'string' && special.texture.includes(':') && !special.texture.startsWith('minecraft:')) throw new Error(uiText("webview.vanillaPreview.currentRenderingLibraryIsNotSupportedNon", type, special.texture))
  if (type === 'head' && (special.profile !== undefined || special.texture !== undefined || special.animation !== undefined)) throw new Error(uiText("webview.vanillaPreview.currentRenderingLibraryDoesNotSupportHead"))
  if (type === 'head' && (typeof special.kind !== 'string' || !/^[a-z0-9_]+$/.test(special.kind))) throw new Error(uiText("webview.vanillaPreview.headSpecialMissingSupportedKind"))
  void assets
}

async function checkedModel(assets: PreparedAssets, reference: ModelReference, session: AssetSession): Promise<ResolvedModel> {
  await checkSpecial(assets, reference)
  let model: ResolvedModel
  try {
    model = normalizeGeneratedGeometry(await resolveModelData(assets, reference))
    if (String(model.model ?? '').startsWith('block-model-renderer:missing')) throw new Error(uiText("webview.vanillaPreview.parsingResultToMissingPlaceholderModel"))
  } catch (error) {
    const missing = [...session.missing].filter(path => !path.startsWith('assets/block-model-renderer/')).slice(0, 8)
    throw new Error(uiText("webview.vanillaPreview.theModelOrParentInheritanceChainIs", missing.length ? '\n' + missing.join('\n') : '', asError(error).message))
  }
  const source = reference.model
  model.__mcrhSource = typeof source === 'string' ? source : source && typeof source === 'object' && typeof source.parent === 'string' ? source.parent : undefined
  if (reference.special && !model.elements?.length) throw new Error(uiText("webview.vanillaPreview.currentRenderLibraryDoesNotSupportThe"))
  return model
}

const root = node('main', 'vp-app')
root.dataset.state = 'waiting'
const header = node('header', 'vp-header'), heading = node('div', 'vp-heading')
heading.append(node('p', 'vp-eyebrow', 'RESOURCE PREVIEW'), node('h1', 'vp-title', uiText("webview.vanillaPreview.clientResourcePreview")))
const identity = node('code', 'vp-resource', uiText("webview.vanillaPreview.waitingForMaterialPackageResources"))
const version = node('span', 'vp-version', uiText("webview.guiPreview.versionNotSpecified")), choose = button(uiText("webview.vanillaPreview.selectOriginalResource"))
choose.title = uiText("webview.vanillaPreview.selectADirectoryOfLocalResourcesIncluding")
const repair = button(uiText("webview.vanillaPreview.completeClientResources"), 'vp-button vp-base')
repair.dataset.action = 'repair-client'
repair.hidden = true
const repairFeedback = node('p', 'vp-repair-feedback')
repairFeedback.setAttribute('role', 'status')
repairFeedback.setAttribute('aria-live', 'polite')
repairFeedback.hidden = true
const badges = node('div', 'vp-badges')
badges.append(version, repair, choose)
header.append(heading, badges)
const layout = node('div', 'vp-layout'), stage = node('section', 'vp-stage')
stage.tabIndex = 0
stage.setAttribute('aria-label', uiText("webview.vanillaPreview.modelViewLeftClickRotationMiddleKey"))
const canvasSlot = node('div', 'vp-canvas-slot'), stageNote = node('p', 'vp-stage-note', uiText("webview.vanillaPreview.leftMiddleRollerZoom"))
const stageLoading = node('p', 'vp-stage-loading')
stageLoading.hidden = true
const status = node('p', 'vp-status', uiText("webview.vanillaPreview.waitingForHostToProvideOriginalModel"))
status.setAttribute('role', 'status')
status.setAttribute('aria-live', 'polite')
stage.append(canvasSlot, stageLoading, stageNote)
const sidebar = node('aside', 'vp-sidebar'), propertyPanel = node('div', 'vp-properties')
const tallLabel = node('label', 'vp-tall'), tall = node('input', 'vp-tall-input')
tall.type = 'checkbox'
tallLabel.append(tall, node('span', '', uiText("webview.vanillaPreview.groupingUpperAndLowerBlocks")))
tallLabel.hidden = true
const layers = node('ol', 'vp-layers'), packLabel = node('p', 'vp-pack-label')
const warnings = node('ul', 'vp-warnings')
const missingTitle = node('h2', 'vp-panel-title', uiText("webview.vanillaPreview.missingResourcePath")), missingPaths = node('ul', 'vp-missing-paths')
missingTitle.hidden = true; missingPaths.hidden = true
const itemStatePanel = node('section', 'vp-item-state')
const itemStateInput = node('textarea', 'vp-item-state-input'), applyItemState = button(uiText("webview.vanillaPreview.applyParameters"))
itemStateInput.setAttribute('aria-label', uiText("webview.vanillaPreview.objectStatusParameters"))
itemStateInput.spellcheck = false
itemStateInput.rows = 5
itemStateInput.value = '{}'
const itemStateFeedback = node('p', 'vp-item-state-feedback', uiText("webview.vanillaPreview.defaultSettingTheStatusOfACustom"))
itemStateFeedback.setAttribute('role', 'status')
itemStateFeedback.setAttribute('aria-live', 'polite')
const cmdInput = node('input', 'vp-cmd-value')
cmdInput.type = 'number'; cmdInput.value = '1'; cmdInput.setAttribute('aria-label', uiText("ui.resourceTemplates.custommodeldataValue"))
const cmdApply = button(uiText("webview.vanillaPreview.previewCmd")), cmdCopy = button(uiText("webview.vanillaPreview.copyTestCommands")), cmdCreate = button(uiText("webview.vanillaPreview.createCmdTemplates"))
const cmdCases = node('select', 'vp-cmd-cases'); cmdCases.setAttribute('aria-label', uiText("webview.vanillaPreview.cmdBranchAlreadyExists"))
const cmdTools = node('div', 'vp-cmd-tools'); cmdTools.append(cmdInput, cmdApply, cmdCopy, cmdCreate, cmdCases)
itemStatePanel.append(node('h2', 'vp-panel-title', uiText("webview.vanillaPreview.custommodeldataObjectStatus")), cmdTools, itemStateInput, applyItemState, itemStateFeedback)
itemStatePanel.hidden = true
const propertyTitle = node('h2', 'vp-panel-title', uiText("ui.resourceDocs.blockState"))
sidebar.append(propertyTitle, propertyPanel, tallLabel, itemStatePanel, node('h2', 'vp-panel-title', uiText("webview.vanillaPreview.resourcePriorities")), packLabel, layers, warnings, missingTitle, missingPaths)
layout.append(stage, sidebar)
const toolbar = node('section', 'vp-toolbar'), reset = button(uiText("webview.vanillaPreview.resetView")), animation = button(uiText("webview.vanillaPreview.playDynamicTexture"))
animation.disabled = true
animation.setAttribute('aria-pressed', 'false')
const controls = new Map<'yaw' | 'pitch' | 'zoom', HTMLInputElement>()
for (const [key, label, min, max, step, value] of [
  ['yaw', uiText("webview.vanillaPreview.rotateHorizontally"), -180, 180, 1, 0], ['pitch', uiText("model.pitch"), -180, 180, 1, 0], ['zoom', uiText("webview.vanillaPreview.scale"), 0.25, 3, 0.05, 1]
] as const) {
  const field = node('label', 'vp-view-control'), range = node('input', 'vp-range'), output = node('output', 'vp-view-value')
  range.type = 'range'; range.min = String(min); range.max = String(max); range.step = String(step); range.value = String(value)
  range.setAttribute('aria-label', label)
  field.append(node('span', '', label), range, output)
  controls.set(key, range)
  toolbar.append(field)
  range.addEventListener('input', () => { view[key] = Number(range.value); if (key !== 'zoom') view.rotation = undefined; syncView(); requestViewRender() })
}
const targetLabel = node('label', 'vp-target'), targetSelect = node('select', 'vp-select')
targetSelect.setAttribute('aria-label', uiText("webview.vanillaPreview.resourceForm"))
targetLabel.append(node('span', '', uiText("webview.vanillaPreview.resourceForm")), targetSelect)
targetLabel.hidden = true
let availableTargets: VanillaPreviewTarget[] = [], selectedTarget: VanillaPreviewTarget | undefined, targetPending = false
const targetNames: Record<VanillaPreviewTarget['kind'], string> = { block: uiText("model.block"), model: uiText("core.advanced.colormap.model"), item: uiText("webview.vanillaPreview.items"), entity: uiText("webview.vanillaPreview.entities") }
function targetValue(target: VanillaPreviewTarget): string { return target.kind + ':' + target.id }
function targetName(target: VanillaPreviewTarget): string { return targetNames[target.kind] + ' · ' + (target.displayName && target.displayName !== target.id ? target.displayName + ' (' + target.id + ')' : target.id) }
function updateTargets(init?: VanillaPreviewInit): void {
  selectedTarget = init?.target
  targetPending = false
  renderTargets(init?.targets ?? [])
}
function renderTargets(targets: VanillaPreviewTarget[]): void {
  availableTargets = selectedTarget ? [...new Map([...targets, selectedTarget].map(target => [targetValue(target), target])).values()] : []
  targetSelect.replaceChildren(...availableTargets.map(target => {
    const option = node('option', '', targetName(target))
    option.value = targetValue(target)
    return option
  }))
  if (selectedTarget) targetSelect.value = targetValue(selectedTarget)
  targetSelect.disabled = targetPending
  targetLabel.hidden = availableTargets.length < 2
}
targetSelect.addEventListener('change', () => {
  const target = availableTargets.find(entry => targetValue(entry) === targetSelect.value)
  if (selectedTarget) targetSelect.value = targetValue(selectedTarget)
  if (targetPending || !target || !selectedTarget || targetValue(target) === targetValue(selectedTarget)) return
  targetPending = true
  repair.disabled = true
  targetSelect.disabled = true
  sessionPhase = 'selecting'
  suspendPreview(uiText("webview.vanillaPreview.switchingToWaitingForTheHostTo", targetName(target)))
  try { post({ command: 'vanillaSelectTarget', sessionId: latestSessionId, target }) }
  catch (error) { targetPending = false; targetSelect.disabled = false; showError(error) }
})
const presentationLabel = node('label', 'vp-presentation'), presentationSelect = node('select', 'vp-select')
presentationSelect.setAttribute('aria-label', uiText("webview.vanillaPreview.previewStatus"))
presentationLabel.append(node('span', '', uiText("webview.vanillaPreview.previewStatus")), presentationSelect)
let presentation: Presentation = 'gui'
presentationSelect.addEventListener('change', () => {
  if (!current || !presentations(current.init).some(entry => entry.id === presentationSelect.value)) return
  presentation = presentationSelect.value as Presentation
  view = { yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0 }; syncView(); syncPresentationNote(); requestRender()
})
toolbar.prepend(targetLabel, presentationLabel)
const follow = button(uiText("webview.preview.followingEdit"))
follow.dataset.action = 'preview-follow'
let following = true
function syncFollow(): void {
  follow.textContent = following ? uiText("webview.preview.followingEdit") : uiText("webview.preview.fixedCurrent")
  follow.setAttribute('aria-pressed', String(following))
  follow.title = following ? uiText("webview.vanillaPreview.clickOnTheCurrentResourceAndPixel") : uiText("webview.vanillaPreview.clickToResumeFollowingTheCurrentResource")
}
follow.addEventListener('click', () => {
  following = !following
  syncFollow()
  try { post({ command: 'setPreviewFollow', following }) } catch (error) { showError(error) }
})
syncFollow()
toolbar.append(reset, animation, follow)
const inspectorSlot = node('div', 'vp-inspector-slot')
const modelFileAction = button(uiText("webview.preview.modelInspector.openModelFile"))
modelFileAction.hidden = true
modelFileAction.addEventListener('click', () => {
  const file = current?.init.modelFile
  if (!file || !current) return
  try { post({ command: 'vanillaOpenModel', sessionId: current.init.sessionId, path: file.path, create: !file.exists }) } catch (error) { showError(error) }
})
const generatedAction = button(uiText("webview.vanillaPreview.addOriginal"))
generatedAction.dataset.action = 'add-generated'
generatedAction.hidden = true
generatedAction.title = uiText("webview.vanillaPreview.addTheOriginalSourcedInCurrentJson")
generatedAction.addEventListener('click', () => {
  const target = active?.inspector?.generatedTargets[0]
  if (!target || !current || generatedAction.disabled) return
  generatedAction.disabled = true; generatedAction.textContent = uiText("webview.vanillaPreview.addingGeneral")
  try { post({ command: 'vanillaAddGenerated', sessionId: current.init.sessionId, path: target }) }
  catch (error) { generatedAction.disabled = false; generatedAction.textContent = uiText("webview.vanillaPreview.addOriginal"); status.textContent = error instanceof Error ? error.message : String(error) }
})
const generatedCompactAction = button(uiText("webview.vanillaPreview.otherOrganiser"))
generatedCompactAction.dataset.action = 'compact-generated'
generatedCompactAction.hidden = true
generatedCompactAction.title = uiText("webview.vanillaPreview.mergeOldGeneratedReferencesOrCompressionsAlready")
generatedCompactAction.addEventListener('click', () => {
  const target = active?.inspector?.generatedCompactTargets[0]
  if (!target || !current || generatedCompactAction.disabled) return
  generatedCompactAction.disabled = true; generatedCompactAction.textContent = uiText("webview.vanillaPreview.sorted")
  try { post({ command: 'vanillaCompactGenerated', sessionId: current.init.sessionId, path: target }) }
  catch (error) { generatedCompactAction.disabled = false; generatedCompactAction.textContent = uiText("webview.vanillaPreview.otherOrganiser"); status.textContent = error instanceof Error ? error.message : String(error) }
})
const optimizeAlphaAction = button(uiText("webview.vanillaPreview.optimizingTransparentContour"))
optimizeAlphaAction.dataset.action = 'optimize-alpha'
optimizeAlphaAction.hidden = true
optimizeAlphaAction.title = uiText("webview.vanillaPreview.splitTheThinSlicesByATransparent")
optimizeAlphaAction.addEventListener('click', () => {
  const file = current?.init.modelFile
  if (!file?.exists || !current || optimizeAlphaAction.disabled) return
  optimizeAlphaAction.disabled = true
  try { post({ command: 'vanillaOptimizeAlpha', sessionId: current.init.sessionId, path: file.path }) }
  catch (error) { optimizeAlphaAction.disabled = false; showError(error) }
})
const inspectorJump = button(uiText("model.inspectJsonUv"))
inspectorJump.addEventListener('click', () => { inspectorSlot.scrollIntoView({ block: 'start' }); inspectorSlot.querySelector<HTMLElement>('select, button, pre')?.focus() })
sidebar.prepend(inspectorJump, modelFileAction, generatedAction, generatedCompactAction, optimizeAlphaAction)
const externalModel = button(uiText("ui.blockbenchCommand.openInBlockbench"))
externalModel.addEventListener('click', () => {
  externalModel.disabled = true
  externalModel.textContent = uiText("webview.vanillaPreview.openingBlockbench")
  try { post({ command: 'vanillaOpenBlockbench', sessionId: latestSessionId }) }
  catch (error) { resetExternalModel(); showError(error) }
})
function resetExternalModel(): void { externalModel.disabled = false; externalModel.textContent = uiText("ui.blockbenchCommand.openInBlockbench") }
sidebar.prepend(externalModel)
const caveat = node('p', 'vp-caveat', uiText("webview.vanillaPreview.useTheSelectedVersionOfResourceWith"))
root.append(header, repairFeedback, identity, layout, toolbar, status, inspectorSlot, caveat)
document.body.append(root)

let current: AssetSession | undefined, active: LiveRender | undefined
let confirmedInit: VanillaPreviewInit | undefined
let latestSessionId = 0
let sessionPhase: 'waiting' | 'loading' | 'flat' | 'model' | 'selecting' | 'repairing' | 'error' = 'waiting'
let appliedItemState: ItemState = {}, pendingItemState: ItemState | undefined
let repairVersion: string | undefined, repairPendingSession: number | undefined
let view: View = { yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0 }, properties: Record<string, string> = {}
let revision = 0, completed = 0, painted = 0, builds = 0, rendering = false, destroyed = false, playing = true
let renderTimer: ReturnType<typeof setTimeout> | undefined
let lastSize = ''
let drag: { rotation?: OrbitRotation; captureTarget: HTMLElement; id: number; button: number; x: number; y: number; yaw: number; pitch: number; panX: number; panY: number } | undefined
let flat: PreviewMessage | undefined, flatSource: HTMLCanvasElement | undefined, flatCanvas: HTMLCanvasElement | undefined
let flatFrame = 0, flatTime = 0, flatStamp = 0
let flatModel: PreviewModel | undefined, flatBlend: HTMLCanvasElement | undefined, flatBlendData: ImageData | undefined

function resetRepair(version?: string): void {
  repairVersion = version
  repairPendingSession = undefined
  repair.hidden = !version
  repair.disabled = false
  repair.textContent = version ? uiText("webview.vanillaPreview.completionJavaClientResources", version) : uiText("webview.vanillaPreview.completeClientResources")
  repair.removeAttribute('aria-busy')
  repairFeedback.textContent = ''
  repairFeedback.hidden = true
}

function showWarnings(messages: readonly string[], modelWarnings: readonly string[] = active?.inspector?.warnings ?? []): void {
  const combined = [...new Set([...messages, ...modelWarnings])]
  warnings.replaceChildren(...combined.map(message => node('li', '', message)))
  warnings.hidden = combined.length === 0
}

function showDiagnostics(messages: string[] = [], paths: string[] = []): void {
  showWarnings(messages, [])
  missingPaths.replaceChildren(...paths.map(path => {
    const entry = node('li', '')
    entry.append(node('code', '', path))
    return entry
  }))
  missingTitle.hidden = missingPaths.hidden = paths.length === 0
}

function validStrings(value: unknown): value is string[] { return Array.isArray(value) && value.every(entry => typeof entry === 'string') }
function validRepairVersion(value: unknown): value is string | undefined { return value === undefined || typeof value === 'string' && value.trim().length > 0 }

function stopFlat(): void {
  finishDrag()
  cancelAnimationFrame(flatFrame)
  flatFrame = 0; flat = undefined; flatSource = undefined; flatCanvas = undefined
  flatModel = undefined; flatBlend = undefined; flatBlendData = undefined
}

function drawFlat(stamp = performance.now()): void {
  if (!flat || !flatSource || !flatCanvas || destroyed) return
  cancelAnimationFrame(flatFrame); flatFrame = 0
  if (playing && flatStamp && !document.hidden) flatTime += Math.min(250, stamp - flatStamp) / 50
  flatStamp = stamp
  const rect = stage.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2)
  const scale = Math.min(dpr, Math.sqrt(1600000 / Math.max(1, rect.width * rect.height)))
  flatCanvas.width = Math.max(64, Math.round(rect.width * scale)); flatCanvas.height = Math.max(64, Math.round(rect.height * scale))
  const ctx = flatCanvas.getContext('2d')
  if (!ctx) return
  ctx.imageSmoothingEnabled = false
  const animated = flatModel?.animated === true
  const frameHeight = animated ? flat.width : flat.height
  const sample = animated && flatModel ? sampleFrame(flatModel.schedule, flatTime, flatModel.interpolate) : { frame: 0, nextFrame: 0, mix: 0 }
  const frame = sample.frame
  const zoom = Math.min(flatCanvas.width / flat.width, flatCanvas.height / frameHeight) * 0.82 * view.zoom
  const width = flat.width * zoom, height = frameHeight * zoom
  let source = flatSource, sourceY = frame * frameHeight
  if (sample.mix > 0 && flat.data) {
    flatBlend ??= node('canvas', '')
    if (flatBlend.width !== flat.width || flatBlend.height !== frameHeight) { flatBlend.width = flat.width; flatBlend.height = frameHeight; flatBlendData = undefined }
    flatBlendData ??= new ImageData(flat.width, frameHeight)
    const pixels = new Uint8Array(flat.data), length = flat.width * frameHeight * 4
    const from = sample.frame * length, next = sample.nextFrame * length
    for (let i = 0; i < length; i++) flatBlendData.data[i] = pixels[from + i] * (1 - sample.mix) + pixels[next + i] * sample.mix
    flatBlend.getContext('2d')?.putImageData(flatBlendData, 0, 0)
    source = flatBlend; sourceY = 0
  }
  ctx.drawImage(source, 0, sourceY, flat.width, frameHeight, (flatCanvas.width - width) / 2 + view.panX * scale, (flatCanvas.height - height) / 2 + view.panY * scale, width, height)
  if (animated && playing && !document.hidden) flatFrame = requestAnimationFrame(drawFlat)
}

function initializeFlat(data: VanillaFlatPreview): void {
  const value = data.preview
  if (!Number.isSafeInteger(data.sessionId) || data.sessionId < latestSessionId || !value || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) || value.width < 1 || value.height < 1 || value.width > 8192 || value.height > 8192 || value.width * value.height > 8192 * 8192 || !Number.isSafeInteger(value.frameCount) || value.frameCount < 1 || value.frameCount > Math.max(1, Math.floor(value.height / value.width)) || typeof value.name !== 'string' || typeof value.packLabel !== 'string' || !(value.data instanceof ArrayBuffer) || value.data.byteLength !== value.width * value.height * 4) return
  if (data.sessionId === latestSessionId && ['model', 'selecting', 'repairing', 'error'].includes(sessionPhase)) return
  if (data.warnings !== undefined && !validStrings(data.warnings) || data.missingPaths !== undefined && !validStrings(data.missingPaths) || !validRepairVersion(data.repairVersion)) return
  const same = flat && (flat.sourceUri ?? flat.name) === (value.sourceUri ?? value.name)
  if (data.sessionId !== latestSessionId) updateTargets()
  latestSessionId = data.sessionId
  sessionPhase = 'flat'
  clearTimeout(renderTimer)
  revision++; completed = revision
  current?.close(); current = undefined; stopActive(); stopFlat()
  flat = value
  flatModel = modelOf(value).model
  if (!same) { view = { yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0 }; flatTime = 0 }
  flatStamp = 0
  flatSource = node('canvas', '')
  flatSource.width = value.width; flatSource.height = value.height
  flatSource.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(value.data), value.width, value.height), 0, 0)
  flatCanvas = node('canvas', 'vp-canvas')
  flatCanvas.setAttribute('role', 'img'); flatCanvas.setAttribute('aria-label', value.name + uiText("webview.vanillaPreview.planePaste"))
  canvasSlot.replaceChildren(flatCanvas)
  identity.textContent = value.displayName && value.displayName !== value.name ? value.displayName + ' · ' + value.name : value.name
  identity.title = [value.translationLocale, value.translationKey].filter(Boolean).join(' · ')
  version.textContent = uiText("webview.vanillaPreview.planePaste_0c5348")
  packLabel.textContent = value.packLabel
  presentationLabel.hidden = true
  itemStatePanel.hidden = true
  propertyTitle.textContent = uiText("webview.vanillaPreview.pasteInformation")
  propertyPanel.replaceChildren(node('p', 'vp-muted', uiText("webview.vanillaPreview.showAPosterInOriginalPixelsModel")))
  layers.replaceChildren(); showDiagnostics(data.warnings, data.missingPaths); tallLabel.hidden = true
  resetRepair(data.repairVersion)
  stageNote.textContent = uiText("webview.vanillaPreview.planePasteRollerScale")
  controls.get('yaw')!.disabled = true; controls.get('pitch')!.disabled = true
  animation.disabled = !flatModel.animated
  animation.textContent = animation.disabled ? uiText("webview.vanillaPreview.noDynamicTexture") : playing ? uiText("webview.vanillaPreview.pauseDynamicTexture") : uiText("webview.vanillaPreview.playDynamicTexture")
  animation.setAttribute('aria-pressed', String(!animation.disabled && playing))
  status.textContent = value.name + ' · ' + value.width + ' × ' + value.height + uiText("webview.vanillaPreview.thePlankIsReadyAndModelInformation")
  if (data.warnings?.length || data.missingPaths?.length) status.textContent += uiText("webview.vanillaPreview.modelResourceDiagnosticsAreShownInThe")
  status.setAttribute('role', 'status')
  root.dataset.state = 'ready'; root.dataset.sessionId = String(data.sessionId); root.dataset.renderId = String(++painted)
  modelFileAction.hidden = true
  generatedAction.hidden = true
  root.dataset.mode = 'flat'
  delete root.dataset.presentation; delete root.dataset.animated
  stageLoading.hidden = true
  targetSelect.disabled = targetPending
  reset.disabled = false
  syncView(); drawFlat()
}

function suspendPreview(message: string): void {
  clearTimeout(renderTimer)
  revision++; completed = revision
  current?.close(); current = undefined
  stopActive(); stopFlat()
  canvasSlot.replaceChildren()
  delete root.dataset.presentation; delete root.dataset.animated
  root.dataset.state = 'loading'; root.dataset.mode = 'loading'
  status.setAttribute('role', 'status')
  status.textContent = message
  stageLoading.textContent = message
  stageLoading.hidden = false
  presentationSelect.disabled = true
  itemStateInput.disabled = true; applyItemState.disabled = true
  for (const select of propertyPanel.querySelectorAll('select')) select.disabled = true
  tall.disabled = true
  reset.disabled = true
  controls.get('yaw')!.disabled = true; controls.get('pitch')!.disabled = true
}

function initializeLoading(data: VanillaPreviewLoading): void {
  if (!Number.isSafeInteger(data.sessionId) || data.sessionId < latestSessionId || typeof data.name !== 'string') return
  if (data.sessionId === latestSessionId && !['waiting', 'loading'].includes(sessionPhase)) return
  latestSessionId = data.sessionId
  sessionPhase = 'loading'
  resetRepair()
  suspendPreview(uiText("webview.vanillaPreview.parsingResourceFormAndModel", data.name))
  updateTargets()
  identity.textContent = data.name
  version.textContent = uiText("webview.vanillaPreview.parsingResource")
  packLabel.textContent = ''
  layers.replaceChildren(); showDiagnostics(); propertyPanel.replaceChildren()
  propertyTitle.textContent = uiText("webview.vanillaPreview.resourceParsing")
  presentationLabel.hidden = true; tallLabel.hidden = true; itemStatePanel.hidden = true
  root.dataset.sessionId = String(data.sessionId)
}

function syncPresentationNote(): void {
  stageNote.textContent = presentation === 'head' ? uiText("webview.vanillaPreview.headLineFrameRefersToHeadSize") : presentation === 'gui' ? uiText("webview.vanillaPreview.objectBarNineCellShortcutLeftKey") : presentation === 'fixed' ? uiText("webview.vanillaPreview.showBoxWallscapeLeftClickRotateMiddle") : presentation === 'model' ? uiText("webview.vanillaPreview.dModelDragRotationRollerScaling") : presentation === 'dropped' ? uiText("webview.vanillaPreview.dropFieldActualGroundTransformationDragRotation") : uiText("webview.vanillaPreview.leftMiddleRollerZoom")
}

function syncView(): void {
  for (const [key, range] of controls) {
    range.value = String(key === 'zoom' ? view[key] : wrapOrbitDegrees(view[key]))
    const output = range.parentElement?.querySelector('output')
    if (output) output.textContent = key === 'zoom' ? `${Math.round(view.zoom * 100)}%` : `${Math.round(wrapOrbitDegrees(view[key]))}°`
  }
}
function stopActive(): void { optimizeAlphaAction.hidden = true; finishDrag(); active?.dispose(); active = undefined; generatedCompactAction.hidden = true; generatedAction.hidden = true; inspectorSlot.replaceChildren(); animation.disabled = true }
function showError(error: unknown): void {
  resetRepair(repairVersion)
  stopActive()
  stopFlat()
  canvasSlot.replaceChildren()
  root.dataset.state = 'error'
  stageLoading.hidden = true
  status.textContent = asError(error).message
  status.setAttribute('role', 'alert')
}
function requestRender(): void {
  if (flat) { drawFlat(); return }
  if (!current || destroyed) return
  revision++
  root.dataset.state = 'loading'
  status.setAttribute('role', 'status')
  status.textContent = uiText("webview.vanillaPreview.readingModelsInheritanceChainsAndFaceTo")
  stageLoading.textContent = status.textContent
  stageLoading.hidden = canvasSlot.childElementCount > 0
  clearTimeout(renderTimer)
  renderTimer = setTimeout(() => { void pump() }, 35)
}

function requestViewRender(): void {
  if (flat) { drawFlat(); return }
  active?.updateView()
}

// 仅调整相机观察位置，方块的 variant 旋转与 uvlock 由库处理
function frameCamera(camera: THREE.OrthographicCamera, bounds: THREE.Box3, width: number, height: number, pose: View, base = { yaw: 35, pitch: 20 }): void {
  const center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3())
  const radius = Math.max(size.length() / 2, 1), aspect = width / height
  const half = radius * 1.2 / pose.zoom
  camera.left = -half * Math.max(1, aspect); camera.right = -camera.left
  camera.top = half * Math.max(1, 1 / aspect); camera.bottom = -camera.top
  const distance = radius * 4 + 32
  placeOrbitCamera(camera, center, distance, base.yaw + pose.yaw, base.pitch + pose.pitch, pose.rotation)
  camera.near = 0.01; camera.far = distance + radius * 8 + 100
  camera.updateProjectionMatrix()
  const rect = stage.getBoundingClientRect(), dx = pose.panX / Math.max(rect.width, 1) * (camera.right - camera.left), dy = pose.panY / Math.max(rect.height, 1) * (camera.top - camera.bottom)
  camera.left -= dx; camera.right -= dx; camera.top += dy; camera.bottom += dy
  camera.updateProjectionMatrix()
  ;(camera as THREE.OrthographicCamera & { fitAspect?: boolean }).fitAspect = false
}

async function buildPreview(session: AssetSession, token: number): Promise<LiveRender> {
  if (!globals.__MCRH__?.modelAssets) throw new Error(uiText("webview.vanillaPreview.unableToInitializeOriginalModelRendererWithout"))
  const itemData = structuredClone(pendingItemState ?? appliedItemState)
  const init = session.init, context = presentation, selected = { ...properties }, pose = { ...view }, combined = tall.checked && init.supportsTallBlock && init.target.kind === 'block'
  const rect = stage.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2)
  const scale = Math.min(dpr, Math.sqrt(1600000 / Math.max(1, rect.width * rect.height)))
  const width = Math.max(64, Math.round(rect.width * scale)), height = Math.max(64, Math.round(rect.height * scale))
  const canvas = node('canvas', 'vp-canvas')
  canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `${init.target.id} ${init.fallbackModel ? uiText("webview.vanillaPreview.temporaryStereoPreview") : uiText("webview.vanillaPreview.originalResourceModel")}`)
  let assets: PreparedAssets | undefined, handle: SceneHandle | undefined, vehicle: VehicleScene | undefined, scene: THREE.Scene | undefined, player: Player | undefined
  let handedOff = false, disposed = false, empty = false
  let camera: THREE.OrthographicCamera | undefined, inspector: ModelInspector | undefined, redrawFrame = 0, motionFrame = 0
  let viewBounds: THREE.Box3 | undefined, cameraBase = { yaw: 35, pitch: 20 }, motionRoot: THREE.Group | undefined
  let requested = false, requestedView = false, drawing = false, localPlaying = playing, motionTime = 0, lastMotion = 0, lastMotionPaint = 0
  let drawScene: (() => Promise<void>) | undefined
  const redraw = (viewChanged = false): void => {
    if (disposed) return
    requested = true; requestedView ||= viewChanged
    if (redrawFrame || drawing || !drawScene) return
    redrawFrame = requestAnimationFrame(() => {
      redrawFrame = 0
      const manual = requestedView; requested = false; requestedView = false; drawing = true
      void drawScene!().then(() => { if (!disposed && manual && active?.canvas === canvas && root.dataset.state === 'ready') root.dataset.renderId = String(++painted) }).catch(error => { if (!disposed) status.textContent = uiText("webview.vanillaPreview.synchronisingS", asError(error).message) }).finally(() => { drawing = false; if (requested) redraw() })
    })
  }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    cancelAnimationFrame(redrawFrame); cancelAnimationFrame(motionFrame); inspector?.dispose(); player?.pause(); player?.dispose(); handle?.dispose(); vehicle?.dispose()
    if (assets) disposeCache(assets)
    if (scene) scene.traverse(value => {
      if (value instanceof THREE.Mesh || value instanceof THREE.LineSegments) {
        value.geometry.dispose()
        for (const material of Array.isArray(value.material) ? value.material : [value.material]) material.dispose()
      }
    })
    scene?.clear(); canvas.remove()
  }
  try {
    const resolve = (reference: ModelReference): Promise<ResolvedModel> => checkedModel(assets!, reference, session)
    session.usedMissing = false
    session.faults.clear()
    await session.prepareFilters()
    assets = await prepareAssets(session.handlers, { cache: true, version: init.version, defaults: 'game' })
    const options = { assets, canvas, width, height, animated: true as const, cache: false as const, pauseOffscreen: false, lighting: 'item' as const, version: init.version, defaults: 'game' as const }
    if (context === 'entity') {
      if (!init.vehicle) throw new Error(uiText("webview.vanillaPreview.currentResourceDoesNotHaveASupported"))
      vehicle = await createVehicleScene(assets, init.vehicle, init.version)
      const setup = await makeModelScene()
      scene = setup.scene; camera = setup.camera
      scene.add(vehicle.group, new THREE.AmbientLight(0xffffff,0.7))
      const light = new THREE.DirectionalLight(0xffffff,1.1)
      light.position.set(-1,2,1); scene.add(light)
      viewBounds = vehicle.bounds.clone()
      frameCamera(setup.camera,viewBounds,width,height,pose)
      player = await renderModelScene(scene,setup.camera,options)
    } else if (init.target.kind === 'block' && context === 'block') {
      await requireJson(resourcePath('blockstates', init.target.id), assets)
      const blocks: SceneBlock[] = [{ id: init.target.id, properties: selected, pos: [0, 0, 0] }]
      if (combined) {
        const halves = init.properties.half ?? [], lower = halves.includes('lower') ? 'lower' : 'bottom', upper = halves.includes('upper') ? 'upper' : 'top'
        if (!halves.includes(lower) || !halves.includes(upper)) throw new Error(uiText("webview.vanillaPreview.topDownGroupRequiresBackendToProvide"))
        blocks[0].properties = { ...selected, half: lower }
        blocks.push({ id: init.target.id, properties: { ...selected, half: upper }, pos: [0, 1, 0] })
      }
      for (const block of blocks) {
        const references = await parseBlockstate(assets, block.id, { data: block.properties, pos: block.pos, version: init.version, defaults: 'game' })
        for (const reference of references) await resolve(reference)
      }
      handle = await createScene(assets, blocks, { lighting: 'item', defaults: 'game', version: init.version, optimize: false, animate: false, shouldCancel: () => session.closed || token !== revision }) ?? undefined
      if (!handle) throw new Error(uiText("webview.vanillaPreview.modelBuildCanceled"))
      if (handle.bounds.isEmpty()) throw new Error(uiText("webview.vanillaPreview.thereIsNoModelGeometryToShow"))
      const setup = await makeModelScene()
      scene = setup.scene; camera = setup.camera
      scene.add(handle.group)
      viewBounds = handle.bounds.clone()
      frameCamera(setup.camera, viewBounds, width, height, pose)
      player = await renderModelScene(scene, setup.camera, options)
    } else {
      let references: ModelReference[]
      if (init.fallbackModel) {
        references = [{ model: init.fallbackModel }]
      } else if (init.target.kind === 'block') {
        const modern = resourcePath('items', init.target.id), legacy = resourcePath('models/item', init.target.id)
        if (await readFile(modern, assets) || await readFile(legacy, assets)) {
          const json = await readFile(modern, assets) ? await requireJson(modern, assets) : undefined
          if (json) validateItemDefinition(json, modern)
          references = await parseVersionedItem(assets, init.target.id, { version: init.version, display: context === 'model' ? 'gui' : context === 'dropped' ? 'ground' : context, data: itemData })
        } else references = (await parseBlockstate(assets, init.target.id, { data: selected, pos: [0, 0, 0], version: init.version, defaults: 'game' })).map(reference => ({ ...reference, type: 'item' }))
      } else if (init.target.kind === 'model') {
        await requireJson(resourcePath('models', init.target.id), assets)
        const direct = await requireJson(resourcePath('models', init.target.id), assets)
        const itemId = init.target.id.replace(':item/', ':')
        const modernItem = init.target.id.includes(':item/') && init.version && compareMinecraftVersion(init.version, '1.21.4') >= 0 && await readFile(resourcePath('items', itemId), assets)
        if (modernItem) references = await parseVersionedItem(assets, itemId, { version: init.version, display: context === 'model' ? 'gui' : context === 'dropped' ? 'ground' : context, data: itemData })
        else {
          const selectedOverride = !init.version || compareMinecraftVersion(init.version, '1.21.4') < 0 ? legacyItemOverride(direct, itemData) : undefined
          references = [{ model: { parent: selectedOverride ?? init.target.id } }]
        }
      } else {
        const modern = resourcePath('items', init.target.id), legacy = resourcePath('models/item', init.target.id)
        const definition = await readFile(modern, assets) ? modern : legacy
        const json = await requireJson(definition, assets)
        if (definition === modern) validateItemDefinition(json, definition)
        references = await parseVersionedItem(assets, init.target.id, { version: init.version, display: context === 'model' ? 'gui' : context === 'dropped' ? 'ground' : context, data: itemData })
      }
      const resolved = await Promise.all(references.map(reference => resolve(reference)))
      empty = resolved.length === 0 || resolved.every(model => !model.elements?.length)
      const setup = await makeModelScene()
      scene = setup.scene; camera = setup.camera
      scene.userData.ephemeral = false
      for (const model of resolved) {
        await loadModel(scene, assets, model, {display:modelDisplay(model,context,{ yaw: 0, pitch: 0, zoom: 1 }),lighting:'item',defaults:'game',animate:false,version:init.version,mergeElements:false})
      }
      if (context === 'head') {
        scene.add(createHeadReference())
        viewBounds = new THREE.Box3().setFromObject(scene); cameraBase = { yaw: 0, pitch: 0 }
        frameCamera(setup.camera, viewBounds, width, height, pose, cameraBase)
      }
      if (context === 'gui' || context === 'fixed') {
        const decoration = createPresentationScene(context, new THREE.Box3().setFromObject(scene))
        scene.add(decoration.group)
        viewBounds = decoration.bounds; cameraBase = decoration.cameraBase
        canvas.dataset.scene = context
        canvas.setAttribute('aria-label', init.target.id + ' ' + decoration.label)
        frameCamera(setup.camera, viewBounds, width, height, pose, cameraBase)
      }
      if (['model', 'ground', 'dropped'].includes(context) && !empty) {
        const center = new THREE.Box3().setFromObject(scene).getCenter(new THREE.Vector3()), children = [...scene.children]
        motionRoot = new THREE.Group(); motionRoot.position.copy(center); motionRoot.userData.motionOriginY = center.y
        scene.add(motionRoot)
        for (const child of children) motionRoot.attach(child)
      }
      if ((context === 'model' || context === 'dropped') && !empty) {
        const bounds = new THREE.Box3().setFromObject(scene)
        if (context === 'dropped') {
          const size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3())
          const floor = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(size.length() * 2, 20), Math.max(size.length() * 2, 20)), new THREE.MeshBasicMaterial({ color: 0x39434d, transparent: true, opacity: 0.45, side: THREE.DoubleSide }))
          floor.rotation.x = -Math.PI / 2
          floor.position.set(center.x, bounds.min.y - 2, center.z)
          const shadow = new THREE.Mesh(new THREE.CircleGeometry(Math.max(size.x, size.z, 2) * 0.45, 48), new THREE.MeshBasicMaterial({ color: 0x080a0c, transparent: true, opacity: 0.3, depthWrite: false }))
          shadow.rotation.x = -Math.PI / 2
          shadow.position.set(center.x, floor.position.y + 0.01, center.z)
          scene.add(floor, shadow)
          bounds.min.y -= 3
        }
        viewBounds = bounds; cameraBase = context === 'model' ? { yaw: 0, pitch: 0 } : { yaw: 35, pitch: 20 }
        frameCamera(setup.camera, bounds, width, height, pose, cameraBase)
      }
      player = await renderModelScene(scene,setup.camera,options)
    }
    if (session.faults.size) throw new Error([...session.faults].join('\n'))
    if (session.usedMissing) throw new Error(uiText("webview.vanillaPreview.modelOrPasteResourcesAreMissingRenderings"))
    scene!.userData.ephemeral = false
    const nativeAnimation = player.animated, motion = Boolean(motionRoot), animated = nativeAnimation || motion
    const updateCamera = (): { width: number; height: number } => {
      const rect = stage.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2), scale = Math.min(dpr, Math.sqrt(1600000 / Math.max(1, rect.width * rect.height)))
      const size = { width: Math.max(64, Math.round(rect.width * scale)), height: Math.max(64, Math.round(rect.height * scale)) }
      if (viewBounds) frameCamera(camera!, viewBounds, size.width, size.height, view, cameraBase)
      else {
        const aspect = size.width / size.height, half = 8 / view.zoom
        camera!.left = -half * aspect; camera!.right = half * aspect; camera!.top = half; camera!.bottom = -half
        placeOrbitCamera(camera!, new THREE.Vector3(), 30, view.yaw, view.pitch, view.rotation)
        const dx = view.panX / Math.max(rect.width, 1) * half * aspect * 2, dy = view.panY / Math.max(rect.height, 1) * half * 2
        camera!.left -= dx; camera!.right -= dx; camera!.top += dy; camera!.bottom += dy
        camera!.near = 0.01; camera!.far = 200; camera!.updateProjectionMatrix()
        ;(camera as THREE.OrthographicCamera & { fitAspect?: boolean }).fitAspect = false
      }
      return size
    }
    drawScene = async (): Promise<void> => {
      if (disposed) return
      const size = updateCamera()
      if (nativeAnimation && motion) {
        if (canvas.width !== size.width || canvas.height !== size.height) player!.setCanvases([{ canvas, ...size }])
        player!.renderTime(motionTime)
      } else {
        if (nativeAnimation && (canvas.width !== size.width || canvas.height !== size.height)) player!.setCanvases([{ canvas, ...size }])
        await renderModelScene(scene!, camera!, { ...options, ...size, animated: false })
      }
    }
    const tick = (stamp: number): void => {
      motionFrame = 0
      if (disposed || !localPlaying || document.hidden || !motionRoot) { lastMotion = 0; return }
      const delta = lastMotion ? Math.min(100, stamp - lastMotion) : 0; lastMotion = stamp
      if (!drag) motionTime += delta
      if (stamp - lastMotionPaint >= 1000 / 30) {
        lastMotionPaint = stamp
        motionRoot.rotation.y = motionTime / (context === 'model' ? 10000 : 3000)
        motionRoot.position.y = Number(motionRoot.userData.motionOriginY) + (context === 'model' ? 0 : Math.sin(motionTime / 500) * 0.7)
        canvas.dataset.motionTime = String(Math.round(motionTime)); redraw()
      }
      motionFrame = requestAnimationFrame(tick)
    }
    const setPlaying = (value: boolean): void => {
      localPlaying = value
      cancelAnimationFrame(motionFrame); motionFrame = 0; lastMotion = 0
      if (motion) { player!.pause(); if (value && !document.hidden) motionFrame = requestAnimationFrame(tick) }
      else if (value && !document.hidden) player!.play(); else player!.pause()
    }
    if (scene && camera && context !== 'entity') inspector = await createModelInspector({
      scene, camera, canvas, assets, targetId: init.target.id, fallback: init.fallbackModel,
      read: path => session.inspectPath(path), redraw: () => redraw(),
      openModel: path => post({ command: 'vanillaOpenModel', sessionId: init.sessionId, path }),
      applyFamily: path => post({ command: 'vanillaApplyFamily', sessionId: init.sessionId, path })
    })
    setPlaying(playing)
    await drawScene()
    handedOff = true
    return { player, canvas, empty, inspector, animated, motion, orientation: () => camera!.quaternion.toArray(), capture: async () => { while (drawing) await new Promise(resolve => requestAnimationFrame(resolve)); await drawScene?.() }, updateView: () => redraw(true), setPlaying, dispose }
  } finally { if (!handedOff) dispose() }
}

async function pump(): Promise<void> {
  if (rendering || destroyed) return
  rendering = true
  try {
    while (current && completed < revision && !destroyed) {
      const token = revision, session = current
      try {
        const next = await buildPreview(session, token)
        if (destroyed || current !== session || token !== revision) next.dispose()
        else {
          if (pendingItemState) {
            appliedItemState = pendingItemState
            saveItemState()
            pendingItemState = undefined
            applyItemState.disabled = false
            itemStateFeedback.textContent = uiText("webview.vanillaPreview.parametersHaveBeenAppliedAndTheObject")
            itemStateFeedback.setAttribute('role', 'status')
          }
          stopActive()
          active = next
          optimizeAlphaAction.hidden = !current?.init.modelFile?.exists; optimizeAlphaAction.disabled = false
          generatedCompactAction.hidden = !next.inspector?.generatedCompactTargets.length
          generatedCompactAction.disabled = false; generatedCompactAction.textContent = uiText("webview.vanillaPreview.otherOrganiser")
          generatedAction.hidden = !next.inspector?.generatedTargets.length
          generatedAction.disabled = false; generatedAction.textContent = uiText("webview.vanillaPreview.addOriginal")
          showWarnings(session.init.warnings)
          canvasSlot.replaceChildren(next.canvas)
          inspectorSlot.replaceChildren(...(next.inspector ? [next.inspector.element] : []))
          root.dataset.state = 'ready'
          stageLoading.hidden = true
          root.dataset.renderId = String(++painted)
          root.dataset.buildCount = String(++builds)
          root.dataset.motion = String(next.motion)
          root.dataset.presentation = presentation
          root.dataset.animated = String(next.animated)
          status.textContent = session.init.fallbackModel ? uiText("webview.vanillaPreview.temporaryDPreviewPleaseCompleteTheSame") : next.empty ? uiText("webview.vanillaPreview.theItemUsesAnEmptyModelIn") : next.motion ? uiText("webview.vanillaPreview.sceneAnimationIsReadyAndCanBe") : next.player.animated ? uiText("webview.vanillaPreview.modelsAreReadyDynamicTextureCanBe") : uiText("webview.vanillaPreview.modelsAreReadyActualGeometryAndFace")
          animation.disabled = !next.animated
          animation.textContent = next.motion ? (playing ? uiText("webview.vanillaPreview.pauseSceneAnimation") : uiText("webview.vanillaPreview.playSceneAnimations")) : next.player.animated ? (playing ? uiText("webview.vanillaPreview.pauseDynamicTexture") : uiText("webview.vanillaPreview.playDynamicTexture")) : uiText("webview.vanillaPreview.noDynamicTexture")
          animation.setAttribute('aria-pressed', String(playing && next.animated))
        }
      } catch (error) {
        if (!destroyed && current === session && token === revision) {
          if (pendingItemState) {
            pendingItemState = undefined
            applyItemState.disabled = false
            itemStateFeedback.textContent = asError(error).message + uiText("webview.vanillaPreview.lastValid")
            itemStateFeedback.setAttribute('role', 'alert')
            if (active) {
              root.dataset.state = 'ready'
              stageLoading.hidden = true
              status.textContent = uiText("webview.vanillaPreview.objectStatusParametersNotAppliedLastValid")
              status.setAttribute('role', 'status')
            } else showError(error)
          } else showError(error)
        }
      }
      completed = token
    }
  } finally { rendering = false }
}

function validTarget(data: unknown): data is VanillaPreviewTarget {
  if (!data || typeof data !== 'object') return false
  const target = data as Partial<VanillaPreviewTarget>
  return typeof target.kind === 'string' && ['block', 'model', 'item', 'entity'].includes(target.kind) && typeof target.id === 'string' && target.id.length > 0 && (target.displayName === undefined || typeof target.displayName === 'string') && (target.translationLocale === undefined || target.translationLocale === 'zh_cn' || target.translationLocale === 'en_us') && (target.translationKey === undefined || typeof target.translationKey === 'string')
}

function receiveTargets(data: VanillaPreviewTargets): void {
  if (!Number.isSafeInteger(data.sessionId) || data.sessionId !== latestSessionId || !selectedTarget || !Array.isArray(data.targets) || !data.targets.every(validTarget)
    || data.warnings !== undefined && (!Array.isArray(data.warnings) || !data.warnings.every(warning => typeof warning === 'string'))) return
  if (sessionPhase === 'repairing') return
  renderTargets(data.targets)
  if (data.warnings !== undefined) {
    if (current) current.init.warnings = data.warnings
    if (confirmedInit) confirmedInit.warnings = data.warnings
    showWarnings(data.warnings)
  }
}

function receiveNames(data: VanillaPreviewNames): void {
  const name = data.name
  if (data.sessionId !== latestSessionId || !['model', 'flat'].includes(sessionPhase) || !name || typeof name.displayName !== 'string'
    || name.translationLocale !== undefined && !['zh_cn', 'en_us'].includes(name.translationLocale)
    || name.translationKey !== undefined && typeof name.translationKey !== 'string'
    || name.nameWarnings !== undefined && !validStrings(name.nameWarnings) || !validStrings(data.warnings)
    || data.targets !== undefined && (!Array.isArray(data.targets) || !data.targets.every(validTarget))) return
  const resolved = { displayName: name.displayName, translationKey: name.translationKey, translationLocale: name.translationLocale, translationSource: name.translationSource, nameWarnings: name.nameWarnings }
  if (selectedTarget && sessionPhase === 'model') {
    selectedTarget = { ...selectedTarget, ...resolved }
    if (confirmedInit) { confirmedInit.target = selectedTarget; confirmedInit.warnings = data.warnings; confirmedInit.targets = data.targets ?? confirmedInit.targets }
    if (current) { current.init.target = selectedTarget; current.init.warnings = data.warnings; current.init.targets = data.targets ?? current.init.targets }
    renderTargets(data.targets ?? availableTargets)
    identity.textContent = name.displayName === selectedTarget.id ? selectedTarget.id : name.displayName + ' · ' + selectedTarget.id
  } else if (flat) {
    flat = { ...flat, ...resolved }
    identity.textContent = name.displayName === flat.name ? flat.name : name.displayName + ' · ' + flat.name
  } else return
  identity.title = [name.translationLocale, name.translationKey].filter(Boolean).join(' · ')
  showWarnings(data.warnings)
}

function validInit(data: unknown): data is VanillaPreviewInit {
  if (!data || typeof data !== 'object') return false
  const item = data as Partial<VanillaPreviewInit>
  return item.command === 'vanillaInit' && Number.isSafeInteger(item.sessionId) && validTarget(item.target)
    && (item.targets === undefined || Array.isArray(item.targets) && item.targets.every(validTarget))
    && Array.isArray(item.layers) && item.layers.length > 0 && item.layers.every(layer => typeof layer === 'string') && !!item.properties && typeof item.properties === 'object'
    && Object.values(item.properties).every(values => Array.isArray(values) && values.length > 0 && values.every(value => typeof value === 'string'))
    && !!item.initialProperties && typeof item.initialProperties === 'object' && Array.isArray(item.warnings) && item.warnings.every(warning => typeof warning === 'string')
    && typeof item.packLabel === 'string' && typeof item.supportsTallBlock === 'boolean' && (item.version === undefined || typeof item.version === 'string')
    && (item.vehicle === undefined || !!item.vehicle && ['boat','raft'].includes(item.vehicle.shape) && typeof item.vehicle.chest === 'boolean' && /^assets\/minecraft\/textures\/entity\/(?:chest_boat|boat)\/[a-z0-9_]+\.png$/.test(item.vehicle.texturePath))
    && (item.fallbackModel === undefined || !!item.fallbackModel && typeof item.fallbackModel === 'object' && !Array.isArray(item.fallbackModel))
    && (item.missingPaths === undefined || validStrings(item.missingPaths))
    && validRepairVersion(item.repairVersion) && (item.target.kind !== 'entity' || !!item.vehicle)
}

function initialize(init: VanillaPreviewInit): void {
  if (init.sessionId < latestSessionId || init.sessionId === latestSessionId && ['model', 'selecting', 'repairing', 'error'].includes(sessionPhase)) return
  const keepFlat = init.sessionId === latestSessionId && sessionPhase === 'flat'
  stopFlat()
  if (!keepFlat) canvasSlot.replaceChildren()
  root.dataset.mode = 'model'
  root.dataset.fallback = String(Boolean(init.fallbackModel))
  controls.get('yaw')!.disabled = false; controls.get('pitch')!.disabled = false
  stageNote.textContent = uiText("webview.vanillaPreview.leftMiddleRollerZoom")
  latestSessionId = init.sessionId
  sessionPhase = 'model'
  resetRepair(init.repairVersion)
  optimizeAlphaAction.hidden = true; optimizeAlphaAction.disabled = false
  generatedAction.hidden = true; generatedAction.disabled = false; generatedAction.textContent = uiText("webview.vanillaPreview.addOriginal")
  generatedCompactAction.hidden = true; generatedCompactAction.disabled = false; generatedCompactAction.textContent = uiText("webview.vanillaPreview.otherOrganiser")
  updateTargets(init)
  presentationSelect.disabled = false; tall.disabled = false; reset.disabled = false
  const sameTarget = confirmedInit?.target.kind === init.target.kind && confirmedInit?.target.id === init.target.id
  confirmedInit = init
  modelFileAction.hidden = !init.modelFile
  modelFileAction.textContent = init.modelFile?.exists ? uiText("webview.preview.modelInspector.openModelFile") : uiText("ui.modelPreviewDocuments.addModelFile")
  modelFileAction.title = init.modelFile ? init.modelFile.path + (init.modelFile.exists ? '' : uiText("webview.vanillaPreview.theCurrentPackageIsNotOverwrittenQualifier")) : ''
  if (pendingItemState) {
    pendingItemState = undefined
    itemStateFeedback.textContent = uiText("webview.vanillaPreview.resourceSessionUpdatedLastValidParameterMaintained")
    itemStateFeedback.setAttribute('role', 'status')
  }
  itemStatePanel.hidden = init.target.kind !== 'item' && !(init.target.kind === 'model' && init.target.id.includes(':item/'))
  cmdApply.disabled = !init.version || customModelDataSchema(init.version) === 'unsupported'
  cmdCopy.disabled = cmdApply.disabled
  cmdCases.hidden = true
  itemStateInput.disabled = false; applyItemState.disabled = false
  if (!sameTarget) {
    appliedItemState = restoreItemState(init)
    itemStateInput.value = JSON.stringify(appliedItemState, null, 2)
    itemStateFeedback.textContent = Object.keys(appliedItemState).length ? uiText("webview.vanillaPreview.lastValidParameterForThisItemHas") : uiText("webview.vanillaPreview.defaultSettingTheStatusOfACustom")
    itemStateFeedback.setAttribute('role', 'status')
  }
  const choices = presentations(init)
  presentation = sameTarget && choices.some(entry => entry.id === presentation) ? presentation : choices[0].id
  presentationSelect.replaceChildren(...choices.map(entry => {
    const option = node('option', '', entry.label)
    option.value = entry.id; return option
  }))
  presentationSelect.value = presentation
  syncPresentationNote()
  presentationLabel.hidden = false
  propertyTitle.textContent = init.target.kind === 'block' ? uiText("ui.resourceDocs.blockState") : init.target.kind === 'entity' ? uiText("webview.vanillaPreview.entityModel") : uiText("ui.resourceDocs.itemModel")
  const retainedProperties = sameTarget ? properties : {}
  const retainedTall = tall.checked
  current?.close()
  stopActive()
  current = new AssetSession(init)
  void updateCmdCases(init)
  const title = root.querySelector('.vp-title'); if (title) title.textContent = uiText("webview.paint.dPreview")
  properties = {}
  for (const [key, values] of Object.entries(init.properties)) {
    const retained = retainedProperties[key], initial = init.initialProperties[key]
    properties[key] = values.includes(retained) ? retained : values.includes(initial) ? initial : values[0]
  }
  if (!sameTarget) view = { yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0 }
  syncView()
  identity.textContent = init.target.displayName && init.target.displayName !== init.target.id ? init.target.displayName + ' · ' + init.target.id : init.target.id
  identity.title = [init.target.translationLocale, init.target.translationKey].filter(Boolean).join(' · ')
  version.textContent = init.version ? `Java ${init.version}` : uiText("webview.guiPreview.versionNotSpecified")
  packLabel.textContent = init.packLabel
  layers.replaceChildren(...init.layers.map(label => node('li', 'vp-layer', label)))
  showDiagnostics(init.warnings, init.missingPaths)
  propertyPanel.replaceChildren()
  for (const [key, values] of Object.entries(init.properties)) {
    const label = node('label', 'vp-property'), select = node('select', 'vp-select')
    select.setAttribute('aria-label', key)
    select.dataset.property = key
    for (const value of values) { const option = node('option', '', value); option.value = value; select.append(option) }
    select.value = properties[key]
    label.append(node('span', 'vp-property-name', key), select)
    propertyPanel.append(label)
    select.addEventListener('change', () => { properties[key] = select.value; requestRender() })
  }
  if (!Object.keys(init.properties).length) propertyPanel.append(node('p', 'vp-muted', init.target.kind === 'block' ? uiText("webview.vanillaPreview.thereIsNoOptionalAttributeForThis") : init.target.kind === 'entity' ? uiText("webview.vanillaPreview.independenceOfHullsOarsAndLockersUsing") : uiText("webview.vanillaPreview.readTheObjectDefinitionAndParentInheritance")))
  tall.checked = init.supportsTallBlock && init.target.kind === 'block' && (sameTarget ? retainedTall : true)
  tallLabel.hidden = !init.supportsTallBlock
  const halfSelect = propertyPanel.querySelector<HTMLSelectElement>('[data-property=half]')
  if (halfSelect) halfSelect.disabled = tall.checked
  tallLabel.title = uiText("webview.vanillaPreview.automaticallySetUpHalfAboveAndBelow")
  root.dataset.sessionId = String(init.sessionId)
  requestRender()
}

window.addEventListener('message', event => {
  const data: unknown = event.data
  if (!data || typeof data !== 'object') return
  const command = (data as { command?: unknown }).command
  if (command === 'vanillaGeneratedResult') {
    const result = data as { sessionId?: unknown; message?: unknown }
    if (result.sessionId !== latestSessionId) return
    optimizeAlphaAction.disabled = false
    generatedCompactAction.disabled = false; generatedCompactAction.textContent = uiText("webview.vanillaPreview.otherOrganiser")
    generatedAction.disabled = false; generatedAction.textContent = uiText("webview.vanillaPreview.addOriginal")
    if (typeof result.message === 'string') status.textContent = result.message
  }
  else if (command === 'vanillaBlockbenchResult') { resetExternalModel() }
  else if (command === 'previewFollow') {
    const value = (data as { following?: unknown }).following
    if (typeof value === 'boolean') { following = value; syncFollow() }
  }
  else if (command === 'vanillaLoading') initializeLoading(data as VanillaPreviewLoading)
  else if (command === 'vanillaTargets') receiveTargets(data as VanillaPreviewTargets)
  else if (command === 'vanillaNames') receiveNames(data as VanillaPreviewNames)
  else if (command === 'vanillaFlat') initializeFlat(data as VanillaFlatPreview)
  else if (command === 'vanillaTexture') { if (current?.invalidate(data as VanillaTextureUpdate)) requestRender() }
  else if (command === 'vanillaAssetResponse') current?.accept(data as VanillaAssetResponse)
  else if (command === 'vanillaError') {
    const failure = data as { sessionId?: unknown; error?: unknown }
    if (!Number.isSafeInteger(failure.sessionId) || Number(failure.sessionId) < latestSessionId || typeof failure.error !== 'string') return
    if (Number(failure.sessionId) === latestSessionId && sessionPhase === 'selecting') return
    resetRepair(Number(failure.sessionId) === latestSessionId ? repairVersion : undefined)
    latestSessionId = Number(failure.sessionId)
    sessionPhase = 'error'
    targetPending = false; targetSelect.disabled = false
    clearTimeout(renderTimer)
    revision++; completed = revision
    root.dataset.sessionId = String(latestSessionId)
    current?.close(); current = undefined; stopActive()
    showError(new Error(failure.error))
  }
  else if (command === 'vanillaInit') {
    const sessionId = (data as { sessionId?: unknown }).sessionId
    if (!Number.isSafeInteger(sessionId) || Number(sessionId) < latestSessionId || Number(sessionId) === latestSessionId && ['model', 'selecting', 'repairing', 'error'].includes(sessionPhase)) return
    if (validInit(data)) initialize(data)
    else {
      resetRepair()
      latestSessionId = Number(sessionId)
      suspendPreview('')
      sessionPhase = 'error'
      targetPending = false; targetSelect.disabled = false
      root.dataset.sessionId = String(latestSessionId)
      showError(new Error(uiText("webview.vanillaPreview.theOriginalPreviewProfileProvidedByThe")))
    }
  }
})
applyItemState.addEventListener('click', () => {
  if (!current || current.init.target.kind !== 'item' || repairPendingSession !== undefined || destroyed) return
  try {
    const next = parseItemState(itemStateInput.value)
    pendingItemState = next
    applyItemState.disabled = true
    itemStateFeedback.textContent = uiText("webview.vanillaPreview.applyingObjectStateParameters")
    itemStateFeedback.setAttribute('role', 'status')
    requestRender()
  } catch (error) {
    itemStateFeedback.textContent = asError(error).message + uiText("webview.vanillaPreview.lastValid")
    itemStateFeedback.setAttribute('role', 'alert')
  }
})
repair.addEventListener('click', () => {
  if (!repairVersion || repair.disabled || targetPending || repairPendingSession !== undefined || destroyed || !Number.isSafeInteger(latestSessionId) || latestSessionId < 1) return
  repairPendingSession = latestSessionId
  sessionPhase = 'repairing'
  repair.disabled = true
  repair.setAttribute('aria-busy', 'true')
  repair.textContent = uiText("webview.vanillaPreview.completionInProgressJavaClientResources", repairVersion)
  const message = uiText("webview.vanillaPreview.weReGettingReadyJavaClientResource", repairVersion)
  suspendPreview(message)
  targetSelect.disabled = true
  repairFeedback.textContent = message
  repairFeedback.hidden = false
  try { post({ command: 'vanillaRepairClient', sessionId: repairPendingSession }) }
  catch (error) {
    sessionPhase = 'error'
    targetPending = false; targetSelect.disabled = false
    showError(error)
  }
})
choose.addEventListener('click', () => { try { post({ command: 'vanillaChooseBase' }) } catch (error) { showError(error) } })
tall.addEventListener('change', () => {
  const halfSelect = propertyPanel.querySelector<HTMLSelectElement>('[data-property=half]')
  if (halfSelect) halfSelect.disabled = tall.checked
  requestRender()
})
reset.addEventListener('click', () => { view = { yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0 }; syncView(); requestViewRender() })
animation.addEventListener('click', () => {
  if (flat && flatModel?.animated) {
    playing = !playing; flatStamp = 0
    animation.textContent = playing ? uiText("webview.vanillaPreview.pauseDynamicTexture") : uiText("webview.vanillaPreview.playDynamicTexture")
    animation.setAttribute('aria-pressed', String(playing)); drawFlat(); return
  }
  if (!active?.animated) return
  playing = !playing
  active.setPlaying(playing)
  animation.textContent = active.motion ? (playing ? uiText("webview.vanillaPreview.pauseSceneAnimation") : uiText("webview.vanillaPreview.playSceneAnimations")) : (playing ? uiText("webview.vanillaPreview.pauseDynamicTexture") : uiText("webview.vanillaPreview.playDynamicTexture"))
  animation.setAttribute('aria-pressed', String(playing))
})
stage.addEventListener('wheel', event => {
  if (!current && !flat) return
  event.preventDefault()
  view.zoom = Math.max(0.25, Math.min(3, view.zoom * Math.exp(-event.deltaY * 0.0015)))
  syncView(); requestViewRender()
}, { passive: false })
stage.addEventListener('pointerdown', event => {
  if ((event.button !== 0 && event.button !== 1) || (!current && !flat) || event.button === 0 && flat) return
  event.preventDefault(); stage.focus({ preventScroll: true })
  const captureTarget = event.target instanceof HTMLCanvasElement ? event.target : stage
  drag = { rotation: active?.orientation(), captureTarget, id: event.pointerId, button: event.button, x: event.clientX, y: event.clientY, yaw: view.yaw, pitch: view.pitch, panX: view.panX, panY: view.panY }
  captureTarget.setPointerCapture(event.pointerId); stage.dataset.dragging = event.button === 1 ? 'pan' : 'rotate'
})
stage.addEventListener('auxclick', event => { if (event.button === 1) event.preventDefault() })
stage.addEventListener('pointermove', event => {
  if (!drag || event.pointerId !== drag.id) return
  if (drag.button === 1) { view.panX = drag.panX + event.clientX - drag.x; view.panY = drag.panY + event.clientY - drag.y }
  else {
    Object.assign(view, dragOrbit(drag, event.clientX - drag.x, event.clientY - drag.y))
  }
  syncView(); requestViewRender()
})
function finishDrag(event?: PointerEvent): void {
  if (event && event.pointerId !== drag?.id) return
  const previous = drag
  drag = undefined
  delete stage.dataset.dragging
  if (previous?.captureTarget.hasPointerCapture(previous.id)) previous.captureTarget.releasePointerCapture(previous.id)
}
for (const name of ['pointerup', 'pointercancel'] as const) stage.addEventListener(name, finishDrag)
document.addEventListener('lostpointercapture', finishDrag, true)
stage.addEventListener('keydown', event => {
  const deltas: Record<string, [number, number]> = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -25], ArrowDown: [0, 25] }
  const delta = deltas[event.key]
  if (!delta) return
  event.preventDefault()
  Object.assign(view, dragOrbit({ ...view, rotation: active?.orientation() }, delta[0], delta[1]))
  syncView(); requestViewRender()
})
const observer = new ResizeObserver(() => {
  const rect = stage.getBoundingClientRect(), size = `${Math.round(rect.width)}:${Math.round(rect.height)}:${window.devicePixelRatio}`
  if (size !== lastSize) { lastSize = size; if (root.dataset.state !== 'error') requestViewRender() }
})
observer.observe(stage)
document.addEventListener('visibilitychange', () => { if (flat) { flatStamp = 0; drawFlat() } else active?.setPlaying(playing && !document.hidden) })
window.addEventListener('pagehide', () => {
  destroyed = true
  clearTimeout(renderTimer)
  observer.disconnect()
  stopFlat()
  current?.close()
  stopActive()
})
syncView()
try { post({ command: 'vanillaReady' }) } catch (error) { showError(error) }

async function parseVersionedItem(assets: PreparedAssets, id: string, args: { version?: string; display: string; data: ItemState }): Promise<ModelReference[]> {
  if (!args.version || compareMinecraftVersion(args.version, '1.21.4') < 0) {
    const legacy = await readFile(resourcePath('models/item', id), assets)
    if (legacy) {
      const json = JSON.parse(new TextDecoder().decode(legacy))
      const selected = legacyItemOverride(json, args.data)
      if (selected) return [{ type: 'item', model: selected } as ModelReference]
      if (await readFile(resourcePath('items', id), assets)) return [{ type: 'item', model: id.includes(':') ? id.replace(':', ':item/') : 'minecraft:item/' + id } as ModelReference]
    }
  }
  return parseItemDefinition(assets, id, args as Parameters<typeof parseItemDefinition>[2])
}
function cmdItemId(init: VanillaPreviewInit): string {
  return init.target.kind === 'model' ? init.target.id.replace(':item/', ':') : init.target.id
}
async function updateCmdCases(init: VanillaPreviewInit): Promise<void> {
  try {
    const activeSession = current
    if (!activeSession) return
    const assets = await prepareAssets(activeSession.handlers, { cache: true, version: init.version, defaults: 'game' })
    const id = cmdItemId(init)
    const path = init.target.kind === 'model' && (!init.version || compareMinecraftVersion(init.version, '1.21.4') < 0) ? resourcePath('models', init.target.id) : resourcePath(init.version && compareMinecraftVersion(init.version, '1.21.4') >= 0 ? 'items' : 'models/item', id)
    const raw = await readFile(path, assets)
    if (!raw || confirmedInit !== init) return
    const cases = customModelDataCases(JSON.parse(new TextDecoder().decode(raw)))
    cmdCases.replaceChildren(new Option(uiText("webview.vanillaPreview.selectAnExistingCmdBranch"), ''), ...cases.map((entry, index) => new Option(entry.label, String(index))))
    cmdCases.hidden = !cases.length
    cmdCases.onchange = () => { const selected = cases[Number(cmdCases.value)]; if (cmdCases.value && selected) { itemStateInput.value = JSON.stringify({ ...appliedItemState, ...selected.state }, null, 2); applyItemState.click() } }
  } catch { cmdCases.hidden = true }
}
cmdApply.addEventListener('click', () => {
  try {
    if (!confirmedInit?.version) throw new Error(uiText("webview.vanillaPreview.pleaseSpecifyAPreviewOfTheMinecraft"))
    const value = Number(cmdInput.value)
    if (!cmdInput.value.trim()) throw new Error(uiText("webview.vanillaPreview.pleaseEnterTheCmdValue"))
    itemStateInput.value = JSON.stringify({ ...parseItemState(itemStateInput.value), ...customModelDataState(value, confirmedInit.version) }, null, 2)
    applyItemState.click()
  } catch (error) { itemStateFeedback.textContent = asError(error).message; itemStateFeedback.setAttribute('role', 'alert') }
})
cmdCopy.addEventListener('click', () => {
  void (async () => {
    if (!confirmedInit?.version) throw new Error(uiText("webview.vanillaPreview.pleaseSpecifyAPreviewOfTheMinecraft"))
    if (!cmdInput.value.trim()) throw new Error(uiText("webview.vanillaPreview.pleaseEnterTheCmdValue"))
    await navigator.clipboard.writeText(customModelDataCommand(cmdItemId(confirmedInit), Number(cmdInput.value), confirmedInit.version))
    itemStateFeedback.textContent = uiText("webview.vanillaPreview.copyedCorrespondingVersionOfTheGiveTest")
  })().catch(error => { itemStateFeedback.textContent = asError(error).message })
})
cmdCreate.addEventListener('click', () => post({ command: 'vanillaCreateCmd' }))

function restoreItemState(init: VanillaPreviewInit): ItemState {
  try {
    const saved = api?.getState?.() as { itemPreview?: { id?: string; kind?: string; state?: unknown } } | undefined
    if (saved?.itemPreview?.id !== init.target.id || saved.itemPreview.kind !== init.target.kind) return {}
    return parseItemState(JSON.stringify(saved.itemPreview.state))
  } catch { return {} }
}
function saveItemState(): void {
  if (!confirmedInit) return
  const saved = api?.getState?.()
  api?.setState?.({ ...(saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}), itemPreview: { id: confirmedInit.target.id, kind: confirmedInit.target.kind, state: appliedItemState } })
}
