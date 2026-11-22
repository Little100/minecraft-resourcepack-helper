import { uiText } from '../i18n/messages'
import { formatSeconds, type AnimationSchedule } from '../core/animationTimeline'

// 帧序列摘要最多展示的项数, 超出部分以省略号代替, 避免长动画撑破信息区
export const SEQUENCE_PREVIEW_LIMIT = 12

// 把播放计划压缩成 "0, 1, 2, 1" 形式的摘要, 超过上限时截断并注明总数
export function describeSequence(schedule: AnimationSchedule): string {
  const indices = schedule.frames.map(frame => frame.index)
  const shown = indices.slice(0, SEQUENCE_PREVIEW_LIMIT).join(', ')
  if (indices.length <= SEQUENCE_PREVIEW_LIMIT) return uiText("ui.animationTiming.frameSequence", shown)
  return uiText("ui.animationTiming.frameSequenceTotalItem", shown, indices.length)
}

export function describeTiming(frameCount: number, schedule: AnimationSchedule): string {
  return uiText("ui.animationTiming.frameFramesRoundPlayItemRound", frameCount, schedule.frames.length, formatSeconds(schedule.totalTicks))
}
