import { uiText } from '../../i18n/messages'
import { TOOLS, formatRgba, type ToolId } from '../tools'
import type { App } from './app'
import { selectTool } from './actions'
import { el, iconButton, setIcon, setPressed } from './dom'
import { validateBindings } from './bindings'
import { PEN_SELECTION_HINT } from './selectionPath'

export interface Toolbar { sync(): void }

export function mountToolbar(parent: HTMLElement, app: App): Toolbar {
  const element = el('nav', 'mp-toolbar'); element.setAttribute('aria-label', uiText("ui.tutorialCards.tools"))
  const saved = app.host.loadPreferences?.() as { toolbarColumns?: number } | undefined
  element.classList.toggle('is-two-column', saved?.toolbarColumns === 2)
  const head = el('div', 'mp-rail-head'), grid = el('div', 'mp-tools-grid'), foot = el('div', 'mp-rail-foot')
  grid.id = 'mp-tools-grid'
  const columns = iconButton('chevron-right', uiText("webview.paint.toolbar.toggleDoubleColumns"))
  columns.setAttribute('aria-controls', grid.id)
  columns.addEventListener('click', () => { const expanded = element.classList.toggle('is-two-column'); app.host.savePreferences?.({ toolbarColumns: expanded ? 2 : 1 }); app.requestChrome() })
  head.append(columns)
  const buttons = new Map<ToolId, HTMLButtonElement>()
  let lastGroup = TOOLS[0]?.group ?? 0
  for (const tool of TOOLS) {
    if (tool.group !== lastGroup) { grid.append(el('span', 'mp-toolbar-sep')); lastGroup = tool.group }
    const button = iconButton(tool.icon, tool.label, 'mcrh-icon-btn mp-tool'); button.dataset.tool = tool.id
    button.addEventListener('click', () => selectTool(app, tool.id)); buttons.set(tool.id, button); grid.append(button)
  }
  const edge = iconButton('color-mode', uiText("webview.paint.toolbar.autoEdgesHeavyOnColourCurrentLayer"), 'mcrh-icon-btn mp-effect-entry')
  const edgeLabel = el('span', 'mp-effect-label'); edgeLabel.textContent = uiText("webview.paint.edgeRecolor.automaticEdgesHeavyOnColour"); edge.append(edgeLabel)
  edge.setAttribute('aria-haspopup', 'dialog'); edge.setAttribute('aria-controls', 'mp-edge-recolor-dialog')
  edge.dataset.action = 'edge-recolor'; edge.addEventListener('click', () => app.openEdgeRecolor?.())
  const dimensions = iconButton('screen-full', uiText("webview.paint.toolbar.imageSizeAnimationFrames"), 'mcrh-icon-btn mp-tool')
  dimensions.dataset.action = 'image-size'; dimensions.addEventListener('click', () => app.openImageEditing?.())
  head.append(edge)
  grid.append(el('span', 'mp-toolbar-sep'), dimensions)
  const colors = el('div', 'mp-color-stack')
  const background = el('input', 'mp-color-square mp-color-back'); background.type = 'color'; background.setAttribute('aria-label', uiText("webview.paint.toolbar.backgroundColour"))
  const foreground = el('button', 'mp-color-square mp-color-front'); foreground.type = 'button'; foreground.setAttribute('aria-label', uiText("webview.paint.toolbar.editForegroundColour"))
  foreground.addEventListener('click', () => document.querySelector<HTMLInputElement>('.mp-color')?.click())
  background.addEventListener('input', () => { const hex = background.value.slice(1); app.state.backgroundColor = [parseInt(hex.slice(0,2),16), parseInt(hex.slice(2,4),16), parseInt(hex.slice(4,6),16), 255]; app.requestChrome() })
  colors.append(background, foreground)
  const swap = iconButton('arrow-swap', uiText("webview.paint.bindings.exchangeForegroundAndBackgroundColours")), settings = iconButton('gear', uiText("webview.paint.shortcuts.customisedCanvasShortcutKey"))
  swap.addEventListener('click', () => { const color = app.state.color; app.state.color = app.state.backgroundColor ?? [0,0,0,255]; app.state.backgroundColor = color; app.requestChrome() })
  settings.addEventListener('click', () => app.openShortcuts?.())
  foot.append(colors, swap, settings); element.append(head, grid, foot); parent.append(element)
  function sync(): void {
    const expanded = element.classList.contains('is-two-column')
    columns.setAttribute('aria-expanded', String(expanded))
    setPressed(columns, expanded)
    setIcon(columns, expanded ? 'chevron-left' : 'chevron-right')
    const bindings = validateBindings(app.state.keybindings ?? {}).bindings
    for (const tool of TOOLS) {
      const button = buttons.get(tool.id)!, key = bindings[`tool:${tool.id}`]
      setPressed(button, tool.id === app.state.tool)
      const title = `${tool.label}${key ? ' (' + key + ')' : uiText("webview.paint.toolbar.unboundQualifier")} · ${tool.id === 'polygon' ? PEN_SELECTION_HINT : tool.hint}`
      button.title = title; button.setAttribute('aria-label', title)
    }
    foreground.style.background = formatRgba(app.state.color)
    background.value = formatRgba(app.state.backgroundColor ?? [0,0,0,255]).slice(0,7)
  }
  sync(); return { sync }
}
