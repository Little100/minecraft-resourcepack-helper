import { uiText } from '../../i18n/messages'
import { applyCrop, cancelPending } from './actions'
import type { App } from './app'
import { el } from './dom'
import { closeSelectionPath } from './selectionPath'

export interface Confirm {
  sync(): void
}

export function mountConfirm(parent: HTMLElement, app: App): Confirm {
  const element = el('div', 'mp-confirm')
  element.hidden = true
  element.setAttribute('role', 'toolbar')
  const label = el('span', 'mp-confirm-text')
  const primary = el('button', 'mcrh-btn mcrh-btn--primary')
  primary.type = 'button'
  const cancel = el('button', 'mcrh-btn mcrh-btn--secondary')
  cancel.type = 'button'
  cancel.textContent = uiText("webview.paint.confirm.cancelEsc")
  element.append(label, primary, cancel)
  parent.append(element)

  primary.addEventListener('click', () => {
    if (app.state.crop?.active) applyCrop(app)
    else closeSelectionPath(app)
  })
  cancel.addEventListener('click', () => cancelPending(app))

  function sync(): void {
    const { state } = app
    const cropping = state.crop?.active === true
    const drawingPen = state.pen.length > 0
    element.hidden = !cropping && !drawingPen
    if (cropping) {
      label.textContent = uiText("webview.paint.confirm.cropArea")
      primary.textContent = uiText("webview.paint.confirm.applyEnter")
    } else if (drawingPen) {
      label.textContent = uiText("webview.paint.confirm.thePenElectoralDistrictVertex", state.pen.length)
      primary.textContent = uiText("webview.paint.confirm.closedSelectionEnterDoubleClick")
    }
  }

  return { sync }
}
