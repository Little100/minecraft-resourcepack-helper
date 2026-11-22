import { uiText } from '../../i18n/messages'
import type { App } from './app'
import { el, iconButton } from './dom'
import { formatRgba } from '../tools'

export interface PaintDock {
  readonly element: HTMLElement
  readonly layerSlot: HTMLElement
  sync(): void
  draw(sourceRevision?: number): void
  setColorControls(controls: HTMLElement): void
}

export function mountPaintDock(parent: HTMLElement, app: App, sourceCanvas?: HTMLCanvasElement): PaintDock {
  const element = el('aside', 'mp-dock')
  element.setAttribute('aria-label', uiText("webview.paint.dock.paintingPanel"))
  const saved = app.host.loadPreferences?.() as { sidebarWidth?: number } | undefined
  let width = Math.max(204, Math.min(420, Number(saved?.sidebarWidth) || 268))
  element.style.width = `${width}px`
  const grip = el('div', 'mp-dock-grip')
  grip.tabIndex = 0; grip.setAttribute('role', 'separator'); grip.setAttribute('aria-label', uiText("webview.paint.dock.resizeSidebar")); grip.setAttribute('aria-orientation', 'vertical')
  const navigator = el('section', 'mp-panel mp-navigator')
  const navTitle = el('header', 'mp-panel-head'); navTitle.textContent = uiText("webview.paint.dock.navigationer")
  const fit = iconButton('screen-normal', uiText("webview.paint.dock.adaptToCanvas")); fit.addEventListener('click', () => app.fitWindow()); navTitle.append(fit)
  const thumbnail = el('canvas', 'mp-navigator-canvas mp-checker'); thumbnail.width = 192; thumbnail.height = 136
  thumbnail.setAttribute('aria-label', uiText("webview.paint.dock.drawThumbnailsClickLocation")); thumbnail.tabIndex = 0
  const metadata = el('div', 'mp-panel-detail')
  navigator.append(navTitle, thumbnail, metadata)
  const colors = el('section', 'mp-panel mp-colors')
  const colorTitle = el('header', 'mp-panel-head'); colorTitle.textContent = uiText("webview.paint.dock.coloursAndSampling")
  const gesture = el('span', 'mp-panel-tag'); gesture.textContent = uiText("webview.paint.dock.altLeft"); colorTitle.append(gesture)
  const colorControls = el('div', 'mp-color-controls')
  const rgba = el('output', 'mp-color-readout')
  colors.append(colorTitle, colorControls, rgba)
  const layerSlot = el('div', 'mp-dock-layers')
  const help = el('div', 'mp-dock-help'); help.textContent = uiText("webview.paint.dock.spaceGrabperAltLeftInsorptionShortcutCustomises")
  element.append(grip, navigator, colors, layerSlot, help); parent.append(element)
  const ctx = thumbnail.getContext('2d')!
  let revision = -1, sourceSize = '', drag: { id: number; x: number; width: number } | undefined
  function resize(value: number): void { width = Math.max(204, Math.min(420, value)); element.style.width = `${width}px`; grip.setAttribute('aria-valuenow', String(Math.round(width))); app.requestChrome() }
  function persist(): void { app.host.savePreferences?.({ sidebarWidth: Math.round(width) }) }
  grip.addEventListener('pointerdown', event => { if (event.button !== 0) return; event.preventDefault(); drag = { id: event.pointerId, x: event.clientX, width }; grip.setPointerCapture(event.pointerId) })
  grip.addEventListener('pointermove', event => { if (drag?.id === event.pointerId) resize(drag.width + drag.x - event.clientX) })
  const finish = () => { if (!drag) return; if (grip.hasPointerCapture(drag.id)) grip.releasePointerCapture(drag.id); drag = undefined; persist() }
  grip.addEventListener('pointerup', finish); grip.addEventListener('pointercancel', finish); window.addEventListener('blur', finish)
  grip.addEventListener('keydown', event => { if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return; event.preventDefault(); resize(width + (event.key === 'ArrowLeft' ? 16 : -16)); persist() })
  thumbnail.addEventListener('click', event => {
    const source = document.querySelector<HTMLElement>('.mp-canvas'); if (!source) return
    const box = thumbnail.getBoundingClientRect(), canvasBox = source.getBoundingClientRect(), stage = app.scroller.getBoundingClientRect()
    const ratio = Math.min(thumbnail.width / app.state.width, thumbnail.height / app.state.height)
    const left = (thumbnail.width - app.state.width * ratio) / 2, top = (thumbnail.height - app.state.height * ratio) / 2
    const x = ((event.clientX - box.left) * thumbnail.width / box.width - left) / ratio
    const y = ((event.clientY - box.top) * thumbnail.height / box.height - top) / ratio
    if (x < 0 || y < 0 || x >= app.state.width || y >= app.state.height) return
    app.scroller.scrollLeft += canvasBox.left - stage.left + x * app.state.zoom - app.scroller.clientWidth / 2
    app.scroller.scrollTop += canvasBox.top - stage.top + y * app.state.zoom - app.scroller.clientHeight / 2
  })
  function sync(): void {
    metadata.textContent = `${app.state.width} × ${app.state.height} px · ${app.state.zoom * 100}%${app.state.frameCount > 1 ? uiText("webview.paint.dock.frame", app.state.frameCount) : ''}`
    rgba.textContent = formatRgba(app.state.color) + ' · RGBA ' + app.state.color.join(', ')
  }
  function draw(sourceRevision = app.state.revision): void {
    const source = sourceCanvas ?? document.querySelector<HTMLCanvasElement>('.mp-pixels'); if (!source) return
    const size = `${source.width}:${source.height}`
    if (revision === sourceRevision && sourceSize === size) return
    revision = sourceRevision; sourceSize = size
    ctx.clearRect(0, 0, thumbnail.width, thumbnail.height); ctx.imageSmoothingEnabled = false
    const ratio = Math.min(thumbnail.width / source.width, thumbnail.height / source.height)
    const w = source.width * ratio, h = source.height * ratio
    if (source.width && source.height) ctx.drawImage(source, (thumbnail.width - w) / 2, (thumbnail.height - h) / 2, w, h)
  }
  resize(width)
  return { element, layerSlot, sync, draw, setColorControls: controls => { colorControls.append(controls) } }
}
