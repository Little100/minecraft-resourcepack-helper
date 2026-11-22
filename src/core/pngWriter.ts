import { uiText } from '../i18n/messages'
import { PNG } from 'pngjs'
import type { DecodedFrame } from './frameSource'

export interface StripResult {
  frameWidth: number
  frameHeight: number
  stripWidth: number
  stripHeight: number
  frameCount: number
  buffer: Buffer
}

export function encodeVerticalStrip(frames: DecodedFrame[]): StripResult {
  if (frames.length === 0) throw new Error(uiText("core.pngWriter.noFrameToWrite"))
  const { width, height } = frames[0]
  if (width <= 0 || height <= 0) throw new Error(uiText("core.pngWriter.frameSizeInvalid"))
  frames.forEach((frame, index) => {
    if (frame.width !== width || frame.height !== height) {
      throw new Error(uiText("core.pngWriter.frameSizeMismatch", index + 1, frame.width, frame.height, width, height))
    }
    if (frame.data.length !== width * height * 4) throw new Error(uiText("core.pngWriter.frameDataLengthMismatch", index + 1))
  })
  const frameBytes = width * height * 4
  const data = new Uint8Array(frameBytes * frames.length)
  frames.forEach((frame, index) => data.set(frame.data, index * frameBytes))
  const png = new PNG({ width, height: height * frames.length })
  png.data = Buffer.from(data)
  return {
    frameWidth: width,
    frameHeight: height,
    stripWidth: width,
    stripHeight: height * frames.length,
    frameCount: frames.length,
    buffer: PNG.sync.write(png)
  }
}
