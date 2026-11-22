import { uiText } from '../i18n/messages'
import { REFERENCE_LIMITS, type ReferenceEntry, type ReferenceSource } from '../core/referenceImages'
import { mountReferencePanel } from './referencePanel'
import { decodeReferenceImage, pickReferencePixel } from './referenceImageDecoder'

interface ReferenceCard {
  entry: ReferenceEntry; element: HTMLElement; canvas: HTMLCanvasElement; message: HTMLElement; controller?: AbortController; bytes: number; hidden: boolean; locked: boolean
}

// 参考素材保持独立画布，只把取到的颜色交给画笔
export function mountReferenceWorkspace(parent: HTMLElement, source: ReferenceSource, pickColor?: (color: [number, number, number, number]) => void) {
  const layer = document.createElement('section'); layer.className = 'reference-workspace'; layer.setAttribute('aria-label', uiText("webview.referenceWorkspace.painterReferenceArea"))
  const tools = document.createElement('div'); tools.className = 'reference-workspace-tools'
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.textContent = uiText("webview.referencePanel.referenceChart"); toggle.setAttribute('aria-label', uiText("webview.referenceWorkspace.managementReferenceDiagram"))
  const restore = document.createElement('select'); restore.setAttribute('aria-label', uiText("webview.referenceWorkspace.restoreHiddenReferenceDiagrams")); restore.hidden = true
  const library = document.createElement('div'); library.className = 'reference-library'; library.hidden = true
  tools.append(toggle, restore); layer.append(tools, library); parent.append(layer)
  const cards = new Map<string, ReferenceCard>()
  let disposed = false, suspended = false, activeBytes = 0, zIndex = 1
  const manager = mountReferencePanel(library, source, { pickColor, pin, remove, clear: () => { for (const id of [...cards.keys()]) remove(id) } })
  toggle.addEventListener('click', () => { library.hidden = !library.hidden; manager.element.open = !library.hidden; toggle.setAttribute('aria-expanded', String(!library.hidden)) })
  restore.addEventListener('change', () => { const card = cards.get(restore.value); if (card) { card.hidden = false; card.element.hidden = false; card.element.style.zIndex = String(++zIndex); void load(card); save(card) }; syncRestore() })
  layer.addEventListener('keydown', event => event.stopPropagation())
  layer.addEventListener('pointerdown', event => event.stopPropagation())
  function syncRestore(): void {
    restore.replaceChildren(new Option(uiText("webview.referenceWorkspace.restoreHiddenReferenceDiagrams"), ''))
    for (const card of cards.values()) if (card.hidden) restore.append(new Option(card.entry.name, card.entry.id))
    restore.value = ''; restore.hidden = restore.options.length === 1
  }
  function release(card: ReferenceCard): void {
    card.controller?.abort(); card.controller = undefined
    activeBytes -= card.bytes; card.bytes = 0; card.canvas.width = 0; card.canvas.height = 0
  }
  function save(card: ReferenceCard, pinned = true): void {
    const layout = { x: Number.parseFloat(card.element.style.left) || 0, y: Number.parseFloat(card.element.style.top) || 0, width: Number.parseFloat(card.canvas.style.width) || 248, hidden: card.hidden, locked: card.locked, pinned }
    card.entry.layout = layout; source.saveLayout?.(card.entry.id, layout)
  }
  function hide(card: ReferenceCard): void { card.hidden = true; card.element.hidden = true; release(card); save(card); syncRestore() }
  function remove(id: string): void { const card = cards.get(id); if (!card) return; release(card); card.element.remove(); cards.delete(id); syncRestore() }
  async function load(card: ReferenceCard): Promise<void> {
    release(card)
    if (disposed || suspended || card.hidden) return
    const controller = new AbortController(); card.controller = controller; card.message.textContent = uiText("webview.referenceWorkspace.readingReferenceDiagram")
    try {
      const blob = await source.read(card.entry.id, controller.signal), bitmap = await decodeReferenceImage(blob, controller.signal, bytes => {
        if (bytes > REFERENCE_LIMITS.cacheBytes) throw new Error(uiText("webview.referenceWorkspace.referenceChartsMoreThanShowMemoryBudget"))
        for (const other of cards.values()) { if (activeBytes + bytes <= REFERENCE_LIMITS.cacheBytes) break; if (other !== card && other.bytes) hide(other) }
      })
      try {
        if (disposed || suspended || card.hidden || controller.signal.aborted || card.controller !== controller) return
        const bytes = bitmap.width * bitmap.height * 4
        if (bytes > REFERENCE_LIMITS.cacheBytes) throw new Error(uiText("webview.referenceWorkspace.referenceChartsMoreThanShowMemoryBudget"))
        for (const other of cards.values()) { if (activeBytes + bytes <= REFERENCE_LIMITS.cacheBytes) break; if (other !== card && other.bytes) hide(other) }
        card.canvas.width = bitmap.width; card.canvas.height = bitmap.height
        card.canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
        activeBytes += bytes; card.bytes = bytes; card.message.textContent = uiText("webview.referenceWorkspace.altClickToColourMiddleKeyHorizontal")
        if (!card.canvas.style.width) { card.canvas.style.width = Math.min(bitmap.width, 248) + 'px'; save(card) }
      } finally { bitmap.close() }
    } catch (error) { if (!controller.signal.aborted && !disposed) card.message.textContent = error instanceof Error ? error.message : uiText("webview.referencePanel.referenceDiagramReadingFailed") }
  }
  function pin(entry: ReferenceEntry): void {
    const existing = cards.get(entry.id)
    if (existing) { library.hidden = true; manager.element.open = false; toggle.setAttribute('aria-expanded', 'false'); existing.hidden = false; existing.element.hidden = false; existing.element.style.zIndex = String(++zIndex); if (!existing.bytes) void load(existing); syncRestore(); save(existing); return }
    const element = document.createElement('section'); element.className = 'reference-card'; element.setAttribute('aria-label', uiText("webview.referenceWorkspace.referenceChart", entry.name)); element.dataset.referenceId = entry.id
    const header = document.createElement('header'), name = document.createElement('span'); name.textContent = entry.name; name.title = entry.name
    const canvas = document.createElement('canvas'), image = document.createElement('div'), message = document.createElement('p')
    canvas.setAttribute('aria-label', uiText("webview.referenceWorkspace.floatingReferenceImages")); image.className = 'reference-card-image'; image.append(canvas); message.className = 'reference-card-status'
    const card: ReferenceCard = { entry, element, canvas, message, bytes: 0, hidden: entry.layout?.hidden ?? false, locked: entry.layout?.locked ?? false }
    const action = (label: string, run: () => void): HTMLButtonElement => { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.addEventListener('pointerdown', event => event.stopPropagation()); button.addEventListener('click', run); return button }
    const lock = action(uiText("webview.referenceWorkspace.fixed"), () => { card.locked = !card.locked; lock.setAttribute('aria-pressed', String(card.locked)); lock.textContent = card.locked ? uiText("webview.referenceWorkspace.unlock") : uiText("webview.referenceWorkspace.fixed"); element.dataset.locked = String(card.locked); save(card) }); lock.setAttribute('aria-pressed', String(card.locked)); lock.textContent = card.locked ? uiText("webview.referenceWorkspace.unlock") : uiText("webview.referenceWorkspace.fixed"); element.dataset.locked = String(card.locked)
    header.append(name, lock, action(uiText("webview.paint.layers.hide"), () => hide(card)), action(uiText("webview.packTools.remove"), () => { save(card, false); remove(entry.id) }))
    element.append(header, image, message); layer.append(element); cards.set(entry.id, card)
    element.style.left = 12 + cards.size % 5 * 22 + 'px'; element.style.top = 50 + cards.size % 5 * 24 + 'px'; element.style.zIndex = String(++zIndex)
    if (entry.layout) { element.style.left = entry.layout.x + 'px'; element.style.top = entry.layout.y + 'px'; canvas.style.width = entry.layout.width + 'px' }
    element.hidden = card.hidden; syncRestore(); save(card)
    let drag: { id: number; x: number; y: number; left: number; top: number } | undefined
    header.addEventListener('pointerdown', event => {
      if (card.locked || event.button !== 0 || (event.target as Element).closest('button')) return
      event.preventDefault(); header.setPointerCapture(event.pointerId)
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: element.offsetLeft, top: element.offsetTop }
      element.style.zIndex = String(++zIndex)
    })
    header.addEventListener('pointermove', event => { if (!drag || drag.id !== event.pointerId) return; element.style.left = Math.max(0, Math.min(Math.max(0, layer.clientWidth - element.offsetWidth), drag.left + event.clientX - drag.x)) + 'px'; element.style.top = Math.max(0, Math.min(Math.max(0, layer.clientHeight - 36), drag.top + event.clientY - drag.y)) + 'px' })
    const endDrag = (): void => { if (drag && header.hasPointerCapture(drag.id)) header.releasePointerCapture(drag.id); if (drag) save(card); drag = undefined }
    header.addEventListener('pointerup', endDrag); header.addEventListener('pointercancel', endDrag); header.addEventListener('lostpointercapture', () => { drag = undefined })
    canvas.addEventListener('pointerdown', event => { pickReferencePixel(canvas, event, pickColor) })
    image.addEventListener('wheel', event => { if (!card.bytes || !event.deltaY) return; event.preventDefault(); event.stopPropagation(); const width = Number.parseFloat(canvas.style.width) || canvas.width; canvas.style.width = Math.max(8, Math.min(canvas.width * 32, width * (event.deltaY < 0 ? 1.2 : 1 / 1.2))) + 'px'; save(card) }, { passive: false })
    let pan: { id: number; x: number; y: number; left: number; top: number } | undefined
    image.addEventListener('pointerdown', event => { if (event.button !== 1) return; event.preventDefault(); image.setPointerCapture(event.pointerId); pan = { id: event.pointerId, x: event.clientX, y: event.clientY, left: image.scrollLeft, top: image.scrollTop } })
    image.addEventListener('pointermove', event => { if (pan?.id === event.pointerId) { image.scrollLeft = pan.left + pan.x - event.clientX; image.scrollTop = pan.top + pan.y - event.clientY } })
    image.addEventListener('pointerup', () => { if (pan && image.hasPointerCapture(pan.id)) image.releasePointerCapture(pan.id); pan = undefined }); image.addEventListener('pointercancel', () => { pan = undefined }); image.addEventListener('auxclick', event => { if (event.button === 1) event.preventDefault() })
    library.hidden = true; manager.element.open = false; toggle.setAttribute('aria-expanded', 'false')
    void load(card)
  }
  const resize = new ResizeObserver(() => { for (const card of cards.values()) { card.element.style.left = Math.max(0, Math.min(card.element.offsetLeft, layer.clientWidth - 40)) + 'px'; card.element.style.top = Math.max(0, Math.min(card.element.offsetTop, layer.clientHeight - 36)) + 'px' } }); resize.observe(parent)
  return { element: layer, manager, suspend(): void { suspended = true; layer.hidden = true; manager.suspend(); for (const card of cards.values()) release(card) }, resume(): void { suspended = false; layer.hidden = false; manager.resume(); for (const card of cards.values()) if (!card.hidden) void load(card) }, clear(): void { manager.clear() }, dispose(): void { if (disposed) return; disposed = true; for (const id of [...cards.keys()]) remove(id); manager.dispose(); resize.disconnect(); layer.remove() } }
}
