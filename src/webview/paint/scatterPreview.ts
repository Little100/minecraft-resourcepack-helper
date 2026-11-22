import { uiHtml, uiText } from '../../i18n/messages'
import { scatterNearby, seededRandom } from '../../core/nearbyColor'
import { compositeAt } from '../painting'
import type { App } from './app'
import { commitDiff } from './strokes'
import { previewLayers, type LayerBuffer } from './state'

export function openScatterPreview(app: App): void {
  const state = app.state, layer = state.layers.find(value => value.id === state.activeLayerId)
  if (!layer) return
  if (!layer.visible) { app.notify(uiText("webview.paint.scatterPreview.theCurrentLayerIsHiddenPleaseShow"), 'warn'); return }
  if (app.hasPendingTransform?.()) { app.notify(uiText("webview.paint.edgeRecolor.pleaseConfirmOrCancelTheLayerChanges"), 'warn'); return }
  const revision = state.revision, before = layer.pixels.slice(), mask = state.selection?.mask.slice(), color = [...state.color] as typeof state.color
  const dialog = document.createElement('dialog'); dialog.className = 'mp-effect-dialog'; dialog.setAttribute('aria-label', uiText("webview.paint.scatterPreview.randomlyMakeALittlePreview"))
  dialog.innerHTML = `<header><div><h2>${uiHtml("webview.paint.scatterPreview.randomly")}</h2><p>${uiHtml("webview.paint.scatterPreview.changeGroupDistributionToBeDeterminedWhen")}</p></div><button data-scatter="cancel">${uiHtml("browser.shell.cancel")}</button></header><div class="mp-scatter-controls"><label>${uiHtml("webview.paint.scatterPreview.seedFixedRandomSeeds")}<input data-scatter="seed" maxlength="256" type="text"></label><button data-scatter="reroll">${uiHtml("webview.paint.scatterPreview.changeTheGroup")}</button><label>${uiHtml("webview.paint.options.colourChange")}<input data-scatter="range" type="number" required min="0" max="64"></label><label>${uiHtml("webview.paint.options.pluginDensity")}<input data-scatter="density" type="number" required min="0" max="100"></label><label><input data-scatter="opaque" type="checkbox">${uiHtml("webview.paint.options.nonTransparentAreaOnly")}</label><button data-scatter="compare" type="button">${uiHtml("webview.paint.edgeRecolor.viewOriginalMaps")}</button></div><div class="mp-scatter-preview"><canvas aria-label="${uiHtml("webview.paint.scatterPreview.randomlyTypeALittleEffectPreview")}"></canvas></div><footer><output data-scatter="status"></output><button data-scatter="apply" class="mcrh-btn">${uiHtml("webview.paint.scatterPreview.makeSureYouHitIt")}</button></footer>`
  const input = (name: string): HTMLInputElement => dialog.querySelector('[data-scatter=' + name + ']')!
  const seed = input('seed'), range = input('range'), density = input('density'), opaque = input('opaque'), canvas = dialog.querySelector('canvas')!, status = dialog.querySelector<HTMLOutputElement>('output')!, apply = dialog.querySelector<HTMLButtonElement>('[data-scatter=apply]')!
  const freshSeed = (): string => String(crypto.getRandomValues(new Uint32Array(1))[0])
  seed.value = state.scatterSeed ?? freshSeed(); range.value = String(state.nearbyRange); density.value = String(state.scatterDensity); opaque.checked = state.scatterOpaqueOnly
  let candidate: Uint8Array | undefined, showOriginal = false, frame = 0
  const valid = (): boolean => state.revision === revision && state.layers.includes(layer) && layer.visible && state.activeLayerId === layer.id
  function render(): void {
    frame = 0
    if (!dialog.open) return
    if (!valid()) { apply.disabled = true; status.textContent = uiText("webview.paint.scatterPreview.theWorkHasBeenUpdatedPleaseReopen"); return }
    if (!seed.value.trim() || !range.checkValidity() || !density.checkValidity()) { apply.disabled = true; status.textContent = uiText("webview.paint.scatterPreview.pleaseFillInTheParametersForId"); return }
    candidate = before.slice()
    const count = scatterNearby(candidate, color, Number(range.value), Number(density.value), mask, opaque.checked, seededRandom(seed.value))
    const layers: LayerBuffer[] = previewLayers(state).map(value => value === layer ? { ...value, pixels: showOriginal ? before : candidate! } : value)
    const height = state.frameHeight ?? state.height, ratio = Math.min(1, 512 / Math.max(state.width, height))
    canvas.width = Math.max(1, Math.round(state.width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio))
    const image = new ImageData(canvas.width, canvas.height)
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) image.data.set(compositeAt(layers, state.width, Math.min(state.width - 1, Math.floor(x / ratio)), Math.min(height - 1, Math.floor(y / ratio))), (y * canvas.width + x) * 4)
    canvas.getContext('2d')!.putImageData(image, 0, 0)
    status.textContent = count + uiText("webview.paint.scatterPreview.seed") + seed.value + (state.frameCount > 1 ? uiText("webview.paint.scatterPreview.showTheFrontFrameAndApplyAll") : '')
    apply.disabled = false
  }
  const queue = (): void => { if (!frame) frame = requestAnimationFrame(render) }
  const close = (): void => dialog.close()
  dialog.addEventListener('keydown', event => event.stopPropagation())
  dialog.addEventListener('input', queue)
  dialog.querySelector('[data-scatter=reroll]')!.addEventListener('click', () => { seed.value = freshSeed(); queue() })
  dialog.querySelector('[data-scatter=compare]')!.addEventListener('click', event => { showOriginal = !showOriginal; (event.currentTarget as HTMLButtonElement).textContent = showOriginal ? uiText("webview.paint.scatterPreview.checkItOut") : uiText("webview.paint.edgeRecolor.viewOriginalMaps"); queue() })
  dialog.querySelector('[data-scatter=cancel]')!.addEventListener('click', close)
  apply.addEventListener('click', () => {
    if (frame) { cancelAnimationFrame(frame); render() }
    if (!candidate || !valid() || apply.disabled) { app.notify(uiText("webview.paint.scatterPreview.theWorkHasBeenUpdatedOrThe"), 'warn'); return }
    layer.pixels.set(candidate); state.scatterSeed = seed.value; state.nearbyRange = Number(range.value); state.scatterDensity = Number(density.value); state.scatterOpaqueOnly = opaque.checked
    app.host.savePreferences?.({ scatterSeed: seed.value, nearbyRange: state.nearbyRange, scatterDensity: state.scatterDensity, scatterOpaqueOnly: opaque.checked })
    commitDiff(app, layer, before); app.requestChrome(); close()
  })
  dialog.addEventListener('close', () => { if (frame) cancelAnimationFrame(frame); canvas.width = 0; canvas.height = 0; candidate = undefined; dialog.remove() }, { once: true })
  document.body.append(dialog); dialog.showModal(); render()
}
