import { uiHtml } from '../../i18n/messages'
import { onHostMessage } from '../bus'
import type { PaintHistoryMessage } from '../messages'
import type { App } from './app'
export function mountPaintHistory(parent: HTMLElement, app: App): void {
  const section = document.createElement('section'); section.className = 'mp-panel mp-history'
  section.innerHTML = `<header class="mp-panel-head">${uiHtml("webview.paint.history.paintHistory")}</header><p class="mp-panel-detail">${uiHtml("webview.paint.history.ctrlZUndoAndGitSubmitIndependent")}</p><div data-paint-history></div>`
  parent.append(section)
  const list = section.querySelector<HTMLElement>('[data-paint-history]')!
  onHostMessage(raw => {
    const value = raw as PaintHistoryMessage
    if (value.command !== 'paintHistory') return
    list.replaceChildren()
    for (const entry of [...value.entries].reverse()) {
      const button = document.createElement('button'); button.className = 'mp-history-entry'; button.textContent = entry.label; button.title = new Date(entry.at).toLocaleString(); button.disabled = value.current === entry.id; button.setAttribute('aria-current', String(value.current === entry.id))
      const time = document.createElement('time'); time.textContent = new Date(entry.at).toLocaleTimeString(); button.append(time)
      button.addEventListener('click', () => app.host.post({ command: 'restoreHistory', id: entry.id })); list.append(button)
    }
  })
}
