import { uiText } from '../i18n/messages'
import { parseGIF, decompressFrames, type ParsedFrame } from 'gifuct-js'
import type { DecodedAnimation, DecodedFrame } from './frameSource'

const MILLISECONDS_PER_TICK = 50

const UNSPECIFIED_MAX_MILLISECONDS = 10
const DEFAULT_MILLISECONDS = 100

// 毫秒换算为游戏刻, 与 apng.ts 的语义保持一致, 四舍五入且最少 1 刻, 避免 0 刻的帧被引擎当作无效值
export function millisecondsToTicks(milliseconds: number): number {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 1
  return Math.max(1, Math.round(milliseconds / MILLISECONDS_PER_TICK))
}

// 单帧像素量上限, 超过该尺寸的帧直接拒绝, 避免恶意动图在解码时耗尽内存
export const MAX_FRAME_PIXELS = 4096 * 4096
// 单帧边长上限, 与像素量上限共同约束分辨率
export const MAX_FRAME_EDGE = 4096
// 帧数上限, 限制累计拷贝量, 避免超长动图叠加占用内存
export const MAX_FRAME_COUNT = 2048

// 校验画布与帧数上限, 超过时抛出带原因的中文错误而不是继续分配内存
export function assertDecodedLimits(width: number, height: number, frameCount: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(uiText("core.gif.frameSizeInvalidX", width, height))
  }
  if (width > MAX_FRAME_EDGE || height > MAX_FRAME_EDGE || width * height > MAX_FRAME_PIXELS) {
    throw new Error(uiText("core.gif.frameSizeXBeyondTheLimitSingle", width, height, MAX_FRAME_EDGE, MAX_FRAME_PIXELS))
  }
  if (frameCount > MAX_FRAME_COUNT) {
    throw new Error(uiText("core.gif.comunicationsOfActionFrameExceedingFrameLimit", frameCount, MAX_FRAME_COUNT))
  }
}

export interface GifFrameInput {
  dims: { left: number; top: number; width: number; height: number }
  patch: Uint8ClampedArray | Uint8Array
  disposalType: number
  delay: number
}

export function composeGifFrames(width: number, height: number, frames: GifFrameInput[]): DecodedFrame[] {
  const canvas = new Uint8Array(width * height * 4)
  const output: DecodedFrame[] = []
  let previous: GifFrameInput | undefined
  let beforePrevious: Uint8Array | undefined

  for (const frame of frames) {
    if (previous?.disposalType === 2) {
      clearRect(canvas, width, height, previous.dims)
    } else if (previous?.disposalType === 3 && beforePrevious) {
      canvas.set(beforePrevious)
    }

    beforePrevious = frame.disposalType === 3 ? new Uint8Array(canvas) : undefined
    drawPatch(canvas, width, height, frame)
    output.push({ width, height, data: new Uint8Array(canvas) })
    previous = frame
  }
  return output
}

function drawPatch(canvas: Uint8Array, width: number, height: number, frame: GifFrameInput): void {
  const { left, top, width: fw, height: fh } = frame.dims
  const patch = frame.patch
  for (let y = 0; y < fh; y++) {
    const dy = top + y
    if (dy < 0 || dy >= height) continue
    for (let x = 0; x < fw; x++) {
      const dx = left + x
      if (dx < 0 || dx >= width) continue
      const src = (y * fw + x) * 4
      if (patch[src + 3] === 0) continue
      const dst = (dy * width + dx) * 4
      canvas[dst] = patch[src]
      canvas[dst + 1] = patch[src + 1]
      canvas[dst + 2] = patch[src + 2]
      canvas[dst + 3] = patch[src + 3]
    }
  }
}

// disposal 2 要求把帧所在矩形清为全透明, 矩形可能越过画布边界故逐像素裁剪
function clearRect(canvas: Uint8Array, width: number, height: number, rect: GifFrameInput['dims']): void {
  for (let y = 0; y < rect.height; y++) {
    const dy = rect.top + y
    if (dy < 0 || dy >= height) continue
    for (let x = 0; x < rect.width; x++) {
      const dx = rect.left + x
      if (dx < 0 || dx >= width) continue
      const dst = (dy * width + dx) * 4
      canvas[dst] = 0
      canvas[dst + 1] = 0
      canvas[dst + 2] = 0
      canvas[dst + 3] = 0
    }
  }
}

function frameDelayTicks(frame: ParsedFrame): number {
  const milliseconds = typeof frame.delay === 'number' ? frame.delay : DEFAULT_MILLISECONDS
  return millisecondsToTicks(milliseconds > UNSPECIFIED_MAX_MILLISECONDS ? milliseconds : DEFAULT_MILLISECONDS)
}

export function decodeGifAnimation(bytes: Uint8Array): DecodedAnimation {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const parsed = parseGIF(buffer)
  const rawFrames = decompressFrames(parsed, true)
  if (rawFrames.length === 0) throw new Error(uiText("core.gif.gifDoesNotContainAnyFrame"))
  const width = parsed.lsd.width > 0 ? parsed.lsd.width : rawFrames[0].dims.width
  const height = parsed.lsd.height > 0 ? parsed.lsd.height : rawFrames[0].dims.height
  // 合成前先做上限校验, 超限直接拒绝以免逐帧拷贝耗尽内存
  assertDecodedLimits(width, height, rawFrames.length)
  const frames = composeGifFrames(width, height, rawFrames)
  const frameTicks = rawFrames.map(frameDelayTicks)
  return { frames, frameTicks, loop: true }
}
