import { uiHtml, uiText } from '../i18n/messages'
import { onHostMessage } from './bus'
import type { TodoItem } from '../core/todos'

export function mountTodoView(parent: HTMLElement, post: (value: { command: 'todo'; action: string; [key: string]: unknown }) => void, compact = false): void {
  const panel = document.createElement('section')
  panel.className = 'mp-panel mcrh-todos'
  panel.setAttribute('aria-label', uiText("webview.todoView.otherOrganiser"))
  panel.innerHTML = `<header class="mp-panel-head"><strong>TODO</strong><span data-todo-count class="mcrh-todo-count"></span><div class="mcrh-todo-toolbar"><button data-todo-add title="${uiHtml("ui.todoHost.addTask")}">${uiHtml("webview.collaboration.add")}</button><button data-todo-refresh title="${uiHtml("webview.todoView.rereadTasks")}">${uiHtml("webview.collaboration.refresh")}</button></div></header><button class="mcrh-todo-root" data-todo-root title="${uiHtml("webview.todoView.toggleResourcePackDirectory")}">${uiHtml("ui.exportPackCommand.selectResourcePack")}</button><input type="search" data-todo-search placeholder="${uiHtml("webview.todoView.searchTaskDescriptionOrResourcePath")}" aria-label="${uiHtml("webview.todoView.searchTodo")}"><div class="mcrh-todo-filters" role="group" aria-label="${uiHtml("webview.todoView.taskStatus")}"><button data-filter="open" aria-pressed="true">${uiHtml("webview.todoView.notCompleted")}</button><button data-filter="all" aria-pressed="false">${uiHtml("webview.todoView.all")}</button><button data-filter="done" aria-pressed="false">${uiHtml("webview.todoView.completed")}</button></div><label data-todo-scope hidden><input type="checkbox">${uiHtml("webview.todoView.currentResourcesOnly")}</label><p data-todo-status role="status" class="mp-panel-detail">${uiHtml("webview.todoView.localChangesAreSubmittedProactivelyAndCollaborative")}</p><div data-todo-list></div>`
  parent.append(panel)
  let items: TodoItem[] = [], revision = 'missing', resource: string | undefined, root: string | undefined, filter = 'open'
  const search = panel.querySelector<HTMLInputElement>('[data-todo-search]')!
  const scope = panel.querySelector<HTMLInputElement>('[data-todo-scope] input')!
  scope.checked = compact
  const list = panel.querySelector<HTMLElement>('[data-todo-list]')!
  const status = panel.querySelector<HTMLElement>('[data-todo-status]')!
  const add = panel.querySelector<HTMLButtonElement>('[data-todo-add]')!
  add.disabled = true
  const send = (action: string, params: Record<string, unknown> = {}) => post({ command: 'todo', action, revision, root, ...params })
  const button = (label: string, action: () => void) => {
    const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.addEventListener('click', action); return node
  }

  function render(): void {
    list.replaceChildren()
    const query = search.value.trim().toLocaleLowerCase()
    const selected = items.filter(item => (filter === 'all' || item.done === (filter === 'done')) && (!resource || !scope.checked || item.resource === resource) && [item.title, item.detail, item.resource ?? ''].join(' ').toLocaleLowerCase().includes(query))
    panel.querySelector('[data-todo-count]')!.textContent = items.filter(item => !item.done).length + uiText("webview.todoView.toDo")
    if (!selected.length) {
      const empty = document.createElement('p'); empty.className = 'mcrh-todo-empty'; empty.textContent = items.length ? uiText("webview.todoView.otherOrganiser_4f621c") : uiText("webview.todoView.noTasksAvailableToAddToDos"); list.append(empty)
    }
    const groups = new Map<string, TodoItem[]>()
    for (const item of selected) { const key = item.resource ?? ''; groups.set(key, [...(groups.get(key) ?? []), item]) }
    for (const [key, tasks] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const group = document.createElement('section'); group.className = 'mcrh-todo-group'
      const heading = document.createElement('h3'); heading.textContent = key ? key.split('/').at(-1)! : uiText("ui.todoHost.globalTasks"); heading.title = key || uiText("webview.todoView.resourcesNotRelated"); group.append(heading)
      if (key) { const location = document.createElement('p'); location.className = 'mcrh-todo-path'; location.textContent = key; group.append(location) }
      for (const item of tasks) {
        const row = document.createElement('article'); row.className = 'mcrh-todo-item'; row.classList.toggle('is-done', item.done)
        const label = document.createElement('label'), check = document.createElement('input'); check.type = 'checkbox'; check.checked = item.done; check.setAttribute('aria-label', uiText("webview.todoView.fulfillTheMission", item.title))
        check.addEventListener('change', () => { check.disabled = true; send('toggle', { id: item.id }) })
        const title = document.createElement('span'); title.textContent = item.title; label.append(check, title); row.append(label)
        if (item.detail) { const detail = document.createElement('p'); detail.className = 'mcrh-todo-detail'; detail.textContent = item.detail; row.append(detail) }
        const actions = document.createElement('div'); actions.className = 'mcrh-todo-actions'
        actions.append(button(uiText("webview.collaboration.modify"), () => send('edit', { id: item.id })), button(uiText("webview.collaboration.delete"), () => send('remove', { id: item.id })))
        if (item.resource) actions.append(button(uiText("webview.todoView.openResource"), () => send('open', { id: item.id })))
        row.append(actions); group.append(row)
      }
      list.append(group)
    }
  }
  add.addEventListener('click', () => send('add'))
  panel.querySelector('[data-todo-refresh]')!.addEventListener('click', () => send('refresh'))
  panel.querySelector('[data-todo-root]')!.addEventListener('click', () => send('selectRoot'))
  for (const input of [search, scope]) input.addEventListener('input', render)
  for (const node of panel.querySelectorAll<HTMLButtonElement>('[data-filter]')) node.addEventListener('click', () => {
    filter = node.dataset.filter!
    panel.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(item => item.setAttribute('aria-pressed', String(item === node)))
    render()
  })
  onHostMessage(raw => {
    if (!raw || typeof raw !== 'object') return
    const value = raw as { command: string; items: TodoItem[]; revision: string; root: string; resource?: string; error: string }
    if (value.command === 'todoError') { status.textContent = value.error; status.classList.add('is-error'); render() }
    if (value.command !== 'todoState') return
    items = value.items; revision = value.revision; root = value.root; resource = value.resource; add.disabled = false; status.classList.remove('is-error')
    const location = panel.querySelector<HTMLButtonElement>('[data-todo-root]')!
    location.textContent = root.replace(/\\/g, '/').split('/').at(-1) || root; location.title = root + uiText("webview.todoView.clickToSwitchQualifier")
    panel.querySelector<HTMLElement>('[data-todo-scope]')!.hidden = !resource
    scope.parentElement!.title = resource ?? ''
    render()
  })
  render(); send('refresh')
}
