import { uiText } from '../i18n/messages'
import * as path from 'node:path'
import { PNG } from 'pngjs'
import { animationFrameSize } from './advanced/textureBatch'
import { decodeTexturePng } from './advanced/pngCodec'
import { assertEditSize, EDIT_PIXEL_BUDGET, scalePixels } from './pixelGeometry'
import type { ReleasePlan } from './clientAssets'

export const VANILLA_TEXTURE_RESOLUTION = 16
export const MAX_CLIENT_TEXTURE_RESOLUTION = 1024
export interface ClientTextureResizeReport {
  resolution: number
  resized: number
  fixedSize: number
  warnings: string[]
}

export function validateClientTextureResolution(resolution: number): void {
  if (!Number.isSafeInteger(resolution) || resolution < 1 || resolution > MAX_CLIENT_TEXTURE_RESOLUTION || (resolution & (resolution - 1)) !== 0) throw new Error(uiText("core.clientTextureResolution.completionResolutionMustBeToNInteger", MAX_CLIENT_TEXTURE_RESOLUTION))
}

// 按原版基准等比采样，动画帧布局与固定尺寸颜色图保持独立
export function resizeClientReleaseTextures(plan: ReleasePlan, resolution: number, maxTotalBytes: number, progress?: (message: string) => void): ClientTextureResizeReport {
  validateClientTextureResolution(resolution)
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) throw new Error(uiText("core.clientTextureResolution.ineffectiveBudgetForTotalResources"))
  const report: ClientTextureResizeReport = { resolution, resized: 0, fixedSize: 0, warnings: [] }
  if (resolution === VANILLA_TEXTURE_RESOLUTION) return report
  const factor = resolution / VANILLA_TEXTURE_RESOLUTION
  const files = new Map(plan.files.map(file => [file.target.fsPath, file]))
  let totalBytes = plan.files.reduce((total, file) => total + file.data.byteLength, 0)
  for (const file of plan.files) {
    const relative = path.relative(plan.root, file.target.fsPath).split(path.sep).join('/')
    if (!/^assets\/[^/]+\/textures\/.+\.png$/i.test(relative)) continue
    if (/^assets\/[^/]+\/textures\/colormap\//i.test(relative)) { report.fixedSize++; continue }
    try {
      const image = decodeTexturePng(file.data, relative, EDIT_PIXEL_BUDGET)
      const sidecar = files.get(file.target.fsPath + '.mcmeta')
      const frame = animationFrameSize(image, sidecar?.data)
      const width = image.width * factor, height = image.height * factor
      assertEditSize(width, height)
      const frameWidth = frame.frameWidth * factor, frameHeight = frame.frameHeight * factor
      if (!Number.isSafeInteger(frameWidth) || !Number.isSafeInteger(frameHeight) || frameWidth < 1 || frameHeight < 1) throw new Error(uiText("core.clientTextureResolution.singleFrameSizeLessThanOneInteger"))
      let metadata: Uint8Array | undefined
      if (sidecar) {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sidecar.data))
        if (value?.animation && (value.animation.width !== undefined || value.animation.height !== undefined)) {
          value.animation.width = frameWidth
          value.animation.height = frameHeight
          metadata = Buffer.from(JSON.stringify(value, null, 2) + '\n')
        }
      }
      progress?.(uiText("core.clientTextureResolution.adjustTheStickers", relative, width, height))
      const png = new PNG({ width, height })
      png.data = Buffer.from(scalePixels(image.data, image.width, image.height, width, height))
      const data = PNG.sync.write(png)
      const bytes = totalBytes - file.data.byteLength - (metadata && sidecar ? sidecar.data.byteLength : 0) + data.byteLength + (metadata?.byteLength ?? 0)
      if (bytes > maxTotalBytes) throw new Error(uiText("core.clientTextureResolution.theTotalAmountOfResourcesAfterScaling", Math.floor(maxTotalBytes / 1024 / 1024)))
      file.data = data
      if (metadata && sidecar) sidecar.data = metadata
      totalBytes = bytes
      report.resized++
    } catch (error) {
      report.warnings.push(relative + ': ' + (error instanceof Error ? error.message : String(error)))
    }
  }
  return report
}
