import { uiHtml, uiText } from '../i18n/messages'
import { decodeReferenceImage, pickReferencePixel } from './referenceImageDecoder'
import { clampZoom, stepZoom } from './paint/geometry'
import { REFERENCE_LIMITS, ReferenceCache, referenceAbort, type ReferenceEntry, type ReferenceImageInfo, type ReferenceSource } from '../core/referenceImages'

interface DecodedReference { bitmap: ImageBitmap; bytes: number; dispose(): void }
export interface ReferencePanel { element: HTMLDetailsElement; suspend(): void; resume(): void; clear(): void; dispose(): void }

export interface ReferencePanelOptions { pickColor?(color: [number, number, number, number]): void; pin?(entry: ReferenceEntry): void; remove?(id: string): void; clear?(): void }

export function mountReferencePanel(parent: HTMLElement, source: ReferenceSource, options: ReferencePanelOptions = {}): ReferencePanel {
  const element = document.createElement('details')
  element.className = 'reference-panel'
  element.innerHTML = `<summary><span class="reference-title">${uiHtml("webview.referencePanel.referenceChart")} <span data-ref-count>${uiHtml("webview.referencePanel.sheets")}</span></span><button type="button" data-ref-action="add" title="${uiHtml("webview.referencePanel.openLocalFileSelectorMultiplePictures")}" aria-label="${uiHtml("webview.referencePanel.selectLocalPictureReferenceDiagram")}">${uiHtml("webview.referencePanel.selectLocalPicture")}</button></summary><div class="reference-body"><div class="reference-actions"><button type="button" data-ref-action="files" title="${uiHtml("webview.referencePanel.selectPicturesFromThisMachineToSupport")}">${uiHtml("webview.referencePanel.selectPicture")}</button><button type="button" data-ref-action="folder">${uiHtml("ui.ffmpegCommands.selectFolder")}</button><button type="button" data-ref-action="cancel" hidden>${uiHtml("webview.referencePanel.cancelAdd")}</button><button type="button" data-ref-action="clear">${uiHtml("webview.referencePanel.clear")}</button></div><label class="reference-search">${uiHtml("webview.referencePanel.searchForRelativeFilenames")}<input type="search" placeholder="${uiHtml("webview.referencePanel.folderOrFilename")}" aria-label="${uiHtml("webview.referencePanel.searchReferenceCharts")}"></label><p class="reference-hint">${uiHtml("webview.referencePanel.onlyThisSessionWillKeepTheOriginal")}</p><p class="reference-status" role="status" aria-live="polite"></p><div class="reference-list" role="list" aria-label="${uiHtml("webview.referencePanel.listOfReferenceFigureFiles")}"></div><div class="reference-pagination"><button type="button" data-ref-action="prev">${uiHtml("browser.resources.previousPage")}</button><output data-ref-page></output><button type="button" data-ref-action="next">${uiHtml("browser.resources.nextPage")}</button></div><div class="reference-preview-slot"><section class="reference-preview"><p class="reference-preview-status" role="status" aria-live="polite"></p><p class="reference-name">${uiHtml("webview.referencePanel.selectAReferenceChartToPreview")}</p><div class="reference-zoom"><button type="button" data-ref-action="fit">${uiHtml("webview.paint.options.adaptation")}</button><button type="button" data-ref-action="actual">${uiHtml("webview.referencePanel.originalFigure")}</button><button type="button" data-ref-action="minus" aria-label="${uiHtml("webview.referencePanel.zoomOutReferenceDiagram")}">−</button><button type="button" data-ref-action="plus" aria-label="${uiHtml("webview.referencePanel.zoomIn")}">+</button><output data-ref-zoom></output><button type="button" data-ref-action="pin">${uiHtml("webview.referencePanel.holdItByTheCanvas")}</button><button type="button" data-ref-action="expand">${uiHtml("webview.referencePanel.largeChartPreview")}</button></div><div class="reference-viewport" tabindex="0" aria-label="${uiHtml("webview.referencePanel.referenceOriginalScrollZoomMiddleClickDrag")}"><canvas aria-label="${uiHtml("webview.referencePanel.previewOfOriginalMaps")}" hidden></canvas></div></section></div><dialog class="reference-dialog"><button type="button" data-ref-action="close-preview">${uiHtml("webview.referencePanel.returnReferencePanel")}</button></dialog></div>`
  parent.append(element)
  if (source.restore) element.querySelector('.reference-hint')!.textContent = uiText("webview.referencePanel.referenceDiagramsAndFloatWindowLayoutsAre")
  const query = <T extends HTMLElement>(selector: string): T => element.querySelector<T>(selector)!
  const list = query('.reference-list'), status = query('.reference-status'), search = query<HTMLInputElement>('input')
  const preview = query('.reference-preview'), slot = query('.reference-preview-slot'), viewport = query('.reference-viewport')
  const canvas = query<HTMLCanvasElement>('canvas'), dialog = query<HTMLDialogElement>('dialog')
  query('[data-ref-action=pin]').hidden = !options.pin
  const cache = new ReferenceCache<DecodedReference>()
  const entries = new Map<string, ReferenceEntry>()
  let filtered: ReferenceEntry[] = [], page = 0, selected: string | undefined, disposed = false, suspended = false
  const restoreController = new AbortController()
  let importController: AbortController | undefined, previewController: AbortController | undefined
  let previewQueue = Promise.resolve(), loading: string | undefined, visible: string | undefined
  let info: ReferenceImageInfo | undefined, zoom = 1, fitMode = true, importRevision = 0
  let pan: { id: number; x: number; y: number; left: number; top: number } | undefined

  function message(text: string): void { status.textContent = text }
  function previewMessage(text: string): void { query('.reference-preview-status').textContent = text }
  function resetPreview(): void {
    endPan()
    previewMessage('')
    previewController?.abort(); previewController = undefined; loading = undefined; visible = undefined; info = undefined
    canvas.hidden = true; canvas.width = 0; canvas.height = 0; query('[data-ref-zoom]').textContent = ''
  }
  function suspend(): void { suspended = true; resetPreview(); cache.clear(); if (dialog.open) dialog.close() }
  function render(): void {
    filtered = Array.from(entries.values()).filter(entry => entry.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()))
    const pages = Math.max(1, Math.ceil(filtered.length / REFERENCE_LIMITS.pageSize))
    page = Math.max(0, Math.min(page, pages - 1))
    const current = filtered.slice(page * REFERENCE_LIMITS.pageSize, (page + 1) * REFERENCE_LIMITS.pageSize)
    if (!current.some(entry => entry.id === selected)) { selected = current[0]?.id; resetPreview() }
    query('[data-ref-count]').textContent = entries.size + uiText("webview.referencePanel.images")
    query('[data-ref-page]').textContent = uiText("webview.referencePanel.chang", page + 1, pages, filtered.length)
    query<HTMLButtonElement>('[data-ref-action=prev]').disabled = page === 0
    query<HTMLButtonElement>('[data-ref-action=next]').disabled = page + 1 >= pages
    list.replaceChildren()
    for (const entry of current) {
      const row = document.createElement('div'); row.className = 'reference-row'; row.setAttribute('role', 'listitem')
      const button = document.createElement('button'); button.type = 'button'; button.textContent = entry.name; button.title = entry.name; button.dataset.refSelect = entry.id
      button.setAttribute('aria-pressed', String(entry.id === selected)); button.classList.toggle('selected', entry.id === selected)
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = uiText("webview.packTools.remove"); remove.dataset.refRemove = entry.id; remove.setAttribute('aria-label', uiText("webview.referencePanel.removeReferenceDiagram", entry.name))
      row.append(button, remove); list.append(row)
    }
    if (!current.length) {
      list.textContent = entries.size ? uiText("webview.referencePanel.noMatchingReferenceDiagramEmptySearchFor") : uiText("webview.referencePanel.selectAPictureOrFolderFromThis")
      if (!entries.size) {
        const choose = document.createElement('button'); choose.type = 'button'; choose.className = 'reference-empty-choose'
        choose.dataset.refAction = 'choose-files'; choose.textContent = uiText("webview.referencePanel.selectLocalPictureReferenceDiagram"); list.append(choose)
      }
    }
    syncImportControls()
    query('.reference-name').textContent = selected ? entries.get(selected)!.name : uiText("webview.referencePanel.selectAReferenceChartToPreview")
    if (!suspended && element.open && !element.hidden && selected && selected !== visible && selected !== loading) loadPreview(selected)
  }
  function updateZoom(): void {
    if (!info) return
    if (fitMode) zoom = Math.min(1, Math.max(0.01, Math.min(Math.max(1, viewport.clientWidth - 16) / info.width, Math.max(1, viewport.clientHeight - 16) / info.height)))
    canvas.style.width = `${Math.max(1, info.width * zoom)}px`; canvas.style.height = `${Math.max(1, info.height * zoom)}px`
    query('[data-ref-zoom]').textContent = `${Math.round(zoom * 100)}% (${info.width} × ${info.height})`
  }
  function setZoom(value: number, anchor?: [number, number]): void {
    if (!info || canvas.hidden) return
    const rect = viewport.getBoundingClientRect(), before = canvas.getBoundingClientRect()
    const client = anchor ?? [rect.left + viewport.clientWidth / 2, rect.top + viewport.clientHeight / 2]
    const x = (client[0] - before.left) / zoom, y = (client[1] - before.top) / zoom
    fitMode = false; zoom = clampZoom(value); updateZoom()
    const after = canvas.getBoundingClientRect()
    viewport.scrollLeft += after.left + x * zoom - client[0]
    viewport.scrollTop += after.top + y * zoom - client[1]
  }
  function zoomBy(direction: 1 | -1, anchor?: [number, number]): void { setZoom(stepZoom(zoom, direction), anchor) }
  function endPan(): void {
    const previous = pan
    pan = undefined; viewport.classList.remove('is-panning')
    if (previous && viewport.hasPointerCapture(previous.id)) viewport.releasePointerCapture(previous.id)
  }
  function loadPreview(id: string): void {
    resetPreview()
    const controller = new AbortController(); previewController = controller; loading = id
    previewMessage(uiText("webview.referencePanel.readingReferenceDiagramsOnDemand"))
    // 串行解码避免取消后的大图与新请求同时占用内存
    previewQueue = previewQueue.then(async () => {
      const { signal } = controller
      referenceAbort(signal)
      let decoded = cache.get(id)
      if (!decoded) {
        const blob = await source.read(id, signal)
        referenceAbort(signal)
        const bitmap = await decodeReferenceImage(blob, signal, bytes => cache.reserve(bytes))
        if (signal.aborted || disposed || selected !== id || !element.open || element.hidden) { bitmap.close(); referenceAbort(signal); return }
        decoded = { bitmap, bytes: bitmap.width * bitmap.height * 4, dispose: () => bitmap.close() }
        cache.set(id, decoded)
      }
      referenceAbort(signal)
      if (disposed || selected !== id || !entries.has(id)) return
      info = { width: decoded.bitmap.width, height: decoded.bitmap.height }
      canvas.width = info.width; canvas.height = info.height
      const context = canvas.getContext('2d')
      if (!context) throw new Error(uiText("webview.referencePanel.aPreviewOfReferenceDiagramsCannotCreate"))
      context.drawImage(decoded.bitmap, 0, 0); canvas.hidden = false; visible = id; loading = undefined
      fitMode = true; updateZoom(); viewport.scrollTo(0, 0)
      previewMessage(uiText("webview.referencePanel.theOriginalPreviewIsForReferencePurposes"))
    }).catch(error => {
      if (!controller.signal.aborted && !disposed && selected === id) { loading = undefined; previewMessage(error instanceof Error ? error.message : uiText("webview.referencePanel.referenceDiagramReadingFailed")) }
    })
  }
  function syncImportControls(): void {
    const busy = !!importController
    element.setAttribute('aria-busy', String(busy))
    for (const button of element.querySelectorAll<HTMLButtonElement>('[data-ref-action=add], [data-ref-action=files], [data-ref-action=choose-files], [data-ref-action=folder]')) button.disabled = busy
    query('[data-ref-action=cancel]').hidden = !busy
  }
  async function append(kind: 'files' | 'folder'): Promise<void> {
    if (importController || disposed) return
    const controller = new AbortController(), revision = ++importRevision
    let firstAdded: string | undefined
    importController = controller
    syncImportControls(); message(kind === 'files' ? uiText("webview.referencePanel.openingLocalPicturesSelectorMultipleOptions") : uiText("webview.referencePanel.openingLocalFolderSelection"))
    try {
      const skipped = await source.append(kind, controller.signal, batch => {
        if (disposed || controller.signal.aborted || revision !== importRevision) return
        for (const entry of batch) entries.set(entry.id, entry)
        if (!firstAdded && batch.length) {
          firstAdded = batch[0].id; selected = firstAdded; search.value = ''
          page = Math.floor(Array.from(entries.keys()).indexOf(firstAdded) / REFERENCE_LIMITS.pageSize)
          resetPreview(); options.pin?.(batch[0])
        }
        render(); message(uiText("webview.referencePanel.recordedAReferenceDiagramAdding", entries.size))
      })
      if (!disposed && !controller.signal.aborted && revision === importRevision) message(firstAdded ? uiText("webview.referencePanel.referenceGraphicsChang", entries.size, skipped ? uiText("webview.referencePanel.skipInvalidOrLimitFileQualifier", skipped) : '') : skipped ? uiText("webview.referencePanel.noReferenceFigureAddedJumpingInvalidOr", skipped) : uiText("webview.referencePanel.noNewReferenceDiagramAddedToRe"))
    } catch (error) {
      if (!disposed && revision === importRevision) message(controller.signal.aborted ? uiText("webview.referencePanel.addedRetainedReferenceCharts") : error instanceof Error ? error.message : uiText("webview.referencePanel.failedToAddReferenceDiagram"))
    } finally {
      if (revision === importRevision) {
        importController = undefined
        syncImportControls()
      }
    }
  }
  function clear(): void {
    restoreController.abort(); importController?.abort(); importRevision++; importController = undefined
    const paused = suspended
    suspend(); source.clear(); options.clear?.(); entries.clear(); selected = undefined; page = 0; search.value = ''
    syncImportControls()
    suspended = paused
    message(uiText("webview.referencePanel.theReferenceDiagramHasBeenEmptiedAnd")); render()
  }
  element.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button')
    if (!button) return
    event.stopPropagation()
    const id = button.dataset.refSelect, removed = button.dataset.refRemove
    if (id) { selected = id; resetPreview(); render(); return }
    if (removed) { entries.delete(removed); source.remove(removed); options.remove?.(removed); cache.delete(removed); if (selected === removed) resetPreview(); render(); return }
    switch (button.dataset.refAction) {
      case 'add': event.preventDefault(); element.open = true; suspended = false; void append('files'); break
      case 'files':
      case 'choose-files': void append('files'); break
      case 'folder': void append('folder'); break
      case 'cancel': importController?.abort(); break
      case 'clear': clear(); break
      case 'prev': page--; resetPreview(); render(); break
      case 'next': page++; resetPreview(); render(); break
      case 'fit': fitMode = true; updateZoom(); viewport.scrollTo(0, 0); break
      case 'actual': setZoom(1); break
      case 'minus': zoomBy(-1); break
      case 'plus': zoomBy(1); break
      case 'pin': if (selected && entries.has(selected)) options.pin?.(entries.get(selected)!); break
      case 'expand': dialog.append(preview); if (!dialog.open) dialog.showModal(); updateZoom(); break
      case 'close-preview': dialog.close(); break
    }
  })
  search.addEventListener('input', () => { page = 0; resetPreview(); render() })
  element.addEventListener('toggle', () => { if (element.open) { suspended = false; render() } else suspend() })
  element.addEventListener('keydown', event => { event.stopPropagation() })
  canvas.addEventListener('pointerdown', event => { pickReferencePixel(canvas, event, options.pickColor) })
  viewport.title = uiText("webview.referencePanel.rollerZoomMiddleMouseButtonDragsHorizontally")
  viewport.addEventListener('wheel', event => {
    if (!info || canvas.hidden || !event.deltaY) return
    event.preventDefault(); event.stopPropagation()
    zoomBy(event.deltaY < 0 ? 1 : -1, [event.clientX, event.clientY])
  }, { passive: false })
  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 1 || !info || canvas.hidden || pan) return
    event.preventDefault(); event.stopPropagation(); viewport.focus({ preventScroll: true })
    pan = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop }
    viewport.setPointerCapture(event.pointerId); viewport.classList.add('is-panning')
  })
  viewport.addEventListener('pointermove', event => {
    if (!pan || pan.id !== event.pointerId) return
    event.preventDefault(); event.stopPropagation()
    viewport.scrollLeft = pan.left - (event.clientX - pan.x)
    viewport.scrollTop = pan.top - (event.clientY - pan.y)
  })
  const finishPan = (event: PointerEvent): void => { if (pan?.id === event.pointerId) { event.stopPropagation(); endPan() } }
  viewport.addEventListener('pointerup', finishPan)
  viewport.addEventListener('pointercancel', finishPan)
  viewport.addEventListener('lostpointercapture', finishPan)
  viewport.addEventListener('auxclick', event => { if (event.button === 1) { event.preventDefault(); event.stopPropagation() } })
  window.addEventListener('blur', endPan)
  dialog.addEventListener('close', () => { slot.append(preview); updateZoom() })
  const resize = new ResizeObserver(() => updateZoom()); resize.observe(viewport)
  const unload = (): void => dispose()
  window.addEventListener('pagehide', unload)
  function dispose(): void {
    if (disposed) return
    disposed = true; restoreController.abort(); importController?.abort(); importRevision++; suspend(); cache.clear(); entries.clear(); source.dispose(); resize.disconnect()
    window.removeEventListener('pagehide', unload); window.removeEventListener('blur', endPan); element.remove()
  }
  render()
  void source.restore?.(restoreController.signal, batch => {
    if (disposed || restoreController.signal.aborted) return
    for (const entry of batch) { if (entries.has(entry.id)) continue; entries.set(entry.id, entry); if (entry.layout?.pinned) options.pin?.(entry) }
    render()
  }).catch(error => { if (!disposed && !restoreController.signal.aborted) message(uiText("webview.referencePanel.referenceDiagramRecoveryFailed", String(error))) })
  return { element, suspend, resume: () => { suspended = false; render() }, clear, dispose }
}
