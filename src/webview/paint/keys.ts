import { createKeybindingsHandler } from 'tinykeys'
import { applyCrop, cancelPending, clearSelection, invertSelection, selectAll, hasPending, removeSelection, selectTool, stepBrush } from './actions'
import type { App } from './app'
import { stepZoom } from './geometry'
import { changePathHistory, closeSelectionPath } from './selectionPath'
import { actionForKeyboardEvent, listBindingActions, validateBindings, type BindingActionId, type BindingPlatform } from './bindings'
import type { ToolId } from '../tools'

export function attachKeys(app: App): void {
  const platform: BindingPlatform = /Mac|iPhone|iPad/.test(navigator.platform) ? 'mac' : 'windows'
  let signature = '', handler: EventListener | undefined
  const actions = listBindingActions()
  function dispatch(action: BindingActionId, event: KeyboardEvent): void {
    if (event.repeat && !actions.find(item => item.id === action)?.repeatable) return
    if (action.startsWith('tool:')) { selectTool(app, action.slice(5) as ToolId); event.preventDefault(); return }
    switch (action) {
      case 'removeSelection': if (!app.state.selection) return; removeSelection(app); break
      case 'clearSelection': clearSelection(app); break
      case 'selectAll': selectAll(app); break
      case 'invertSelection': invertSelection(app); break
      case 'cancelPending': if (hasPending(app.state)) cancelPending(app); else if (app.state.selection) clearSelection(app); else return; break
      case 'applyPending': if (app.state.crop?.active) applyCrop(app); else if (app.state.pen.length) closeSelectionPath(app); else return; break
      case 'brushSmaller': stepBrush(app, -1); break
      case 'brushLarger': stepBrush(app, 1); break
      case 'zoomIn': app.zoomTo(stepZoom(app.state.zoom, 1)); break
      case 'zoomOut': app.zoomTo(stepZoom(app.state.zoom, -1)); break
      case 'fitWindow': app.fitWindow(); break
      case 'toggleGrid': app.state.showGrid = !app.state.showGrid; app.requestChrome(); break
      case 'togglePanels': if (document.activeElement instanceof HTMLButtonElement) return; app.togglePanels?.(); break
      case 'swapColors': { const foreground = app.state.color; app.state.color = app.state.backgroundColor ?? [0, 0, 0, 255]; app.state.backgroundColor = foreground; app.requestChrome(); break }
      case 'resetColors': app.state.color = [0, 0, 0, 255]; app.state.backgroundColor = [255, 255, 255, 255]; app.requestChrome(); break
    }
    event.preventDefault()
  }
  window.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.key === 'Process' || isTextTarget(document.activeElement) || isTextTarget(event.target) || document.querySelector('dialog[open]')) return
    if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) return
    if (event.key === 'Enter' && (isNativeEnterTarget(document.activeElement) || isNativeEnterTarget(event.target))) return
    const historyModifier = platform === 'mac' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
    if (historyModifier && !event.altKey) {
      const key = event.key.toLowerCase()
      const direction = key === 'z' ? event.shiftKey ? 'redo' : 'undo' : key === 'y' && !event.shiftKey ? 'redo' : undefined
      if (direction && changePathHistory(app, direction)) { event.preventDefault(); return }
    }
    if (event.key === 'Alt') { event.preventDefault(); app.hover.altKey = true; app.requestRender(); return }
    if (event.key === ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const focused = document.activeElement
      if (focused instanceof HTMLElement && focused.closest('button, a[href], [role=button], [role=option], [role=tab], [role=checkbox]')) return
      event.preventDefault(); app.modifiers.space = true; app.scroller.dataset.spaceHand = 'true'; app.requestRender(); return
    }
    const bindings = validateBindings(app.state.keybindings ?? {}).bindings
    const next = JSON.stringify(bindings)
    if (next !== signature) {
      signature = next
      const map: Record<string, (event: KeyboardEvent) => void> = {}
      for (const action of actions) {
        const chord = bindings[action.id]
        if (!chord) continue
        const pieces = chord.split('+')
        const rawKey = pieces.pop()!
        const shifted: Record<string, string> = { '=': '+', '-': '_', '[': '{', ']': '}', "'": '"', ';': ':', '`': '~', '/': '?', '\\': '|', ',': '<', '.': '>', '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')' }
        const escape = (value: string) => value.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&')
        const physical = pieces.includes('Shift') && shifted[rawKey] ? '(' + escape(rawKey) + '|' + escape(shifted[rawKey]) + ')' : pieces.includes('Alt') && /^[A-Z]$/.test(rawKey) ? '(' + rawKey + '|Key' + rawKey + ')' : rawKey
        const key = [...pieces.map(part => part === 'Mod' ? '$mod' : part === 'Ctrl' ? 'Control' : part), physical].join('+')
        map[key] = event => { if (actionForKeyboardEvent(bindings, event, platform) === action.id) dispatch(action.id, event) }
      }
      if (bindings.zoomIn === 'Mod+=' && !map['$mod+Shift+Equal']) map['$mod+Shift+Equal'] = event => { const matched = actionForKeyboardEvent(bindings, event, platform); if (!matched || matched === 'zoomIn') dispatch('zoomIn', event) }
      handler = createKeybindingsHandler(map, { ignore: () => false })
    }
    handler?.(event)
  })
  window.addEventListener('keyup', event => {
    if (event.key === ' ') { app.modifiers.space = false; app.scroller.dataset.spaceHand = 'false'; app.requestRender() }
    if (event.key === 'Alt') { app.hover.altKey = false; app.requestRender(); if (!isTextTarget(document.activeElement)) event.preventDefault() }
  })
  window.addEventListener('blur', () => { app.modifiers.space = false; app.hover.point = undefined; app.hover.client = undefined; app.hover.buttons = 0; app.scroller.dataset.spaceHand = 'false'; app.requestRender() })
}

function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || Boolean(target.closest('input, textarea, select, [contenteditable=true]'))
}

function isNativeEnterTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('button, a[href], summary'))
}
