import type { Rect } from '../gl/types'

export interface Placement {
  scale: number
  originX: number
  originY: number
}

// 原版快捷栏的逻辑尺寸, 槽位间距 20 像素, 槽位框 18 像素, 图标 16 像素, 选中框 24 像素
export const HOTBAR = {
  width: 182,
  height: 22,
  slotCount: 9,
  pitch: 20,
  slotInset: 2,
  slotSize: 18,
  iconInset: 3,
  iconSize: 16,
  selectionInset: -1,
  selectionSize: 24
} as const

// 快捷栏中央槽位用于显示当前贴图, 与原版主手位置一致
export const HOTBAR_FOCUS_SLOT = 4

// 展示框占位绘制的逻辑尺寸与边框厚度, 原版展示框贴图为 128 像素, 占位以 40 像素近似其比例
export const FRAME_PLACEHOLDER = { size: 40, border: 4 } as const

// 手持姿态参数集中定义, 偏移为相机空间坐标, 角度为度, 数值是近似值, 仅用于预览观感而非精确复刻原版
export interface HandPose {
  offset: readonly [number, number, number]
  pitchDeg: number
  yawDeg: number
  scale: number
}

export const HAND_POSES: Record<'hand-first' | 'hand-third', HandPose> = {
  'hand-first': { offset: [0.62, -0.5, -1.6], pitchDeg: 24, yawDeg: 40, scale: 0.5 },
  'hand-third': { offset: [0.7, -0.42, -2.1], pitchDeg: 35, yawDeg: -15, scale: 0.55 }
}

export const BLOCK_VIEW = { yawDeg: -34, pitchDeg: 20, distance: 2.6, fovyDeg: 40 } as const

export const HAND_FOV_DEG = 70

export function fitScale(canvasWidth: number, canvasHeight: number, logicalWidth: number, logicalHeight: number, margin: number): number {
  const availableWidth = Math.max(1, canvasWidth - margin * 2)
  const availableHeight = Math.max(1, canvasHeight - margin * 2)
  return Math.min(availableWidth / logicalWidth, availableHeight / logicalHeight)
}

export function integerScale(scale: number): number {
  return Math.max(1, Math.floor(scale))
}

export function placeCentered(
  canvasWidth: number,
  canvasHeight: number,
  logicalWidth: number,
  logicalHeight: number,
  scale: number
): Placement {
  return {
    scale,
    originX: Math.round((canvasWidth - logicalWidth * scale) / 2),
    originY: Math.round((canvasHeight - logicalHeight * scale) / 2)
  }
}

export function toDevice(placement: Placement, x: number, y: number, width: number, height: number): Rect {
  return {
    x: placement.originX + x * placement.scale,
    y: placement.originY + y * placement.scale,
    width: width * placement.scale,
    height: height * placement.scale
  }
}

export function frameIconSize(frameDeviceSize: number, textureWidth: number): number {
  const texelScale = Math.max(1, Math.floor((frameDeviceSize * 0.5) / textureWidth))
  return textureWidth * texelScale
}
