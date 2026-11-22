import { uiText } from '../i18n/messages'
import { decode as decodeUpng, toRGBA8, type UPNGFrame, type UPNGImage } from 'upng-js'
import type { DecodedAnimation, DecodedFrame } from './frameSource'
import { assertDecodedLimits, millisecondsToTicks } from './gif'

const DISPOSE_NONE = 0
const DISPOSE_BACKGROUND = 1
const DISPOSE_PREVIOUS = 2

const BLEND_SOURCE = 0

export interface ApngFrameInput {
  rect: { x: number; y: number; width: number; height: number }
  rgba: Uint8Array
  dispose: number
  blend: number
}

export function composeApngFrames(width: number, height: number, frames: ApngFrameInput[]): DecodedFrame[] {
  const canvas = new Uint8Array(width * height * 4)
  const output: DecodedFrame[] = []
  for (const frame of frames) {
    const before = frame.dispose === DISPOSE_PREVIOUS ? new Uint8Array(canvas) : undefined
    drawRegion(canvas, width, height, frame)
    output.push({ width, height, data: new Uint8Array(canvas) })
    applyDispose(canvas, width, height, frame, before)
  }
  return output
}

function drawRegion(canvas: Uint8Array, width: number, height: number, frame: ApngFrameInput): void {
  const { x, y, width: fw, height: fh } = frame.rect
  for (let row = 0; row < fh; row++) {
    const dy = y + row
    if (dy < 0 || dy >= height) continue
    for (let col = 0; col < fw; col++) {
      const dx = x + col
      if (dx < 0 || dx >= width) continue
      const src = (row * fw + col) * 4
      const dst = (dy * width + dx) * 4
      if (frame.blend === BLEND_SOURCE) {
        canvas.set(frame.rgba.subarray(src, src + 4), dst)
      } else {
        blendOver(canvas, dst, frame.rgba, src)
      }
    }
  }
}

function blendOver(canvas: Uint8Array, dst: number, src: Uint8Array, s: number): void {
  const sa = src[s + 3] / 255
  const da = canvas[dst + 3] / 255
  const oa = sa + da * (1 - sa)
  if (oa === 0) {
    canvas[dst] = 0
    canvas[dst + 1] = 0
    canvas[dst + 2] = 0
    canvas[dst + 3] = 0
    return
  }
  for (let c = 0; c < 3; c++) {
    const value = (src[s + c] * sa + canvas[dst + c] * da * (1 - sa)) / oa
    canvas[dst + c] = Math.round(value)
  }
  canvas[dst + 3] = Math.round(oa * 255)
}

function applyDispose(
  canvas: Uint8Array,
  width: number,
  height: number,
  frame: ApngFrameInput,
  before: Uint8Array | undefined
): void {
  if (frame.dispose === DISPOSE_NONE) return
  const { x, y, width: fw, height: fh } = frame.rect
  for (let row = 0; row < fh; row++) {
    const dy = y + row
    if (dy < 0 || dy >= height) continue
    for (let col = 0; col < fw; col++) {
      const dx = x + col
      if (dx < 0 || dx >= width) continue
      const dst = (dy * width + dx) * 4
      if (frame.dispose === DISPOSE_BACKGROUND) {
        canvas.fill(0, dst, dst + 4)
      } else if (frame.dispose === DISPOSE_PREVIOUS && before) {
        canvas.set(before.subarray(dst, dst + 4), dst)
      }
    }
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function requirePixels(data: Uint8Array | undefined, label: string): Uint8Array {
  if (!data) throw new Error(uiText("core.apng.missingPixelDataFileMayBeCorrupted", label))
  return data
}

function regionRgba(image: UPNGImage, width: number, height: number, data: Uint8Array): Uint8Array {
  const single: UPNGImage = { ...image, width, height, data, frames: [], tabs: { ...image.tabs, acTL: null } }
  return new Uint8Array(toRGBA8(single)[0])
}

export function decodeApngFrames(bytes: Uint8Array): DecodedAnimation {
  const image = decodeUpng(toArrayBuffer(bytes))
  if (!image.tabs.acTL || image.frames.length === 0) {
    // 静态图按单帧处理, 同样受尺寸上限约束
    assertDecodedLimits(image.width, image.height, 1)
    const rgba = regionRgba(image, image.width, image.height, requirePixels(image.data, uiText("core.apng.staticImages")))
    return { frames: [{ width: image.width, height: image.height, data: rgba }], frameTicks: [1], loop: false }
  }
  assertDecodedLimits(image.width, image.height, image.frames.length)
  const inputs: ApngFrameInput[] = image.frames.map((frame: UPNGFrame, index: number) => {
    const pixels = frame.data ?? (index === 0 ? image.data : undefined)
    return {
      rect: frame.rect,
      rgba: regionRgba(image, frame.rect.width, frame.rect.height, requirePixels(pixels, uiText("core.apng.frameNumber", index + 1))),
      dispose: frame.dispose,
      blend: frame.blend
    }
  })
  return {
    frames: composeApngFrames(image.width, image.height, inputs),
    frameTicks: image.frames.map(frame => millisecondsToTicks(frame.delay)),
    loop: true
  }
}
