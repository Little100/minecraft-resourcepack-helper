import type { AnimationSchedule } from '../../core/animationTimeline'

const TICKS_PER_SECOND = 20

export interface FrameMix {
  frame: number
  nextFrame: number
  mix: number
}

export function wrapTicks(timeTicks: number, totalTicks: number): number {
  if (totalTicks <= 0) return 0
  return ((timeTicks % totalTicks) + totalTicks) % totalTicks
}

export function findEntry(schedule: AnimationSchedule, timeTicks: number): number {
  const time = wrapTicks(timeTicks, schedule.totalTicks)
  let start = 0
  for (let i = 0; i < schedule.frames.length; i++) {
    start += schedule.frames[i].ticks
    if (time < start) return i
  }
  return Math.max(0, schedule.frames.length - 1)
}

// 计算某条目在播放周期内的起始刻, 用于逐帧步进时跳到条目边界
export function entryStart(schedule: AnimationSchedule, entry: number): number {
  let start = 0
  for (let i = 0; i < entry && i < schedule.frames.length; i++) start += schedule.frames[i].ticks
  return start
}

export function sampleFrame(schedule: AnimationSchedule, timeTicks: number, interpolate: boolean): FrameMix {
  if (schedule.frames.length === 0) return { frame: 0, nextFrame: 0, mix: 0 }
  const entry = findEntry(schedule, timeTicks)
  const current = schedule.frames[entry]
  if (!interpolate) return { frame: current.index, nextFrame: current.index, mix: 0 }
  const next = schedule.frames[(entry + 1) % schedule.frames.length]
  const time = wrapTicks(timeTicks, schedule.totalTicks)
  const progress = (time - entryStart(schedule, entry)) / current.ticks
  return { frame: current.index, nextFrame: next.index, mix: Math.min(1, Math.max(0, progress)) }
}

export function stepTime(schedule: AnimationSchedule, timeTicks: number, direction: 1 | -1): number {
  const count = schedule.frames.length
  if (count === 0) return 0
  const next = (findEntry(schedule, timeTicks) + direction + count) % count
  return entryStart(schedule, next)
}

export function advanceTime(timeTicks: number, elapsedSeconds: number): number {
  return timeTicks + elapsedSeconds * TICKS_PER_SECOND
}
