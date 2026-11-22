import { uiHtml, uiText } from '../../i18n/messages'
import { variantLayers } from '../../core/randomVariants'
import { DEFAULT_EDGE_RECOLOR, edgeRecolorOptions, type EdgeRecolorOptions } from '../../core/edgeRecolor'
import { recolorLayerComposite } from '../../core/layerEdgeRecolor'
import { onHostMessage } from '../bus'
import { compositeAt } from '../painting'
import type { App } from './app'
import { el } from './dom'

export function mountEdgeRecolor(parent: HTMLElement, app: App): void {
  const dialog = el('dialog', 'mp-effect-dialog')
  dialog.id = 'mp-edge-recolor-dialog'
  dialog.setAttribute('aria-label', uiText("webview.paint.edgeRecolor.automaticEdgesHeavyOnColour"))
  dialog.innerHTML = `<header><div><h2>${uiHtml("webview.paint.edgeRecolor.automaticEdgesHeavyOnColour")}</h2><p>${uiHtml("webview.paint.edgeRecolor.clearAndDarkContourOrAdjacentBlock")}</p></div><button data-edge="close" aria-label="${uiHtml("webview.paint.edgeRecolor.closeEdgeColored")}">${uiHtml("browser.resources.close")}</button></header>
<div class="mp-effect-layout"><div class="mp-effect-visual"><div class="mp-effect-preview mp-checker"><canvas aria-label="${uiHtml("webview.paint.edgeRecolor.edgeHeavyColourPreview")}"></canvas></div><button data-edge="compare" aria-pressed="false">${uiHtml("webview.paint.edgeRecolor.viewOriginalMaps")}</button><p data-edge-preview-label>${uiHtml("webview.paint.edgeRecolor.effectsPreview")}</p></div>
<div class="mp-effect-controls">
<label>${uiHtml("webview.paint.edgeRecolor.roleLayer")}<select data-edge-field="scope"><option value="selected">${uiHtml("webview.paint.edgeRecolor.selectedLayer")}</option><option value="active">${uiHtml("webview.paint.edgeRecolor.currentLayer")}</option><option value="all">${uiHtml("webview.paint.edgeRecolor.allLayersIncludingHiddenLayers")}</option></select></label>
<label>${uiHtml("webview.paint.edgeRecolor.effects")}<select data-edge-field="mode"><option value="bevel">${uiHtml("webview.paint.edgeRecolor.contoursLevelLightedBackdark")}</option><option value="darken">${uiHtml("webview.paint.edgeRecolor.closerToTheEdge")}</option><option value="lighten">${uiHtml("webview.paint.edgeRecolor.closeToTheEdgeToLightUp")}</option><option value="transition">${uiHtml("webview.paint.edgeRecolor.midChooseTransitionToAdjacentColorBlock")}</option></select></label>
<div class="mp-effect-transition" data-edge-transition hidden>
<label>${uiHtml("webview.paint.edgeRecolor.organisation")}<select data-edge-field="transitionSide"><option value="lighter">${uiHtml("webview.paint.edgeRecolor.lightSideDarkProfileRetained")}</option><option value="darker">${uiHtml("webview.paint.edgeRecolor.darkSide")}</option><option value="both">${uiHtml("webview.paint.edgeRecolor.onBothSidesOfTheBorder")}</option></select></label>
<label>${uiHtml("webview.paint.edgeRecolor.transitionalColourSource")}<select data-edge-field="transitionSource"><option value="nearby">${uiHtml("webview.paint.edgeRecolor.thereSAMiddleColorInThe")}</option><option value="mix">${uiHtml("webview.paint.edgeRecolor.directlyMixedWithTwoColours")}</option></select></label>
<label>${uiHtml("webview.paint.edgeRecolor.distanceColourScales")}<input data-edge-field="transitionSteps" type="number" min="1" max="8" value="2"></label>
<p>${uiHtml("webview.paint.edgeRecolor.noSuitableMiddleColoursAreAutomaticallyMixed")}</p>
</div>
<label>${uiHtml("webview.paint.edgeRecolor.edgeWidthPixels")}<input data-edge-field="radius" type="number" min="1" max="32" value="2"></label>
<label><span data-edge-strength-label>${uiHtml("webview.paint.edgeRecolor.darkness")}</span><output data-edge-strength>25%</output><input data-edge-field="strength" type="range" min="0" max="1" step="0.01" value="0.25"></label>
<p data-edge-mix-help hidden>${uiHtml("webview.paint.edgeRecolor.colourTargetWithMiddleColourOnBoth")}</p>
<label data-edge-shading>${uiHtml("webview.paint.edgeRecolor.hueOffsetDegrees")}<output data-edge-hue>6°</output><input data-edge-field="hueShift" type="range" min="-60" max="60" step="1" value="6"></label>
<label data-edge-shading>${uiHtml("webview.paint.edgeRecolor.lightedDirection")}<select data-edge-field="light"><option value="top-left">${uiHtml("webview.paint.edgeRecolor.topLeft")}</option><option value="top-right">${uiHtml("webview.paint.edgeRecolor.topRight")}</option><option value="bottom-left">${uiHtml("webview.paint.edgeRecolor.bottomLeft")}</option><option value="bottom-right">${uiHtml("webview.paint.edgeRecolor.bottomRight")}</option></select></label>
<label class="mp-effect-check" data-edge-shading><input data-edge-field="colorEdges" type="checkbox">${uiHtml("webview.paint.edgeRecolor.alsoIdentifyTheInternalBorderOfAdjacent")}</label>
<label>${uiHtml("webview.paint.edgeRecolor.colorBlockBorderDifference")}<input data-edge-field="tolerance" type="number" min="0" max="255" value="48"></label>
<label class="mp-effect-check" data-edge-shading><input data-edge-field="selectionBoundary" type="checkbox" checked>${uiHtml("webview.paint.edgeRecolor.theBoundariesOfTheElectoralDistrictAre")}</label>
<div class="mp-effect-selection"><div><button type="button" data-edge="select-area" aria-pressed="false">${uiHtml("webview.paint.edgeRecolor.checkInPreview")}</button><button type="button" data-edge="clear-area">${uiHtml("webview.paint.edgeRecolor.clearRange")}</button></div><p data-edge-area-help>${uiHtml("webview.paint.edgeRecolor.dragBoxToPositionCtrlAddAlt")}</p><label>${uiHtml("webview.advanced.scopeOfProcessing")}<select data-edge-field="selectionRange"><option value="inside">${uiHtml("webview.paint.edgeRecolor.onlyWithinTheConstituency")}</option><option value="expand">${uiHtml("webview.paint.edgeRecolor.aSmallNumberOfPixelsInThe")}</option></select></label><label data-edge-expansion>${uiHtml("webview.paint.edgeRecolor.threadWidthPixels")}<input data-edge-field="selectionExpansion" type="number" min="1" max="8" value="1"></label><label>${uiHtml("webview.paint.edgeRecolor.colourRange")}<select data-edge-field="samplingRange"><option value="adjacent">${uiHtml("webview.paint.edgeRecolor.allowsASmallNumberOfPixelsOutside")}</option><option value="inside">${uiHtml("webview.paint.edgeRecolor.transitionColourOnlyInProcessingConstituencies")}</option></select></label><label data-edge-sample-margin>${uiHtml("webview.paint.edgeRecolor.externalColourDistancePixels")}<input data-edge-field="sampleMargin" type="number" min="1" max="4" value="1"></label></div><p data-edge-selection></p><p class="mp-panel-detail">${uiHtml("webview.paint.edgeRecolor.pixelRecognitionEdgesByActionLayerWith")}</p>
</div></div><footer><output data-edge-status role="status"></output><button data-edge="reset">${uiHtml("webview.paint.edgeRecolor.restoreDefault")}</button><button data-edge="apply">${uiHtml("webview.paint.edgeRecolor.applyAndRecordRevocation")}</button></footer>`
  parent.append(dialog)
  const field = <T extends HTMLInputElement | HTMLSelectElement>(name: string): T => dialog.querySelector<T>('[data-edge-field=' + name + ']')!
  const canvas = dialog.querySelector('canvas')!, status = dialog.querySelector<HTMLOutputElement>('[data-edge-status]')!, apply = dialog.querySelector<HTMLButtonElement>('[data-edge=apply]')!, compare = dialog.querySelector<HTMLButtonElement>('[data-edge=compare]')!
  let busy = false, disposed = false, previewFrame = 0, showOriginal = false, selecting = false
  let effectMask: Uint8Array | undefined, selectionDrag: { id: number; origin: [number, number]; before?: Uint8Array; subtract: boolean } | undefined
  function layerIds(): string[] {
    const scope = field<HTMLSelectElement>('scope').value, state = app.state
    return scope === 'all' ? state.layers.map(layer => layer.id) : scope === 'active' ? state.activeLayerId ? [state.activeLayerId] : [] : state.selectedLayerIds?.length ? state.selectedLayerIds : state.activeLayerId ? [state.activeLayerId] : []
  }
  function settings(): EdgeRecolorOptions {
    const state = app.state
    return edgeRecolorOptions({ radius: Number(field('radius').value), strength: Number(field('strength').value), hueShift: Number(field('hueShift').value), mode: field<HTMLSelectElement>('mode').value, light: field<HTMLSelectElement>('light').value, colorEdges: field<HTMLInputElement>('colorEdges').checked, tolerance: Number(field('tolerance').value), selectionBoundary: field<HTMLInputElement>('selectionBoundary').checked, transitionSource: field<HTMLSelectElement>('transitionSource').value, transitionSide: field<HTMLSelectElement>('transitionSide').value, transitionSteps: Number(field('transitionSteps').value), selectionExpansion: field<HTMLSelectElement>('selectionRange').value === 'expand' ? Number(field('selectionExpansion').value) : 0, sampleOutside: field<HTMLSelectElement>('samplingRange').value === 'adjacent', sampleMargin: Number(field('sampleMargin').value), frameWidth: state.width, frameHeight: state.height / state.frameCount })
  }
  function syncControls(): void {
    dialog.querySelector<HTMLElement>('[data-edge-expansion]')!.hidden = field<HTMLSelectElement>('selectionRange').value !== 'expand'
    dialog.querySelector<HTMLElement>('[data-edge-sample-margin]')!.hidden = field<HTMLSelectElement>('samplingRange').value !== 'adjacent'
    const transition = field<HTMLSelectElement>('mode').value === 'transition'
    dialog.querySelector<HTMLElement>('[data-edge-transition]')!.hidden = !transition
    dialog.querySelector<HTMLElement>('[data-edge-mix-help]')!.hidden = !transition
    dialog.querySelectorAll<HTMLElement>('[data-edge-shading]').forEach(element => { element.hidden = transition })
    dialog.querySelector('[data-edge-strength-label]')!.textContent = transition ? uiText("webview.paint.edgeRecolor.transitionIntensity") : uiText("webview.paint.edgeRecolor.darkness")
    for (const input of dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-edge-field]')) input.disabled = busy
    field<HTMLInputElement>('tolerance').disabled = busy || !transition && !field<HTMLInputElement>('colorEdges').checked
    compare.disabled = busy
    dialog.querySelector<HTMLButtonElement>('[data-edge=reset]')!.disabled = busy
    dialog.querySelector<HTMLButtonElement>('[data-edge=close]')!.disabled = busy
    compare.setAttribute('aria-pressed', String(showOriginal)); compare.textContent = showOriginal ? uiText("webview.paint.edgeRecolor.returnEffectsPreview") : uiText("webview.paint.edgeRecolor.viewOriginalMaps")
    dialog.querySelector('[data-edge-preview-label]')!.textContent = showOriginal ? uiText("webview.paint.edgeRecolor.originalFigureSeeFigsSynthesis") : uiText("webview.paint.edgeRecolor.impactPreviewSeeFigLayerSynthesis")
  }
  function preview(): void {
    previewFrame = 0
    if (!dialog.open || disposed) return
    syncControls()
    try {
      const state = app.state, selected = new Set(layerIds()), options = settings(), context = canvas.getContext('2d')!
      canvas.width = state.width; canvas.height = options.frameHeight ?? state.height
      context.clearRect(0, 0, canvas.width, canvas.height)
      const group = state.layers.filter(layer => selected.has(layer.id))
      const recolored = showOriginal ? group.map(layer => layer.pixels) : recolorLayerComposite(group, state.width, state.height, options, effectMask)
      const changes = new Map(group.map((layer, index) => [layer.id, recolored[index]]))
      const layers = state.layers.map(layer => changes.has(layer.id) ? { ...layer, pixels: changes.get(layer.id)! } : layer)
      const visibleLayers = variantLayers(layers, state.layers.find(layer => layer.id === state.activeLayerId)?.randomVariant ? state.activeLayerId : state.previewVariantId)
      const image = new ImageData(canvas.width, canvas.height)
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) image.data.set(compositeAt(visibleLayers, state.width, x, y), (y * canvas.width + x) * 4)
      context.putImageData(image, 0, 0)
      if (effectMask) {
        context.strokeStyle = '#3bafff'; context.lineWidth = .08; context.beginPath()
        for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) if (effectMask[y * canvas.width + x]) {
          if (!x || !effectMask[y * canvas.width + x - 1]) { context.moveTo(x, y); context.lineTo(x, y + 1) }
          if (x === canvas.width - 1 || !effectMask[y * canvas.width + x + 1]) { context.moveTo(x + 1, y); context.lineTo(x + 1, y + 1) }
          if (!y || !effectMask[(y - 1) * canvas.width + x]) { context.moveTo(x, y); context.lineTo(x + 1, y) }
          if (y === canvas.height - 1 || !effectMask[(y + 1) * canvas.width + x]) { context.moveTo(x, y + 1); context.lineTo(x + 1, y + 1) }
        }
        context.stroke()
      }
      dialog.querySelector('[data-edge-strength]')!.textContent = Math.round(options.strength * 100) + '%'
      dialog.querySelector('[data-edge-hue]')!.textContent = options.hueShift + '°'
      dialog.querySelector('[data-edge-selection]')!.textContent = effectMask ? uiText("webview.paint.edgeRecolor.handledPositionSelectedColouredRangeIndependentControl") : uiText("webview.paint.edgeRecolor.noConstituencyWasCreatedNonTransparentPixels")
      if (!busy) status.textContent = uiText("webview.paint.edgeRecolor.syntheticProcessingLayersPrepareAllTheFigure", selected.size, (state.frameCount > 1 ? uiText("webview.paint.edgeRecolor.showTheFrameOfFirstInstanceAndQualifier") : ''))
      apply.disabled = busy || !selected.size
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); apply.disabled = true }
  }
  function queuePreview(): void { if (!previewFrame) previewFrame = requestAnimationFrame(preview) }
  const selectArea = dialog.querySelector<HTMLButtonElement>('[data-edge=select-area]')!
  selectArea.addEventListener('click', () => { if (busy) return; selecting = !selecting; selectArea.setAttribute('aria-pressed', String(selecting)); canvas.classList.toggle('is-selecting', selecting) })
  dialog.querySelector('[data-edge=clear-area]')!.addEventListener('click', () => { if (!busy) { effectMask = undefined; queuePreview() } })
  const pointAt = (event: PointerEvent): [number, number] => { const bounds = canvas.getBoundingClientRect(); return [Math.max(0, Math.min(canvas.width - 1, Math.floor((event.clientX - bounds.left) * canvas.width / bounds.width))), Math.max(0, Math.min(canvas.height - 1, Math.floor((event.clientY - bounds.top) * canvas.height / bounds.height)))] }
  const updateArea = (event: PointerEvent): void => {
    if (!selectionDrag || selectionDrag.id !== event.pointerId) return
    const head = pointAt(event), origin = selectionDrag.origin, state = app.state
    const mask = selectionDrag.before?.slice() ?? new Uint8Array(state.width * state.height)
    const x0 = Math.min(head[0], origin[0]), x1 = Math.max(head[0], origin[0]), y0 = Math.min(head[1], origin[1]), y1 = Math.max(head[1], origin[1])
    for (let top = 0; top < state.height; top += canvas.height) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) mask[(top + y) * state.width + x] = selectionDrag.subtract ? 0 : 1
    effectMask = mask; queuePreview()
  }
  canvas.addEventListener('pointerdown', event => {
    if (!selecting || busy || event.button !== 0) return
    event.preventDefault(); canvas.setPointerCapture(event.pointerId)
    selectionDrag = { id: event.pointerId, origin: pointAt(event), before: event.ctrlKey || event.metaKey || event.altKey ? effectMask?.slice() : undefined, subtract: event.altKey }
    updateArea(event)
  })
  canvas.addEventListener('pointermove', updateArea)
  const endArea = (event: PointerEvent): void => { if (selectionDrag?.id === event.pointerId) { updateArea(event); selectionDrag = undefined; if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId) } }
  canvas.addEventListener('pointerup', endArea); canvas.addEventListener('pointercancel', endArea); canvas.addEventListener('lostpointercapture', () => { selectionDrag = undefined })
  const close = (): void => { if (!busy) dialog.close() }
  dialog.addEventListener('input', queuePreview)
  dialog.addEventListener('change', queuePreview)
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault() })
  dialog.addEventListener('keydown', event => event.stopPropagation())
  dialog.querySelector('[data-edge=close]')!.addEventListener('click', close)
  compare.addEventListener('click', () => { showOriginal = !showOriginal; queuePreview() })
  dialog.querySelector('[data-edge=reset]')!.addEventListener('click', () => {
    for (const [key, value] of Object.entries(DEFAULT_EDGE_RECOLOR)) { if (['selectionExpansion', 'sampleOutside'].includes(key)) continue; const input = field<HTMLInputElement>(key); if (typeof value === 'boolean') input.checked = value; else input.value = String(value) }
    for (const select of dialog.querySelectorAll('select')) select.dispatchEvent(new Event('change', { bubbles: true }))
    field('selectionRange').value = 'inside'; field('samplingRange').value = 'adjacent'; field('selectionExpansion').value = '1'
    showOriginal = false; queuePreview()
  })
  apply.addEventListener('click', () => {
    if (busy) return
    try {
      const options = settings(), ids = layerIds()
      if (!ids.length) throw new Error(uiText("webview.paint.edgeRecolor.selectTheLayerToProcess"))
      busy = true; apply.disabled = true; status.textContent = uiText("webview.paint.edgeRecolor.applyingByComposite"); syncControls()
      app.host.post({ command: 'pixelTools', action: 'edgeRecolor', layerIds: ids, options, mask: effectMask?.slice().buffer })
    } catch (error) { busy = false; syncControls(); status.textContent = error instanceof Error ? error.message : String(error) }
  })
  app.openEdgeRecolor = () => { if (app.hasPendingTransform?.()) { app.notify(uiText("webview.paint.edgeRecolor.pleaseConfirmOrCancelTheLayerChanges"), 'warn'); return }; if (!app.state.layers.length) return; showOriginal = false; effectMask = app.state.selection?.mask.slice(); selecting = false; canvas.classList.remove('is-selecting'); dialog.querySelector('[data-edge=select-area]')!.setAttribute('aria-pressed', 'false'); if (!dialog.open) dialog.showModal(); queuePreview() }
  onHostMessage(raw => {
    const message = raw as { command?: string; action?: string; ok?: boolean; error?: string }
    if (message.command === 'pixelToolsResult' && message.action === 'edgeRecolor') { busy = false; syncControls(); if (message.ok) dialog.close(); else { status.textContent = message.error ?? uiText("webview.paint.edgeRecolor.theColoringFailedTryAgain"); apply.disabled = false } }
    if (['snapshot', 'layers', 'patch'].includes(message.command ?? '') && !busy) queuePreview()
  })
  window.addEventListener('pagehide', () => { disposed = true; if (previewFrame) cancelAnimationFrame(previewFrame); dialog.remove() }, { once: true })
}
