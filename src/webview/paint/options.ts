import { uiText } from '../../i18n/messages'
import { parseHexColor, toColorInputValue, type ToolId } from '../tools'
import { svgIcon } from '../svgIcons'
import type { App } from './app'
import { rememberColor } from './app'
import { scatterAt } from './strokes'
import { openScatterPreview } from './scatterPreview'
import { changeHistory, clearSelection, removeSelection, invertSelection, selectAll } from './actions'
import { el, iconButton, setPressed } from './dom'
import { BRUSH_RANGE, TOLERANCE_RANGE } from './state'
import { MAX_ZOOM, MIN_ZOOM, clampInt, stepZoom } from './geometry'

export interface Options {
  actions: HTMLElement
  sync(): void
}

const SIZE_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(['brush', 'nearby', 'symmetry', 'eraser', 'line', 'rect', 'ellipse'])
const TOLERANCE_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(['fill', 'wand'])

export function mountOptions(parent: HTMLElement, app: App): Options {
  const element = el('div', 'mp-options')
  const toolSlot = el('div', 'mp-options-tool')
  const selectionSlot = el('div', 'mp-options-selection')
  const opacitySlot = el('div', 'mp-options-opacity')
  const colorSlot = el('div', 'mp-options-color')
  const viewSlot = el('div', 'mp-options-view')
  const settings = el('div', 'mp-options-settings')
  const zoomControls = el('div', 'mp-zoom-controls')
  const actions = el('div', 'mp-options-actions')
  actions.setAttribute('role', 'group')
  actions.setAttribute('aria-label', uiText("webview.paint.options.modelPreviewAndExternalEditor"))
  zoomControls.setAttribute('role', 'group')
  zoomControls.setAttribute('aria-label', uiText("webview.paint.options.drawZoom"))
  zoomControls.title = uiText("webview.paint.options.rollerCtrlCmdRollerZoomShiftRoller")
  settings.append(toolSlot, opacitySlot, selectionSlot, separator(), colorSlot, separator(), viewSlot)
  element.append(settings, actions, zoomControls)
  parent.append(element)

  const sizeRow = sliderRow(uiText("webview.paint.options.brushSize"), BRUSH_RANGE.min, BRUSH_RANGE.max, () => app.state.brushSize, value => {
    app.state.brushSize = value
    app.requestRender()
  })
  const toleranceRow = sliderRow(uiText("webview.paint.options.portability"), TOLERANCE_RANGE.min, TOLERANCE_RANGE.max, () => app.state.tolerance, value => {
    app.state.tolerance = value
    app.requestRender()
  })
  const symmetry = el('select', 'mcrh-input')
  symmetry.setAttribute('aria-label', uiText("webview.paint.options.symmetricalBrushMode"))
  for (const [value, label] of [['x', uiText("webview.paint.options.xAxisSymmetryUpAndDown")], ['y', uiText("webview.paint.options.yAxisSymmetryRightAndLeft")], ['origin', uiText("webview.paint.options.originSymmetryCentre")]]) symmetry.append(new Option(label, value))
  symmetry.addEventListener('change', () => { app.state.symmetryMode = symmetry.value as typeof app.state.symmetryMode; app.host.savePreferences?.({ symmetryMode: symmetry.value }); app.requestRender() })
  const savedSymmetry = app.host.loadPreferences?.()?.symmetryMode
  if (savedSymmetry === 'x' || savedSymmetry === 'y' || savedSymmetry === 'origin') app.state.symmetryMode = savedSymmetry
  toolSlot.append(sizeRow.element, toleranceRow.element, symmetry)

  app.openScatter = () => openScatterPreview(app)
  const saved = app.host.loadPreferences?.()
  if (typeof saved?.scatterSeed === 'string' && saved.scatterSeed.length <= 256) app.state.scatterSeed = saved.scatterSeed
  if (typeof saved?.nearbyRange === 'number' && Number.isFinite(saved.nearbyRange)) app.state.nearbyRange = clampInt(saved.nearbyRange, 0, 64)
  if (typeof saved?.scatterDensity === 'number' && Number.isFinite(saved.scatterDensity)) app.state.scatterDensity = clampInt(saved.scatterDensity, 0, 100)
  if (typeof saved?.scatterOpaqueOnly === 'boolean') app.state.scatterOpaqueOnly = saved.scatterOpaqueOnly
  const nearbyRow = sliderRow(uiText("webview.paint.options.colourChange"), 0, 64, () => app.state.nearbyRange, value => {
    app.state.nearbyRange = value
    app.host.savePreferences?.({ nearbyRange: value })
  })
  nearbyRow.element.title = uiText("webview.paint.options.theSmallerTheValueIsCloseTo")
  const densityRow = sliderRow(uiText("webview.paint.options.pluginDensity"), 0, 100, () => app.state.scatterDensity, value => {
    app.state.scatterDensity = value
    app.host.savePreferences?.({ scatterDensity: value })
  })
  const opaqueLabel = el('label', 'mp-checkbox')
  const opaqueOnly = el('input'); opaqueOnly.type = 'checkbox'; opaqueOnly.setAttribute('aria-label', uiText("webview.paint.options.justALittleNonTransparentPixel"))
  opaqueOnly.addEventListener('change', () => { app.state.scatterOpaqueOnly = opaqueOnly.checked; app.host.savePreferences?.({ scatterOpaqueOnly: opaqueOnly.checked }) })
  opaqueLabel.append(opaqueOnly, uiText("webview.paint.options.nonTransparentAreaOnly"))
  const applyScatter = el('button', 'mp-text-button'); applyScatter.type = 'button'; applyScatter.textContent = uiText("webview.paint.options.previewRandomPoint")
  applyScatter.title = uiText("webview.paint.options.actOnTheCurrentLayerAndComply")
  applyScatter.addEventListener('click', () => scatterAt(app))
  toolSlot.append(nearbyRow.element, densityRow.element, opaqueLabel, applyScatter)

  const opacityRow = sliderRow(uiText("webview.paint.options.brushOpacity"), 0, 100, () => Math.round(app.state.color[3] * 100 / 255), value => {
    const [r, g, b] = app.state.color
    app.state.color = [r, g, b, Math.round(value * 255 / 100)]
    syncColor()
    app.requestChrome()
    app.requestRender()
  })
  opacityRow.element.classList.add('mp-brush-opacity')
  opacityRow.element.title = uiText("webview.paint.options.alphaWhichReplacesPixelsDirectlyDoesNot")
  const opacityUnit = el('span', 'mp-opacity-unit')
  opacityUnit.textContent = '%'
  opacityUnit.setAttribute('aria-hidden', 'true')
  opacityRow.element.append(opacityUnit)
  const opacityHint = el('span', 'mp-opacity-hint')
  opacityHint.id = 'mp-brush-opacity-hint'
  opacityHint.title = opacityRow.element.title
  opacityRow.element.querySelectorAll('input').forEach(input => input.setAttribute('aria-describedby', opacityHint.id))
  opacitySlot.append(opacityRow.element, opacityHint)

  const cancelSelection = iconButton('close', uiText("webview.paint.options.cancelSelectionCtrlD"))
  const deleteSelection = iconButton('trash', uiText("webview.paint.options.deleteSelection"))
  cancelSelection.addEventListener('click', () => clearSelection(app))
  deleteSelection.addEventListener('click', () => removeSelection(app))
  const mode = el('select', 'mcrh-input')
  mode.setAttribute('aria-label', uiText("webview.paint.options.constituentGroupMode")); mode.title = uiText("webview.paint.options.lessThanThatYouCanDigOut")
  for (const [value, label] of [['replace', uiText("webview.paint.options.replaceSelection")], ['add', uiText("webview.materialGraphEditor.add")], ['subtract', uiText("webview.paint.options.lessDeepEmpty")], ['intersect', uiText("webview.paint.options.intersection")], ['xor', uiText("webview.paint.options.excludeOverlaps")]]) mode.append(new Option(label, value))
  mode.addEventListener('change', () => { app.state.selectionMode = mode.value as typeof app.state.selectionMode })
  const all = el('button', 'mp-text-button'); all.textContent = uiText("webview.paint.options.selectAll"); all.title = 'Ctrl/Cmd+A'; all.addEventListener('click', () => selectAll(app))
  const invert = el('button', 'mp-text-button'); invert.textContent = uiText("webview.paint.bindings.invert"); invert.title = 'Ctrl/Cmd+Shift+I'; invert.addEventListener('click', () => invertSelection(app))
  selectionSlot.append(mode, all, invert, cancelSelection, deleteSelection)

  const picker = el('input', 'mp-color')
  picker.type = 'color'
  picker.title = uiText("webview.paint.options.outlookColour")
  picker.setAttribute('aria-label', uiText("webview.paint.options.outlookColour"))
  const hex = el('input', 'mcrh-input mp-hex')
  hex.type = 'text'
  hex.spellcheck = false
  hex.maxLength = 9
  hex.title = uiText("webview.paint.options.supportRggbbWithRrggbbaa")
  hex.setAttribute('aria-label', uiText("webview.paint.options.hexadecimalColour"))
  const recent = el('div', 'mp-recent')
  let shownRecent = ''
  colorSlot.append(picker, hex, recent, opacitySlot)

  picker.addEventListener('input', () => {
    const parsed = parseHexColor(picker.value)
    if (!parsed) return
    const alpha = app.state.color[3]
    app.state.color = [parsed[0], parsed[1], parsed[2], alpha]
    hex.value = colorText(app.state.color)
    app.requestChrome()
    app.requestRender()
  })
  picker.addEventListener('change', () => rememberColor(app, app.state.color))
  hex.addEventListener('change', () => {
    const parsed = parseHexColor(hex.value)
    if (!parsed) {
      app.notify(uiText("webview.paint.options.colourFormatShouldBeRrggbbOrRrggbbaa"), 'warn')
      hex.value = colorText(app.state.color)
      return
    }
    applyColor(parsed)
  })
  hex.addEventListener('keydown', event => {
    if (event.key === 'Enter') hex.blur()
    if (event.key === 'Escape') hex.value = colorText(app.state.color)
  })

  const grid = toggle('table', uiText("webview.paint.options.grid"), () => app.state.showGrid, value => {
    app.state.showGrid = value
    app.requestRender()
  })
  const guides = toggle('symbol-ruler', uiText("webview.paint.options.smartGuide"), () => app.state.showSmartGuides, value => { app.state.showSmartGuides = value; app.requestRender() })
  guides.title = uiText("webview.paint.options.showAlignmentTipsWhenApproachingLongLine")
  const transparent = toggle('color-mode', uiText("webview.paint.options.transparentBottomGayboard"), () => app.state.showTransparent, value => {
    app.state.showTransparent = value
    app.requestRender()
  })
  const zoomOut = iconButton('zoom-out', uiText("webview.paint.options.zoomOutCtrl"))
  const zoomIn = iconButton('zoom-in', uiText("webview.paint.options.zoomInCtrl"))
  const fit = iconButton('screen-full', uiText("webview.paint.options.adaptiveWindowCtrl"))
  zoomOut.replaceChildren(svgIcon('zoom-out'))
  zoomIn.replaceChildren(svgIcon('zoom-in'))
  zoomOut.classList.add('mp-zoom-step')
  zoomIn.classList.add('mp-zoom-step')
  fit.className = 'mcrh-btn mp-zoom-fit'
  fit.textContent = uiText("webview.paint.options.adaptation")
  const actual = el('button', 'mcrh-btn mp-zoom-actual')
  actual.type = 'button'
  actual.textContent = '100%'
  actual.title = uiText("webview.paint.options.actualSize")
  actual.setAttribute('aria-label', actual.title)
  actual.addEventListener('click', () => app.zoomTo(1))
  const percent = el('output', 'mcrh-tag mp-zoom-value')
  percent.setAttribute('aria-label', uiText("webview.paint.options.currentScale"))
  const undo = iconButton('reply', uiText("webview.paint.options.undoCtrlZ"))
  const redo = iconButton('redo', uiText("webview.paint.options.redoCtrlY"))
  zoomOut.addEventListener('click', () => app.zoomTo(stepZoom(app.state.zoom, -1)))
  zoomIn.addEventListener('click', () => app.zoomTo(stepZoom(app.state.zoom, 1)))
  fit.addEventListener('click', () => app.fitWindow())
  undo.addEventListener('click', () => changeHistory(app, 'undo'))
  redo.addEventListener('click', () => changeHistory(app, 'redo'))
  viewSlot.append(grid, guides, transparent, separator(), undo, redo)
  zoomControls.append(zoomOut, percent, zoomIn, actual, fit)

  function applyColor(color: [number, number, number, number]): void {
    app.state.color = color
    rememberColor(app, color)
    syncColor()
    app.requestRender()
  }

  // 最近颜色只在列表内容变化时重建按钮, 取色拖动时的频繁同步不会反复创建节点
  function syncColor(): void {
    picker.value = toColorInputValue(app.state.color)
    hex.value = colorText(app.state.color)
    const erase = app.state.tool === 'eraser'
    opacityRow.sync(erase)
    opacityHint.textContent = erase ? uiText("webview.paint.options.theRubberIsAlwaysCompletelyWipedOut") : uiText("webview.paint.options.replacingPixelsRightKeyFullWipe")
    const key = app.state.recentColors.join('|')
    if (key === shownRecent) return
    shownRecent = key
    recent.replaceChildren(...app.state.recentColors.map(recentSwatch))
  }

  function recentSwatch(value: string): HTMLButtonElement {
    const button = el('button', 'mp-swatch')
    button.type = 'button'
    button.style.background = value
    button.title = value
    button.setAttribute('aria-label', uiText("webview.paint.options.recentColours", value))
    button.addEventListener('click', () => {
      const parsed = parseHexColor(value)
      if (parsed) applyColor(parsed)
    })
    return button
  }

  // 依据当前工具决定显示哪组滑块与选区按钮, 其余隐藏而非删除, 避免布局抖动
  function sync(): void {
    const tool = app.state.tool
    sizeRow.element.hidden = !SIZE_TOOLS.has(tool)
    symmetry.hidden = tool !== 'symmetry'; symmetry.value = app.state.symmetryMode
    toleranceRow.element.hidden = !TOLERANCE_TOOLS.has(tool)
    nearbyRow.element.hidden = tool !== 'nearby' && tool !== 'scatter'
    densityRow.element.hidden = opaqueLabel.hidden = applyScatter.hidden = tool !== 'scatter'
    opaqueOnly.checked = app.state.scatterOpaqueOnly
    nearbyRow.sync(); densityRow.sync()
    sizeRow.sync()
    toleranceRow.sync()
    const hasSelection = app.state.selection !== undefined
    mode.value = app.state.selectionMode
    mode.hidden = !['select', 'polygon', 'wand'].includes(app.state.tool)
    cancelSelection.hidden = !hasSelection
    deleteSelection.hidden = !hasSelection
    setPressed(grid, app.state.showGrid)
    setPressed(guides, app.state.showSmartGuides)
    setPressed(transparent, app.state.showTransparent)
    percent.textContent = `${Number((app.state.zoom * 100).toFixed(2))}%`
    zoomOut.disabled = app.state.zoom <= MIN_ZOOM
    zoomIn.disabled = app.state.zoom >= MAX_ZOOM
    syncColor()
  }

  sync()
  return { actions, sync }
}

interface SliderRow {
  readonly element: HTMLLabelElement
  sync(disabled?: boolean): void
}

function sliderRow(label: string, min: number, max: number, read: () => number, write: (value: number) => void): SliderRow {
  const element = el('label', 'mp-slider')
  const name = el('span', 'mcrh-section-title')
  name.textContent = label
  const range = el('input', 'mcrh-range')
  range.type = 'range'
  range.min = String(min)
  range.max = String(max)
  range.step = '1'
  range.setAttribute('aria-label', label)
  const number = el('input', 'mcrh-input mp-number')
  number.type = 'number'
  number.min = String(min)
  number.max = String(max)
  number.step = '1'
  number.setAttribute('aria-label', uiText("webview.paint.options.value", label))
  range.addEventListener('input', () => {
    const value = Number(range.value)
    write(value)
    number.value = String(value)
  })
  number.addEventListener('change', () => {
    const numeric = number.valueAsNumber
    const value = Number.isFinite(numeric) ? clampInt(numeric, min, max) : read()
    if (Number.isFinite(numeric)) write(value)
    range.value = String(value)
    number.value = String(value)
  })
  element.append(name, range, number)
  return {
    element,
    sync(disabled = false) {
      range.disabled = disabled
      number.disabled = disabled
      const value = read()
      range.value = String(value)
      if (document.activeElement !== number) number.value = String(value)
    }
  }
}

function toggle(name: string, label: string, read: () => boolean, write: (value: boolean) => void): HTMLButtonElement {
  const button = iconButton(name, label)
  button.addEventListener('click', () => {
    write(!read())
    setPressed(button, read())
  })
  return button
}

function colorText(rgba: [number, number, number, number]): string {
  const alpha = rgba[3] === 255 ? '' : rgba[3].toString(16).padStart(2, '0')
  return toColorInputValue(rgba) + alpha
}

function separator(): HTMLSpanElement {
  return el('span', 'mcrh-sep')
}
