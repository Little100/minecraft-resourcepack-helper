// 物品栏, 展示框与平面的 2D 叠加绘制, 原版贴图缺失时使用深色边框与浅色内底的占位绘制
import type { PreviewRenderer } from '../gl/renderer'
import type { FrameSample, Rect, Rgba } from '../gl/types'
import { FRAME_PLACEHOLDER, HOTBAR, HOTBAR_FOCUS_SLOT, fitScale, frameIconSize, integerScale, placeCentered, toDevice, type Placement } from './layout'

export interface OverlayInput {
  mode: 'hotbar' | 'frame' | 'flat'
  sample: FrameSample
  /** 单帧宽度, 图标与平面绘制都以它作为纹理像素宽度 */
  frameWidth: number
  /** 单帧高度, 静态非方形贴图时为整幅高度 */
  frameHeight: number
  zoom: number
}

const MARGIN = 24

// 占位绘制的近似原版界面配色, 仅在缺少原版贴图时使用, 硬编码以保证脱离主题时仍可辨认
const PLACEHOLDER = {
  bar: [0.05, 0.05, 0.05, 0.5] as Rgba,
  slotBorder: [0.216, 0.216, 0.216, 1] as Rgba,
  slotFill: [0.78, 0.78, 0.78, 1] as Rgba,
  selection: [1, 1, 1, 0.95] as Rgba,
  frameBorder: [0.36, 0.25, 0.15, 1] as Rgba,
  frameBack: [0.16, 0.13, 0.1, 1] as Rgba
}

// 2D 模式的统一入口, 所有矩形都以设备像素绘制, 有原版贴图时以贴图为准
export function drawOverlay(renderer: PreviewRenderer, width: number, height: number, input: OverlayInput): void {
  if (input.mode === 'hotbar') drawHotbar(renderer, width, height, input)
  else if (input.mode === 'frame') drawItemFrame(renderer, width, height, input)
  else drawFlat(renderer, width, height, input)
}

function drawHotbar(renderer: PreviewRenderer, width: number, height: number, input: OverlayInput): void {
  const bar = renderer.sizeOf('hotbar') ?? { width: HOTBAR.width, height: HOTBAR.height }
  const scale = integerScale(fitScale(width, height, bar.width, bar.height, MARGIN) * input.zoom)
  const placement = placeCentered(width, height, bar.width, bar.height, scale)
  if (renderer.hasImage('hotbar')) {
    renderer.drawSprite('hotbar', toDevice(placement, 0, 0, bar.width, bar.height))
  } else {
    renderer.drawSolid(toDevice(placement, 0, 0, bar.width, bar.height), PLACEHOLDER.bar)
    for (let i = 0; i < HOTBAR.slotCount; i++) {
      drawSlot(renderer, placement, HOTBAR.pitch * i + HOTBAR.slotInset, HOTBAR.slotInset)
    }
  }
  const focusX = HOTBAR.pitch * HOTBAR_FOCUS_SLOT
  const icon = toDevice(placement, focusX + HOTBAR.iconInset, HOTBAR.iconInset, HOTBAR.iconSize, HOTBAR.iconSize)
  renderer.drawSprite('strip', icon, input.sample)
  const selectionX = focusX + HOTBAR.selectionInset
  if (renderer.hasImage('hotbarSelection')) {
    renderer.drawSprite('hotbarSelection', toDevice(placement, selectionX, HOTBAR.selectionInset, HOTBAR.selectionSize, HOTBAR.selectionSize))
  } else {
    drawOutline(renderer, placement, selectionX, HOTBAR.selectionInset, HOTBAR.selectionSize, PLACEHOLDER.selection)
  }
}

// 单个槽位的占位绘制, 深色边框加浅色内底, 与原版槽位的明暗层次一致
function drawSlot(renderer: PreviewRenderer, placement: Placement, x: number, y: number): void {
  const size = HOTBAR.slotSize
  if (renderer.hasImage('slot')) {
    renderer.drawSprite('slot', toDevice(placement, x, y, size, size))
    return
  }
  renderer.drawSolid(toDevice(placement, x, y, size, size), PLACEHOLDER.slotBorder)
  renderer.drawSolid(toDevice(placement, x + 1, y + 1, size - 2, size - 2), PLACEHOLDER.slotFill)
}

function drawOutline(renderer: PreviewRenderer, placement: Placement, x: number, y: number, size: number, color: Rgba): void {
  renderer.drawSolid(toDevice(placement, x, y, size, 1), color)
  renderer.drawSolid(toDevice(placement, x, y + size - 1, size, 1), color)
  renderer.drawSolid(toDevice(placement, x, y, 1, size), color)
  renderer.drawSolid(toDevice(placement, x + size - 1, y, 1, size), color)
}

function drawItemFrame(renderer: PreviewRenderer, width: number, height: number, input: OverlayInput): void {
  const sprite = renderer.sizeOf('frame') ?? { width: FRAME_PLACEHOLDER.size, height: FRAME_PLACEHOLDER.size }
  const scale = integerScale(fitScale(width, height, sprite.width, sprite.height, MARGIN) * input.zoom)
  const placement = placeCentered(width, height, sprite.width, sprite.height, scale)
  const box = toDevice(placement, 0, 0, sprite.width, sprite.height)
  if (renderer.hasImage('frame')) {
    renderer.drawSprite('frame', box)
  } else {
    renderer.drawSolid(box, PLACEHOLDER.frameBorder)
    const border = FRAME_PLACEHOLDER.border
    renderer.drawSolid(toDevice(placement, border, border, sprite.width - border * 2, sprite.height - border * 2), PLACEHOLDER.frameBack)
  }
  const iconSize = frameIconSize(box.width, input.frameWidth)
  const icon: Rect = {
    x: box.x + Math.floor((box.width - iconSize) / 2),
    y: box.y + Math.floor((box.height - iconSize) / 2),
    width: iconSize,
    height: iconSize
  }
  renderer.drawSprite('strip', icon, input.sample)
}

function drawFlat(renderer: PreviewRenderer, width: number, height: number, input: OverlayInput): void {
  const scale = fitScale(width, height, input.frameWidth, input.frameHeight, MARGIN) * input.zoom
  const placement = placeCentered(width, height, input.frameWidth, input.frameHeight, scale)
  renderer.drawSprite('strip', toDevice(placement, 0, 0, input.frameWidth, input.frameHeight), input.sample)
}
