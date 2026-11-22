import { uiText } from '../../i18n/messages'
import type { App } from './app'
import { mountRandomVariants } from './randomVariants'
import { defaultVariantId } from '../../core/randomVariants'
import { el, iconButton, setIcon, setPressed } from './dom'
import { clampInt, frameHeightOf } from './geometry'
import { activeLayer, layerById, type LayerBuffer } from './state'
import { createThumb, paintThumb } from './thumbs'

export interface Layers {
  sync(): void
  drawThumbs(): void
}

interface Row {
  element: HTMLDivElement
  eye: HTMLButtonElement
  thumb: HTMLCanvasElement
  name: HTMLSpanElement
  editing: boolean
}

export function mountLayers(parent: HTMLElement, app: App): Layers {
  const { state, host } = app
  const element = el('section', 'mp-layers')
  element.setAttribute('aria-label', uiText("webview.paint.editing.layer"))
  const head = el('div', 'mp-layers-head')
  const title = el('span', 'mcrh-section-title')
  title.textContent = uiText("webview.paint.editing.layer")
  const exportButton = iconButton('export', uiText("webview.paint.layers.exportSelectedLayerToPngReserveStand"))
  const mergeExportButton = iconButton('collapse-all', uiText("webview.paint.layers.exportPngCtrlCmdClickMultipleAfter"))
  const addButton = iconButton('add', uiText("ui.pixelEditor.addLayer"))
  const upButton = iconButton('arrow-up', uiText("webview.paint.layers.moveLayerUp"))
  const downButton = iconButton('arrow-down', uiText("webview.paint.layers.moveLayerDown"))
  const removeButton = iconButton('trash', uiText("ui.pixelEditor.removeLayer"))
  head.append(title, exportButton, mergeExportButton, addButton, upButton, downButton, removeButton)

  const list = el('div', 'mp-layer-list')
  list.setAttribute('role', 'listbox'); list.setAttribute('aria-multiselectable', 'true'); list.title = uiText("webview.paint.layers.ctrlCmdClickMultipleShiftClickTo")
  const foot = el('div', 'mp-layers-foot')
  const opacityTitle = el('span', 'mcrh-section-title')
  opacityTitle.textContent = uiText("webview.paint.layers.opacity")
  const opacityRange = el('input', 'mcrh-range mp-opacity')
  opacityRange.type = 'range'
  opacityRange.min = '0'
  opacityRange.max = '100'
  opacityRange.step = '1'
  opacityRange.setAttribute('aria-label', uiText("webview.paint.layers.currentLayerOpacity"))
  const opacityNumber = el('input', 'mcrh-input mp-number')
  opacityNumber.type = 'number'
  opacityNumber.min = '0'
  opacityNumber.max = '100'
  opacityNumber.step = '1'
  opacityNumber.setAttribute('aria-label', uiText("webview.paint.layers.currentLayerOpacityValue"))
  foot.append(opacityTitle, opacityRange, opacityNumber)
  element.append(head, list, foot)
  const syncVariants = mountRandomVariants(element, app)
  parent.append(element)

  const rows = new Map<string, Row>()
  let thumbRevision = -1

  exportButton.addEventListener('click', () => {
    const layerIds = selectedIds()
    if (layerIds.length) host.post({ command: 'pixelTools', action: 'exportLayers', layerIds, mode: 'layers' })
  })
  mergeExportButton.addEventListener('click', () => {
    const layerIds = selectedIds()
    if (layerIds.length) host.post({ command: 'pixelTools', action: 'exportLayers', layerIds, mode: 'merged' })
  })
  addButton.addEventListener('click', () => host.post({ command: 'addLayer' }))
  upButton.addEventListener('click', () => moveActive(-1))
  downButton.addEventListener('click', () => moveActive(1))
  removeButton.addEventListener('click', () => {
    const id = state.activeLayerId
    if (id !== undefined) host.post({ command: 'removeLayer', layerId: id })
  })

  function moveActive(delta: number): void {
    const index = indexOfActive()
    const target = index + delta
    if (index < 0 || target < 0 || target >= state.layers.length) return
    host.post({ command: 'moveLayer', layerId: state.layers[index].id, toIndex: target })
  }

  function selectedIds(): string[] {
    const selected = new Set(state.selectedLayerIds ?? (state.activeLayerId ? [state.activeLayerId] : []))
    return state.layers.filter(layer => selected.has(layer.id)).map(layer => layer.id)
  }

  function indexOfActive(): number {
    return state.layers.findIndex(layer => layer.id === state.activeLayerId)
  }

  // 拖动时只预览，松开时才记一次修改
  opacityRange.addEventListener('input', () => previewOpacity(Number(opacityRange.value)))
  opacityRange.addEventListener('change', () => commitOpacity(Number(opacityRange.value)))
  opacityNumber.addEventListener('change', () => {
    const percent = clampInt(Number(opacityNumber.value), 0, 100)
    opacityRange.value = String(percent)
    opacityNumber.value = String(percent)
    commitOpacity(percent)
  })

  function previewOpacity(percent: number): void {
    const layer = activeLayer(state)
    if (!layer) return
    layer.opacity = percent / 100
    state.fullRedraw = true
    opacityNumber.value = String(percent)
    app.requestRender()
  }

  function commitOpacity(percent: number): void {
    const layer = activeLayer(state)
    if (!layer) return
    layer.opacity = percent / 100
    state.fullRedraw = true
    host.post({ command: 'setLayerOpacity', layerId: layer.id, opacity: percent / 100 })
    app.requestRender()
  }

  function createRow(id: string): Row {
    const row = el('div', 'mp-layer')
    row.tabIndex = 0
    const eye = iconButton('eye', uiText("paint.toggleLayer"), 'mcrh-icon-btn mp-eye')
    const thumb = createThumb()
    const name = el('span', 'mp-layer-name')
    name.dataset.variantLabel = uiText('paint.variantBadge')
    row.append(eye, thumb, name)
    const entry: Row = { element: row, eye, thumb, name, editing: false }
    row.setAttribute('role', 'option')
    row.addEventListener('click', event => activate(id, event.ctrlKey || event.metaKey, event.shiftKey))
    row.addEventListener('keydown', event => { if (event.target !== row || !['Enter', ' '].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); activate(id, event.ctrlKey || event.metaKey, event.shiftKey) })
    eye.addEventListener('click', event => {
      event.stopPropagation()
      toggleVisible(id)
    })
    name.addEventListener('dblclick', event => {
      event.stopPropagation()
      beginRename(entry, id)
    })
    return entry
  }

  function activate(id: string, additive = false, range = false): void {
    const selected = new Set(state.selectedLayerIds ?? (state.activeLayerId ? [state.activeLayerId] : []))
    if (range && state.activeLayerId) {
      const from = state.layers.findIndex(layer => layer.id === state.activeLayerId), to = state.layers.findIndex(layer => layer.id === id)
      for (let index = Math.min(from, to); index <= Math.max(from, to); index++) selected.add(state.layers[index].id)
    } else if (additive) { if (selected.has(id) && selected.size > 1) selected.delete(id); else selected.add(id) }
    else { selected.clear(); selected.add(id) }
    state.selectedLayerIds = [...selected]
    const active = selected.has(id) ? id : [...selected].at(-1)!
    if (state.activeLayerId !== active) { state.activeLayerId = active; host.post({ command: 'setActiveLayer', layerId: active }) }
    if (layerById(state, active)?.randomVariant) state.previewVariantId = active
    state.fullRedraw = true
    app.requestRender()
    app.requestChrome()
  }

  function toggleVisible(id: string): void {
    const layer = layerById(state, id)
    if (!layer) return
    layer.visible = !layer.visible
    state.fullRedraw = true
    host.post({ command: 'setLayerVisible', layerId: id, visible: layer.visible })
    app.requestChrome()
  }

  function beginRename(row: Row, id: string): void {
    const layer = layerById(state, id)
    if (!layer || row.editing) return
    row.editing = true
    const input = el('input', 'mcrh-input mp-rename')
    input.value = layer.name
    input.setAttribute('aria-label', uiText("webview.paint.layers.layerName"))
    row.name.hidden = true
    row.name.after(input)
    input.focus()
    input.select()
    const finish = (commit: boolean): void => {
      if (!row.editing) return
      row.editing = false
      const next = input.value.trim()
      input.remove()
      row.name.hidden = false
      if (commit && next !== '' && next !== layer.name) host.post({ command: 'renameLayer', layerId: id, name: next })
    }
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault()
        finish(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        finish(false)
      }
      event.stopPropagation()
    })
    input.addEventListener('click', event => event.stopPropagation())
    input.addEventListener('blur', () => finish(true))
  }

  function updateRow(row: Row, layer: LayerBuffer, active: boolean): void {
    const selected = (state.selectedLayerIds ?? [state.activeLayerId]).includes(layer.id)
    row.element.classList.toggle('is-active', active)
    row.element.classList.toggle('is-selected', selected)
    row.element.setAttribute('aria-selected', String(selected))
    row.element.classList.toggle('is-hidden', !layer.visible)
    row.element.setAttribute('aria-current', String(active))
    setIcon(row.eye, layer.visible ? 'eye' : 'eye-closed')
    setPressed(row.eye, layer.visible)
    const visibilityLabel = (layer.visible ? uiText("webview.paint.layers.hide") : uiText("webview.paint.layers.show")) + uiText("webview.paint.layers.layer") + layer.name + uiText("webview.paint.layers.alsoAffectPngSavingAndExportQualifier")
    row.eye.title = visibilityLabel; row.eye.setAttribute('aria-label', visibilityLabel)
    row.element.classList.toggle('is-variant', !!layer.randomVariant)
    row.element.title = layer.randomVariant ? uiText("webview.paint.layers.randomCandidateWeight", layer.randomVariant.weight, (defaultVariantId(state.layers) === layer.id ? uiText("webview.paint.layers.defaultPng") : '')) : uiText("webview.paint.layers.sharedLayer")
    if (!row.editing && row.name.textContent !== layer.name) row.name.textContent = layer.name
  }

  function sync(): void {
    const seen = new Set<string>()
    state.layers.forEach((layer, index) => {
      let row = rows.get(layer.id)
      if (!row) {
        row = createRow(layer.id)
        rows.set(layer.id, row)
      }
      seen.add(layer.id)
      updateRow(row, layer, layer.id === state.activeLayerId)
      const current = list.children[index]
      if (current !== row.element) list.insertBefore(row.element, current ?? null)
    })
    for (const [id, row] of rows) {
      if (seen.has(id)) continue
      row.element.remove()
      rows.delete(id)
    }
    thumbRevision = -1
    syncFooter()
  }

  function syncFooter(): void {
    syncVariants()
    const selectedCount = selectedIds().length
    exportButton.disabled = selectedCount === 0
    mergeExportButton.disabled = selectedCount === 0
    title.textContent = selectedCount > 1 ? uiText("webview.paint.layers.layerSelected", selectedCount) : uiText("webview.paint.editing.layer")
    const index = indexOfActive()
    const layer = activeLayer(state)
    upButton.disabled = index <= 0
    downButton.disabled = index < 0 || index >= state.layers.length - 1
    removeButton.disabled = state.layers.length <= 1
    opacityRange.disabled = !layer
    opacityNumber.disabled = !layer
    if (!layer) return
    const percent = String(Math.round(layer.opacity * 100))
    if (document.activeElement !== opacityRange) opacityRange.value = percent
    if (document.activeElement !== opacityNumber) opacityNumber.value = percent
  }

  function drawThumbs(): void {
    if (thumbRevision === state.revision) return
    thumbRevision = state.revision
    const frameHeight = frameHeightOf(state.height, state.frameCount)
    for (const layer of state.layers) {
      const row = rows.get(layer.id)
      if (row) paintThumb(row.thumb, layer, state.width, frameHeight)
    }
  }

  return { sync, drawThumbs }
}
