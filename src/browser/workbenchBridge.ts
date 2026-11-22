import { uiText } from '../i18n/messages'
import { filterMcrhEditorData } from '../core/advanced/editorDataExportPolicy'
import { BrowserModTexturesBridge } from './modTexturesBridge'
import { generateTintPreset } from '../core/advanced/tintPresets'
import { withPackRequirements } from '../core/advanced/packRequirements'
import { zip } from 'fflate'
import { BrowserPackToolsBridge } from './packToolsBridge'
import { z } from 'zod'
import { decodeColormapPng, getColormapCoordinate, sampleColormap, tintColorToHex, generateColormapFiles, exportBiomeTintDatapack, exportUntintedModel, removeModelTintIndices, type BiomeTintOverrides, type ColormapKind } from '../core/advanced/colormap'
import { generateCtmTextures, generateNaturalTextures, generateRandomEntityTextures, expandTextureTiles, type CtmMethod, type NaturalTransform } from '../core/advanced/textures'
import { generateOldPbrFiles, generatePbrFiles } from '../core/advanced/pbr'
import { generatePbrgenFiles } from '../core/advanced/pbrgenCompat'
import { generateTotemFiles, fetchMojangSkin, type TotemModel, type TotemPose } from '../core/advanced/totem'
import { compileShaderGraph, type ShaderGraphBlock } from '../core/advanced/shaderGraph'
import { compileMaterialGraph } from '../core/advanced/materialGraph'
import { resolveModelInheritance } from '../core/advanced/modelInheritance'
import { listVersionCapabilities, getVersionCapabilities, createPackMcmeta } from '../core/advanced/versionCapabilities'
import { deserializeSceneWorkbenchProject, serializeSceneWorkbenchProject } from '../core/sceneWorkbench'
import steve from '../core/data/totem/steve.json'
import alex from '../core/data/totem/alex.json'
import { decodePng, encodePng, download, errorText, fileName, imageUrl, pickFiles, readFile, textDecoder, textEncoder, yieldToBrowser, type BrowserFile } from './files'
import type { ProjectPort, BrowserBridgeOptions } from './projectPort'

const STUDIO_MAX_PIXELS = 1024 * 1024
const studioMaterialId = z.string().min(1).max(256).regex(/^[a-z0-9_.-]+:[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*$/).refine(value => value.split(/[:/]/).every(part => part !== '.' && part !== '..'))
const studioTextureTarget = z.object({ materialId: studioMaterialId.optional(), createMaterial: z.boolean().optional() })
const studioTextureRequest = studioTextureTarget.extend({ command: z.literal('studioTexture'), role: z.enum(['albedo', 'normal', 'specular']) }).strict().refine(request => request.role === 'albedo' || request.createMaterial === undefined)
const studioAlbedo = z.strictObject({
  width: z.number().int().min(1).max(2048),
  height: z.number().int().min(1).max(2048),
  data: z.custom<number[]>(Array.isArray)
}).refine(image => {
  if(image.width * image.height > STUDIO_MAX_PIXELS || image.data.length !== image.width * image.height * 4) return false
  for(const value of image.data) if(!Number.isInteger(value) || value < 0 || value > 255) return false
  return true
})
const studioPbrRequest = z.strictObject({
  command: z.literal('studioGeneratePbr'), profile: z.enum(['labPBR', 'oldPBR', 'pbrgen-mer']).default('labPBR'),
  strength: z.number().finite().min(0).max(16).default(1), roughness: z.number().finite().min(0).max(1).default(0.6),
  metallic: z.number().finite().min(0).max(1).default(0), emission: z.number().finite().min(0).max(1).default(0),
  materialId: studioMaterialId.optional(), albedo: studioAlbedo.optional()
})
type StudioTextureTarget = z.infer<typeof studioTextureTarget>

const rolePaths: Record<string, string> = { colormap: 'assets/minecraft/textures/colormap/grass.png', pbr: 'assets/minecraft/textures/block/selected.png', skin: 'assets/minecraft/textures/entity/selected_skin.png', model: 'assets/minecraft/models/block/selected.json', biome: 'selected-biome.json', albedo: 'assets/minecraft/textures/block/studio_albedo.png', normal: 'assets/minecraft/textures/block/studio_normal.png', specular: 'assets/minecraft/textures/block/studio_specular.png' }
const studioSourceKey = (role: string, materialId: string) => 'studio:' + materialId + ':' + role
const studioTexturePath = (role: string, materialId: string) => 'assets/mcrh/textures/materials/' + materialId.replace(':', '/') + '/albedo' + (role === 'normal' ? '_n' : role === 'specular' ? '_s' : '') + '.png'
const text = (params: Record<string, unknown>, key: string, fallback = ''): string => { const value = params[key] ?? fallback; if (typeof value !== 'string' || value.length > 4096) throw new Error(uiText("browser.workbenchBridge.parametersInvalid", key)); return value }
const number = (params: Record<string, unknown>, key: string, fallback: number): number => { const value = params[key] ?? fallback; if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(uiText("browser.workbenchBridge.parametersInvalid", key)); return value }
const post = (message: object): void => { window.postMessage(message, location.origin) }
const zipFiles = (files: readonly BrowserFile[], signal?: AbortSignal): Promise<Uint8Array> => new Promise((resolve, reject) => {
  const entries: Record<string, Uint8Array> = Object.create(null)
  for (const file of files) { if (entries[file.path]) throw new Error(uiText("browser.workbenchBridge.exportHasADuplicatePath")); entries[file.path] = typeof file.content === 'string' ? textEncoder.encode(file.content) : file.content }
  const cancel = zip(entries, { level: 6 }, (error, result) => { signal?.removeEventListener('abort', abort); if (error) reject(error); else if (signal?.aborted) reject(new Error(uiText("browser.workbenchBridge.exportCancelled"))); else resolve(result) })
  const abort = () => { cancel(); reject(new Error(uiText("browser.workbenchBridge.exportCancelled"))) }
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
})

export class BrowserWorkbenchBridge {
  private readonly modTextures: BrowserModTexturesBridge
  private readonly packTools: BrowserPackToolsBridge
  private readonly sources = new Map<string, string[]>()
  private controller?: AbortController
  private sessionId = 0
  private assetBytes = 0
  private busy = false
  private replacingProject = false
  constructor(private readonly project: ProjectPort, private readonly options: BrowserBridgeOptions) { this.packTools = new BrowserPackToolsBridge(project, () => !this.busy && !this.replacingProject && !this.modTextures?.busy); this.modTextures = new BrowserModTexturesBridge(project, () => !this.busy && !this.replacingProject && !this.packTools.busy, options.changed) }
  assertCanReplaceProject(): void { if (this.busy || this.packTools.busy || this.modTextures.busy || this.replacingProject) throw new Error(uiText("browser.workbenchBridge.workbenchIsGeneratingExportingOrReplacingItems")) }
  beginProjectReplacement(): () => void { this.assertCanReplaceProject(); this.replacingProject = true; return () => { this.replacingProject = false } }
  private assertCurrent(revision: number): void { this.controller?.signal.throwIfAborted(); if (revision !== this.project.revision) throw new Error(uiText("browser.workbenchBridge.projectHasChangedOldOperationResultsAre")) }
  projectReplaced(): void {
    this.sources.clear(); this.sessionId++; this.assetBytes = 0
    for (const label of document.querySelectorAll<HTMLElement>('[data-source]')) label.textContent = uiText("browser.workbenchBridge.itemReplacedPleaseReSelect")
    for (const image of document.querySelectorAll<HTMLImageElement>('#pbr-preview, #skin-preview')) { image.hidden = true; image.removeAttribute('src') }
    const map = document.querySelector<HTMLCanvasElement>('#colormap-preview'); map?.getContext('2d')?.clearRect(0, 0, map.width, map.height)
    post({ type: 'studioReset' })
    post({ type: 'studioResources', sessionId: this.sessionId, layers: [uiText("browser.workbenchBridge.browserItemReplaced")], blocks: [], version: this.project.info().version })
    post({ type: 'studioError', error: uiText("browser.workbenchBridge.projectResourcesHaveBeenReplacedPleaseRead") })
  }
  initialize(): void {
    post({ type: 'versions', selected: this.project.info().version, entries: listVersionCapabilities().map(version => ({ ...version, status: uiText("browser.workbenchBridge.verified"), summary: version.summary })) })
    post({ type: 'catalog', entries: [] })
    this.adaptUi()
  }
  setVersions(entries: readonly { id: string; type: string }[]): void {
    post({ type: 'versions', entries: entries.map(entry => ({ id: entry.id, status: entry.type === 'release' ? uiText("browser.workbenchBridge.release") : uiText("browser.workbenchBridge.quickshot"), summary: getVersionCapabilities(entry.id)?.summary ?? uiText("browser.workbenchBridge.mojangRunTimeVersionPackageFormatRead") })) })
  }
  private adaptUi(): void {
    const optimizer = document.querySelector('#page-optimizer')!
    optimizer.querySelector('[data-pick=optimizer]')?.closest('.source')?.remove()
    const engine = optimizer.querySelector<HTMLSelectElement>('[name=engine]')!
    engine.replaceChildren(new Option(uiText("browser.workbenchBridge.noDamageToBrowserZip"), 'portable'))
    optimizer.querySelector('.notice')!.textContent = uiText("browser.workbenchBridge.allExecuteTheUseOfBuiltIn")
    document.querySelector('[data-tab=optimizer] span')!.textContent = uiText("browser.workbenchBridge.localZipNoApplication")
    document.querySelector('[data-pick=samples]')!.textContent = uiText("browser.workbenchBridge.importLocalResourcesZipJar")
    document.querySelector('#page-samples .notice')!.textContent = uiText("browser.workbenchBridge.selectTheImportOfLocalZipJar")
    document.querySelector('#sample-list')!.textContent = uiText("browser.workbenchBridge.pleaseSelectALocalExampleZipJar")
    document.querySelector('[data-pick=pbrFolder]')!.textContent = uiText("browser.workbenchBridge.useTheCurrentItemVolumePbr")
    document.querySelector('[data-edit-skin]')!.textContent = uiText("browser.workbenchBridge.editSelectedSkinPixels")
  }
  async handle(raw: unknown): Promise<void> {
    if (await this.modTextures.handle(raw)) return
    if (await this.packTools.handle(raw)) return
    if (!raw || typeof raw !== 'object') return
    const message = raw as Record<string, unknown>, command = String(message.command ?? '')
    if (command === 'cancel') { this.controller?.abort(); return }
    if (command === 'ready') { this.initialize(); return }
    if (command === 'copyShaderCode') {
      try { if (typeof message.text !== 'string' || message.text.length > 256 * 1024 || !message.text.trim()) throw new Error(uiText("browser.workbenchBridge.sourceCodeIsEmptyOrBeyondLimit")); await navigator.clipboard.writeText(message.text); post({ type: 'shaderCodeCopied', requestId: message.requestId, ok: true }) }
      catch (error) { post({ type: 'shaderCodeCopied', requestId: message.requestId, ok: false, error: uiText("browser.workbenchBridge.browserClipboardNotAvailableHttpsOrLocalhost", errorText(error)) }) }
      return
    }
    if (command === 'studioAsset') { this.asset(message); return }
    if (this.replacingProject) { this.options.notify(uiText("browser.workbenchBridge.itemIsBeingReplacedOperationNotImplemented"), true); return }
    if (command === 'sampleColor') {
      const path = this.sources.get('colormap')?.[0], bytes = path ? this.project.read(path) : undefined
      if (bytes) { const image = decodeColormapPng(bytes), climate = { temperature: number(message, 'temperature', 0.5), downfall: number(message, 'downfall', 0.5) }; post({ type: 'sampleColor', ...getColormapCoordinate(climate), color: tintColorToHex(sampleColormap(image, climate)) }) }
      return
    }
    if (this.busy || this.packTools.busy || this.modTextures.busy) { this.options.notify(uiText("browser.workbenchBridge.theCurrentOperationIsNotCompletedPlease")); return }
    const revision = this.project.revision
    this.busy = true; this.controller = new AbortController()
    post({ type: 'status', busy: true, text: uiText("browser.workbenchBridge.browserLocalProcessing") })
    try {
      const params = message.params && typeof message.params === 'object' ? message.params as Record<string, unknown> : {}
      if (command === 'exportPackZip') await this.exportProject(false, revision)
      else if (command === 'pick') { const target = studioTextureTarget.parse(message); if (message.role !== 'albedo' && target.createMaterial !== undefined) throw new Error(uiText("browser.workbenchBridge.onlyBaseColourSelectionSupports")); await this.pick(String(message.role), revision, target) }
      else if (command === 'generate') await this.generate(String(message.kind), params, revision)
      else if (command === 'shaderPreview') { const compiled = this.shader(params); post({ type: 'shaderCode', requestId: message.requestId, sources: compiled.files.filter(file => /\.(glsl|vsh|fsh)$/.test(file.path)).map(file => ({ id: file.path, label: fileName(file.path), content: file.content })), warnings: compiled.warnings }) }
      else if (command === 'editSkin') { const path = this.sources.get('skin')?.[0]; if (!path) throw new Error(uiText("browser.workbenchBridge.pleaseChooseSkinFirstPng")); this.options.edit(path) }
      else if (command.startsWith('studio')) await this.studio(command, message, revision)
      else throw new Error(uiText("browser.workbenchBridge.browserDoesNotSupportThisRequestUse"))
    } catch (error) {
      const detail = this.controller.signal.aborted ? uiText("browser.workbenchBridge.operationCanceledNoResultSubmitted") : errorText(error)
      post({ type: command.startsWith('studio') ? 'studioError' : 'result', error: detail, text: uiText("browser.workbenchBridge.notCompleted", detail) }); this.options.notify(detail, true)
    } finally { this.busy = false; this.controller = undefined; post({ type: 'status', busy: false, text: uiText("browser.workbenchBridge.readySaveAllResourcesInTheCurrent") }) }
  }
  private source(role: string): Uint8Array {
    const path = this.sources.get(role)?.[0], bytes = path ? this.project.read(path) : undefined
    if (!bytes) throw new Error(uiText("browser.workbenchBridge.pleaseChooseFirstLocalFileOrSelect", role))
    return bytes
  }
  async useResource(role: string, path: string, target: StudioTextureTarget = {}, displayName = path): Promise<void> {
    const bytes = this.project.read(path)
    if (!bytes) throw new Error(uiText("browser.workbenchBridge.engineeringResourcesDoNotExist"))
    if (path.endsWith('.png')) decodePng(bytes, ['albedo', 'normal', 'specular'].includes(role) ? STUDIO_MAX_PIXELS : undefined)
    if (role === 'colormap') decodeColormapPng(bytes)
    this.sources.set(role, [path])
    if (target.materialId) this.sources.set(studioSourceKey(role, target.materialId), [path])
    if (['albedo', 'normal', 'specular'].includes(role)) this.sendTexture(role, bytes, displayName, target)
    else post({ type: 'source', role, name: path, image: path.endsWith('.png') ? imageUrl(bytes) : undefined })
  }
  private async pick(role: string, revision: number, target: StudioTextureTarget = {}): Promise<void> {
    if (role === 'pbrFolder') { this.sources.set(role, ['project']); post({ type: 'source', role, name: this.project.info().name + ' · ' + this.project.paths().length + uiText("browser.workbenchBridge.resources") }); return }
    if (role === 'samples') { const files = await pickFiles('.zip,.jar'); if (!files[0] || !this.options.confirmReplace()) return; const bytes = await readFile(files[0], 384 * 1024 * 1024); this.assertCurrent(revision); await this.project.importArchive(bytes, files[0].name, false, undefined, this.controller?.signal); this.options.replaced(); post({ type: 'source', role, name: files[0].name }); post({ type: 'result', text: uiText("browser.workbenchBridge.localExamplesImportedJarIsNotExecuted") }); return }
    if (role === 'optimizer') throw new Error(uiText("browser.workbenchBridge.browserCannotRunAnExecutablePleaseUse"))
    const json = ['model', 'biome'].includes(role), many = ['tiles', 'randomBase'].includes(role), files = await pickFiles(json ? '.json' : '.png', many)
    if (!files.length) return
    if (files.length > 256) throw new Error(uiText("browser.workbenchBridge.moreThanFilesSelected"))
    const staged: BrowserFile[] = []; let size = 0
    for (const [index, file] of files.entries()) {
      const bytes = await readFile(file); size += bytes.length; if (size > 128 * 1024 * 1024) throw new Error(uiText("browser.workbenchBridge.theTotalNumberOfSelectedFilesExceeds"))
      if (json) { const value = JSON.parse(textDecoder.decode(bytes)); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(uiText("browser.workbenchBridge.jsonMustBeAnObject")) }
      else decodePng(bytes, ['albedo', 'normal', 'specular'].includes(role) ? STUDIO_MAX_PIXELS : undefined)
      const suggested = role === 'pbr' ? document.querySelector<HTMLInputElement>('form[data-kind=pbr] [name=texturePath]')?.value : role === 'model' ? document.querySelector<HTMLInputElement>('form[data-kind=untint] [name=modelPath]')?.value : undefined
      const path = suggested || rolePaths[role] || 'assets/minecraft/textures/mcrh_inputs/' + role + '/' + index + '.png'
      staged.push({ path, content: bytes })
    }
    this.controller?.signal.throwIfAborted()
    await this.project.apply(staged, revision)
    this.sources.set(role, staged.map(file => file.path)); this.options.changed()
    await this.useResource(role, staged[0].path, target)
    if (many) this.sources.set(role, staged.map(file => file.path))
  }
  private shader(params: Record<string, unknown>) { return compileShaderGraph({ targetVersion: text(params, 'targetVersion'), blocks: params.blocks as ShaderGraphBlock[] }) }
  private async generate(kind: string, params: Record<string, unknown>, revision: number): Promise<void> {
    const target = text(params, 'targetVersion', this.project.info().version ?? ''), warnings: string[] = []
    let files: BrowserFile[] = []
    if (kind === 'optimize' || kind === 'portablezip') { await this.exportProject(true, revision); return }
    if (kind === 'sample') { await this.pick('samples', revision); return }
    if (kind === 'tintPreset') files = generateTintPreset({ ...params, targetVersion: target })
    else if (kind === 'colormap') {
      const mode = text(params, 'mode', 'triangle'), mapKind = text(params, 'map', 'grass') as ColormapKind
      const options = mode === 'selected' ? decodeColormapPng(this.source('colormap')) : mode === 'flat' ? { color: text(params, 'flat', '#80a755') } : { cold: text(params, 'cold'), dry: text(params, 'dry'), wet: text(params, 'wet') }
      files = generateColormapFiles(mapKind, options)
    } else if (kind === 'biome') {
      const overrides: BiomeTintOverrides = {}
      for (const [key, field] of [['foliage', 'foliage_color'], ['grass', 'grass_color'], ['dryFoliage', 'dry_foliage_color']] as const) { const value = text(params, key).trim(); if (value) overrides[field] = value }
      const modifier = text(params, 'modifier', 'keep'); if (modifier !== 'keep') overrides.grass_color_modifier = modifier as 'none' | 'dark_forest' | 'swamp'
      files = exportBiomeTintDatapack(text(params, 'biomeId'), textDecoder.decode(this.source('biome')), overrides)
      files.push({ path: 'pack.mcmeta', content: JSON.stringify(createPackMcmeta(target, 'data', uiText("browser.workbenchBridge.mcrhGroupSystemDataPackage"))) })
      warnings.push(uiText("browser.workbenchBridge.theGroupSystemIsRegisteredAsA"))
    } else if (kind === 'untint') {
      const path = text(params, 'modelPath'), match = /^assets\/([a-z0-9_.-]+)\/models\/(.+)\.json$/.exec(path)
      if (!match) throw new Error(uiText("browser.workbenchBridge.modelPathMustBeLocatedAtAsets"))
      let model = textDecoder.decode(this.source('model'))
      if (JSON.parse(model).parent) { const result = await resolveModelInheritance(model, async id => { const [namespace, name] = id.split(':'); const bytes = this.project.read('assets/' + namespace + '/models/' + name + '.json'); if (!bytes) throw new Error(uiText("browser.workbenchBridge.missingParentModelPleaseImportOriginalVersions", id)); return textDecoder.decode(bytes) }); model = JSON.stringify(result.model); warnings.push(uiText("browser.workbenchBridge.expanddParentModelInheritance")) }
      const result = removeModelTintIndices(model); if (!result.removed) throw new Error(uiText("browser.workbenchBridge.modelDoesNotHaveRemoveableTintindex"))
      files = exportUntintedModel(match[1] + ':' + match[2], model)
    } else if (kind === 'ctm') {
      const images = (this.sources.get('tiles') ?? []).map((path, index) => ({ name: index + '.png', content: this.project.read(path)! })), method = text(params, 'method') as CtmMethod
      const tiles = text(params, 'tiles').trim() || (images.length ? '0-' + (images.length - 1) : '')
      if (!tiles) throw new Error(uiText("browser.workbenchBridge.selectPngOrProvideTilesRules"))
      if (!images.length) warnings.push(uiText("browser.workbenchBridge.generateAttributeRulesOnlyNeedToComplete"))
      if (images.length && expandTextureTiles(tiles).some(tile => !images.some(image => image.name === tile + '.png'))) throw new Error(uiText("browser.workbenchBridge.tilesDoesNotMatchTheNumberOf"))
      files = generateCtmTextures({ namespace: 'minecraft', name: text(params, 'name'), matchBlocks: text(params, 'matchBlocks'), method, tiles, images, weights: method === 'random' ? text(params, 'weights').trim() || undefined : undefined, symmetry: method === 'random' ? text(params, 'symmetry', 'none') as 'none' | 'opposite' | 'all' : undefined })
      warnings.push(uiText("browser.workbenchBridge.ctmRequiresOptifineOrCompatibleModulesNot"))
    } else if (kind === 'natural') {
      files = generateNaturalTextures({ namespace: 'minecraft', texture: text(params, 'texture'), transform: text(params, 'transform') as NaturalTransform })
      const file = files[0], previous = this.project.read(file.path)
      if (previous) { const key = String(file.content).split('\n').find(line => line.includes('='))?.split('=')[0]; const remaining = textDecoder.decode(previous).split(/\r?\n/).filter(line => line.split('=')[0].trim() !== key).join('\n').replace(/\n+$/, ''); file.content = remaining + '\n' + file.content }
      warnings.push(uiText("browser.workbenchBridge.naturalTextureRequiresOptifineOrCompatibleModule"))
    }
    else if (kind === 'randomEntity') {
      const skins = text(params, 'skins').trim().split(/\s+/).map(Number), sources = this.sources.get('randomBase') ?? []
      if (sources.length && sources.length !== skins.length) throw new Error(uiText("browser.workbenchBridge.pngVariantsMustMatchTheSkinsNumber"))
      files = generateRandomEntityTextures({ namespace: 'minecraft', texture: 'entity/' + text(params, 'entity').replace(/^entity\//, ''), skins, weights: text(params, 'weights').trim() || undefined, biomes: text(params, 'biomes').trim() || undefined, variants: sources.map((path, index) => ({ index: skins[index], content: this.project.read(path)! })) }); warnings.push(uiText("browser.workbenchBridge.randomEntityNeedsOptifineOrCompatibleModule"))
    } else if (kind === 'pbr') {
      const profile = text(params, 'profile', 'labpbr'), generate = (path: string, bytes: Uint8Array) => profile === 'pbrgen' ? generatePbrgenFiles({ texturePath: path, albedoPng: bytes }) : (profile === 'oldpbr' ? generateOldPbrFiles : generatePbrFiles)({ texturePath: path, albedoPng: bytes, normalStrength: number(params, 'strength', 1), roughness: number(params, 'roughness', 0.6), metalness: number(params, 'metalness', 0), porosity: number(params, 'porosity', 0), emission: number(params, 'emission', 0) })
      const paths = text(params, 'scope', 'single') === 'pack' ? this.project.paths().filter(path => /^assets\/[a-z0-9_.-]+\/textures\/.+\.png$/.test(path) && !/_[nse]\.png$/.test(path)) : [text(params, 'texturePath')]
      if (!paths.length || paths.length > 4096) throw new Error(uiText("browser.workbenchBridge.thereIsNoBasisForAProject"))
      let outputBytes = 0
      for (const [index, path] of paths.entries()) {
        this.controller?.signal.throwIfAborted()
        const bytes = text(params, 'scope', 'single') === 'pack' ? this.project.read(path)! : this.source('pbr'); decodePng(bytes)
        const result = generate(path, bytes); files.push(...result.files); warnings.push(...result.warnings)
        const animation = this.project.read(path + '.mcmeta'); if (animation) for (const file of result.files) files.push({ path: file.path + '.mcmeta', content: animation })
        outputBytes += result.files.reduce((size, file) => size + (typeof file.content === 'string' ? textEncoder.encode(file.content).length : file.content.length), 0)
        if (outputBytes > 128 * 1024 * 1024) throw new Error(uiText("browser.workbenchBridge.pbrOutputExceedingMibBatchProcessing"))
        post({ type: 'status', busy: true, text: uiText("browser.workbenchBridge.generatePbr", (index + 1), paths.length) }); await yieldToBrowser()
      }
    } else if (kind === 'totem') {
      const model = text(params, 'model') as TotemModel, pose = text(params, 'pose') as TotemPose, player = text(params, 'player').trim()
      let skin = this.source.bind(this, 'skin')
      if (player) { let fetched; try { fetched = await fetchMojangSkin(player, { signal: this.controller?.signal }) } catch { throw new Error(uiText("browser.workbenchBridge.browserSDirectConnectionToMojangSkin")) }; const skinBytes = fetched.skinPng; skin = () => skinBytes; warnings.push(uiText("browser.workbenchBridge.playerSkinRequestsDirectAccessFromBrowser")) }
      const result = generateTotemFiles({ skinPng: skin(), model, pose, templateModel: model === 'alex' ? alex : steve, namespace: 'minecraft' }); files = result.files; warnings.push(...result.warnings)
      const license = await fetch('./licenses/totem-LICENSE.md'); if (!license.ok) throw new Error(uiText("browser.workbenchBridge.tottenPermissionFileMissingExportDenied")); files.push({ path: 'MCRH-TOTEM-LICENSE.md', content: await license.text() })
      if (getVersionCapabilities(target)?.features.itemDefinitions) files.push({ path: 'assets/minecraft/items/totem_of_undying.json', content: JSON.stringify({ model: { type: 'minecraft:model', model: result.modelPath.replace(/^assets\/([^/]+)\/models\/(.+)\.json$/, '$1:$2') } }) })
    } else if (kind === 'shader') { const result = this.shader(params); files = result.files; warnings.push(...result.warnings) }
    else throw new Error(uiText("browser.workbenchBridge.thisFunctionCannotBePerformedInBrowser"))
    this.controller?.signal.throwIfAborted()
    if (kind === 'biome' && this.options.beforeExport) files = [...await this.options.beforeExport(files, { kind, targetVersion: target, projectName: this.project.info().name })]
    this.assertCurrent(revision)
    if (kind === 'biome') { const bytes = await zipFiles(filterMcrhEditorData(files, { includeMcrhEditorData: document.querySelector<HTMLInputElement>('#export-include-mcrh')?.checked ?? false }).files, this.controller?.signal); this.assertCurrent(revision); download(bytes, 'mcrh-biome-datapack.zip', 'application/zip') }
    else { await this.project.apply(files, revision); this.options.changed() }
    post({ type: 'result', text: uiText("browser.workbenchBridge.generatedInBrowserFile", files.length, (kind === 'biome' ? uiText("browser.workbenchBridge.andDownloadASeparatePackage") : uiText("browser.workbenchBridge.clickOnTheExportZipSave")), files.map(file => file.path).join('\n'), [...new Set(warnings)].join('\n')) })
  }
  private async exportProject(optimize = false, revision = this.project.revision): Promise<void> {
    if (!this.project.paths().length) throw new Error(uiText("browser.workbenchBridge.itemIsEmptyPleaseImportZipOr"))
    let files: readonly BrowserFile[] = this.project.exportFiles()
    if (optimize) post({ type: 'log', text: uiText("browser.workbenchBridge.browserBuiltInZipCompressionAllOriginal") })
    if (this.options.beforeExport) files = await this.options.beforeExport(files, { kind: optimize ? 'portablezip' : 'project', targetVersion: this.project.info().version ?? '', projectName: this.project.info().name })
    this.assertCurrent(revision)
    const required = withPackRequirements(files, this.project.paths()); files = required.files
    const bytes = await zipFiles(filterMcrhEditorData(files, { includeMcrhEditorData: document.querySelector<HTMLInputElement>('#export-include-mcrh')?.checked ?? false }).files, this.controller?.signal)
    this.assertCurrent(revision)
    download(bytes, this.project.info().name.replace(/\.(zip|jar)$/i, '') + (optimize ? '-optimized' : '') + '.zip', 'application/zip')
    this.project.markExported(revision); this.options.changed()
    this.options.notify(uiText("browser.workbenchBridge.zipGeneratedAndSentToBrowserFor", bytes.length))
    post({ type: 'result', text: uiText("browser.workbenchBridge.zipExportedOriginalItemWithAllPng", (required.warnings.length ? '\n' + required.warnings.join('\n') : '')) })
  }
  private sendTexture(role: string, bytes: Uint8Array, name: string, target: StudioTextureTarget = {}): void { const image = decodePng(bytes, STUDIO_MAX_PIXELS); post({ type: 'studioTexture', role, name, width: image.width, height: image.height, data: Array.from(image.data), ...target }) }
  private async studio(command: string, message: Record<string, unknown>, revision: number): Promise<void> {
    if (command === 'studioResources') {
      const blocks = this.project.paths().filter(path => /^assets\/[^/]+\/blockstates\/.+\.json$/.test(path)).map(path => path.replace(/^assets\/([^/]+)\/blockstates\/(.+)\.json$/, '$1:$2'))
      if (!blocks.length) throw new Error(uiText("browser.workbenchBridge.noBlockstatesPleaseImportOriginalClientJar"))
      this.sessionId++; this.assetBytes = 0; post({ type: 'studioResources', sessionId: this.sessionId, layers: [uiText("browser.workbenchBridge.browserItems")], blocks, version: this.project.info().version })
    } else if (command === 'studioTexture') {
      const request = studioTextureRequest.parse(message), files = await pickFiles('.png')
      if (!files[0]) return
      const bytes = await readFile(files[0]); decodePng(bytes, STUDIO_MAX_PIXELS)
      const path = request.materialId ? studioTexturePath(request.role, request.materialId) : rolePaths[request.role]
      await this.project.apply([{ path, content: bytes }], revision)
      await this.useResource(request.role, path, studioTextureTarget.parse(request), files[0].name); this.options.changed()
    }
    else if (command === 'studioGeneratePbr') {
      const request = studioPbrRequest.parse(message)
      const sourcePath = request.materialId ? this.sources.get(studioSourceKey('albedo', request.materialId))?.[0] : this.sources.get('albedo')?.[0]
      const sourceBytes = sourcePath ? this.project.read(sourcePath) : undefined
      const bytes = request.albedo ? encodePng(request.albedo.width, request.albedo.height, Uint8Array.from(request.albedo.data)) : sourceBytes
      if (!bytes) throw new Error(uiText("browser.workbenchBridge.pleaseSelectTheBaseFigureForThis"))
      decodePng(bytes, STUDIO_MAX_PIXELS)
      const options = { texturePath: sourcePath ?? (request.materialId ? studioTexturePath('albedo', request.materialId) : rolePaths.albedo), albedoPng: bytes }
      const result = request.profile === 'pbrgen-mer' ? generatePbrgenFiles(options) : (request.profile === 'oldPBR' ? generateOldPbrFiles : generatePbrFiles)({ ...options, normalStrength: request.strength, roughness: request.roughness, metalness: request.metallic, emission: request.emission })
      await this.project.apply(result.files, revision); this.options.changed()
      for (const file of result.files) if (file.path.endsWith('_n.png') || file.path.endsWith('_s.png')) { const role = file.path.endsWith('_n.png') ? 'normal' : 'specular'; await this.useResource(role, file.path, { ...(request.materialId === undefined ? {} : { materialId: request.materialId }), createMaterial: false }) }
      post({ type: 'studioPbrGenerated', profile: request.profile, ...(request.materialId === undefined ? {} : { materialId: request.materialId }) })
    } else if (command === 'studioSave') {
      const saveId = z.uuid().optional().parse(message.saveId)
      const project = deserializeSceneWorkbenchProject(String(message.project)); if (project.materialGraph) compileMaterialGraph(project.materialGraph)
      const name = 'material-scene.mcrh.json', content = serializeSceneWorkbenchProject(project)
      await this.project.apply([{ path: name, content }], revision)
      this.options.changed(); download(content, name, 'application/json')
      post({ type: 'studioSaved', name, ...(saveId === undefined ? {} : { saveId }) })
    } else if (command === 'studioLoad') { const files = await pickFiles('.json'); if (!files[0]) return; const project = deserializeSceneWorkbenchProject(textDecoder.decode(await readFile(files[0], 4 * 1024 * 1024))); if (project.materialGraph) compileMaterialGraph(project.materialGraph); this.assertCurrent(revision); post({ type: 'studioProject', project: serializeSceneWorkbenchProject(project), name: files[0].name }) }
    else throw new Error(uiText("browser.workbenchBridge.theSceneOperationIsInvalid"))
  }
  private asset(message: Record<string, unknown>): void {
    const response: Record<string, unknown> = { type: 'studioAsset', sessionId: message.sessionId, requestId: message.requestId }
    try {
      if (message.sessionId !== this.sessionId || message.layer !== 0) throw new Error(uiText("browser.workbenchBridge.projectResourceSessionIsInvalidPleaseRead"))
      const path = String(message.path)
      if (message.operation === 'list') { const prefix = path.replace(/\/$/, '') + '/'; response.entries = [...new Set(this.project.paths().filter(file => file.startsWith(prefix)).map(file => file.slice(prefix.length).split('/')[0]))] }
      else if (message.operation === 'read') { const bytes = this.project.read(path); if (bytes) { this.assetBytes += bytes.length; if (this.assetBytes > 256 * 1024 * 1024) throw new Error(uiText("browser.workbenchBridge.sceneTransferExceedingMib")); response.data = Array.from(bytes) } else response.missing = true }
      else throw new Error(uiText("browser.workbenchBridge.resourceReadOperationInvalid"))
    } catch (error) { response.error = errorText(error) }
    post(response)
  }
}
