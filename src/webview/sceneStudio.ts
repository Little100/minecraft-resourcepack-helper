import { uiHtml, uiText } from '../i18n/messages'
import * as THREE from 'three'
import { addBlock, canRedo, canUndo, commitScene, copyBlock, createPreviewScene, createSceneHistory, createSceneWorkbenchProject, deleteBlock, deserializeSceneWorkbenchProject, moveBlock, redo, selectBlocks, serializeSceneWorkbenchProject, undo, updateBlockProperties, type JsonObject, type PreviewScene, type ScenePosition, type SceneAppearance } from '../core/sceneWorkbench'
import { createMaterialPreviewData, materialPreviewToRgbaTextures, summarizeMaterialPreview, type PbrPreviewImageData, type PbrPreviewProfile } from '../core/advanced/pbrPreview'
import { compileMaterialGraph, MaterialGraphValidationError, type MaterialGraph } from '../core/advanced/materialGraph'
import { createMaterialGraphEditor, type MaterialGraphEditor } from './materialGraphEditor'
import { createSceneWorkbench, type SceneWorkbenchApi, type SceneWorkbenchScene, type SceneWorkbenchTextures, type SceneWorkbenchBlock } from './sceneWorkbench'
import { SceneStudioAssets } from './sceneStudioAssets'
import { createShaderSourceViewer } from './shaderSourceViewer'
import { PBR_SCENE_PRESETS } from '../core/advanced/pbrScenePresets'
import { MATERIAL_GRAPH_PRESETS } from '../core/advanced/materialPresets'

interface StudioOptions { post(value: object): void; media?: string; state?: unknown; saveState(state: unknown): void }
export interface SceneStudio { activate(active: boolean): void; receive(message: Record<string, unknown>): void; dispose(): void }
interface MaterialState {
  name: string
  images: Partial<Record<'albedo' | 'normal' | 'specular', PbrPreviewImageData>>
  profile: PbrPreviewProfile
  roughness: number
  metallic: number
  emission: number
  manual: Set<'roughness' | 'metallic' | 'emissive'>
}
const neutralGraph: MaterialGraph = { version: 1, nodes: [{ id: 'output', type: 'output' }], output: 'output' }
const materialPrefix = 'mcrh:material/'
const basicLighting = PBR_SCENE_PRESETS[0].lighting
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => { const node = document.createElement(tag); if (text) node.textContent = text; return node }

function userScene(scene: PreviewScene): PreviewScene {
  return createPreviewScene({ ...scene, blocks: scene.blocks.filter(block => block.id !== 'mcrh:preview_cube') })
}

export function createSceneStudio(container: HTMLElement, options: StudioOptions): SceneStudio {
  container.classList.add('scene-studio')
  container.innerHTML =
    `<div class="studio-heading"><div><h2>${uiHtml("webview.advanced.sceneAndMaterialGraph")}</h2><p class="muted">${uiHtml("webview.sceneStudio.placeYourOwnMaterialBlocksAndObserve")}</p></div><div class="studio-actions"><button data-action="resources">${uiHtml("webview.sceneStudio.readResourcePack")}</button><button data-action="material">${uiHtml("webview.sceneStudio.newBlockFromPng")}</button><button data-action="load">${uiHtml("webview.sceneStudio.openProject")}</button><button data-action="save">${uiHtml("webview.sceneStudio.saveProject")}</button></div></div><div class="studio-toolbar"><label>${uiHtml("webview.sceneStudio.interactive")}<select id="studio-tool"><option value="select">${uiHtml("webview.sceneStudio.select")}</option><option value="place">${uiHtml("webview.sceneStudio.placement")}</option><option value="remove">${uiHtml("webview.packTools.remove")}</option></select></label><label>${uiHtml("webview.sceneStudio.observation")}<select id="studio-debug"><option value="final">${uiHtml("webview.sceneStudio.materialEffects")}</option><option value="base">${uiHtml("webview.sceneStudio.originalColour")}</option><option value="normal">${uiHtml("webview.materialGraphEditor.normals")}</option><option value="roughness">${uiHtml("webview.advanced.roughness")}</option><option value="metallic">${uiHtml("webview.advanced.metallic")}</option><option value="emissive">${uiHtml("webview.advanced.autolight")}</option><option value="ao">${uiHtml("webview.materialGraphEditor.environmentMask")}</option></select></label><button data-action="undo">${uiHtml("ui.tutorialCards.undo")}</button><button data-action="redo">${uiHtml("ui.tutorialCards.redo")}</button><button data-action="duplicate">${uiHtml("webview.sceneStudio.copySelected")}</button><button data-action="delete">${uiHtml("webview.sceneStudio.deleteSelected")}</button></div><div class="studio-layout"><div class="studio-graph"><div class="studio-panel-head"><strong>${uiHtml("webview.sceneStudio.materialBlocks")}</strong><button data-action="graph-reset">${uiHtml("webview.sceneStudio.mobilityPreset")}</button><button data-action="graph-neutral">${uiHtml("core.advanced.materialPresets.originalMaterial")}</button></div><div id="studio-blockly" aria-label="${uiHtml("webview.sceneStudio.materialNodeBlock")}"></div><details><summary>${uiHtml("webview.sceneStudio.webglGlslGenerated")}</summary><div id="studio-code"></div></details></div><div class="studio-viewport-panel"><div id="studio-viewport" aria-label="${uiHtml("webview.sceneStudio.userMaterialsSite")}"></div><p id="studio-empty" class="studio-empty">${uiHtml("webview.sceneStudio.readResourcePacksOrCreateNewBlocks")}</p><p class="studio-hint">${uiHtml("webview.sceneStudio.pbrLightLeftClickSelectsOrPlaces")}</p></div><aside class="studio-inspector"><strong>${uiHtml("webview.sceneStudio.yourBlock")}</strong><label>${uiHtml("webview.sceneStudio.squareResources")}<select id="studio-palette"><option value="">${uiHtml("webview.sceneStudio.readResourcePacksOrChoosePngFirst")}</option></select></label><div class="studio-position"><label>X<input id="studio-x" type="number" value="0" step="1"></label><label>Y<input id="studio-y" type="number" value="0" step="1"></label><label>Z<input id="studio-z" type="number" value="0" step="1"></label></div><button data-action="place" disabled>${uiHtml("webview.sceneStudio.placeInCoordinates")}</button><button data-action="move">${uiHtml("webview.sceneStudio.movesTheSelectedCoordinates")}</button><label>${uiHtml("webview.sceneStudio.statusPropertiesJson")}<textarea id="studio-properties" rows="2">{}</textarea></label><button data-action="properties">${uiHtml("webview.sceneStudio.applyBlockProperties")}</button><div id="studio-selection" class="muted">${uiHtml("webview.sceneStudio.noBlockSelected")}</div><p id="studio-material-target" class="muted">${uiHtml("webview.sceneStudio.editMatchingMaterialAfterSelectingTheBlock")}</p><label>${uiHtml("webview.sceneStudio.materialEncoded")}<select id="studio-profile"><option value="labPBR">labPBR 1.3</option><option value="oldPBR">${uiHtml("webview.sceneStudio.oldpbrClassicChannel")}</option><option value="pbrgen-mer">PBRGen MER</option></select></label><div class="studio-textures"><button data-texture="albedo">${uiHtml("webview.sceneStudio.replaceThisMaterialBaseMap")}</button><button data-texture="normal">${uiHtml("webview.sceneStudio.frontlineNPng")}</button><button data-texture="specular">${uiHtml("webview.sceneStudio.materialsSPng")}</button></div><label>${uiHtml("webview.advanced.roughness")}<input id="studio-roughness" type="range" min="0" max="1" step="0.01" value="0.6"></label><label>${uiHtml("webview.advanced.metallic")}<input id="studio-metallic" type="range" min="0" max="1" step="0.01" value="0"></label><label>${uiHtml("webview.advanced.autolight")}<input id="studio-emission" type="range" min="0" max="1" step="0.01" value="0"></label><button data-action="generate-pbr">${uiHtml("webview.sceneStudio.generatePbrPreviewsFromBottom")}</button><pre id="studio-material-info" class="muted">${uiHtml("webview.sceneStudio.aSideBySideProfileOfThe")}</pre></aside></div><p id="studio-status" role="status">${uiHtml("webview.sceneStudio.initialisingScene")}</p>`
  const query = <T extends HTMLElement>(selector: string) => container.querySelector<T>(selector)!
  const status = query<HTMLParagraphElement>('#studio-status'), viewport = query<HTMLDivElement>('#studio-viewport'), palette = query<HTMLSelectElement>('#studio-palette')
  const lightingPanel = element('details')
  lightingPanel.className = 'studio-lighting'
  lightingPanel.open = true
  lightingPanel.innerHTML = `<summary>${uiHtml("webview.sceneStudio.pbrSceneAndLight")}</summary><label>${uiHtml("webview.sceneStudio.scenePreset")}<select id="studio-scene-preset"></select></label>${[['sun-intensity', uiHtml("webview.sceneStudio.sunBrightness"), 0, 20, 0.05], ['ambient', uiHtml("webview.sceneStudio.environmentBrightness"), 0, 20, 0.05], ['environment', uiHtml("webview.sceneStudio.environmentalReflection"), 0, 20, 0.05], ['exposure', uiHtml("webview.sceneStudio.exposure"), 0.01, 20, 0.01], ['azimuth', uiHtml("webview.sceneStudio.sunPosition"), -180, 180, 1], ['elevation', uiHtml("webview.sceneStudio.sunHeight"), -90, 90, 1]].map(([id, label, min, max, step]) => '<label>' + label + '<output data-light-value="' + id + '"></output><input aria-label="' + label + '" id="studio-light-' + id + '" type="range" min="' + min + '" max="' + max + '" step="' + step + '"></label>').join('')}<label class="studio-shadow-toggle"><input id="studio-light-shadows" type="checkbox">${uiHtml("webview.sceneStudio.softShadows")}</label><p class="muted">${uiHtml("webview.sceneStudio.labpbrOldpbrUseTheirRespectiveNS")}</p>`
  const presetSelect = lightingPanel.querySelector<HTMLSelectElement>('#studio-scene-preset')!
  presetSelect.append(new Option(uiText("webview.sceneStudio.customLight"), 'custom'), ...PBR_SCENE_PRESETS.map(preset => new Option(preset.label, preset.id)))
  query('.studio-inspector').prepend(lightingPanel)
  const graphPresets = element('select')
  graphPresets.id = 'studio-graph-preset'
  graphPresets.setAttribute('aria-label', uiText("webview.sceneStudio.materialBuildUpPreset"))
  graphPresets.append(new Option(uiText("webview.sceneStudio.selectMaterialsPreset"), ''), ...MATERIAL_GRAPH_PRESETS.map(preset => new Option(preset.label, preset.id)))
  query('.studio-panel-head').after(graphPresets)
  const sourceViewer = createShaderSourceViewer(query('#studio-code'), { post: options.post, scope: 'studio' })
  let history = createSceneHistory(createPreviewScene({ version: 1, blocks: [], lighting: basicLighting }))
  let renderer: SceneWorkbenchApi | undefined, editor: MaterialGraphEditor | undefined, resources: SceneStudioAssets | undefined
  let graph = neutralGraph, active = true, closed = false, serial = 0
  let hitNormal: [number, number, number] | undefined, hitBlockId: string | undefined
  const materials = new Map<string, MaterialState>(), resourceIds = new Set<string>(), pendingMaterials = new Set<string>()
  const notify = (text: string, error = false) => { status.textContent = (text); status.setAttribute('role', error ? 'alert' : 'status'); container.dataset.state = error ? 'error' : 'ready' }
  const run = (action: () => void) => { try { action() } catch (error) { if (error instanceof MaterialGraphValidationError) sourceViewer.clear(uiText("webview.sceneStudio.couldNotCloseTemporaryFolderS", error.message)); notify(error instanceof Error ? error.message : String(error), true) } }
  const selected = () => history.present.selection[0]
  const currentMaterial = () => palette.value || history.present.scene.blocks.find(block => block.instanceId === selected())?.id
  const stateFor = (id: string): MaterialState => {
    let state = materials.get(id)
    if (!state) { state = { name: id, images: {}, profile: history.present.appearance.materialProfiles[id] ?? history.present.appearance.previewProfile, roughness: 0.6, metallic: 0, emission: 0, manual: new Set() }; materials.set(id, state) }
    return state
  }
  const saved = options.state as { project?: string; profile?: PbrPreviewProfile; dirty?: boolean } | undefined
  let savedProject: string | undefined
  let pendingSave: { id: string; project: string } | undefined
  if (saved?.profile && ['labPBR', 'oldPBR', 'pbrgen-mer'].includes(saved.profile)) history = createSceneHistory(history.present.scene, undefined, { previewProfile: saved.profile, materialProfiles: {} })
  if (saved?.project) run(() => { const project = deserializeSceneWorkbenchProject(saved.project!); history = createSceneHistory(userScene(project.scene), undefined, { previewProfile: project.previewProfile ?? history.present.appearance.previewProfile, materialProfiles: project.materialProfiles ?? {} }); if (project.materialGraph) { compileMaterialGraph(project.materialGraph); graph = project.materialGraph as unknown as MaterialGraph } })
  const projectData = () => {
    const camera = renderer?.getCamera()
    const scene = camera ? createPreviewScene({ ...history.present.scene, camera: { position: camera.position, target: camera.target, projection: camera.projection } }) : history.present.scene
    return serializeSceneWorkbenchProject(createSceneWorkbenchProject(scene, graph as unknown as JsonObject, history.present.appearance.previewProfile, materialProfiles()))
  }
  const persist = () => {
    if (closed) return
    const project = projectData()
    options.saveState({ project, profile: history.present.appearance.previewProfile, dirty: project !== savedProject })
  }
  const replacement = document.createElement('dialog')
  replacement.className = 'studio-project-confirmation'
  replacement.setAttribute('aria-labelledby', 'studio-project-confirmation-title')
  replacement.setAttribute('aria-describedby', 'studio-project-confirmation-detail')
  replacement.innerHTML = `<h2 id="studio-project-confirmation-title">${uiHtml("webview.sceneStudio.currentSceneHasUnsavedChanges")}</h2><p id="studio-project-confirmation-detail">${uiHtml("webview.sceneStudio.openingAnotherProjectWillReplaceTheCurrent")}</p><div class="watermark-actions"><button type="button" value="cancel" autofocus>${uiHtml("browser.shell.cancel")}</button><button type="button" value="replace">${uiHtml("webview.sceneStudio.discardChangesAndOpen")}</button></div>`
  for (const button of replacement.querySelectorAll('button')) button.addEventListener('click', () => replacement.close(button.value))
  document.body.append(replacement)
  let replaceProject: (() => void) | undefined
  replacement.addEventListener('close', () => {
    const apply = replaceProject
    replaceProject = undefined
    if (!closed && replacement.returnValue === 'replace' && apply) run(apply)
  })
  const position = (): ScenePosition => ['x', 'y', 'z'].map(axis => Number(query<HTMLInputElement>('#studio-' + axis).value)) as unknown as ScenePosition
  const updatePalette = (preferred = palette.value) => {
    palette.replaceChildren()
    for (const id of [...resourceIds, ...materials.keys()].filter((id, index, all) => all.indexOf(id) === index && (resourceIds.has(id) || id.startsWith(materialPrefix) && materials.get(id)?.images.albedo))) {
      const option = element('option', materials.get(id)?.name ?? id); option.value = id; palette.append(option)
    }
    for (const id of new Set(history.present.scene.blocks.map(block => block.id))) {
      if (Array.from(palette.options).some(option => option.value === id)) continue
      const option = element('option', (materials.get(id)?.name ?? id) + uiText("webview.sceneStudio.rereadMaterialsToReadQualifier")); option.value = id; palette.append(option)
    }
    if (!palette.options.length) { const option = element('option', uiText("webview.sceneStudio.readResourcePacksOrChoosePngFirst")); option.value = ''; palette.append(option) }
    if (Array.from(palette.options).some(option => option.value === preferred)) palette.value = preferred
    query<HTMLButtonElement>('[data-action=place]').disabled = !resourceIds.has(palette.value) && !materials.get(palette.value)?.images.albedo
  }
  const refreshInspector = () => {
    const id = currentMaterial(), state = id ? materials.get(id) : undefined
    query('#studio-material-target').textContent = id ? uiText("webview.sceneStudio.editingSharedWithMassBlocks", (state?.name ?? id)) : uiText("webview.sceneStudio.editMatchingMaterialAfterSelectingTheBlock")
    query<HTMLSelectElement>('#studio-profile').value = state?.profile ?? history.present.appearance.previewProfile
    for (const name of ['roughness', 'metallic', 'emission'] as const) query<HTMLInputElement>('#studio-' + name).value = String(state?.[name] ?? (name === 'roughness' ? 0.6 : 0))
    for (const button of container.querySelectorAll<HTMLButtonElement>('[data-texture]')) button.disabled = !id
    for (const control of container.querySelectorAll<HTMLInputElement | HTMLSelectElement>('#studio-profile, #studio-roughness, #studio-metallic, #studio-emission')) control.disabled = !id
    query<HTMLButtonElement>('[data-action=generate-pbr]').disabled = !state?.images.albedo
    if (state?.images.albedo) {
      const data = createMaterialPreviewData({ albedo: state.images.albedo, normal: state.images.normal, mer: state.images.specular, profile: state.profile })
      const summary = summarizeMaterialPreview(data)
      query('#studio-material-info').textContent = state.profile + ' · ' + data.width + ' × ' + data.height + uiText("webview.sceneStudio.roughness") + summary.roughness.average.toFixed(3) + uiText("webview.sceneStudio.metallicDegrees") + summary.metallic.average.toFixed(3) + uiText("webview.sceneStudio.shine") + summary.emissive.average.toFixed(3) + '\nAO ' + summary.ao.average.toFixed(3)
    } else query('#studio-material-info').textContent = id ? uiText("webview.sceneStudio.useTheResourcePackActualModelWith") : ''
  }
  const refreshSelection = () => {
    renderer?.setSelection(selected())
    const block = history.present.scene.blocks.find(block => block.instanceId === selected())
    if (block) {
      if (Array.from(palette.options).some(option => option.value === block.id)) palette.value = block.id
      for (const [axis, index] of ['x', 'y', 'z'].map((axis, index) => [axis, index] as const)) query<HTMLInputElement>('#studio-' + axis).value = String(block.position[index])
      query<HTMLTextAreaElement>('#studio-properties').value = JSON.stringify(block.properties)
    }
    query('#studio-selection').textContent = block ? (materials.get(block.id)?.name ?? block.id) + ' · ' + block.position.join(', ') : uiText("webview.sceneStudio.noBlockSelected")
    refreshInspector()
  }
  const sceneData = (): SceneWorkbenchScene => ({ version: 1, blocks: history.present.scene.blocks.map(block => ({ id: block.instanceId, resource: block.id, position: [...block.position], properties: { ...block.properties } })), camera: { position: [...history.present.scene.camera.position], target: [...history.present.scene.camera.target] }, lighting: { ...history.present.scene.lighting, sunDirection: [...history.present.scene.lighting.sunDirection] } })
  const sync = (preserveCamera = true) => {
    syncMaterialProfiles()
    const data = sceneData(), camera = renderer?.getCamera()
    if (camera && preserveCamera) data.camera = { position: camera.position, target: camera.target }
    renderer?.setScene(data)
    container.dataset.blockCount = String(history.present.scene.blocks.length)
    query('#studio-empty').hidden = history.present.scene.blocks.length > 0
    query<HTMLButtonElement>('[data-action=undo]').disabled = !canUndo(history)
    query<HTMLButtonElement>('[data-action=redo]').disabled = !canRedo(history)
    refreshSelection(); syncLightingControls(); persist()
  }
  function materialProfiles(): Record<string, PbrPreviewProfile> {
    return { ...history.present.appearance.materialProfiles, ...Object.fromEntries([...materials].map(([id, state]) => [id, state.profile])) }
  }
  function syncMaterialProfiles(): void {
    const appearance = history.present.appearance
    for (const [id, state] of materials) {
      const profile = appearance.materialProfiles[id] ?? appearance.previewProfile
      if (state.profile !== profile) { state.profile = profile; refreshMaterial(id) }
    }
  }
  function syncLightingControls(): void {
    const lighting = history.present.scene.lighting, direction = lighting.sunDirection
    const length = Math.hypot(...direction)
    const values: Record<string, number> = { 'sun-intensity': lighting.sunIntensity, ambient: lighting.ambientIntensity, environment: lighting.environmentIntensity, exposure: lighting.exposure, azimuth: Math.atan2(direction[0], direction[2]) * 180 / Math.PI, elevation: Math.asin(direction[1] / length) * 180 / Math.PI }
    for (const [name, value] of Object.entries(values)) {
      const input = query<HTMLInputElement>('#studio-light-' + name)
      input.value = String(value)
      query('[data-light-value="' + name + '"]').textContent = value.toFixed(name === 'azimuth' || name === 'elevation' ? 0 : 2)
    }
    query<HTMLInputElement>('#studio-light-shadows').checked = lighting.shadows
    const appearance = history.present.appearance
    presetSelect.value = PBR_SCENE_PRESETS.find(preset => preset.profile === appearance.previewProfile && Object.values(appearance.materialProfiles).every(profile => profile === preset.profile) && Object.keys(lighting).every(key => key === 'sunDirection' ? lighting.sunDirection.every((value, index) => value === preset.lighting.sunDirection[index]) : lighting[key as keyof typeof lighting] === preset.lighting[key as keyof typeof lighting]))?.id ?? 'custom'
  }
  function changeLighting(lighting: PreviewScene['lighting'], appearance: SceneAppearance = history.present.appearance): void {
    const next = createPreviewScene({ ...history.present.scene, lighting })
    history = commitScene(history, next, undefined, appearance)
    syncMaterialProfiles()
    renderer?.setLighting({ ...next.lighting, sunDirection: [...next.lighting.sunDirection] })
    syncLightingControls()
    query<HTMLButtonElement>('[data-action=undo]').disabled = !canUndo(history)
    query<HTMLButtonElement>('[data-action=redo]').disabled = !canRedo(history)
    persist()
  }
  lightingPanel.addEventListener('input', event => run(() => {
    const input = event.target as HTMLInputElement
    if (!input.id.startsWith('studio-light-')) return
    const lighting = history.present.scene.lighting, name = input.id.slice('studio-light-'.length)
    const next = { ...lighting }
    const fields = { 'sun-intensity': 'sunIntensity', ambient: 'ambientIntensity', environment: 'environmentIntensity', exposure: 'exposure' } as const
    if (name in fields) next[fields[name as keyof typeof fields]] = Number(input.value)
    else if (name === 'shadows') next.shadows = input.checked
    else if (name === 'azimuth' || name === 'elevation') {
      const direction = lighting.sunDirection, length = Math.hypot(...direction)
      const azimuth = name === 'azimuth' ? Number(input.value) * Math.PI / 180 : Math.atan2(direction[0], direction[2])
      const elevation = name === 'elevation' ? Number(input.value) * Math.PI / 180 : Math.asin(direction[1] / length)
      next.sunDirection = [Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation)]
    } else return
    changeLighting(next)
  }))
  presetSelect.addEventListener('change', () => run(() => {
    const preset = PBR_SCENE_PRESETS.find(preset => preset.id === presetSelect.value)
    if (!preset) return
    const profiles = Object.fromEntries(Object.keys(materialProfiles()).map(id => [id, preset.profile]))
    changeLighting(preset.lighting, { previewProfile: preset.profile, materialProfiles: profiles })
    if (resourceIds.size) sync()
    refreshInspector()
    notify(uiText("webview.sceneStudio.applyd", preset.label))
  }))
  graphPresets.addEventListener('change', () => run(() => {
    const preset = MATERIAL_GRAPH_PRESETS.find(preset => preset.id === graphPresets.value)
    if (preset) editor?.setGraph(preset.graph)
  }))
  syncLightingControls()
  const commit = (scene: PreviewScene, selection: readonly string[] = history.present.selection) => { history = commitScene(history, scene, selection); sync(); notify(uiText("webview.sceneStudio.theSceneHasBeenUpdatedSquares", scene.blocks.length)) }
  const place = () => {
    if (!palette.value || !resourceIds.has(palette.value) && !materials.get(palette.value)?.images.albedo) throw new Error(uiText("webview.sceneStudio.pleaseReadTheResourcePackFirstOr"))
    const id = 'block_' + Date.now().toString(36) + '_' + serial++
    commit(addBlock(history.present.scene, { instanceId: id, id: palette.value, position: position(), properties: {} }), [id])
  }
  const select = (id?: string) => { history = selectBlocks(history, id ? [id] : []); refreshSelection(); persist() }
  const refreshMaterial = (id: string) => {
    const state = stateFor(id), mapped: SceneWorkbenchTextures = { albedo: null, normal: null, roughness: null, metallic: null, emissive: null, ao: null }
    const reference = state.images.albedo ?? state.images.normal ?? state.images.specular
    if (reference) {
      const albedo = state.images.albedo ?? { width: reference.width, height: reference.height, data: new Uint8Array(reference.width * reference.height * 4).fill(255) }
      const data = createMaterialPreviewData({ albedo, normal: state.images.normal, mer: state.images.specular, profile: state.profile })
      const textures = materialPreviewToRgbaTextures(data)
      const channels: Array<keyof SceneWorkbenchTextures> = []
      if (state.images.albedo) channels.push('albedo')
      if (state.images.normal || id.startsWith(materialPrefix)) channels.push('normal', 'ao')
      if (state.images.specular || id.startsWith(materialPrefix)) channels.push('roughness', 'metallic', 'emissive')
      for (const channel of channels) mapped[channel] = { width: textures.width, height: textures.height, data: textures[channel] }
    }
    const rgba = (value: number) => ({ width: 1, height: 1, data: Uint8Array.from([value, value, value, 255]) })
    for (const channel of state.manual) mapped[channel] = rgba(Math.round(state[channel === 'emissive' ? 'emission' : channel] * 255))
    renderer?.setResourceTextures(id, mapped)
    if (currentMaterial() === id) refreshInspector()
  }
  const buildBlock = async (block: SceneWorkbenchBlock) => {
    const id = block.resource
    if (!id) throw new Error(uiText("webview.sceneStudio.noBlockMaterial"))
    if (id.startsWith(materialPrefix)) {
      if (!materials.get(id)?.images.albedo) throw new Error(uiText("webview.sceneStudio.pleaseReSelectThePngOfThis", id.slice(materialPrefix.length)))
      return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, alphaTest: 0.1 }))
    }
    if (!resources || !resourceIds.has(id)) throw new Error(uiText("webview.sceneStudio.readThePackageContainingThisBlockFirst", id))
    return resources.block(block, stateFor(id).profile)
  }
  try {
    renderer = createSceneWorkbench(viewport, { scene: sceneData(), shader: compileMaterialGraph(graph), debug: 'final', blockFactory: buildBlock, postMessage: message => {
      if (message.command === 'sceneWorkbenchError') notify(message.error, true)
      else if (message.command === 'sceneWorkbenchSelectionChanged') {
        hitNormal = message.normal; hitBlockId = message.id
        const tool = query<HTMLSelectElement>('#studio-tool').value
        if (tool === 'place') return
        select(message.id)
        if (tool === 'remove' && message.id) run(() => commit(deleteBlock(history.present.scene, message.id!), []))
      }
    } })
    const retained = graph
    editor = createMaterialGraphEditor(query('#studio-blockly'), { media: options.media, onChange: (next, compiled, error) => {
      if (error) { sourceViewer.clear(uiText("webview.sceneStudio.couldNotCloseTemporaryFolderS", error.message)); notify(error.message, true); return }
      if (next && compiled) { graph = next; renderer?.setShader(compiled); sourceViewer.setSources([{ id: 'vertex', label: uiText("webview.sceneStudio.vertexColorer"), content: compiled.vertexShader }, { id: 'fragment', label: uiText("webview.sceneStudio.snippetColourer"), content: compiled.fragmentShader }]); persist(); notify(uiText("webview.sceneStudio.materialMapsCompiledNodes", next.nodes.length)) }
    } })
    editor.setGraph(retained); updatePalette(); sync()
    if (!saved?.project || saved.dirty === false) { savedProject = projectData(); persist() }
    if (!history.present.scene.blocks.length) notify(uiText("webview.sceneStudio.sceneIsEmptyPleaseReadTheResource"))
  } catch (error) { sourceViewer.clear(error instanceof Error ? error.message : String(error)); notify(error instanceof Error ? error.message : String(error), true) }
  const sendTexture = (role: string, createMaterial = false) => {
    const materialId = createMaterial ? materialPrefix + 'user_' + crypto.randomUUID().replace(/-/g, '') : currentMaterial()
    if (!createMaterial && !materialId) throw new Error(uiText("webview.sceneStudio.pleaseSelectTheMaterialFirstOrCreate"))
    if (materialId) pendingMaterials.add(materialId)
    options.post({ command: 'studioTexture', role, materialId, ...(createMaterial ? { createMaterial: true } : {}) })
  }
  container.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button')
    if (!button) return
    run(() => {
      if (button.dataset.texture) { sendTexture(button.dataset.texture); return }
      const id = selected()
      switch (button.dataset.action) {
        case 'resources': options.post({ command: 'studioResources' }); break
        case 'material': sendTexture('albedo', true); break
        case 'load': options.post({ command: 'studioLoad' }); break
        case 'save': {
          const request = { id: crypto.randomUUID(), project: projectData() }
          pendingSave = request
          options.post({ command: 'studioSave', project: request.project, saveId: request.id })
          break
        }
        case 'place': place(); break
        case 'delete': if (id) commit(deleteBlock(history.present.scene, id), []); break
        case 'move': if (id) commit(moveBlock(history.present.scene, id, position())); break
        case 'properties': if (id) commit(updateBlockProperties(history.present.scene, id, JSON.parse(query<HTMLTextAreaElement>('#studio-properties').value))); break
        case 'duplicate': if (id) { const block = history.present.scene.blocks.find(block => block.instanceId === id)!; const copy = 'copy_' + Date.now().toString(36) + '_' + serial++; commit(copyBlock(history.present.scene, id, copy, [block.position[0] + 1, block.position[1], block.position[2]]), [copy]) } break
        case 'undo': history = undo(history); sync(); break
        case 'redo': history = redo(history); sync(); break
        case 'graph-reset': editor?.reset(); break
        case 'graph-neutral': editor?.setGraph(neutralGraph); break
        case 'generate-pbr': { const materialId = currentMaterial(), state = materialId ? stateFor(materialId) : undefined; const albedo = state?.images.albedo; if (!materialId || !state || !albedo) throw new Error(uiText("browser.workbenchBridge.pleaseSelectTheBaseFigureForThis")); options.post({ command: 'studioGeneratePbr', materialId, albedo: { width: albedo.width, height: albedo.height, data: Array.from(albedo.data) }, profile: state.profile, strength: 1, roughness: state.roughness, metallic: state.metallic, emission: state.emission }); break }
      }
    })
  })
  palette.addEventListener('change', () => { updatePalette(); history = selectBlocks(history, []); refreshSelection(); persist() })
  query<HTMLSelectElement>('#studio-debug').addEventListener('change', event => run(() => renderer?.setDebug((event.target as HTMLSelectElement).value as Parameters<SceneWorkbenchApi['setDebug']>[0])))
  query('#studio-profile').addEventListener('change', () => run(() => { const id = currentMaterial(); if (!id) return; const profile = query<HTMLSelectElement>('#studio-profile').value as PbrPreviewProfile; history = commitScene(history, history.present.scene, undefined, { previewProfile: profile, materialProfiles: { ...materialProfiles(), [id]: profile } }); sync() }))
  for (const name of ['roughness', 'metallic', 'emission'] as const) query('#studio-' + name).addEventListener('input', () => run(() => { const id = currentMaterial(); if (!id) return; const state = stateFor(id); state[name] = Number(query<HTMLInputElement>('#studio-' + name).value); state.manual.add(name === 'emission' ? 'emissive' : name); refreshMaterial(id) }))
  let pointer: { x: number; y: number; button: number } | undefined
  viewport.addEventListener('pointerdown', event => { pointer = { x: event.clientX, y: event.clientY, button: event.button }; hitBlockId = undefined; hitNormal = undefined })
  viewport.addEventListener('pointerup', event => {
    const start = pointer; pointer = undefined
    if (!start || start.button !== 0 || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5 || query<HTMLSelectElement>('#studio-tool').value !== 'place') return
    run(() => {
      const block = history.present.scene.blocks.find(block => block.instanceId === hitBlockId), normal = hitNormal ?? [0, 1, 0]
      const axis = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)))
      const at = block ? block.position.map((value, index) => value + (index === axis ? Math.sign(normal[index]) : 0)) : position()
      for (const [axis, index] of ['x', 'y', 'z'].map((axis, index) => [axis, index] as const)) query<HTMLInputElement>('#studio-' + axis).value = String(at[index])
      place()
    })
    hitNormal = undefined; hitBlockId = undefined
  })
  const keyboard = (event: KeyboardEvent) => {
    if (!active || event.defaultPrevented || replacement.open || (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable=true], .blocklySvg'))) return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); run(() => { history = event.shiftKey ? redo(history) : undo(history); sync() }) }
    if (event.key === 'Delete' && selected()) { event.preventDefault(); run(() => commit(deleteBlock(history.present.scene, selected()!), [])) }
  }
  window.addEventListener('keydown', keyboard)
  return {
    activate(value) { active = value; renderer?.setActive(value && !document.hidden); if (value) { renderer?.resize(); editor?.resize() } },
    receive(message) {
      sourceViewer.receive(message)
      if (message.type === 'studioAsset') { resources?.accept(message); return }
      run(() => {
        if (message.type === 'studioReset') {
          resources?.dispose(); resources = undefined; resourceIds.clear(); materials.clear(); pendingMaterials.clear(); renderer?.clearResourceTextures(); updatePalette(); sync(); notify(uiText("webview.sceneStudio.reloadBlockOrSelectPng")); return
        }
        if (message.type === 'studioError') notify(String(message.error), true)
        if (message.type === 'studioSaved') {
          if (pendingSave && message.saveId === pendingSave.id) {
            savedProject = pendingSave.project
            pendingSave = undefined
            persist()
          }
          notify(uiText("webview.sceneStudio.projectSaved", message.name))
        }
        if (message.type === 'studioProject' && typeof message.project === 'string' && !replacement.open) {
          const project = deserializeSceneWorkbenchProject(message.project), next = project.materialGraph ?? neutralGraph
          compileMaterialGraph(next)
          const apply = () => {
            pendingSave = undefined
            history = createSceneHistory(userScene(project.scene), undefined, { previewProfile: project.previewProfile ?? 'labPBR', materialProfiles: project.materialProfiles ?? {} })
            graph = next as unknown as MaterialGraph
            editor?.setGraph(graph); updatePalette(); sync(false)
            savedProject = projectData()
            persist()
            notify(uiText("webview.sceneStudio.theProjectHasBeenCarriedOut", message.name))
          }
          if (projectData() === savedProject) apply()
          else {
            replaceProject = apply
            replacement.returnValue = ''
            replacement.showModal()
          }
        }
        if (message.type === 'studioResources' && Number.isSafeInteger(message.sessionId) && Array.isArray(message.layers) && Array.isArray(message.blocks)) {
          resources?.dispose(); resources = new SceneStudioAssets({ sessionId: Number(message.sessionId), layers: message.layers as string[], version: typeof message.version === 'string' ? message.version : undefined }, options.post)
          for (const id of resourceIds) { materials.delete(id); renderer?.setResourceTextures(id, null) }
          resourceIds.clear()
          for (const id of message.blocks) if (typeof id === 'string') resourceIds.add(id)
          updatePalette(); sync(); notify(uiText("webview.sceneStudio.readSpeculateBlocksSelectYourOwnMaterial", resourceIds.size))
        }
        if (message.type === 'studioTexture' && ['albedo', 'normal', 'specular'].includes(String(message.role))) {
          const role = message.role as 'albedo' | 'normal' | 'specular', width = Number(message.width), height = Number(message.height), pixels = message.data
          if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 1024 * 1024 || !Array.isArray(pixels) || pixels.length !== width * height * 4 || !pixels.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) throw new Error(uiText("webview.sceneStudio.theSceneTextureMessageIsInvalid"))
          let materialId = typeof message.materialId === 'string' ? message.materialId : currentMaterial()
          if (typeof message.materialId === 'string' && !materials.has(message.materialId) && !pendingMaterials.has(message.materialId) && !resourceIds.has(message.materialId)) return
          const creating = role === 'albedo' && (message.createMaterial === true || !materialId)
          if (role === 'albedo' && (!materialId || message.createMaterial === true && typeof message.materialId !== 'string')) {
            const name = String(message.name ?? uiText("webview.sceneStudio.myMaterialPng")), stem = name.replace(/\.png$/i, '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^[_\.]+|[_\.]+$/g, '') || 'material'
            materialId = materialPrefix + stem
            if (message.createMaterial === true) { let suffix = 2; while (materials.get(materialId)?.images.albedo) materialId = materialPrefix + stem + '_' + suffix++ }
            stateFor(materialId).name = name
          }
          if (!materialId) throw new Error(uiText("webview.sceneStudio.pleaseSelectTheMaterialYouWantTo"))
          pendingMaterials.delete(materialId)
          const state = stateFor(materialId)
          if (role === 'albedo' && materialId.startsWith(materialPrefix) && (creating || !state.images.albedo)) state.name = String(message.name ?? state.name)
          const image = { width, height, data: Uint8Array.from(pixels) }, previous = { ...state.images }, previousManual = new Set(state.manual)
          if (role === 'albedo') for (const companion of ['normal', 'specular'] as const) { const source = state.images[companion]; if (source && (source.width !== width || source.height !== height)) delete state.images[companion] }
          state.images[role] = image
          if (role === 'specular') state.manual.clear()
          try { refreshMaterial(materialId) } catch (error) { state.images = previous; state.manual = previousManual; throw error }
          if (creating) history = selectBlocks(history, [])
          updatePalette(creating ? materialId : palette.value); refreshInspector()
          if (materialId.startsWith(materialPrefix)) sync()
          notify(uiText("webview.sceneStudio.applydTo", state.name, String(message.name ?? role)))
        }
        if (message.type === 'studioPbrGenerated') {
          const id = typeof message.materialId === 'string' ? message.materialId : currentMaterial()
          if (id && materials.has(id) && ['labPBR', 'oldPBR', 'pbrgen-mer'].includes(String(message.profile))) { const profile = message.profile as PbrPreviewProfile; history = commitScene(history, history.present.scene, undefined, { ...history.present.appearance, materialProfiles: { ...materialProfiles(), [id]: profile } }); sync() }
          notify(uiText("webview.sceneStudio.pbrAppliedToCurrentMaterialSourceMap"))
        }
      })
    },
    dispose() { closed = true; replaceProject = undefined; replacement.remove(); window.removeEventListener('keydown', keyboard); sourceViewer.dispose(); resources?.dispose(); editor?.dispose(); renderer?.dispose(); materials.clear() }
  }
}
