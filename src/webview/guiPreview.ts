import { uiHtml, uiText } from '../i18n/messages'
import { DEFAULT_GUI_SETTINGS, GUI_SCENES, guiSceneDraws, guiSettingsForPath, guiSpritePatches, isGuiScene, normalizeGuiSettings, type GuiDraw, type GuiNumberSetting, type GuiPreviewData, type GuiScene, type GuiSettings } from '../core/guiPreview'
import { enhanceNativeSelects } from './selectControls'
declare function acquireVsCodeApi(): { postMessage(value: unknown): void; getState(): unknown; setState(value: unknown): void }
const host = acquireVsCodeApi()
const saved = host.getState() as { scene?: unknown; settings?: Partial<GuiSettings>; zoom?: unknown; background?: unknown; selected?: unknown } | undefined
let settings = normalizeGuiSettings(saved?.settings && typeof saved.settings === 'object' ? saved.settings : DEFAULT_GUI_SETTINGS)
let scene: GuiScene = isGuiScene(saved?.scene) ? saved.scene : 'hud'
let zoom = typeof saved?.zoom === 'number' && [0, 0.5, 1, 2, 3, 4, 6, 8].includes(saved.zoom) ? saved.zoom : 0
let background = ['checker', 'dark', 'light'].includes(String(saved?.background)) ? String(saved?.background) : 'checker'
let data: GuiPreviewData | undefined, drawGeneration = 0, selectedKey: string | undefined, lastTexture: string | undefined, lastHudTexture: string | undefined = typeof saved?.selected === 'string' ? saved.selected : undefined
let requestedScene: GuiScene | undefined
let highlightSelection = false
let draws: GuiDraw[] = []
const images = new Map<string, HTMLImageElement>()
const root = document.createElement('main'); root.className = 'gui-preview-page'
root.innerHTML = `<header class="gui-header"><div class="gui-heading"><span class="codicon codicon-layout" aria-hidden="true"></span><div><h1>${uiHtml("ui.sidebarTree.guiHudPreview")}</h1><p class="gui-pack">${uiHtml("webview.guiPreview.readingMaterialPackages")}</p></div></div><div class="gui-header-actions"><button type="button" data-action="pack">${uiHtml("webview.guiPreview.switchResourcePack")}</button><button type="button" data-action="vanilla">${uiHtml("webview.guiPreview.prepareVanillaAssets")}</button><button type="button" data-action="refresh" title="${uiHtml("webview.guiPreview.reloadResources")}">${uiHtml("webview.collaboration.refresh")}</button></div></header>
<nav class="gui-scenes" aria-label="${uiHtml("webview.guiPreview.previewScene")}"></nav>
<div class="gui-toolbar"><label>${uiHtml("webview.guiPreview.viewportSize")} <select aria-label="${uiHtml("webview.guiPreview.viewportSize")}"><option value="320,240">320 × 240</option><option value="426,240">426 × 240</option><option value="480,270">480 × 270</option><option value="640,360">640 × 360</option><option value="960,540">960 × 540</option></select></label><label>${uiHtml("webview.guiPreview.displayScale")} <select aria-label="${uiHtml("webview.guiPreview.displayScale")}"><option value="0">${uiHtml("ui.tutorialCards.fitToWindow")}</option><option value="0.5">50%</option><option value="1">100%</option><option value="2">200%</option><option value="3">300%</option><option value="4">400%</option><option value="6">600%</option><option value="8">800%</option></select></label><label>${uiHtml("core.document.background")} <select aria-label="${uiHtml("webview.guiPreview.previewBackground")}"><option value="checker">${uiHtml("webview.guiPreview.transparencyGrid")}</option><option value="dark">${uiHtml("browser.shell.dark")}</option><option value="light">${uiHtml("browser.shell.light")}</option></select></label><span class="gui-scale-info"></span></div>
<div class="gui-workspace"><section class="gui-preview-area" aria-label="${uiHtml("webview.guiPreview.compositePreview")}"><div class="gui-stage" tabindex="0" aria-label="${uiHtml("webview.guiPreview.gameInterfaceCanvasRollerScalingMiddleButton")}"><canvas aria-label="${uiHtml("webview.guiPreview.guiHudPixelPreview")}"></canvas></div><footer class="gui-stage-caption"><span class="gui-scene-description"></span><span>${uiHtml("webview.guiPreview.scrollToZoomMiddleDragToPan")}</span></footer></section><aside class="gui-inspector"><section class="gui-section gui-controls"><h2>${uiHtml("webview.guiPreview.sceneSettings")}</h2></section><section class="gui-section"><h2>${uiHtml("webview.guiPreview.pasteUsedForScenes")} <span class="gui-texture-count"></span></h2><p class="gui-small">${uiHtml("webview.guiPreview.currentPackagePriorityUsingTheBasisOf")}</p><div class="gui-textures"></div></section><section class="gui-section gui-issues-section" hidden><h2>${uiHtml("webview.guiPreview.needsReview")}</h2><ul class="gui-issues"></ul></section><section class="gui-section gui-boundary"><h2>${uiHtml("webview.guiPreview.previewScope")}</h2><p>${uiHtml("webview.guiPreview.useActualPasteAndFixedOriginalLayouts")}</p><p>${uiHtml("webview.guiPreview.aSuperstarUsesACommonTransparentMix")}</p></section></aside></div><p class="gui-status" role="status">${uiHtml("webview.guiPreview.preparingPreview")}</p>`
document.body.append(root)
const find = <T extends Element>(selector: string): T => root.querySelector<T>(selector)!
const canvas = find<HTMLCanvasElement>('canvas'), stage = find<HTMLElement>('.gui-stage'), ctx = canvas.getContext('2d')!
const status = find<HTMLElement>('.gui-status'), controls = find<HTMLElement>('.gui-controls'), textureList = find<HTMLElement>('.gui-textures')
const zoomInput = find<HTMLSelectElement>("[aria-label=\"" + uiText("webview.guiPreview.displayScale") + "\"]"), screenInput = find<HTMLSelectElement>("[aria-label=\"" + uiText("webview.guiPreview.viewportSize") + "\"]"), backgroundInput = find<HTMLSelectElement>("[aria-label=\"" + uiText("webview.guiPreview.previewBackground") + "\"]")
function persist(): void { host.setState({ scene, settings, zoom, background, selected: data?.selected }) }
function report(message: string, error = false): void { status.textContent = message; status.classList.toggle('is-error', error); status.setAttribute('role', error ? 'alert' : 'status') }
function resize(): void {
  const available = Math.min((stage.clientWidth - 40) / settings.width, (stage.clientHeight - 40) / settings.height)
  const factor = zoom || (available >= 1 ? Math.min(8, Math.floor(available)) : Math.max(0.25, available))
  canvas.style.width = Math.round(settings.width * factor) + 'px'; canvas.style.height = Math.round(settings.height * factor) + 'px'
  find('.gui-scale-info').textContent = settings.width + ' × ' + settings.height + ' GUI px · ' + Math.round(factor * 100) + '%'
}
function render(): void {
  canvas.width = settings.width; canvas.height = settings.height
  ctx.imageSmoothingEnabled = false
  if (background !== 'checker') { ctx.fillStyle = background === 'dark' ? '#20252b' : '#e7e8ea'; ctx.fillRect(0, 0, canvas.width, canvas.height) }
  canvas.dataset.background = background
  draws = guiSceneDraws(scene, settings)
  for (const draw of draws) {
    const sprite = data?.scene === scene ? data.sprites.find(sprite => sprite.id === draw.id) : undefined
    const image = sprite ? images.get(sprite.texture) : undefined
    ctx.save()
    if (draw.clip) { ctx.beginPath(); ctx.rect(draw.clip.x, draw.clip.y, draw.clip.w, draw.clip.h); ctx.clip() }
    if (sprite && image) {
      try { for (const patch of guiSpritePatches(sprite.scaling, sprite.rect, draw)) ctx.drawImage(image, patch.source.x, patch.source.y, patch.source.w, patch.source.h, patch.target.x, patch.target.y, patch.target.w, patch.target.h) }
      catch (error) { report(error instanceof Error ? error.message : String(error), true) }
    } else {
      ctx.fillStyle = '#d169691a'; ctx.fillRect(draw.x, draw.y, draw.w, draw.h)
      ctx.strokeStyle = '#d16969'; ctx.setLineDash([2, 2]); ctx.lineWidth = 1; ctx.strokeRect(draw.x + 0.5, draw.y + 0.5, draw.w - 1, draw.h - 1)
    }
    ctx.restore()
    if (highlightSelection && selectedKey && sprite?.texture === selectedKey) { ctx.save(); ctx.strokeStyle = '#4ca8ef'; ctx.lineWidth = 1; ctx.strokeRect(draw.x + 0.5, draw.y + 0.5, draw.w - 1, draw.h - 1); ctx.restore() }
  }
  resize()
}
let controlScene: GuiScene | undefined
const updateControls: Array<() => void> = []
function addSlider(key: GuiNumberSetting, title: string, min: number, max: number, step = 1): void {
  const label = document.createElement('label'); label.className = 'gui-slider'
  const heading = document.createElement('span'), name = document.createElement('span'), value = document.createElement('output'); name.textContent = title; heading.append(name, value)
  const input = document.createElement('input'); input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(settings[key]); input.setAttribute('aria-label', title)
  const update = (): void => {
    if (Number(input.value) !== settings[key]) input.value = String(settings[key])
    value.textContent = key === 'slot' ? String(settings[key] + 1) : step < 1 ? Math.round(settings[key] * 100) + '%' : String(settings[key])
  }
  updateControls.push(update)
  input.addEventListener('input', () => { settings = normalizeGuiSettings({ ...settings, [key]: Number(input.value) }); update(); persist(); render() }); label.append(heading, input); controls.append(label)
}
function mountSceneControls(): void {
  updateControls.length = 0
  controls.replaceChildren(Object.assign(document.createElement('h2'), { textContent: uiText("webview.guiPreview.sceneSettings") }))
  if (scene === 'hud') {
    addSlider('slot', uiText("core.guiPreview.selectedSlot"), 0, 8); addSlider('health', uiText("webview.guiPreview.health"), 0, 20); addSlider('food', uiText("webview.guiPreview.hunger"), 0, 20)
    const effectLabel = document.createElement('label'); effectLabel.className = 'gui-effect-toggle'
    const effect = document.createElement('input'); effect.type = 'checkbox'; effect.checked = settings.hungerEffect; effect.setAttribute('aria-label', uiText("webview.guiPreview.hungerEffect"))
    const effectText = document.createElement('span'); effectText.textContent = uiText("webview.guiPreview.hungerEffect")
    const effectHint = document.createElement('small'); effectHint.textContent = uiText("webview.guiPreview.useFoodHungerStickersEGAfter")
    effect.addEventListener('change', () => { settings = { ...settings, hungerEffect: effect.checked }; persist(); render() })
    updateControls.push(() => { effect.checked = settings.hungerEffect })
    effectLabel.append(effect, effectText, effectHint); controls.append(effectLabel)
    addSlider('armor', uiText("webview.guiPreview.armourValue"), 0, 20); addSlider('experience', uiText("webview.guiPreview.progressOfExperience"), 0, 1, 0.01)
  } else if (scene === 'furnace') addSlider('progress', uiText("webview.guiPreview.refiningBurningProgress"), 0, 1, 0.01)
  else if (scene === 'widgets' || scene === 'texture') { addSlider('widgetWidth', uiText("webview.guiPreview.targetWidth"), 1, 512); addSlider('widgetHeight', uiText("webview.guiPreview.targetHeight"), 1, 320) }
  else controls.append(Object.assign(document.createElement('p'), { textContent: uiText("webview.guiPreview.fixedOriginalContainerLayoutTailoredToOriginal"), className: 'gui-small' }))
}
function chrome(): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>('.gui-scenes button')) { const active = button.dataset.scene === scene; button.setAttribute('aria-pressed', String(active)); button.classList.toggle('is-active', active) }
  find('.gui-scene-description').textContent = GUI_SCENES.find(entry => entry.id === scene)!.note
  if (controlScene !== scene) { mountSceneControls(); controlScene = scene }
  for (const update of updateControls) update()
  zoomInput.value = String(zoom); backgroundInput.value = background
  const size = settings.width + ',' + settings.height
  for (const option of [...screenInput.options]) if (option.dataset.custom) option.remove()
  if (![...screenInput.options].some(option => option.value === size)) { const option = new Option(settings.width + ' × ' + settings.height, size); option.dataset.custom = 'true'; screenInput.add(option) }
  screenInput.value = size
}
for (const entry of GUI_SCENES) {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = entry.label; button.dataset.scene = entry.id; button.title = entry.note
  button.addEventListener('click', () => { if (scene === entry.id) return; drawGeneration++; requestedScene = entry.id; scene = entry.id; selectedKey = undefined; chrome(); persist(); render(); host.postMessage({ command: 'guiScene', scene }) })
  find('.gui-scenes').append(button)
}
for (const [action, command] of [['refresh', 'guiRefresh'], ['vanilla', 'guiPrepareVanilla'], ['pack', 'guiChoosePack']]) find(`[data-action="${action}"]`).addEventListener('click', () => host.postMessage({ command }))
zoomInput.addEventListener('change', () => { zoom = Number(zoomInput.value); persist(); resize() })
backgroundInput.addEventListener('change', () => { background = backgroundInput.value; persist(); render() })
screenInput.addEventListener('change', () => { const [width, height] = screenInput.value.split(',').map(Number); settings = normalizeGuiSettings({ ...settings, width, height }); persist(); render() })
function select(key: string | undefined): void {
  selectedKey = key; highlightSelection = !!key
  for (const row of textureList.querySelectorAll<HTMLElement>('[data-key]')) row.classList.toggle('is-selected', row.dataset.key === key)
  render()
}
function open(key: string): void { if (data) host.postMessage({ command: 'guiOpenTexture', revision: data.revision, key }) }
function hit(event: MouseEvent): string | undefined {
  const bounds = canvas.getBoundingClientRect(), x = (event.clientX - bounds.left) / bounds.width * canvas.width, y = (event.clientY - bounds.top) / bounds.height * canvas.height
  for (const draw of [...draws].reverse()) { const r = draw.clip ?? draw; if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return data?.sprites.find(sprite => sprite.id === draw.id)?.texture }
  return undefined
}
canvas.addEventListener('click', event => select(hit(event)))
canvas.addEventListener('dblclick', event => { const key = hit(event); if (key) open(key) })
canvas.addEventListener('mousemove', event => { canvas.style.cursor = hit(event) ? 'pointer' : 'default' })
stage.addEventListener('wheel', event => {
  event.preventDefault()
  const old = canvas.getBoundingClientRect(), x = (event.clientX - old.left) / old.width, y = (event.clientY - old.top) / old.height
  const factor = old.width / canvas.width, choices = [0.5, 1, 2, 3, 4, 6, 8]
  zoom = event.deltaY < 0 ? choices.find(value => value > factor + 0.01) ?? 8 : [...choices].reverse().find(value => value < factor - 0.01) ?? 0.5
  if (![...zoomInput.options].some(option => Number(option.value) === zoom)) zoomInput.add(new Option('50%', '0.5'))
  zoomInput.value = String(zoom); resize()
  const next = canvas.getBoundingClientRect(); stage.scrollLeft += next.left + x * next.width - event.clientX; stage.scrollTop += next.top + y * next.height - event.clientY
  persist()
}, { passive: false })
let pan: { id: number; x: number; y: number; left: number; top: number } | undefined
stage.addEventListener('pointerdown', event => { if (event.button !== 1) return; event.preventDefault(); pan = { id: event.pointerId, x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop }; stage.setPointerCapture(event.pointerId); stage.classList.add('is-panning') })
stage.addEventListener('pointermove', event => { if (pan?.id !== event.pointerId) return; stage.scrollLeft = pan.left - event.clientX + pan.x; stage.scrollTop = pan.top - event.clientY + pan.y })
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) stage.addEventListener(name, () => { pan = undefined; stage.classList.remove('is-panning') })
stage.addEventListener('auxclick', event => { if (event.button === 1) event.preventDefault() })
const observer = new ResizeObserver(resize); observer.observe(stage)
window.addEventListener('pagehide', () => observer.disconnect(), { once: true })
window.addEventListener('message', async event => {
  const message = event.data
  if (message?.command === 'guiSelectScene' && isGuiScene(message.scene)) { drawGeneration++; requestedScene = message.scene; scene = message.scene; selectedKey = undefined; chrome(); persist(); render(); return }
  if (message?.command === 'guiStatus' && typeof message.message === 'string') { report(message.message, !!message.error); find<HTMLButtonElement>('[data-action="vanilla"]').disabled = !!message.preparing; return }
  if (message?.command !== 'guiData' || !message.data || !isGuiScene(message.data.scene) || !Array.isArray(message.data.textures) || !Array.isArray(message.data.sprites) || !Array.isArray(message.data.warnings)) return
  const next = message.data as GuiPreviewData
  if (!Number.isSafeInteger(next.revision) || next.revision <= (data?.revision ?? -1) || requestedScene && requestedScene !== next.scene) return
  const generation = ++drawGeneration
  const decoded = await Promise.all(next.textures.map(async texture => {
    const image = new Image(); image.src = texture.png
    try { await image.decode(); return [texture.key, image] as const } catch { return undefined }
  }))
  if (generation !== drawGeneration) return
  const sourceChanged = data?.selected !== next.selected
  data = next; scene = data.scene; root.dataset.loadedScene = scene; images.clear()
  for (const entry of decoded) if (entry) images.set(entry[0], entry[1])
  if (scene === 'hud' && lastHudTexture !== data.selected) {
    settings = normalizeGuiSettings({ ...settings, ...guiSettingsForPath(data.selected) })
    lastHudTexture = data.selected
  }
  if (scene === 'texture' && lastTexture !== data.selected) {
    const sprite = data.sprites[0]
    if (sprite) { const w = sprite.scaling.type === 'stretch' ? sprite.rect.w : sprite.scaling.width, h = sprite.scaling.type === 'stretch' ? sprite.rect.h : sprite.scaling.height; settings = normalizeGuiSettings({ ...settings, widgetWidth: w, widgetHeight: h, width: Math.max(settings.width, w + 32), height: Math.max(settings.height, h + 32) }) }
    lastTexture = data.selected
  }
  if (sourceChanged || !next.textures.some(texture => texture.key === selectedKey)) {
    selectedKey = next.selected && next.textures.some(texture => texture.key === next.selected) ? next.selected : undefined
    highlightSelection = false
  }
  find('.gui-pack').textContent = data.name + ' · Java ' + (data.version ?? uiText("webview.guiPreview.versionNotSpecified"))
  find('.gui-texture-count').textContent = String(data.textures.length)
  textureList.replaceChildren()
  for (const texture of data.textures) {
    const row = document.createElement('div'); row.className = 'gui-texture'; row.dataset.key = texture.key; row.classList.toggle('is-selected', texture.key === selectedKey)
    const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'gui-texture-select'; preview.title = texture.path; preview.setAttribute('aria-label', uiText("webview.guiPreview.positioning", texture.path))
    const thumb = document.createElement('img'); thumb.src = texture.png; thumb.alt = ''; const text = document.createElement('span'), title = document.createElement('span'), source = document.createElement('small'); title.textContent = texture.path.split('/gui/')[1]; source.textContent = texture.sourceLabel + (texture.dirty ? uiText("webview.guiPreview.unsaved") : '') + ' · ' + texture.width + '×' + texture.height; text.append(title, source); preview.append(thumb, text); preview.addEventListener('click', () => select(texture.key))
    const button = document.createElement('button'); button.type = 'button'; button.className = 'gui-texture-open'; button.textContent = texture.sourceLabel === uiText("gui.currentPack") ? uiText("ui.tutorialCards.edit") : uiText("webview.gitView.view"); button.setAttribute('aria-label', uiText("webview.guiPreview.open", texture.path)); button.addEventListener('click', () => open(texture.key)); row.append(preview, button); textureList.append(row)
  }
  const issues = [...data.warnings, ...data.textures.filter(texture => !images.has(texture.key)).map(texture => uiText("webview.guiPreview.browserCannotDecode", texture.path))]
  find<HTMLElement>('.gui-issues-section').hidden = !issues.length
  const list = find('.gui-issues'); list.replaceChildren()
  for (const warning of issues) list.append(Object.assign(document.createElement('li'), { textContent: warning }))
  chrome(); persist(); render()
})
chrome(); render(); enhanceNativeSelects(); host.postMessage({ command: 'guiReady', scene: saved?.scene })
