import { uiText } from '../../i18n/messages'
// 预览数据的纯函数模型, 把宿主消息换算为纹理来源, 帧布局, 时间轴与界面文案, 不依赖 DOM 与 WebGL
import { buildSchedule, formatSeconds, type AnimationSchedule } from '../../core/animationTimeline'
import type { TextureSource } from '../gl/textureSync'
import type { PreviewMessage, PreviewMode } from '../messages'
import { MODES } from './modes'

export const TEXTURE_SLOTS = ['strip', 'hotbar', 'hotbarSelection', 'slot', 'frame'] as const
export type TextureSlot = (typeof TEXTURE_SLOTS)[number]

export const EMPTY_TEXT = uiText("webview.preview.model.notReceivedPastePleaseSelectAPreview")

export interface FrameLayout {
  /** 整幅贴图是否由多帧竖排组成 */
  stacked: boolean
  /** 单帧占整幅高度的比例, 非竖排贴图时为 1 */
  frameScale: number
  /** 单帧的像素高度, 平面与展示框以此截取当前帧 */
  frameHeight: number
}

export interface PreviewModel {
  name: string
  width: number
  height: number
  frameCount: number
  packLabel: string
  layout: FrameLayout
  schedule: AnimationSchedule
  animated: boolean
  interpolate: boolean
}

export interface ModelResult {
  model: PreviewModel
  /** 动画信息不可用时的原因, 模型此时按静态显示 */
  notice?: string
}

export function frameLayoutOf(width: number, height: number, frameCount: number): FrameLayout {
  const stacked = frameCount > 1 && height > 0
  return {
    stacked,
    frameScale: stacked ? width / height : 1,
    frameHeight: stacked ? width : height
  }
}

export function modelOf(message: PreviewMessage): ModelResult {
  const base = {
    name: message.name,
    width: message.width,
    height: message.height,
    frameCount: message.frameCount,
    packLabel: message.packLabel,
    layout: frameLayoutOf(message.width, message.height, message.frameCount)
  }
  const still: PreviewModel = { ...base, schedule: buildSchedule(1, {}), animated: false, interpolate: false }
  if (!message.animation || message.frameCount <= 1) return { model: still }
  try {
    const schedule = buildSchedule(message.frameCount, message.animation)
    if (schedule.frames.length === 0) return { model: still, notice: uiText("webview.preview.model.animateFrameListEmptyByStatic") }
    return { model: { ...base, schedule, animated: true, interpolate: message.animation.interpolate } }
  } catch (error) {
    return { model: still, notice: uiText("webview.preview.model.animatedInformationIsInvalidAsStatic", errorText(error)) }
  }
}

// 贴图来源表, 宽高非法或缺少像素时视为没有 strip, 原版精灵沿用宿主给出的键
export function textureSourcesOf(message: PreviewMessage): Record<TextureSlot, TextureSource | undefined> {
  const { data, width, height } = message
  const strip = data !== undefined && width > 0 && height > 0 ? { width, height, data } : undefined
  return {
    strip,
    hotbar: message.sprites?.hotbar,
    hotbarSelection: message.sprites?.hotbarSelection,
    slot: message.sprites?.slot,
    frame: message.sprites?.frame
  }
}

export function infoText(model: PreviewModel, mode: PreviewMode): string {
  const modeLabel = MODES.find(item => item.id === mode)?.label ?? mode
  const duration = model.animated ? formatSeconds(model.schedule.totalTicks) : uiText("webview.preview.model.static")
  return [model.name, `${model.width}×${model.height}`, uiText("webview.preview.model.frame", model.frameCount), duration, model.packLabel, modeLabel]
    .filter(part => part !== '')
    .join(' · ')
}

export function frameTagText(model: PreviewModel, entry: number): string {
  return model.animated ? uiText("webview.preview.model.frame_310f4f", entry + 1, model.schedule.frames.length) : uiText("webview.preview.model.static")
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
