import { uiText } from '../i18n/messages'
export interface AnimationInput {
  frametime?: number
  frames?: Array<number | { index: number; time: number }>
}

export interface ScheduledFrame {
  index: number
  ticks: number
}

export interface AnimationSchedule {
  frames: ScheduledFrame[]
  totalTicks: number
}

export type AnimationFrame = number | { index: number; time: number }

export interface ParsedAnimationMeta {
  animation?: { frametime: number; interpolate: boolean; frames?: AnimationFrame[] }
  error?: string
}

const TICKS_PER_SECOND = 20

// 按 frames 顺序生成播放计划, 缺省时按帧条顺序播放, 越界索引直接报错
export function buildSchedule(frameCount: number, input: AnimationInput): AnimationSchedule {
  const frametime = input.frametime && input.frametime > 0 ? input.frametime : 1
  const source = input.frames ?? Array.from({ length: frameCount }, (_, index) => index)
  const frames = source.map(entry => {
    if (typeof entry === 'number') return { index: checkIndex(entry, frameCount), ticks: frametime }
    return { index: checkIndex(entry.index, frameCount), ticks: entry.time > 0 ? entry.time : frametime }
  })
  const totalTicks = frames.reduce((sum, frame) => sum + frame.ticks, 0)
  return { frames, totalTicks }
}

export function formatSeconds(totalTicks: number): string {
  return uiText("core.animationTimeline.aboutSec", (totalTicks / TICKS_PER_SECOND).toFixed(2))
}

export function parseAnimationMeta(text: string): ParsedAnimationMeta {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    return { error: uiText("core.animationTimeline.itSNotLegal", errorText(error)) }
  }
  const animation = isRecord(json) ? json.animation : undefined
  if (animation === undefined) return {}
  if (!isRecord(animation)) return { error: uiText("core.animationTimeline.animationMustBeAnObject") }
  const frametime = isPositive(animation.frametime) ? animation.frametime : 1
  const frames = normalizeFrames(animation.frames, frametime)
  if (frames.error) return { error: frames.error }
  return { animation: { frametime, interpolate: animation.interpolate === true, frames: frames.frames } }
}

function normalizeFrames(value: unknown, frametime: number): { frames?: AnimationFrame[]; error?: string } {
  if (value === undefined) return {}
  if (!Array.isArray(value)) return { error: uiText("core.animationTimeline.animationRamasMustBeAnArray") }
  const frames: AnimationFrame[] = []
  for (const [position, entry] of value.entries()) {
    if (typeof entry === 'number' && Number.isInteger(entry)) {
      frames.push(entry)
    } else if (isRecord(entry) && Number.isInteger(entry.index)) {
      frames.push({ index: entry.index as number, time: isPositive(entry.time) ? entry.time : frametime })
    } else {
      return { error: uiText("core.animationTimeline.iMSorryAnimationInvalidEntryShould", position + 1) }
    }
  }
  return { frames }
}

// 越界索引直接报错, 避免播放时读取到不存在的帧
function checkIndex(index: number, frameCount: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= frameCount) {
    throw new Error(uiText("core.animationTimeline.animatedFrameIndexBeyondRangePasteFrame", index, frameCount))
  }
  return index
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && value > 0
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
