import { uiText } from '../i18n/messages'
export interface TextureResolution {
  width: number
  frameHeight: number
  frameCount: number
  totalHeight: number
  warnings: string[]
}

export function isPowerOfTwo(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && Number.isInteger(Math.log2(value))
}

// 分辨率建议只看单帧，动画条带的总高度无需是二的幂
export function textureResolution(width: number, frameHeight: number, frameCount = 1): TextureResolution {
  if (![width, frameHeight, frameCount].every(value => Number.isSafeInteger(value) && value > 0) || !Number.isSafeInteger(frameHeight * frameCount)) throw new Error(uiText("core.textureResolution.singleWidthAndFrameNumbersMustBe"))
  const warnings: string[] = []
  if (width !== frameHeight) warnings.push(uiText("core.textureResolution.singleFrameIsNotSquareMakeSure"))
  if (!isPowerOfTwo(width) || !isPowerOfTwo(frameHeight)) warnings.push(uiText("core.textureResolution.singleFrameWidthIsNotALuminum"))
  return { width, frameHeight, frameCount, totalHeight: frameHeight * frameCount, warnings }
}
