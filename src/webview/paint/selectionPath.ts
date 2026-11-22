import { uiText } from '../../i18n/messages'
import { polygonSelectionMask } from '../painting'
import type { App } from './app'
import { resetPen, combineSelection } from './state'

export const PEN_SELECTION_HINT = uiText("webview.paint.selectionPath.createsAPointByPointPathTo")

function refresh(app: App): void {
  app.requestChrome()
  app.requestRender()
}

// 点击起点可闭合草稿
export function addPenPoint(app: App, point: [number, number]): void {
  const { state } = app
  if (point[0] < 0 || point[1] < 0 || point[0] >= state.width || point[1] >= state.height) return
  const first = state.pen[0], last = state.pen[state.pen.length - 1]
  if (state.pen.length >= 3 && first[0] === point[0] && first[1] === point[1]) {
    closeSelectionPath(app)
    return
  }
  if (last && last[0] === point[0] && last[1] === point[1]) return
  state.pen.push([point[0], point[1]])
  state.penRedo = []
  refresh(app)
}

// 路径有效时按当前模式更新选区
export function closeSelectionPath(app: App): void {
  const { state } = app
  const mask = polygonSelectionMask(state, state.pen)
  if (!mask) {
    if (state.pen.length) app.notify(uiText("webview.paint.selectionPath.theElectoralPathRequiresAtLeastThree"), 'warn')
    refresh(app)
    return
  }
  combineSelection(state, mask)
  resetPen(state)
  refresh(app)
}

// 有路径草稿时只撤销或重做草稿
export function changePathHistory(app: App, direction: 'undo' | 'redo'): boolean {
  const { state } = app
  if (state.tool !== 'polygon' || !state.pen.length && !state.penRedo.length) return false
  const from = direction === 'undo' ? state.pen : state.penRedo
  const to = direction === 'undo' ? state.penRedo : state.pen
  const point = from.pop()
  if (point) to.push(point)
  refresh(app)
  return true
}
