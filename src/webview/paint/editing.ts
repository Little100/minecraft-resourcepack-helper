import { uiHtml, uiText } from '../../i18n/messages'
import { assertEditSize, MAX_PNG_EDGE, placePixels, rotatedBounds } from '../../core/pixelGeometry'
import { textureResolution } from '../../core/textureResolution'
import { MAX_IMAGE_IMPORT_BYTES, MAX_IMAGE_IMPORT_FILES } from '../../core/imageImportUris'
import { onHostMessage } from '../bus'
import { attachImageTransfer, clipboardImage, imageFile } from './imageTransfer'
import { activeLayer, type LayerBuffer } from './state'
import { el } from './dom'
import type { App } from './app'
import type { Stage } from './stage'

interface Floating {
  width: number
  height: number
  pixels?: Uint8Array
  x: number
  y: number
  w: number
  h: number
  name: string
  rotation?: number
  layerIds?: string[]
  layers?: LayerBuffer[]
}
interface TransformDrag { id: number; x: number; y: number; sx: number; sy: number; mode: 'move' | 'resize' | 'rotate'; angle: number; rotation: number; cx: number; cy: number }

export function mountImageEditing(parent: HTMLElement, app: App, stage: Stage): void {
  const panel = el('section', 'mp-panel mp-editing')
  panel.innerHTML = `<header class="mp-panel-head">${uiHtml("webview.paint.editing.imageSizeAndAnimation")}</header><p class="mp-resolution-current" data-resolution-current></p><div class="mp-edit-grid"><label>${uiHtml("webview.paint.editing.frameWidthPixels")}<input data-size="width" type="number" min="1" step="1"></label><label>${uiHtml("webview.paint.editing.singleFrameHeightPixels")}<input data-size="height" type="number" min="1" step="1"></label></div><p class="mp-resolution-summary" data-resolution-summary></p><p class="mp-resolution-warning" data-resolution-warning role="status" hidden></p><div class="mp-edit-actions"><button data-edit="scale">${uiHtml("webview.paint.editing.frameToSizing")}</button><button data-edit="canvas">${uiHtml("webview.paint.editing.adjustSingleFrameCanvas")}</button></div><p class="mp-panel-detail">${uiHtml("webview.paint.editing.framesStandAloneNumberScaldingWithThe")}</p><details class="mp-animation-section"><summary>${uiHtml("webview.paint.editing.animatedFrameAndStripSlash")}</summary><div class="mp-edit-grid"><label>${uiHtml("webview.paint.editing.zincedHeight")}<input data-frame-height type="number" min="1" step="1"></label><label>${uiHtml("webview.paint.editing.targetFrame")}<input data-frame-count type="number" min="1" step="1" value="2"></label></div><div class="mp-edit-actions"><button data-edit="slice">${uiHtml("webview.paint.editing.cutTheFrameAtThisHeight")}</button><button data-edit="duplicate">${uiHtml("webview.paint.editing.copyAsMultiframe")}</button><button data-edit="blank">${uiHtml("webview.paint.editing.addBlankFrame")}</button></div><label class="mp-edit-field">${uiHtml("webview.paint.editing.currentFrame")}<select data-frame-index></select></label><div class="mp-edit-actions"><button data-edit="frame-copy">${uiHtml("webview.paint.editing.copyThisFrame")}</button><button data-edit="frame-remove">${uiHtml("webview.paint.editing.deleteThisFrame")}</button><button data-edit="frame-up">${uiHtml("webview.paint.editing.forward")}</button><button data-edit="frame-down">${uiHtml("webview.paint.editing.backward")}</button></div></details><div class="mp-edit-actions mp-layer-actions"><button data-edit="import">${uiHtml("core.pixelTransforms.importLayer")}</button><button data-edit="transform">${uiHtml("ui.pixelEditor.changeSelectedLayer")}</button><button data-edit="copy">${uiHtml("webview.paint.editing.copyPixels")}</button><button data-edit="paste">${uiHtml("ui.pixelEditingHost.pasteLayer")}</button></div><p class="mp-panel-detail">${uiHtml("webview.paint.editing.vDragSelectedLayerEnterConfirmsThat")}</p>`
  parent.append(panel)
  const width = panel.querySelector<HTMLInputElement>('[data-size=width]')!, height = panel.querySelector<HTMLInputElement>('[data-size=height]')!
  const frameHeight = panel.querySelector<HTMLInputElement>('[data-frame-height]')!, count = panel.querySelector<HTMLInputElement>('[data-frame-count]')!, frame = panel.querySelector<HTMLSelectElement>('[data-frame-index]')!
  for (const input of [width, height, frameHeight, count]) input.max = String(MAX_PNG_EDGE)
  const queue: File[] = []
  let decoding = false, awaitingInsert = false, disposed = false, previewFrame = 0
  let floating: Floating | undefined, drag: TransformDrag | undefined, zoom = -1
  const wrap = stage.scroller.querySelector<HTMLElement>('.mp-canvas')!, overlay = el('div', 'mp-floating'), canvas = el('canvas'), grip = el('button', 'mp-float-grip'), rotationGrip = el('button', 'mp-float-rotate')
  grip.type = 'button'; grip.title = uiText("webview.paint.editing.dragZoomStrengthOfHardSide"); grip.setAttribute('aria-label', uiText("webview.paint.editing.scaleSelectedLayer")); rotationGrip.type = 'button'; rotationGrip.title = uiText("webview.paint.editing.dragAndRotateHoldDownShiftAdhesion"); rotationGrip.setAttribute('aria-label', uiText("webview.paint.editing.rotateSelectedLayer")); overlay.append(canvas, grip, rotationGrip)
  const bar = el('div', 'mp-transform-bar'); bar.hidden = true
  bar.setAttribute('aria-label', uiText("webview.paint.editing.layerTransformation"))
  bar.innerHTML = `<strong>${uiHtml("webview.paint.editing.layerTransformation")}</strong><label>X<input data-transform="x" type="number" step="1"></label><label>Y<input data-transform="y" type="number" step="1"></label><label>${uiHtml("webview.paint.editing.width")}<input data-transform="w" type="number" min="1" step="1"></label><label>${uiHtml("webview.paint.editing.height")}<input data-transform="h" type="number" min="1" step="1"></label><label>${uiHtml("webview.paint.editing.zoom")}<input data-transform-scale aria-label="${uiHtml("webview.paint.editing.changeZoomPercentage")}" type="number" min="0.01" step="1" value="100" placeholder="${uiHtml("webview.paint.editing.itSNotEven")}"></label><label><input data-transform-proportions type="checkbox" checked>${uiHtml("webview.paint.editing.keepRatio")}</label><label>${uiHtml("webview.paint.editing.rotation")}<input data-transform="rotation" aria-label="${uiHtml("webview.paint.editing.rotationAngle")}" type="number" step="1" value="0"></label><button data-transform-turn="-90" title="${uiHtml("webview.paint.editing.rotateCounterclockwise")}">${uiHtml("webview.paint.editing.turnLeftDegrees")}</button><button data-transform-turn="90" title="${uiHtml("webview.paint.editing.rotateTheClockwise")}">${uiHtml("webview.paint.editing.rightDegrees")}</button><button data-transform-apply>${uiHtml("webview.paint.editing.confirm")}</button><button data-transform-cancel>${uiHtml("browser.shell.cancel")}</button><span data-transform-status role="status"></span>`
  ;(stage.scroller.parentElement ?? parent).append(bar)
  const applyButton = bar.querySelector<HTMLButtonElement>('[data-transform-apply]')!, transformStatus = bar.querySelector<HTMLElement>('[data-transform-status]')!
  const scaleInput = bar.querySelector<HTMLInputElement>('[data-transform-scale]')!, proportions = bar.querySelector<HTMLInputElement>('[data-transform-proportions]')!
  const send = (action: string, params: Record<string, unknown> = {}) => app.host.post({ command: 'pixelTools', action, ...params })
  app.hasPendingTransform = () => Boolean(floating || awaitingInsert)
  const importButton = el('button', 'mcrh-btn mp-import-entry'), dropHint = el('p', 'mp-panel-detail')
  importButton.type = 'button'; importButton.setAttribute('data-paint-import', ''); importButton.textContent = uiText("core.pixelTransforms.importLayer")
  importButton.title = uiText("webview.paint.editing.selectLocalPicturesAndScaleThemWith")
  const summary = parent.querySelector(':scope > summary')
  if (summary) summary.append(importButton); else panel.prepend(importButton)
  dropHint.textContent = uiText("webview.paint.editing.holdShiftInDragWhileDraggingFrom")
  panel.append(dropHint)
  importButton.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); send('importFiles') })

  function dimensions(): void {
    const state = app.state, currentHeight = state.frameHeight ?? state.height / Math.max(1, state.frameCount)
    panel.querySelector('[data-resolution-current]')!.textContent = uiText("webview.paint.editing.currentPngFrame", state.width, state.height, state.frameCount, state.width, currentHeight)
    const warning = panel.querySelector<HTMLElement>('[data-resolution-warning]')!, summary = panel.querySelector<HTMLElement>('[data-resolution-summary]')!
    try {
      const result = textureResolution(Number(width.value), Number(height.value), state.frameCount)
      assertEditSize(result.width, result.totalHeight, Math.max(1, state.layers.length))
      summary.textContent = uiText("webview.paint.editing.adjustedPngMaintainFrame", result.width, result.totalHeight, result.frameCount)
      warning.textContent = result.warnings.join(' '); warning.hidden = !result.warnings.length
      warning.classList.remove('is-error')
      panel.querySelectorAll<HTMLButtonElement>('[data-edit=scale], [data-edit=canvas]').forEach(button => { button.disabled = false })
    } catch (error) {
      summary.textContent = uiText("webview.paint.editing.pleaseEnterAValidSingleFrameSize")
      warning.textContent = error instanceof Error ? error.message : String(error); warning.hidden = false; warning.classList.add('is-error')
      panel.querySelectorAll<HTMLButtonElement>('[data-edit=scale], [data-edit=canvas]').forEach(button => { button.disabled = true })
    }
  }
  width.addEventListener('input', dimensions); height.addEventListener('input', dimensions)

  function resetPreview(): void {
    if (previewFrame) cancelAnimationFrame(previewFrame)
    previewFrame = 0
    if (app.state.transformedLayers) { app.state.transformedLayers = undefined; app.state.fullRedraw = true; app.state.revision++; app.requestRender() }
  }
  function cancel(next = true): void {
    floating = undefined; overlay.remove(); bar.hidden = true; drag = undefined; resetPreview()
    if (next) void importNext()
  }
  function paintTransformPreview(): void {
    previewFrame = 0
    if (!floating?.layerIds || !floating.layers || disposed) return
    const value = floating, selected = new Set(value.layerIds)
    try {
      app.state.transformedLayers = value.layers!.map(layer => selected.has(layer.id) ? { ...layer, pixels: placePixels(layer.pixels, value.width, value.height, app.state.width, app.state.height, value.x, value.y, value.w, value.h, value.rotation ?? 0) } : layer)
      app.state.fullRedraw = true; app.state.revision++; app.requestRender()
    } catch (error) { transformStatus.textContent = error instanceof Error ? error.message : String(error); applyButton.disabled = true }
  }
  function update(syncInputs = true): void {
    if (!floating) return
    if (syncInputs) {
      const uniform = Math.abs(floating.w / floating.width - floating.h / floating.height) < .0001
      scaleInput.value = uniform ? String(Math.round(floating.w / floating.width * 10000) / 100) : ''
    }
    if (syncInputs) for (const key of ['x', 'y', 'w', 'h', 'rotation'] as const) bar.querySelector<HTMLInputElement>('[data-transform=' + key + ']')!.value = String(floating[key] ?? 0)
    try {
      assertEditSize(floating.w, floating.h)
      if (![floating.x, floating.y].every(value => Number.isSafeInteger(value) && Math.abs(value) <= MAX_PNG_EDGE)) throw new Error(uiText("webview.paint.editing.layerPositionBeyondEditRange"))
      if (!Number.isFinite(floating.rotation ?? 0)) throw new Error(uiText("webview.paint.editing.pleaseEnterAValidRotationAngle"))
      const bounds = rotatedBounds(floating.x, floating.y, floating.w, floating.h, floating.rotation ?? 0)
      applyButton.disabled = false
      transformStatus.textContent = bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.width > app.state.width || bounds.y + bounds.height > app.state.height ? uiText("webview.paint.editing.thePixelsOfTheCanvasWillBe") : uiText("webview.paint.editing.pixelAlignmentEnterConfirmEscCancel")
      if (floating.layerIds && !previewFrame) previewFrame = requestAnimationFrame(paintTransformPreview)
    } catch (error) { transformStatus.textContent = error instanceof Error ? error.message : String(error); applyButton.disabled = true }
    overlay.style.transform = 'rotate(' + ((floating.rotation ?? 0) % 360) + 'deg)'
    overlay.style.left = floating.x * app.state.zoom + 'px'; overlay.style.top = floating.y * app.state.zoom + 'px'
    overlay.style.width = floating.w * app.state.zoom + 'px'; overlay.style.height = floating.h * app.state.zoom + 'px'; zoom = app.state.zoom
  }
  function begin(value: Floating): void {
    if (floating || awaitingInsert) { app.notify(uiText("webview.paint.editing.pleaseConfirmOrCancelTheCurrentChange"), 'warn'); return }
    floating = { ...value, rotation: value.rotation ?? 0 }
    canvas.hidden = Boolean(value.layerIds)
    if (value.pixels) {
      canvas.width = value.width; canvas.height = value.height
      canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(value.pixels), value.width, value.height), 0, 0)
    }
    wrap.append(overlay); bar.hidden = false; update()
    stage.scroller.focus({ preventScroll: true })
  }
  function beginLayers(): void {
    const state = app.state, selected = new Set(state.selectedLayerIds?.length ? state.selectedLayerIds : state.activeLayerId ? [state.activeLayerId] : [])
    const ids = state.layers.filter(layer => selected.has(layer.id)).map(layer => layer.id)
    if (!ids.length) return
    begin({ width: state.width, height: state.height, x: 0, y: 0, w: state.width, h: state.height, name: ids.length > 1 ? ids.length + uiText("webview.paint.editing.selectedLayers") : activeLayer(state)?.name ?? uiText("webview.paint.editing.layer"), layerIds: ids, layers: state.layers.map(layer => selected.has(layer.id) ? { ...layer, pixels: layer.pixels.slice() } : layer) })
  }
  function applyTransform(): void {
    if (!floating || applyButton.disabled) return
    const value = floating
    awaitingInsert = true
    if (value.layerIds) send('transform', { layerIds: value.layerIds, sourceWidth: value.width, sourceHeight: value.height, x: value.x, y: value.y, targetWidth: value.w, targetHeight: value.h, rotation: value.rotation ?? 0 })
    else send('insert', { width: value.width, height: value.height, pixels: value.pixels!.buffer, x: value.x, y: value.y, targetWidth: value.w, targetHeight: value.h, name: value.name })
    cancel(false)
  }
  async function importFile(source: File): Promise<void> {
    if (!imageFile(source)) throw new Error(uiText("ui.pixelEditingHost.onlyPngJpegOrWebpPicturesAre"))
    if (source.size > MAX_IMAGE_IMPORT_BYTES) throw new Error(uiText("webview.paint.editing.pictureFileMoreThanMib"))
    const bitmap = await createImageBitmap(source)
    try {
      assertEditSize(bitmap.width, bitmap.height)
      const decoded = el('canvas'); decoded.width = bitmap.width; decoded.height = bitmap.height
      const context = decoded.getContext('2d')!; context.drawImage(bitmap, 0, 0)
      if (!disposed) begin({ width: bitmap.width, height: bitmap.height, pixels: new Uint8Array(context.getImageData(0, 0, bitmap.width, bitmap.height).data), x: 0, y: 0, w: bitmap.width, h: bitmap.height, name: source.name })
    } finally { bitmap.close() }
  }
  async function importNext(): Promise<void> {
    if (disposed || decoding || awaitingInsert || floating || !queue.length) return
    decoding = true
    try { await importFile(queue.shift()!) }
    catch (error) { app.notify(error instanceof Error ? error.message : String(error), 'error') }
    finally { decoding = false; if (!floating) void importNext() }
  }
  function enqueue(files: File[]): void {
    if (queue.length + files.length > MAX_IMAGE_IMPORT_FILES) { app.notify(uiText("webview.paint.editing.toImportTooManyPicturesPleaseContinue"), 'warn'); return }
    queue.push(...files); void importNext()
  }
  let copyPending = false
  async function pasteImage(): Promise<void> {
    if (copyPending) { send('paste'); return }
    try { const image = await clipboardImage(); if (image) { enqueue([image]); return } }
    catch { app.notify(uiText("webview.paint.editing.systemClipboardIsNotOpenForReading"), 'info') }
    send('paste')
  }
  function copy(): void {
    const state = app.state, layer = activeLayer(state)
    if (!layer) return
    const rect = state.selection?.bounds ?? { x: 0, y: 0, width: state.width, height: state.height }
    if (!rect.width || !rect.height) { app.notify(uiText("webview.paint.editing.currentSelectionIsEmpty"), 'warn'); return }
    const pixels = new Uint8Array(rect.width * rect.height * 4)
    for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
      const index = (rect.y + y) * state.width + rect.x + x
      if (!state.selection || state.selection.mask[index]) pixels.set(layer.pixels.subarray(index * 4, index * 4 + 4), (y * rect.width + x) * 4)
    }
    copyPending = true
    send('copy', { width: rect.width, height: rect.height, pixels: pixels.buffer })
  }
  function editFrames(action: string): void {
    const h = Number(frameHeight.value), existing = app.state.height / h
    if (!Number.isSafeInteger(h) || h < 1 || !Number.isSafeInteger(existing)) { app.notify(uiText("webview.paint.editing.theStripSplitHeightMustBeRemoved"), 'warn'); return }
    const order = Array.from({ length: existing }, (_, index) => index), index = Number(frame.value)
    if (action === 'duplicate' || action === 'blank') {
      const total = Number(count.value)
      if (!Number.isSafeInteger(total) || total < 1 || total * h > MAX_PNG_EDGE) { app.notify(uiText("webview.paint.editing.frameOrTotalHeightExceedingRange"), 'warn'); return }
      if (total < order.length) { app.notify(uiText("webview.paint.editing.theTargetFrameCannotBeLessThan"), 'warn'); return }
      while (order.length < total) order.push(action === 'duplicate' ? 0 : -1)
    } else if (action !== 'slice') {
      if (!Number.isSafeInteger(index) || index < 0 || index >= existing) return
      if (action === 'frame-copy') order.splice(index + 1, 0, index)
      else if (action === 'frame-remove') { if (order.length === 1) return; order.splice(index, 1) }
      else if (action === 'frame-up' && index > 0) [order[index - 1], order[index]] = [order[index], order[index - 1]]
      else if (action === 'frame-down' && index < order.length - 1) [order[index + 1], order[index]] = [order[index], order[index + 1]]
      else return
    }
    send('frames', { height: h, order })
  }
  panel.addEventListener('click', event => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-edit]')?.dataset.edit
    if (!action) return
    if (floating || awaitingInsert) { app.notify(uiText("webview.paint.edgeRecolor.pleaseConfirmOrCancelTheLayerChanges"), 'warn'); return }
    if (action === 'scale' || action === 'canvas') send('resize', { width: Number(width.value), height: Number(height.value), perFrame: true, scale: action === 'scale' })
    else if (action === 'import') send('importFiles')
    else if (action === 'copy') copy()
    else if (action === 'paste') void pasteImage()
    else if (action === 'transform') beginLayers()
    else editFrames(action)
  })
  bar.addEventListener('input', event => {
    const input = event.target as HTMLInputElement, key = input.dataset.transform as 'x' | 'y' | 'w' | 'h' | 'rotation'
    if (!floating || !['x', 'y', 'w', 'h', 'rotation'].includes(key)) return
    const value = input.value.trim() ? Number(input.value) : NaN
    if (!(key === 'rotation' ? Number.isFinite(value) : Number.isSafeInteger(value))) { applyButton.disabled = true; transformStatus.textContent = key === 'rotation' ? uiText("webview.paint.editing.pleaseEnterAValidRotationAngle") : uiText("webview.paint.editing.enterIntegerPixels"); return }
    floating[key] = value
    if (proportions.checked && (key === 'w' || key === 'h')) {
      if (key === 'w') floating.h = Math.max(1, Math.round(value * floating.height / floating.width))
      else floating.w = Math.max(1, Math.round(value * floating.width / floating.height))
    }
    update()

  })
  scaleInput.addEventListener('input', () => {
    if (!floating) return
    const percent = scaleInput.value.trim() ? Number(scaleInput.value) : NaN
    if (!Number.isFinite(percent) || percent <= 0) { applyButton.disabled = true; transformStatus.textContent = uiText("webview.paint.editing.zoomPercentageMustBeGreaterThanZero"); return }
    const ratio = percent / 100
    floating.w = Math.max(1, Math.round(floating.width * ratio)); floating.h = Math.max(1, Math.round(floating.height * ratio)); update(false)
    for (const key of ['w', 'h'] as const) bar.querySelector<HTMLInputElement>('[data-transform=' + key + ']')!.value = String(floating[key])
  })
  bar.querySelectorAll<HTMLButtonElement>('[data-transform-turn]').forEach(button => button.addEventListener('click', () => { if (floating) { floating.rotation = (floating.rotation ?? 0) + Number(button.dataset.transformTurn); update() } }))
  bar.querySelector('[data-transform-cancel]')!.addEventListener('click', () => cancel())
  applyButton.addEventListener('click', applyTransform)
  function beginDrag(event: PointerEvent, mode: TransformDrag['mode']): void {
    if (!floating || event.button !== 0 || app.modifiers.space || event.altKey) return
    event.stopPropagation(); event.preventDefault(); overlay.setPointerCapture(event.pointerId)
    const bounds = wrap.getBoundingClientRect(), cx = bounds.left + (floating.x + floating.w / 2) * app.state.zoom, cy = bounds.top + (floating.y + floating.h / 2) * app.state.zoom
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, sx: mode === 'resize' ? floating.w : floating.x, sy: mode === 'resize' ? floating.h : floating.y, mode, angle: Math.atan2(event.clientY - cy, event.clientX - cx), rotation: floating.rotation ?? 0, cx, cy }
  }
  overlay.addEventListener('pointerdown', event => beginDrag(event, event.target === rotationGrip ? 'rotate' : event.target === grip ? 'resize' : 'move'))
  overlay.addEventListener('pointermove', event => {
    if (!drag || !floating || drag.id !== event.pointerId) return
    event.stopPropagation()
    const dx = (event.clientX - drag.x) / app.state.zoom, dy = (event.clientY - drag.y) / app.state.zoom
    if (drag.mode === 'rotate') {
      const angle = Math.atan2(event.clientY - drag.cy, event.clientX - drag.cx), delta = Math.atan2(Math.sin(angle - drag.angle), Math.cos(angle - drag.angle))
      const degrees = drag.rotation + delta * 180 / Math.PI
      floating.rotation = event.shiftKey ? Math.round(degrees / 15) * 15 : Math.round(degrees * 10) / 10
    } else if (drag.mode === 'resize') {
      const radians = drag.rotation * Math.PI / 180, x = Math.round(Math.cos(radians) * dx + Math.sin(radians) * dy), y = Math.round(-Math.sin(radians) * dx + Math.cos(radians) * dy)
      floating.w = Math.max(1, Math.min(MAX_PNG_EDGE, drag.sx + x)); floating.h = Math.max(1, Math.min(MAX_PNG_EDGE, drag.sy + y))
      if (proportions.checked) floating.h = Math.max(1, Math.round(floating.w * floating.height / floating.width))
    } else { floating.x = Math.max(-MAX_PNG_EDGE, Math.min(MAX_PNG_EDGE, drag.sx + Math.round(dx))); floating.y = Math.max(-MAX_PNG_EDGE, Math.min(MAX_PNG_EDGE, drag.sy + Math.round(dy))) }
    update()
  })
  const endDrag = (event: PointerEvent): void => { if (drag?.id === event.pointerId) { event.stopPropagation(); drag = undefined } }
  overlay.addEventListener('pointerup', endDrag); overlay.addEventListener('pointercancel', endDrag); overlay.addEventListener('lostpointercapture', endDrag)
  wrap.addEventListener('pointerdown', event => {
    if (event.button !== 0 || app.modifiers.space || event.altKey) return
    if (!floating && app.state.tool === 'move' && !awaitingInsert) { event.preventDefault(); event.stopImmediatePropagation(); beginLayers(); beginDrag(event, 'move') }
    else if (floating && !overlay.contains(event.target as Node)) { event.preventDefault(); event.stopImmediatePropagation() }
  }, true)
  const transformKey = (event: KeyboardEvent): void => {
    if (!floating || event.isComposing || document.querySelector('dialog[open]')) return
    const target = event.target instanceof HTMLElement ? event.target : undefined
    if (target?.closest('input, textarea, select, [contenteditable=true]') && !bar.contains(target)) return
    if (event.key === 'Enter' && target?.closest('button, a[href], summary, [role=button]')) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancel() }
    else if (event.key === 'Enter') { event.preventDefault(); event.stopImmediatePropagation(); applyTransform() }
    else if (!target?.closest('input, textarea, select') && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); event.stopImmediatePropagation()
      const step = event.shiftKey ? 10 : 1
      floating.x += event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
      floating.y += event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
      update()
    }
  }
  window.addEventListener('keydown', transformKey, true)
  const detachTransfer = attachImageTransfer({
    root: stage.scroller.closest<HTMLElement>('.mp-app') ?? parent,
    importFiles: enqueue,
    importUris: uris => send('importUris', { uris }),
    copyPixels: copy,
    pastePixels: () => send('paste'),
    preferPixelPaste: () => copyPending,
    cancelTransform: () => { if (!floating) return false; cancel(); return true },
    notify: message => app.notify(message, 'warn')
  })
  onHostMessage(raw => {
    const message = raw as { command?: string; width: number; height: number; frameHeight?: number; pixels: ArrayBuffer; data: ArrayBuffer; name: string; mime: string; action?: string }
    if (message.command === 'pixelToolsResult' && message.action === 'copy') copyPending = false
    if (message.command === 'pixelImportFile') enqueue([new File([message.data], message.name, { type: message.mime })])
    if (message.command === 'pixelToolsResult' && (message.action === 'insert' || message.action === 'transform')) { awaitingInsert = false; void importNext() }
    if (message.command === 'pixelClipboard') begin({ width: message.width, height: message.height, pixels: new Uint8Array(message.pixels), x: 0, y: 0, w: message.width, h: message.height, name: uiText("ui.pixelEditingHost.pasteLayer") })
    if (message.command === 'layers' || message.command === 'patch') { if (floating?.layerIds) { cancel(false); void importNext() }; return }
    if (message.command === 'snapshot') {
      cancel(false)
      width.value = String(message.width); height.value = String(message.frameHeight ?? message.height / Math.max(1, app.state.frameCount))
      frameHeight.value = height.value; count.value = String(Math.max(2, app.state.frameCount))
      const previous = Number(frame.value), total = message.height / Number(frameHeight.value)
      frame.replaceChildren(...Array.from({ length: total }, (_, index) => { const option = el('option'); option.value = String(index); option.textContent = uiText("core.apng.frameNumber", (index + 1)); return option }))
      frame.value = String(Math.max(0, Math.min(total - 1, previous)))
      dimensions(); void importNext()
    }
  })
  const observer = new MutationObserver(() => { if (floating && zoom !== app.state.zoom) update() })
  observer.observe(wrap, { attributes: true, attributeFilter: ['style'] })
  window.addEventListener('pagehide', () => { disposed = true; queue.length = 0; cancel(false); importButton.remove(); detachTransfer(); observer.disconnect(); window.removeEventListener('keydown', transformKey, true) }, { once: true })
}
