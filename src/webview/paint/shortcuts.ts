import { uiText } from '../../i18n/messages'
import { defaultBindings, bindingForEvent, listBindingActions, validateBindings, type BindingActionId, type PaintBindings } from './bindings'
import type { App } from './app'
import { el, iconButton } from './dom'

export function mountShortcutDialog(parent: HTMLElement, app: App): () => void {
  const dialog = el('dialog', 'mp-shortcuts')
  dialog.setAttribute('aria-label', uiText("webview.paint.shortcuts.customisedCanvasShortcutKey"))
  const head = el('header', 'mp-shortcuts-head')
  const heading = el('h2'); heading.textContent = uiText("webview.paint.shortcuts.painterShortcutKey")
  const close = iconButton('close', uiText("webview.paint.shortcuts.closeShortcutSettings")); head.append(heading, close)
  const description = el('p', 'mp-shortcuts-description'); description.textContent = uiText("webview.paint.shortcuts.clickOnTheButtonToPressMod")
  const search = el('input', 'mcrh-input mp-shortcuts-search'); search.type = 'search'; search.placeholder = uiText("webview.paint.shortcuts.findToolsOrOperations"); search.setAttribute('aria-label', uiText("webview.paint.shortcuts.findShortcutKeys"))
  const table = el('div', 'mp-shortcuts-list')
  const errors = el('div', 'mp-shortcuts-errors'); errors.setAttribute('role', 'status')
  const foot = el('footer', 'mp-shortcuts-foot')
  const restore = el('button', 'mcrh-btn'); restore.type = 'button'; restore.textContent = uiText("webview.paint.shortcuts.restoreDefaultAll")
  const cancel = el('button', 'mcrh-btn'); cancel.type = 'button'; cancel.textContent = uiText("browser.shell.cancel")
  const save = el('button', 'mcrh-btn mp-shortcuts-save'); save.type = 'button'; save.textContent = uiText("webview.paint.shortcuts.saveToGlobalSettings")
  foot.append(restore, cancel, save)
  dialog.append(head, description, search, table, errors, foot); parent.append(dialog)
  const actions = listBindingActions(), defaults = defaultBindings(), fields = new Map<BindingActionId, HTMLInputElement>()
  let draft: PaintBindings = { ...defaults }
  const changed = new Set<BindingActionId>()
  for (const action of actions) {
    const row = el('label', 'mp-shortcut-row'); row.dataset.action = action.id; row.dataset.search = action.label + action.id
    const name = el('span'); name.textContent = action.label
    const field = el('input', 'mcrh-input mp-shortcut-binding'); field.type = 'text'; field.readOnly = true; field.placeholder = uiText("webview.paint.shortcuts.unbound"); field.setAttribute('aria-label', uiText("webview.paint.shortcuts.shortcuts", action.label))
    const disable = iconButton('circle-slash', uiText("webview.paint.shortcuts.disable", action.label)), reset = iconButton('discard', uiText("webview.paint.shortcuts.restoreDefault", action.label))
    fields.set(action.id, field); row.append(name, field, disable, reset); table.append(row)
    field.addEventListener('keydown', event => {
      if (event.key === 'Tab') { event.stopPropagation(); return }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hide(); return }
      event.preventDefault(); event.stopPropagation()
      if (event.repeat || event.isComposing) return
      const captured = bindingForEvent(event)
      if (captured !== undefined) { draft[action.id] = captured.replace(/^(?:Ctrl|Meta)\+/, 'Mod+'); changed.add(action.id); refresh() }
    })
    disable.addEventListener('click', event => { event.preventDefault(); draft[action.id] = ''; changed.add(action.id); refresh() })
    reset.addEventListener('click', event => { event.preventDefault(); draft[action.id] = defaults[action.id]; changed.add(action.id); refresh() })
  }
  function refresh(): void {
    const current = validateBindings(app.state.keybindings ?? {}).bindings
    for (const action of actions) if (!changed.has(action.id)) draft[action.id] = current[action.id]
    const result = validateBindings(draft)
    for (const [id, field] of fields) {
      field.value = draft[id]
      const issue = result.issues.find(item => item.actionId === id)
      field.classList.toggle('is-conflict', Boolean(issue)); field.setAttribute('aria-invalid', String(Boolean(issue)))
    }
    errors.textContent = result.issues.map(issue => `${actions.find(action => action.id === issue.actionId)?.label ?? ''}: ${issue.message}${issue.conflictsWith?.length ? ' (' + issue.conflictsWith.map(id => actions.find(action => action.id === id)?.label ?? id).join('、') + ')' : ''}`).join('\n')
    save.disabled = !result.valid
  }
  function hide(): void { dialog.close(); app.scroller.focus({ preventScroll: true }) }
  close.addEventListener('click', hide); cancel.addEventListener('click', hide)
  restore.addEventListener('click', () => { draft = defaultBindings(); for (const action of actions) changed.add(action.id); refresh() })
  search.addEventListener('input', () => { const term = search.value.toLowerCase(); for (const row of table.querySelectorAll<HTMLElement>('.mp-shortcut-row')) row.hidden = !(row.dataset.search ?? '').toLowerCase().includes(term) })
  save.addEventListener('click', () => {
    refresh(); const result = validateBindings(draft); if (!result.valid) return
    app.state.keybindings = result.bindings
    app.host.savePreferences?.({ keybindings: result.bindings })
    app.host.post({ command: 'setKeybindings', bindings: Object.fromEntries([...changed].map(id => [id, result.bindings[id]])) })
    app.requestChrome(); hide(); app.notify(uiText("webview.paint.shortcuts.shortcutsSubmittedToGlobalSettings"), 'info')
  })
  window.addEventListener('mcrh-paint-settings', () => { if (dialog.open) refresh() })
  return () => { changed.clear(); draft = { ...validateBindings(app.state.keybindings ?? {}).bindings }; search.value = ''; for (const row of table.querySelectorAll<HTMLElement>('.mp-shortcut-row')) row.hidden = false; refresh(); dialog.showModal() }
}
