import { uiText } from '../../i18n/messages'
import { cropRectOf, clampInt } from './geometry'
import type { App } from './app'
import { extractRect, deleteSelection as clearSelectionPixels } from './ops'
import { activeLayer, dropSelection, setSelection, resetPen, selectTool as setTool, BRUSH_RANGE, type PaintState } from './state'
import type { ToolId } from '../tools'
import { changePathHistory } from './selectionPath'

export function selectTool(app: App, tool: ToolId): void {
  setTool(app.state, tool)
  app.requestChrome()
  app.requestRender()
}

export function clearSelection(app: App): void {
  dropSelection(app.state)
  app.requestChrome()
  app.requestRender()
}

export function selectAll(app: App): void {
  setSelection(app.state, new Uint8Array(app.state.width * app.state.height).fill(1))
  app.requestChrome(); app.requestRender()
}

export function invertSelection(app: App): void {
  const mask = new Uint8Array(app.state.width * app.state.height)
  for (let index = 0; index < mask.length; index++) mask[index] = app.state.selection?.mask[index] ? 0 : 1
  setSelection(app.state, mask)
  app.requestChrome(); app.requestRender()
}

export function removeSelection(app: App): void {
  const { state } = app
  const layer = activeLayer(state)
  const rect = clearSelectionPixels(state)
  if (layer && rect) {
    app.host.post({
      command: 'commit',
      layerId: layer.id,
      rect,
      pixels: extractRect(layer.pixels, state.width, rect)
    })
  }
  app.requestChrome()
  app.requestRender()
}

export function applyCrop(app: App): void {
  const { state } = app
  const crop = state.crop
  if (!crop?.active) return
  state.crop = undefined
  const rect = cropRectOf(crop.start, crop.end, state.width, state.height)
  if (!rect) {
    app.notify(uiText("webview.paint.actions.cropAreaIsEmpty"), 'warn')
  } else {
    app.host.post({ command: 'crop', rect })
  }
  app.requestChrome()
  app.requestRender()
}

export function cancelPending(app: App): void {
  resetPen(app.state)
  app.state.crop = undefined
  app.requestChrome()
  app.requestRender()
}

export function stepBrush(app: App, delta: number): void {
  app.state.brushSize = clampInt(app.state.brushSize + delta, BRUSH_RANGE.min, BRUSH_RANGE.max)
  app.requestChrome()
  app.requestRender()
}

export function hasPending(state: PaintState): boolean {
  return state.pen.length > 0 || state.penRedo.length > 0 || state.crop !== undefined
}

// 工具态优先处理路径历史, 像素历史继续由宿主管理
export function changeHistory(app: App, direction: 'undo' | 'redo'): void {
  if (!changePathHistory(app, direction)) app.host.post({ command: direction })
}
