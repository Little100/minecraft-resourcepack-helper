import { uiText } from '../../i18n/messages'
import { compositeAt } from '../painting'
import { TOOLS, formatRgba } from '../tools'
import type { NoticeMessage } from '../messages'
import type { App } from './app'
import { el } from './dom'
import { frameHeightOf, frameIndexAt } from './geometry'

export interface StatusBar {
  update(): void
  notify(text: string, level: NoticeMessage['level']): void
}

const NOTICE_MS = 3000

export function mountStatusBar(parent: HTMLElement, app: App): StatusBar {
  const element = el('footer', 'mp-statusbar')
  const coord = cell('mp-cell mp-cell-coord')
  const chip = el('span', 'mp-chip')
  const colorText = cell('mp-cell')
  const size = cell('mp-cell')
  const frame = cell('mp-cell')
  const selection = cell('mp-cell')
  const zoom = cell('mp-cell')
  const tool = cell('mp-cell')
  const notice = el('span', 'mp-notice')
  notice.setAttribute('role', 'status')
  notice.hidden = true
  const colorBox = el('span', 'mp-cell mp-cell-color')
  colorBox.append(chip, colorText)
  element.append(coord, colorBox, separator(), size, frame, separator(), selection, zoom, separator(), tool, notice)
  parent.append(element)

  let noticeTimer: number | undefined
  let chipColor = ''

  function update(): void {
    const { state, hover } = app
    const point = hover.point
    if (point) {
      setText(coord, `X ${point[0]} · Y ${point[1]}`)
      const hex = formatRgba(compositeAt(state.layers, state.width, point[0], point[1]))
      setText(colorText, hex)
      setChip(hex)
      setText(frame, frameText(point[1]))
    } else {
      setText(coord, 'X — · Y —')
      setText(colorText, '—')
      setChip('')
      setText(frame, state.frameCount > 1 ? uiText("webview.paint.statusbar.noFrame", state.frameCount) : '')
    }
    setText(size, `${state.width} × ${state.height}`)
    const bounds = state.selection?.bounds
    setText(selection, bounds ? uiText("webview.paint.statusbar.selection", bounds.width, bounds.height) : uiText("webview.paint.statusbar.constituency"))
    setText(zoom, `${state.zoom * 100}%`)
    setText(tool, TOOLS.find(item => item.id === state.tool)?.label ?? '')
  }

  function frameText(y: number): string {
    const { state } = app
    if (state.frameCount <= 1) return ''
    const index = frameIndexAt(y, state.height, state.frameCount)
    const height = frameHeightOf(state.height, state.frameCount)
    const top = index * height
    return uiText("webview.paint.statusbar.frameRange", index + 1, state.frameCount, top, top + height - 1)
  }

  function setChip(hex: string): void {
    if (hex === chipColor) return
    chipColor = hex
    chip.style.background = hex
    chip.classList.toggle('is-empty', hex === '')
  }

  function notify(text: string, level: NoticeMessage['level']): void {
    notice.textContent = text
    notice.dataset.level = level
    notice.hidden = false
    if (noticeTimer !== undefined) window.clearTimeout(noticeTimer)
    noticeTimer = window.setTimeout(() => {
      notice.hidden = true
      notice.textContent = ''
      noticeTimer = undefined
    }, NOTICE_MS)
  }

  return { update, notify }
}

function cell(className: string): HTMLSpanElement {
  return el('span', className)
}

// 文本未变化时不写入 DOM, 避免每帧重排
function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text
}

function separator(): HTMLSpanElement {
  return el('span', 'mcrh-sep')
}

