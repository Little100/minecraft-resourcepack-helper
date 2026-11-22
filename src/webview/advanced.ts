import * as En from 'blockly/msg/en'
import { activeLanguage, uiHtml, uiText } from '../i18n/messages'
import { enhanceNativeSelects } from './selectControls'
import * as Blockly from 'blockly/core'
import * as Zh from 'blockly/msg/zh-hans'
import { createSceneStudio, type SceneStudio } from './sceneStudio'
import { svgIcon } from './svgIcons'
import { createShaderSourceViewer, type ShaderSourceFile } from './shaderSourceViewer'

import { createPackTools } from './packTools'
import { createTextureWatermarkTools, readTextureWatermarkSettings } from './watermarkTools'
import { createTintPresets } from './tintPresets'
import { createTextureBatch } from './textureBatch'

enhanceNativeSelects()

interface Api { postMessage(message: unknown): void; getState(): unknown; setState(value: unknown): void }
const api = (globalThis as unknown as { acquireVsCodeApi(): Api }).acquireVsCodeApi()
const assets = (globalThis as unknown as { __MCRH__: { blocklyMedia?: string } }).__MCRH__
const locale: Record<string, string> = {}
for (const [key, value] of Object.entries(activeLanguage().locale === 'en_us' ? En : Zh)) if (typeof value === 'string') locale[key] = value
Blockly.setLocale(locale)

// 页面使用构建时生成的样式
class StaticConstants extends Blockly.geras.ConstantProvider {
  protected injectCSS_(_root: Document | ShadowRoot, _selector: string): void {}
}
class StaticRenderer extends Blockly.geras.Renderer {
  makeConstants_(): Blockly.geras.ConstantProvider { return new StaticConstants() }
}
Blockly.blockRendering.register('mcrh_static', StaticRenderer)
const saved = api.getState() as { fields?: Record<string, string | boolean>; tab?: string; graph?: unknown; studio?: unknown } | undefined
const tabs = [
  ['packs', uiText("webview.advanced.packManager"), uiText("webview.advanced.mergeConvertExport")],
  ['batch', uiText("webview.advanced.batchTextureEditing"), uiText("webview.advanced.edgesConnectedTextures")], ['colormap', uiText("webview.advanced.biomesAndColormaps"), uiText("webview.advanced.vanillaDataPacks")], ['textures', uiText("webview.advanced.connectedAndRandomTextures"), 'OptiFine'],
  ['pbr', uiText("webview.advanced.pbrMaps"), 'labPBR / OldPBR'], ['totem', uiText("webview.advanced.skinTotem"), uiText("webview.advanced.originalModel")],
  ['studio', uiText("webview.advanced.sceneAndMaterialGraph"), uiText("webview.advanced.webgl2PbrRealTime")], ['shader', uiText("webview.advanced.legacyShaderSnippets"), uiText("webview.advanced.minecraftExport")], ['optimizer', uiText("webview.advanced.packOptimizer"), 'PackSquash'],
  ['samples', uiText("webview.advanced.exampleLibrary"), uiText("webview.advanced.importsSafelyByAbility")], ['versions', uiText("webview.advanced.versionCompatibilityAndAcknowledgement"), uiText("webview.advanced.verifiedSupportBoundaries")]
]
const escape = (value: string) => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!))
const options = (values: Array<[string, string]>) => values.map(([value, label]) => `<option value="${escape(value)}">${escape(label)}</option>`).join('')
const input = (key: string, label: string, value: string | number, type = 'text', extra = '') => `<label class="field"><span>${escape(label)}</span><input name="${key}" type="${type}" value="${escape(String(value))}" ${extra}></label>`
const select = (key: string, label: string, values: Array<[string, string]>) => `<label class="field"><span>${escape(label)}</span><select name="${key}">${options(values)}</select></label>`
const pick = (role: string, title: string) => `<div class="source"><button type="button" data-pick="${role}">${escape(title)}</button><span data-source="${role}">${uiHtml("webview.advanced.notSelected")}</span></div>`
const submit = (kind: string, label = uiText("webview.advanced.previewExportFileAndGenerate")) => `<button class="primary" type="submit" data-kind="${kind}">${escape(label)}</button>`
const note = (text: string) => `<p class="notice">${escape(text)}</p>`
const form = (kind: string, contents: string) => `<form data-kind="${kind}" class="form-grid">${contents}${submit(kind)}</form>`
const root = document.createElement('main')
root.className = 'workbench'
root.innerHTML = `<aside class="rail"><div class="brand">MCRH<span>${uiHtml("ui.sidebarTree.advancedMaterialsWorkbench")}</span></div><label class="rail-compact" for="workbench-section">${uiHtml("webview.advanced.desktopFunctionality")}<select id="workbench-section">${tabs.map(([id, title]) => `<option value="${id}">${escape(title)}</option>`).join('')}</select></label><nav aria-label="${uiHtml("webview.advanced.desktopFunctionality")}">${tabs.map(([id, title, badge]) => `<button type="button" data-tab="${id}" aria-controls="page-${id}"><strong>${escape(title)}</strong><span>${escape(badge)}</span></button>`).join('')}</nav></aside><div class="main"><header class="toolbar"><div><span class="eyebrow">RESOURCE PACK STUDIO</span><h1 id="page-title">${uiHtml("webview.advanced.biomesAndColormaps")}</h1></div><label class="target">${uiHtml("webview.advanced.targetMinecraft")}<select id="target-version"><option>1.20.4</option></select></label><details class="export-options"><summary>${uiHtml("webview.advanced.exportOptions")}</summary><div class="export-options-panel"><label><input type="checkbox" id="export-include-vanilla">${uiHtml("webview.advanced.retainUnmodifiedOriginalResource")}</label><label><input type="checkbox" id="export-include-mcrh">${uiHtml("ui.exportPackCommand.includeMcrhEditData")}</label><p class="muted">${uiHtml("webview.advanced.defaultClosesOnlyTheSourcePackageIs")}</p><p class="muted">${uiHtml("webview.advanced.defaultOnlyExportFromDefinitionAndModification")}</p><p class="muted">${uiHtml("webview.advanced.saveAndExportAutoWrittenMrchLowbit")}</p><div data-watermark-tools></div></div></details><button type="button" class="primary" id="workbench-export-pack">${uiHtml("webview.advanced.exportResourcePackZip")}</button></header><div class="pages">
<section id="page-batch" class="page" hidden><div id="texture-batch-root"></div></section>
<section id="page-packs" class="page" hidden><div id="pack-tools-root"></div></section>
<section id="page-colormap" class="page">
${note(uiText("webview.advanced.theResourcePackSColourMassColor"))}
<div id="tint-presets-root"></div><div class="split"><article class="card"><h2>${uiHtml("webview.advanced.colourChartSampling")}</h2>${pick('colormap', uiText("webview.advanced.selectXColourChartPng"))}<div class="form-grid" id="sampling">${input('temperature', uiText("webview.advanced.temperature"), 0.8, 'number', 'step="0.01"')}${input('downfall', uiText("webview.advanced.precipitation"), 0.4, 'number', 'step="0.01"')}</div><canvas id="colormap-preview" width="256" height="256" aria-label="${uiHtml("webview.advanced.colourChartSamplingPreview")}"></canvas><output id="sample-result">${uiHtml("webview.advanced.displaysTheExactSampleColourAfterSelecting")}</output><p class="muted">${uiHtml("webview.advanced.pixelCoordinatesXFloorTX255Y")}</p></article>
<article class="card"><h2>${uiHtml("webview.advanced.generateGradientColourCharts")}</h2>${form('colormap', select('map', uiText("webview.advanced.type"), [['foliage', uiText("webview.advanced.leaves")], ['grass', uiText("webview.advanced.grassland")], ['dry_foliage', uiText("webview.advanced.dryLeavesNew")]]) + input('cold', uiText("webview.advanced.coldColor"), '#80a8c8', 'color') + input('dry', uiText("webview.advanced.dryHotColor"), '#b6b45f', 'color') + input('wet', uiText("webview.advanced.wetAndHotColours"), '#278747', 'color'))}<h2>${uiHtml("webview.advanced.modifyGroupOverwhelm")}</h2>${pick('biome', uiText("webview.advanced.selectFullBiomeJson"))}${form('biome', input('biomeId', uiText("core.advanced.textures.groupId"), 'minecraft:plains') + input('foliage', uiText("webview.advanced.treeOverleafEmptyRemainsOriginal"), '', 'text', 'placeholder="#77ab2f"') + input('grass', uiText("webview.advanced.grasslandColourEmptyRemainsOriginal"), '', 'text', 'placeholder="#91bd59"') + input('dryFoliage', uiText("webview.advanced.dryleafDuplicateVersionLimit"), '', 'text', 'placeholder="#a9a14b"') + select('modifier', uiText("webview.advanced.strawSpecialHandling"), [['keep', uiText("webview.advanced.retainGroupSetup")], ['none', uiText("webview.advanced.noExtraProcessing")], ['dark_forest', uiText("webview.advanced.blackForestColourMix")], ['swamp', uiText("webview.advanced.swampNoisesBothColors")]]))}${note(uiText("webview.advanced.aCompleteGroupFileMustBeProvided"))}
<h2>${uiHtml("webview.advanced.closeModelTint")}</h2><p class="muted">${uiHtml("webview.advanced.automaticallyExpandTheParentModelInThe")}</p>${pick('model', uiText("webview.advanced.selectModelJson"))}${form('untint', input('modelPath', uiText("webview.advanced.modelPathInResourcePack"), 'assets/minecraft/models/block/birch_leaves.json'))}</article></div></section>
<section id="page-textures" class="page" hidden>${note(uiText("webview.advanced.linkTextureNaturalTextureRandomEntitiesNeed"))}
<div class="split"><article class="card"><h2>${uiHtml("webview.advanced.connectionTextureRandomSquare")}</h2>${pick('tiles', uiText("webview.advanced.selectASetOfPngTextures"))}${form('ctm', input('name', uiText("webview.advanced.ruleFileName"), 'custom') + input('matchBlocks', uiText("webview.advanced.matchBlockIds"), 'minecraft:glass') + select('method', uiText("webview.advanced.connectionMethod"), [['ctm', uiText("webview.advanced.fullConnectionPieces")], ['ctm_compact', uiText("webview.advanced.tightConnectionPieces")], ['horizontal', uiText("webview.advanced.horizontalConnectionPieces")], ['vertical', uiText("webview.advanced.verticalConnectionSheets")], ['random', uiText("webview.advanced.randomBlocks")]]) + input('tiles', uiText("webview.advanced.tilesEmptyGeneratedBySelectedFiles"), '') + input('weights', uiText("webview.advanced.randomWeightOptional"), '') + select('symmetry', uiText("webview.advanced.randomRotationSymmetry"), [['none', uiText("webview.advanced.none")], ['opposite', uiText("webview.advanced.symmetric")], ['all', uiText("webview.advanced.allSides")]]))}</article>
<article class="card"><h2>${uiHtml("core.advanced.textures.naturalTexture")}</h2>${form('natural', input('texture', uiText("webview.advanced.squareTextureNameExcludingPng"), 'stone') + select('transform', uiText("webview.advanced.naturalRotationFlip"), [['4F', uiText("webview.advanced.rotateAndFlipAroundFour")], ['2F', uiText("webview.advanced.rotateAndFlipInTwoDirections")], ['4', uiText("webview.advanced.fourWayRotation")], ['2', uiText("webview.advanced.rotationInTwoDirections")], ['F', uiText("webview.advanced.flipOnly")]]))}${note(uiText("webview.advanced.exportingNaturalPropertiesWillFirstReadThe"))}<h2>${uiHtml("webview.advanced.randomEntity")}</h2>${pick('randomBase', uiText("webview.advanced.selectPhysicalVariablePng"))}${form('randomEntity', input('entity', uiText("webview.advanced.physicalTextureRelativePath"), 'cow/cow') + input('skins', uiText("webview.advanced.variableNumberBasicTexture"), '2 3') + input('weights', uiText("webview.advanced.weightsOptional"), '') + input('biomes', uiText("webview.advanced.limitGroupSystemOptional"), ''))}</article></div></section>
<section id="page-pbr" class="page" hidden>${note(uiText("webview.advanced.youCanGenerateLabpbrOldpbrClassicChannels"))}
<article class="card">${pick('pbr', uiText("webview.advanced.selectBaseColourPng"))}${pick('pbrFolder', uiText("webview.advanced.selectTheMaterialPackageRootDirectoryVolume"))}<div class="split"><img id="pbr-preview" class="texture-preview" alt="${uiHtml("webview.advanced.selectedBasePaste")}" hidden>${form('pbr', select('scope', uiText("webview.advanced.scopeOfProcessing"), [['single', uiText("webview.advanced.currentSinglePng")], ['pack', uiText("webview.advanced.totalResourcePackTexturesVolume")]]) + select('profile', uiText("webview.advanced.generateAlgorithms"), [['labpbr', uiText("webview.advanced.reluctableLabpbr")], ['oldpbr', uiText("webview.advanced.oldpbrClassicChannel")], ['pbrgen', uiText("webview.advanced.pbrgenCompatibleAlgorithm")]]) + input('texturePath', uiText("webview.advanced.basicPasteResourcePath"), 'assets/minecraft/textures/block/stone.png') + input('strength', uiText("webview.advanced.highTransversalIntensity"), 1, 'number', 'min="0" max="16" step="0.1"') + input('roughness', uiText("webview.advanced.roughness"), 0.6, 'number', 'min="0" max="1" step="0.01"') + input('metalness', uiText("webview.advanced.metallic"), 0, 'number', 'min="0" max="1" step="0.01"') + input('porosity', uiText("webview.advanced.holerate"), 0, 'number', 'min="0" max="1" step="0.01"') + input('emission', uiText("webview.advanced.autolight"), 0, 'number', 'min="0" max="1" step="0.01"'))}</div><p class="muted">${uiHtml("webview.advanced.sPngForPbrgenIsRgbMer")}</p></article></section>
<section id="page-totem" class="page" hidden>${note(uiText("webview.advanced.totemSupportsSteveAlexStandSittingTo"))}
<article class="card">${pick('skin', uiText("webview.advanced.selectPlayerSkinPng"))}<button type="button" data-edit-skin>${uiHtml("webview.advanced.openSkinBrushSelfDraw")}</button><div class="split"><img id="skin-preview" class="skin-preview" alt="${uiHtml("webview.advanced.playerSkinExpand")}" hidden>${form('totem', input('player', uiText("webview.advanced.playerNameRetrievedFromMojangAfterCompletion"), '', 'text', uiText("webview.advanced.placeholderScreenUseSelectedPng")) + select('model', uiText("webview.advanced.armsModel"), [['steve', uiText("webview.advanced.steveBroadArm")], ['alex', uiText("webview.advanced.alex")]]) + select('pose', uiText("webview.advanced.posture"), [['standing', uiText("webview.advanced.normalPosition")], ['sitting', uiText("webview.advanced.sitDown")]]))}</div><p class="muted">${uiHtml("webview.advanced.exampleModelSourceMissingInTheRed")}</p></article></section>
<section id="page-studio" class="page" hidden><div id="scene-studio-root"></div></section>
<section id="page-shader" class="page" hidden>${note(uiText("webview.advanced.dragTheBuildingBlocksIntoTheWorkspace"))}
<article class="card"><div class="shader-actions"><button type="button" id="shader-reset">${uiHtml("webview.advanced.loadingSkyPresets")}</button><button type="button" id="shader-show">${uiHtml("webview.advanced.viewGeneratingCode")}</button><button type="button" class="primary" id="shader-export">${uiHtml("webview.advanced.exportColorIntegrationSnippet")}</button></div><div class="shader-grid"><div id="blockly" aria-label="${uiHtml("webview.advanced.shadeColorEditor")}"></div><div><canvas id="shader-preview" width="320" height="320" aria-label="${uiHtml("webview.advanced.starColoredApproximatePreview")}"></canvas><p class="muted">${uiHtml("webview.advanced.theGlobalColourerSampleLibraryOfIntegrated")}</p><div id="shader-code"></div></div></div></article></section>
<section id="page-optimizer" class="page" hidden>${note(uiText("webview.advanced.defaultBuiltInInterplatformWithoutDamageZip"))}
<article class="card">${pick('optimizer', uiText("webview.advanced.selectPacksquashProgram"))}${form('optimize', select('engine', uiText("webview.advanced.optimizingBackend"), [['portable', uiText("webview.advanced.internalWithoutDamageZipWindowsDirectlyAvailable")], ['packsquash', uiText("webview.advanced.externalPacksquashCredibleHq")]]) + input('description', uiText("webview.advanced.optimizationNoteThisTimeWorkbenchOnly"), '') + select('mode', uiText("webview.advanced.optimizingMode"), [['safe', uiText("webview.advanced.conservativeOptimizationRetainReadableStructure")], ['balanced', uiText("webview.advanced.standardOptimization")]]))}<div class="terminal"><h2>${uiHtml("webview.advanced.optimizingLog")}</h2><pre id="optimizer-log"></pre><button type="button" data-cancel hidden>${uiHtml("webview.advanced.cancelOptimization")}</button></div></article></section>
<section id="page-samples" class="page" hidden>${note(uiText("webview.advanced.allResourceTypeDetectionAndSecurityImport"))}${pick('samples', uiText("webview.advanced.selectTheExampleDirectoryOfAMaterial"))}<div id="sample-list" class="sample-list"><p class="muted">${uiHtml("webview.advanced.readingLocalExampleDirectories")}</p></div></section>
<section id="page-versions" class="page" hidden><article class="card"><h2>${uiHtml("webview.advanced.versionCapacityTable")}</h2><div id="version-list">${uiHtml("webview.advanced.loadingVerifiedVersionInformation")}</div></article><article class="card"><h2>${uiHtml("webview.advanced.acknowledgementsAndPermissions")}</h2><p>${uiHtml("webview.advanced.blockModerenderEwanHowellMplBlocksAnd")}</p><p>${uiHtml("webview.advanced.fflateMitBrowserZipReadingWritingAnd")}</p><p>${uiHtml("webview.advanced.livedincornerKyanitepacktoolStablePyramidStudioMitReference")}</p><p>${uiHtml("webview.advanced.mojangSlicerMicrosoftCorporationMitOfficialGui")}</p><p>${uiHtml("webview.advanced.comunidadaylasPacksquashResourcePackOptimizationBackendAnd")}</p><p>${uiHtml("webview.advanced.stationBRedTeaUidSteveAlex")}</p><p>${uiHtml("webview.advanced.bv1mwns6aeyoOriginalVideoAuthorColorChartAnd")}</p><p>${uiHtml("webview.advanced.blocklyApacheZodMitPngjsMitBuild")}</p><p class="muted">${uiHtml("webview.advanced.freeOfChargeDoesNotAmountTo")}</p></article></section>
</div></div>`
document.body.append(root)
const feedback = document.createElement('section')
feedback.id = 'workbench-feedback'
feedback.className = 'operation-feedback'
feedback.hidden = true
feedback.setAttribute('aria-label', uiText("webview.advanced.currentToolOperationResults"))
feedback.innerHTML = `<header><div class="operation-feedback-heading"><span class="operation-feedback-symbol"></span><strong>${uiHtml("webview.advanced.operationResults")}</strong><span id="status" role="status" aria-live="polite"></span></div><div class="operation-feedback-actions"><button type="button" data-cancel hidden>${uiHtml("browser.shell.cancel")}</button><button type="button" id="feedback-close" aria-label="${uiHtml("webview.advanced.clearOperationResults")}" title="${uiHtml("webview.advanced.clearOperationResults")}"></button></div></header><pre id="result" tabindex="0" hidden></pre>`
feedback.querySelector('.operation-feedback-symbol')!.append(svgIcon('info'))
feedback.querySelector('#feedback-close')!.append(svgIcon('close'))
root.querySelector('#page-colormap')!.append(feedback)
let feedbackOwner: string | undefined
const clearFeedback = () => { feedback.hidden = true; feedback.querySelector('#result')!.textContent = ''; feedback.querySelector<HTMLElement>('#result')!.hidden = true; feedback.querySelector('#status')!.textContent = ''; feedbackOwner = undefined }
feedback.querySelector('#feedback-close')!.addEventListener('click', clearFeedback)
const placeFeedback = () => { root.querySelector('#page-' + (feedbackOwner ?? activeTab))?.append(feedback) }
const exportOptions=root.querySelector<HTMLDetailsElement>('.export-options')!
document.addEventListener('pointerdown',event=>{if(exportOptions.open&&!exportOptions.contains(event.target as Node)&&!(event.target as Element).closest('.watermark-dialog'))exportOptions.open=false})
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&exportOptions.open&&!document.querySelector('.watermark-dialog[open]')){exportOptions.open=false;exportOptions.querySelector('summary')!.focus()}})
const packTools = createPackTools(root.querySelector('#pack-tools-root')!, { post: message => api.postMessage(message), includeVanilla: () => root.querySelector<HTMLInputElement>('#export-include-vanilla')!.checked, includeMcrhEditorData: () => root.querySelector<HTMLInputElement>('#export-include-mcrh')!.checked, watermark: () => readTextureWatermarkSettings(root) })
const watermarkTools = createTextureWatermarkTools(root.querySelector('[data-watermark-tools]')!)
const tintPresets = createTintPresets(root.querySelector('#tint-presets-root')!, () => root.querySelector<HTMLSelectElement>('#target-version')!.value, message=>api.postMessage(message))
const textureBatch = createTextureBatch(root.querySelector('#texture-batch-root')!, { post: message => api.postMessage(message), version: () => root.querySelector<HTMLSelectElement>('#target-version')!.value })
const shaderSourceViewer = createShaderSourceViewer(root.querySelector('#shader-code')!, { post: message => api.postMessage(message), scope: 'shader' })
shaderSourceViewer.clear()
let shaderPreviewRequest: string | undefined
const invalidateShaderSource = () => { shaderPreviewRequest = undefined; shaderSourceViewer.clear(uiText("webview.advanced.theBuildingBlockOrTargetHasChanged")) }
let activeTab = saved?.tab ?? 'colormap'
let workspace: Blockly.WorkspaceSvg | undefined
let selectedMap: HTMLImageElement | undefined
let marker: { x: number; y: number } | undefined
let animation = 0
let stopped = false
let busy = false
let studio: SceneStudio | undefined
let studioState: unknown = saved?.studio

function initStudio(): void {
  studio ??= createSceneStudio(root.querySelector<HTMLElement>('#scene-studio-root')!, {post:message => api.postMessage(message), media:assets.blocklyMedia, state:studioState, saveState:state => {studioState=state;persist()} })
}

function activateTab(id: string): void {
  if (!tabs.some(item => item[0] === id)) return
  activeTab = id
  for (const page of root.querySelectorAll<HTMLElement>('.page')) page.hidden = page.id !== `page-${id}`
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    button.classList.toggle('active', button.dataset.tab === id)
    button.setAttribute('aria-current', button.dataset.tab === id ? 'page' : 'false')
  }
  root.querySelector<HTMLSelectElement>('#workbench-section')!.value = id
  root.querySelector('#page-title')!.textContent = tabs.find(item => item[0] === id)![1]
  if (id === 'studio') initStudio()
  studio?.activate(id === 'studio')
  tintPresets.activate(id === 'colormap')
  if (id === 'shader') { initBlockly(); if (workspace) Blockly.svgResize(workspace); startPreview() }
  else { cancelAnimationFrame(animation); animation = 0 }
  persist()
}
function persist(): void {
  const fields: Record<string, string | boolean> = {}
  for (const el of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input:not([data-private]), select')) { if (el.closest('#pack-tools-root, #texture-batch-root')) continue; fields[`${el.closest('form')?.dataset.kind ?? el.closest('[id]')?.id}:${el.name || el.id}`] = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value }
  api.setState({ fields, tab: activeTab, graph: workspace ? Blockly.serialization.workspaces.save(workspace) : saved?.graph, studio: studioState })
}
for (const el of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input:not([data-private]), select')) {
  if (el.closest('#pack-tools-root, #texture-batch-root')) continue
  const key = `${el.closest('form')?.dataset.kind ?? el.closest('[id]')?.id}:${el.name || el.id}`
  const value = saved?.fields?.[key]
  if (el instanceof HTMLInputElement && el.type === 'checkbox' && typeof value === 'boolean') el.checked = value
  else if (typeof value === 'string') el.value = value
}
function parameters(form: HTMLFormElement): Record<string, unknown> {
  const result: Record<string, unknown> = { targetVersion: (root.querySelector('#target-version') as HTMLSelectElement).value, includeVanillaTextures: root.querySelector<HTMLInputElement>('#export-include-vanilla')!.checked, includeMcrhEditorData: root.querySelector<HTMLInputElement>('#export-include-mcrh')!.checked, watermark: readExportWatermark() }
  for (const el of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')) result[el.name] = el instanceof HTMLInputElement && el.type === 'number' ? Number(el.value) : el.value
  return result
}
function readExportWatermark(): unknown { return readTextureWatermarkSettings(root) }
root.querySelector<HTMLSelectElement>('#workbench-section')!.addEventListener('change', event => activateTab((event.target as HTMLSelectElement).value))
root.addEventListener('click', event => {
  const target = (event.target as Element).closest<HTMLElement>('button')
  if (!target) return
  if (target.dataset.tab) activateTab(target.dataset.tab)
  if (target.id === 'workbench-export-pack' && !busy) { feedbackOwner = activeTab; try { api.postMessage({ command: 'exportPackZip', params: { includeVanillaTextures: root.querySelector<HTMLInputElement>('#export-include-vanilla')!.checked, includeMcrhEditorData: root.querySelector<HTMLInputElement>('#export-include-mcrh')!.checked, watermark: readExportWatermark() } }) } catch (error) { showResult(error instanceof Error ? error.message : String(error)) } }
  if (target.dataset.pick && !busy) { feedbackOwner = activeTab; api.postMessage({ command: 'pick', role: target.dataset.pick }) }
  if (target.hasAttribute('data-edit-skin') && !busy) {
    feedbackOwner = activeTab
    const player = root.querySelector<HTMLInputElement>('form[data-kind=totem] [name=player]')!
    player.value = ''; persist(); api.postMessage({ command: 'editSkin' })
  }
  if (target.hasAttribute('data-cancel')) api.postMessage({ command: 'cancel' })
  if (target.dataset.sample && !busy) { feedbackOwner = activeTab; try { api.postMessage({ command: 'generate', kind: 'sample', params: { id: target.dataset.sample, targetVersion: (root.querySelector('#target-version') as HTMLSelectElement).value, includeVanillaTextures: root.querySelector<HTMLInputElement>('#export-include-vanilla')!.checked, includeMcrhEditorData: root.querySelector<HTMLInputElement>('#export-include-mcrh')!.checked, watermark: readExportWatermark() } }) } catch (error) { showResult(error instanceof Error ? error.message : String(error)) } }
})
root.addEventListener('submit', event => {
  event.preventDefault()
  if (busy) return
  const form = event.target as HTMLFormElement
  feedbackOwner = activeTab
  try { api.postMessage({ command: 'generate', kind: form.dataset.kind, params: parameters(form) }) } catch (error) { showResult(error instanceof Error ? error.message : String(error)) }
})
function syncPbrControls(): void {
  const form = root.querySelector<HTMLFormElement>('form[data-kind=pbr]')!
  const profile = (form.querySelector('[name=profile]') as HTMLSelectElement).value
  const native = profile === 'pbrgen'
  for (const name of ['strength', 'roughness', 'metalness', 'porosity', 'emission']) {
    const input = form.querySelector<HTMLInputElement>(`[name=${name}]`)!
    input.disabled = native || profile === 'oldpbr' && name === 'porosity'
    input.closest('.field')?.classList.toggle('is-inactive', input.disabled)
  }
  const single = (form.querySelector('[name=scope]') as HTMLSelectElement).value === 'single'
  ;(form.querySelector('[name=texturePath]') as HTMLInputElement).disabled = !single
}
root.addEventListener('change', event => { if ((event.target as Element).closest('#pack-tools-root, #texture-batch-root')) return; persist(); sampleColor(); syncPbrControls() })
function sampleColor(): void {
  const controls = root.querySelector('#sampling')!
  api.postMessage({ command: 'sampleColor', temperature: Number((controls.querySelector('[name=temperature]') as HTMLInputElement).value), downfall: Number((controls.querySelector('[name=downfall]') as HTMLInputElement).value) })
}
function drawColormap(): void {
  const canvas = root.querySelector<HTMLCanvasElement>('#colormap-preview')!
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, 256, 256)
  if (selectedMap) ctx.drawImage(selectedMap, 0, 0, 256, 256)
  if (marker) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(marker.x - 4, marker.y - 4, 8, 8); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.strokeRect(marker.x - 5, marker.y - 5, 10, 10) }
}

Blockly.defineBlocksWithJsonArray([
  { type: 'mcrh_uvScale', message0: uiText("webview.advanced.uvZoomXY"), args0: [{ type: 'field_number', name: 'x', value: 1, min: 0.01, max: 64 }, { type: 'field_number', name: 'y', value: 1, min: 0.01, max: 64 }], previousStatement: null, nextStatement: null, colour: 185 },
  { type: 'mcrh_scroll', message0: uiText("webview.advanced.timeFlowXY"), args0: [{ type: 'field_number', name: 'x', value: 0.04, min: -10, max: 10 }, { type: 'field_number', name: 'y', value: 0.02, min: -10, max: 10 }], previousStatement: null, nextStatement: null, colour: 185 },
  { type: 'mcrh_rotate', message0: uiText("webview.advanced.rotationSpeed"), args0: [{ type: 'field_number', name: 'speed', value: 0.2, min: -20, max: 20 }], previousStatement: null, nextStatement: null, colour: 185 },
  { type: 'mcrh_stars', message0: uiText("webview.advanced.starSkyDensityBrightness"), args0: [{ type: 'field_number', name: 'density', value: 32, min: 1, max: 256 }, { type: 'field_number', name: 'brightness', value: 1, min: 0, max: 8 }], previousStatement: null, nextStatement: null, colour: 265 },
  { type: 'mcrh_vortex', message0: uiText("webview.advanced.turboStrength"), args0: [{ type: 'field_number', name: 'strength', value: 2, min: -20, max: 20 }], previousStatement: null, nextStatement: null, colour: 265 },
  { type: 'mcrh_tint', message0: uiText("webview.advanced.colourMixRGB"), args0: [{ type: 'field_number', name: 'r', value: 0.4, min: 0, max: 1 }, { type: 'field_number', name: 'g', value: 0.65, min: 0, max: 1 }, { type: 'field_number', name: 'b', value: 1, min: 0, max: 1 }], previousStatement: null, nextStatement: null, colour: 35 },
  { type: 'mcrh_output', message0: uiText("webview.advanced.outputColour"), previousStatement: null, colour: 130 }
])
function initBlockly(): void {
  if (workspace) return
  workspace = Blockly.inject(root.querySelector<HTMLElement>('#blockly')!, {
    toolbox: { kind: 'flyoutToolbox', contents: ['uvScale', 'scroll', 'rotate', 'vortex', 'stars', 'tint', 'output'].map(type => ({ kind: 'block', type: `mcrh_${type}` })) },
    renderer: 'mcrh_static', theme: Blockly.Theme.defineTheme('mcrh', { name: 'mcrh', base: Blockly.Themes.Classic, componentStyles: { workspaceBackgroundColour: getComputedStyle(root).getPropertyValue('--mcrh-bg').trim(), flyoutBackgroundColour: getComputedStyle(root).getPropertyValue('--mcrh-surface').trim(), flyoutOpacity: 1, scrollbarColour: '#67717d' } }), media: assets.blocklyMedia, css: false, sounds: false, trashcan: true,
    zoom: { controls: true, wheel: true, startScale: 0.9, maxScale: 1.5, minScale: 0.5 },
    grid: { spacing: 24, length: 1, colour: '#3c4854', snap: true }
  })
  if (saved?.graph) {
    try { Blockly.serialization.workspaces.load(saved.graph, workspace) } catch { resetGraph() }
  } else resetGraph()
  workspace.scrollCenter()
  workspace.addChangeListener(event => { if (!event.isUiEvent) { invalidateShaderSource(); persist() } })
  new ResizeObserver(() => { if (workspace) Blockly.svgResize(workspace) }).observe(root.querySelector('#blockly')!)
}
function resetGraph(): void {
  if (!workspace) return
  workspace.clear()
  const list = ['scroll', 'stars', 'tint', 'output'].map(name => { const block = workspace!.newBlock(`mcrh_${name}`); block.initSvg(); block.render(); return block })
  for (let index = 0; index < list.length - 1; index++) list[index].nextConnection!.connect(list[index + 1].previousConnection!)
  list[0].moveBy(40, 40)
  workspace.scrollCenter()
  persist()
}
function graphBlocks(): Array<Record<string, unknown>> {
  if (!workspace) return []
  const tops = workspace.getTopBlocks(true).filter(block => !block.isInsertionMarker())
  if (tops.length !== 1) throw new Error(uiText("webview.advanced.pleaseConnectAllTheBlocksToA"))
  const result: Array<Record<string, unknown>> = []
  let block: Blockly.Block | null = tops[0]
  while (block) {
    const type = block.type.replace('mcrh_', '')
    const fields: Record<string, unknown> = { type }
    for (const key of ['x', 'y', 'speed', 'density', 'brightness', 'strength', 'r', 'g', 'b']) if (block.getField(key)) fields[key] = Number(block.getFieldValue(key))
    result.push(fields)
    block = block.getNextBlock()
  }
  return result
}
function sendShader(preview: boolean): void {
  if (busy) return
  try {
    feedbackOwner = activeTab
    const params = { blocks: graphBlocks(), targetVersion: (root.querySelector('#target-version') as HTMLSelectElement).value, includeVanillaTextures: root.querySelector<HTMLInputElement>('#export-include-vanilla')!.checked, includeMcrhEditorData: root.querySelector<HTMLInputElement>('#export-include-mcrh')!.checked, watermark: undefined }
    if (preview) {
      shaderPreviewRequest = crypto.randomUUID()
      shaderSourceViewer.clear(uiText("webview.advanced.generatingSourceCode"))
      api.postMessage({ command: 'shaderPreview', params, requestId: shaderPreviewRequest })
    } else api.postMessage({ command: 'generate', kind: 'shader', params })
  } catch (error) { showResult(String(error)) }
}
root.querySelector('#target-version')!.addEventListener('change', invalidateShaderSource)
root.querySelector('#shader-reset')!.addEventListener('click', resetGraph)
root.querySelector('#shader-show')!.addEventListener('click', () => sendShader(true))
root.querySelector('#shader-export')!.addEventListener('click', () => sendShader(false))
function startPreview(): void {
  if (animation || stopped || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { drawPreview(0); return }
  const tick = (time: number) => { drawPreview(time / 1000); if (activeTab === 'shader' && !stopped) animation = requestAnimationFrame(tick); else animation = 0 }
  animation = requestAnimationFrame(tick)
}
function drawPreview(time: number): void {
  const canvas = root.querySelector<HTMLCanvasElement>('#shader-preview')!
  const ctx = canvas.getContext('2d')!
  let blocks: Array<Record<string, unknown>>
  try { blocks = graphBlocks() } catch { blocks = [] }
  ctx.fillStyle = '#080f24'; ctx.fillRect(0, 0, 320, 320)
  const star = blocks.find(block => block.type === 'stars')
  const tint = blocks.find(block => block.type === 'tint')
  const scroll = blocks.find(block => block.type === 'scroll')
  const vortex = blocks.find(block => block.type === 'vortex')
  const rotation = blocks.find(block => block.type === 'rotate')
  if (!star) return
  const count = Math.min(400, Number(star.density) * 5)
  const channel = (value: unknown) => Math.round(Number(value ?? 1) * 255)
  ctx.fillStyle = `rgb(${channel(tint?.r)},${channel(tint?.g)},${channel(tint?.b)})`
  ctx.save(); ctx.translate(160, 160); ctx.rotate(time * Number(rotation?.speed ?? 0)); ctx.translate(-160, -160)
  for (let index = 0; index < count; index++) {
    let x = (Math.sin(index * 93.31) * 23421.7 % 1 + 1) % 1 * 320
    let y = (Math.sin(index * 41.13 + 4.2) * 51439.2 % 1 + 1) % 1 * 320
    x = ((x + time * Number(scroll?.x ?? 0) * 320) % 320 + 320) % 320
    y = ((y + time * Number(scroll?.y ?? 0) * 320) % 320 + 320) % 320
    if (vortex) { const dx = x - 160, dy = y - 160, angle = Number(vortex.strength) / (Math.hypot(dx, dy) / 30 + 1); x = 160 + dx * Math.cos(angle) - dy * Math.sin(angle); y = 160 + dx * Math.sin(angle) + dy * Math.cos(angle) }
    ctx.globalAlpha = Math.max(0, Math.min(1, Number(star.brightness) * (0.5 + 0.5 * Math.sin(time + index))))
    ctx.fillRect(x, y, index % 9 === 0 ? 2 : 1, index % 9 === 0 ? 2 : 1)
  }
  ctx.restore(); ctx.globalAlpha = 1
}
function showResult(text: string): void {
  const result = root.querySelector<HTMLElement>('#result')!
  result.textContent = text
  result.hidden = !text.trim()
  placeFeedback()
  feedback.hidden = !text.trim() && !busy
}
window.addEventListener('message', event => {
  const message = event.data as Record<string, unknown>
  if (!message || typeof message !== 'object') return
  if (message.type === 'workbenchNavigate' && message.page === 'packs') { activateTab('packs'); packTools.openConversion(typeof message.projectToken === 'string' ? message.projectToken : undefined) }
  packTools.receive(message)
  textureBatch.receive(message)
  studio?.receive(message)
  tintPresets.receive(message)
  shaderSourceViewer.receive(message)
  if (message.type === 'status') {
    const wasBusy = busy
    busy = message.busy === true
    if (busy && !wasBusy) { feedbackOwner ??= activeTab; feedback.querySelector('#result')!.textContent = '' }
    if (busy) { placeFeedback(); feedback.hidden = false; feedback.querySelector<HTMLElement>('#result')!.hidden = true }
    root.querySelector('#status')!.textContent = String(message.text ?? '')
    if (!busy) { const result = feedback.querySelector<HTMLElement>('#result')!; result.hidden = !result.textContent?.trim(); feedback.hidden = result.hidden }
    feedback.querySelector<HTMLButtonElement>('#feedback-close')!.hidden = busy
    for (const btn of root.querySelectorAll<HTMLButtonElement>('form button, [data-pick], [data-sample], #shader-export, #shader-show, #workbench-export-pack')) btn.disabled = busy
    for (const btn of root.querySelectorAll<HTMLButtonElement>('[data-cancel]')) btn.hidden = !busy
  }
  if (message.type === 'result') showResult(String(message.text ?? ''))
  if (message.type === 'shaderCode' && shaderPreviewRequest && message.requestId === shaderPreviewRequest) {
    const sources = Array.isArray(message.sources) ? message.sources.filter((source): source is ShaderSourceFile => Boolean(source) && typeof source === 'object' && typeof source.id === 'string' && typeof source.label === 'string' && typeof source.content === 'string') : []
    shaderSourceViewer.setSources(sources, Array.isArray(message.warnings) ? message.warnings.filter((warning): warning is string => typeof warning === 'string') : [])
  }
  if (message.type === 'log') { const log = root.querySelector('#optimizer-log')!; log.textContent = (log.textContent + String(message.text ?? '')).slice(-40000); log.scrollTop = log.scrollHeight }
  if (message.type === 'source') {
    const role = String(message.role)
    const label = root.querySelector(`[data-source="${CSS.escape(role)}"]`)
    if (label) label.textContent = String(message.name ?? '')
    if (typeof message.image === 'string') {
      if (role === 'colormap') { selectedMap = new Image(); selectedMap.onload = () => { drawColormap(); sampleColor() }; selectedMap.src = message.image }
      const image = root.querySelector<HTMLImageElement>(`#${CSS.escape(role)}-preview`)
      if (image) { image.src = message.image; image.hidden = false }
    }
  }
  if (message.type === 'sampleColor') { marker = { x: Number(message.x), y: Number(message.y) }; root.querySelector('#sample-result')!.textContent = uiText("webview.advanced.coordinates", marker.x, marker.y, message.color); drawColormap() }
  if (message.type === 'catalog') renderCatalog(message.entries as Array<Record<string, unknown>>)
  if (message.type === 'versions') { renderVersions(message.entries as Array<Record<string, unknown>>, typeof message.selected === 'string' ? message.selected : undefined); tintPresets.refresh() }
})
function renderCatalog(entries: Array<Record<string, unknown>>): void {
  const list = root.querySelector('#sample-list')!
  list.replaceChildren()
  if (!entries.length) { list.textContent = uiText("webview.advanced.exampleNotDetectedPleaseSelectYourOwn"); return }
  for (const entry of entries) {
    const card = document.createElement('article'); card.className = 'card sample-card'
    const title = document.createElement('h2'); title.textContent = String(entry.name)
    const detail = document.createElement('p'); detail.textContent = String(entry.description ?? '')
    const badge = document.createElement('p'); badge.className = 'muted'; badge.textContent = String(entry.requirements ?? '')
    const button = document.createElement('button'); button.textContent = entry.canImport === false ? uiText("webview.advanced.moduleResourceOnlyCheckedNotImportedAs") : uiText("webview.advanced.viewFilesAndImport"); button.disabled = entry.canImport === false; button.dataset.sample = String(entry.id)
    card.append(title, detail, badge, button); list.append(card)
  }
}
function renderVersions(entries: Array<Record<string, unknown>>, selected?: string): void {
  const list = root.querySelector('#version-list')!
  list.replaceChildren()
  const version = root.querySelector<HTMLSelectElement>('#target-version')!
  const current = selected ?? saved?.fields?.['target-version:target-version'] ?? version.value
  version.replaceChildren()
  for (const entry of entries) {
    const opt = document.createElement('option'); opt.value = String(entry.id); opt.textContent = `${entry.id} (${entry.status ?? uiText("webview.advanced.versionInformation")})`; version.append(opt)
    const item = document.createElement('div'); item.className = 'version-row'
    const title = document.createElement('strong'); title.textContent = String(entry.id)
    const content = document.createElement('p'); content.textContent = String(entry.summary ?? '')
    item.append(title, content); list.append(item)
  }
  if (Array.from(version.options).some(option => option.value === current)) version.value = String(current)
  persist()
}
window.addEventListener('pagehide', event => {
  if (event.persisted) return
  packTools.dispose(); textureBatch.dispose(); tintPresets.dispose(); shaderSourceViewer.dispose(); watermarkTools.dispose(); studio?.dispose()
})
document.addEventListener('visibilitychange', () => { studio?.activate(activeTab === 'studio'); stopped = document.hidden; if (stopped) { cancelAnimationFrame(animation); animation = 0 } else if (activeTab === 'shader') startPreview() })
syncPbrControls()
activateTab(activeTab)
api.postMessage({ command: 'ready' })

export function hasWorkbenchSession(): boolean {
  return packTools.hasSession() || textureBatch.hasSession()
}
