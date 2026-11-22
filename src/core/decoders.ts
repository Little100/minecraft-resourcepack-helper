import { uiText } from '../i18n/messages'
import { PNG } from 'pngjs'
import type { DecodedAnimation, DecodedFrame } from './frameSource'
import { stripFrameCount } from './frameSource'
import { decodeApngFrames } from './apng'
import { decodeGifAnimation } from './gif'
import { assertPngDimensionsWithinLimit } from './document'

export function decodeSingleFrame(bytes: Uint8Array): DecodedFrame {
  assertPngDimensionsWithinLimit(bytes)
  const image = PNG.sync.read(Buffer.from(bytes))
  return { width: image.width, height: image.height, data: new Uint8Array(image.data) }
}

export function decodePng(bytes: Uint8Array): DecodedAnimation {
  const image = decodeSingleFrame(bytes)
  const count = stripFrameCount(image.width, image.height)
  if (count <= 1) return { frames: [image], loop: false }
  const frameBytes = image.width * image.width * 4
  const frames: DecodedFrame[] = Array.from({ length: count }, (_, index) => ({
    width: image.width,
    height: image.width,
    data: image.data.slice(index * frameBytes, (index + 1) * frameBytes)
  }))
  return { frames, frameTicks: frames.map(() => 1), loop: true }
}

export function decodeAnimation(bytes: Uint8Array, format: string): DecodedAnimation {
  switch (format) {
    case 'png':
      return { frames: [decodeSingleFrame(bytes)], loop: false }
    case 'apng':
      return decodeApngFrames(bytes)
    case 'gif':
      return decodeGifAnimation(bytes)
    default:
      throw new Error(uiText("core.decoders.formatNotSupported", format))
  }
}
