import { uiText } from '../i18n/messages'
import type { AnimationMeta } from './types'

export interface DecodedFrame {
  width: number
  height: number
  data: Uint8Array
}

export interface DecodedAnimation {
  frames: DecodedFrame[]
  frameTicks?: number[]
  loop: boolean
}

export type SourceFormat = 'png' | 'apng' | 'gif' | 'webp' | 'mp4' | 'unknown'

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)
}

export function isGif(bytes: Uint8Array): boolean {
  return bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46
}

export function isWebp(bytes: Uint8Array): boolean {
  return bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
}

export function isMp4(bytes: Uint8Array): boolean {
  return bytes.length > 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
}

export function sniffFormat(bytes: Uint8Array): SourceFormat {
  if (isPng(bytes)) return 'png'
  if (isGif(bytes)) return 'gif'
  if (isWebp(bytes)) return 'webp'
  if (isMp4(bytes)) return 'mp4'
  return 'unknown'
}

export function sniffAnimatedFormat(bytes: Uint8Array): SourceFormat {
  const format = sniffFormat(bytes)
  if (format !== 'png') return format
  return hasChunkBeforeData(bytes, 'acTL') ? 'apng' : 'png'
}

function hasChunkBeforeData(bytes: Uint8Array, type: string): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset)
    const name = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
    if (name === type) return true
    if (name === 'IDAT' || name === 'IEND') return false
    offset += 12 + length
  }
  return false
}

export function stripFrameCount(frameWidth: number, stripHeight: number): number {
  return frameWidth > 0 ? Math.floor(stripHeight / frameWidth) : 0
}

export interface FrameTimeEntry {
  index: number
  time: number
}

export function buildAnimationMcmeta(frameTicks: number[]): { animation: AnimationMeta } {
  if (frameTicks.length === 0) throw new Error(uiText("core.frameSource.noFrameTimeToWrite"))
  if (frameTicks.some(tick => !Number.isInteger(tick) || tick < 1)) throw new Error(uiText("core.frameSource.frameLengthMustBeCarvedForInteger"))
  const uniform = frameTicks.every(tick => tick === frameTicks[0])
  const entries: FrameTimeEntry[] = frameTicks.map((time, index) => ({ index, time }))
  const animation: AnimationMeta = uniform ? { frametime: frameTicks[0] } : { frames: entries }
  return { animation }
}

// 帧时长优先级为用户覆盖 > 源文件逐帧时长 > 默认值, 逐帧数组长度须与帧数一致
export function resolveFrameTicks(
  frameCount: number,
  frametime: number | readonly number[] | undefined,
  sourceTicks: readonly number[] | undefined,
  defaultTicks: number
): number[] {
  if (typeof frametime === 'number') return Array.from({ length: frameCount }, () => frametime)
  if (frametime !== undefined) {
    if (frametime.length !== frameCount) throw new Error(uiText("core.frameSource.longTimeByFrameItemWithFrame", frametime.length, frameCount))
    return [...frametime]
  }
  if (sourceTicks && sourceTicks.length === frameCount) return [...sourceTicks]
  return Array.from({ length: frameCount }, () => defaultTicks)
}

export function centerCropSquare(frame: DecodedFrame): DecodedFrame {
  if (frame.width === frame.height) return frame
  const side = Math.min(frame.width, frame.height)
  const offsetX = Math.floor((frame.width - side) / 2)
  const offsetY = Math.floor((frame.height - side) / 2)
  const out = new Uint8Array(side * side * 4)
  for (let y = 0; y < side; y++) {
    const start = ((y + offsetY) * frame.width + offsetX) * 4
    out.set(frame.data.subarray(start, start + side * 4), y * side * 4)
  }
  return { width: side, height: side, data: out }
}
