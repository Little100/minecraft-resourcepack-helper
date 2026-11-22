import { PNG } from 'pngjs'

export type Rgba = [number, number, number, number]

const RED: Rgba = [224, 62, 62, 255]
const GREEN: Rgba = [62, 224, 120, 255]

export function stripPng(frameWidth: number, frameHeight: number, frameColors: Rgba[]): Uint8Array {
  const image = new PNG({ width: frameWidth, height: frameHeight * frameColors.length })
  frameColors.forEach((rgba, frame) => {
    for (let y = 0; y < frameHeight; y++) {
      for (let x = 0; x < frameWidth; x++) {
        image.data.set(rgba, ((frame * frameHeight + y) * frameWidth + x) * 4)
      }
    }
  })
  return PNG.sync.write(image)
}

export function flatPng(width: number, height: number, rgba: Rgba): Uint8Array {
  return stripPng(width, height, [rgba])
}

export const MAGENTA = flatPng(16, 16, [233, 62, 201, 255])
export const CYAN = flatPng(16, 16, [62, 201, 233, 255])
export const STRIP_20 = stripPng(16, 16, Array.from({ length: 20 }, (_, frame) => (frame % 2 === 0 ? RED : GREEN)))
