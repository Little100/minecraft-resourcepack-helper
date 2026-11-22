import { uiText } from '../i18n/messages'
const MARK = new Uint8Array([0x4d, 0x43, 0x52, 0x48, 1, 0x57])
export const MCRH_MARK_MIN_SIDE = 8
export function canMarkTexture(path: string): boolean {
  return /\.png$/i.test(path) && !/(?:^|\/)(?:colormap|font)\//i.test(path) && !/_(?:n|s|e|r|m|ao|normal|roughness|metallic|emissive|height)\.png$/i.test(path)
}
// 固定采样点只改 RGB 最低位，不改变透明度或反复累积误差
export function markMcrhPixels(width: number, height: number, data: Uint8Array, frameHeight = height): Uint8Array {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || data.length !== width * height * 4) throw new Error(uiText("core.mcrhMark.watermarkPixelsAreInvalid"))
  const output = data.slice()
  if (width < MCRH_MARK_MIN_SIDE || frameHeight < MCRH_MARK_MIN_SIDE || !Number.isSafeInteger(frameHeight) || height % frameHeight) return output
  for (let frame = 0; frame < height; frame += frameHeight) {
    for (let bit = 0; bit < MARK.length * 8; bit++) {
      const point = Math.floor(bit / 3), channel = bit % 3
      const offset = ((frame + Math.floor(point / 4) * 2) * width + point % 4 * 2) * 4 + channel
      output[offset] = (output[offset] & 254) | ((MARK[Math.floor(bit / 8)] >> (7 - bit % 8)) & 1)
    }
  }
  return output
}
export function hasMcrhMark(width: number, height: number, data: Uint8Array): boolean {
  if (width < 8 || height < 8 || data.length !== width * height * 4) return false
  return Array.from(MARK).every((byte, index) => {
    let value = 0
    for (let b = 0; b < 8; b++) {
      const bit = index * 8 + b, point = Math.floor(bit / 3)
      value = value * 2 + (data[(Math.floor(point / 4) * 2 * width + point % 4 * 2) * 4 + bit % 3] & 1)
    }
    return value === byte
  })
}
