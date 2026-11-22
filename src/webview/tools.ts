import { uiText } from '../i18n/messages'
import type { Rgba } from './painting'

export type ToolId =
  | 'move'
  | 'select'
  | 'wand'
  | 'brush'
  | 'nearby'
  | 'scatter'
  | 'symmetry'
  | 'eraser'
  | 'fill'
  | 'picker'
  | 'line'
  | 'rect'
  | 'ellipse'
  | 'polygon'
  | 'crop'
  | 'hand'

export interface ToolDef {
  id: ToolId
  label: string
  key: string
  // 图标名由 SVG 注册表或 Codicons 提供
  icon: string
  hint: string
  group: number
}

export const TOOLS: ToolDef[] = [
  { id: 'move', label: uiText("ui.pixelEditor.moveLayer"), key: 'V', icon: 'move', hint: uiText("webview.tools.dragSelectedLayerPixelAlignmentEnterConfirm"), group: 0 },
  { id: 'select', label: uiText("webview.tools.box"), key: 'M', icon: 'list-selection', hint: uiText("webview.tools.dragBoxRectangleAreaTheSelectionRemains"), group: 0 },
  { id: 'wand', label: uiText("webview.tools.theMagicWand"), key: 'W', icon: 'wand', hint: uiText("webview.tools.selectTheAreaToConnectToThe"), group: 0 },
  { id: 'brush', label: uiText("webview.tools.brush"), key: 'B', icon: 'edit', hint: uiText("webview.tools.dragDrawingTabSupportPressureRightClick"), group: 1 },
  { id: 'nearby', label: uiText("webview.tools.nearColourBrush"), key: '', icon: 'symbol-color', hint: uiText("webview.tools.randomlyPicksTheNearbyColourAroundThe"), group: 1 },
  { id: 'scatter', label: uiText("webview.paint.scatterPreview.randomly"), key: '', icon: 'symbol-misc', hint: uiText("webview.tools.clickACanvasOrApplicationButtonTo"), group: 1 },
  { id: 'symmetry', label: uiText("webview.tools.symmetricalBrushes"), key: '', icon: 'mirror', hint: uiText("webview.tools.xAxisTopDownSymmetryYAxis"), group: 1 },
  { id: 'eraser', label: uiText("webview.tools.rubber"), key: 'E', icon: 'eraser', hint: uiText("webview.tools.eraseAsTransparentPixels"), group: 1 },
  { id: 'fill', label: uiText("webview.tools.fill"), key: 'G', icon: 'paintcan', hint: uiText("webview.tools.fillInTheSameColouredAreaConnected"), group: 1 },
  { id: 'picker', label: uiText("webview.tools.colour"), key: 'I', icon: 'symbol-color', hint: uiText("webview.tools.picksUpACompositeColourOfThe"), group: 1 },
  { id: 'line', label: uiText("webview.tools.line"), key: 'L', icon: 'graph-line', hint: uiText("webview.tools.dragAnimatedLinePressShiftToDegrees"), group: 2 },
  { id: 'rect', label: uiText("webview.tools.rectangle"), key: 'R', icon: 'primitive-square', hint: uiText("webview.tools.dragAnAnimationRectangleBorderHoldDown"), group: 2 },
  { id: 'ellipse', label: uiText("webview.tools.ellipse"), key: 'O', icon: 'circle-large', hint: uiText("webview.tools.dragOutTheInnerCutEllipseBorder"), group: 2 },
  { id: 'polygon', label: uiText("webview.tools.pen"), key: 'P', icon: 'pen-nib', hint: uiText("webview.tools.createsASelectionByPointClickFrom"), group: 2 },
  { id: 'crop', label: uiText("webview.tools.crop"), key: 'C', icon: 'screen-cut', hint: uiText("webview.tools.dragOutTheReserveEnterApplicationEsc"), group: 3 },
  { id: 'hand', label: uiText("webview.tools.holdHands"), key: 'H', icon: 'grabber', hint: uiText("webview.tools.dragAndSmoothViewHoldTheSpace"), group: 3 }
]

export function toolForKey(key: string): ToolDef | undefined {
  const lower = key.toLowerCase()
  return TOOLS.find(tool => tool.key.toLowerCase() === lower)
}

// 严格解析 #rrggbb 与 #rrggbbaa, 格式不合法返回 undefined 而不是静默回退
export function parseHexColor(input: string): Rgba | undefined {
  const match = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(input.trim())
  if (!match) return undefined
  const hex = match[1] + (match[2] ?? 'ff')
  return [0, 2, 4, 6].map(offset => parseInt(hex.slice(offset, offset + 2), 16)) as Rgba
}

export function formatRgba(rgba: Rgba): string {
  return `#${rgba.map(channel => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')).join('')}`
}

export function toColorInputValue(rgba: Rgba): string {
  return formatRgba(rgba).slice(0, 7)
}
