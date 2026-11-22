import { uiText } from '../i18n/messages'
import * as path from 'node:path'
import { PNG } from 'pngjs'
import { assertPngDimensionsWithinLimit } from './document'
import { ModelPreviewAssets } from './modelPreviewAssets'
import { firstGuiFrame, guiResourceEra, guiSpriteSpecs, parseGuiScaling, type GuiPreviewData, type GuiScene, type GuiTexture } from './guiPreview'
export const GUI_TEXTURE_PIXEL_BUDGET = 16 * 1024 * 1024
export const GUI_TOTAL_PIXEL_BUDGET = 32 * 1024 * 1024
const DEFAULT_LIMITS = { texturePixels: GUI_TEXTURE_PIXEL_BUDGET, totalPixels: GUI_TOTAL_PIXEL_BUDGET, fileBytes: 16 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, outputBytes: 32 * 1024 * 1024 } as const
export interface GuiAssetOverlay { png?: (absolute: string, remainingPixels: number) => { width: number; height: number; pixels: Uint8Array } | undefined; text?: (absolute: string) => string | undefined }
export async function loadGuiPreview(roots: readonly string[], scene: GuiScene, options: { version?: string; selected?: string; overlay?: GuiAssetOverlay; limits?: Partial<Record<keyof typeof DEFAULT_LIMITS, number>> } = {}): Promise<Omit<GuiPreviewData, 'name' | 'revision'>> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits }
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > DEFAULT_LIMITS[key]) throw new Error(uiText("core.guiPreviewAssets.theGuiPreviewBudgetIsInvalid", key))
  const assets = new ModelPreviewAssets([...roots], { maxTotalBytes: limits.totalBytes, maxFileBytes: limits.fileBytes })
  const warnings: string[] = [], warn = (message: string): void => { if (!warnings.includes(message)) warnings.push(message) }
  const era = guiResourceEra(options.version)
  if (era === 'unknown') warn(uiText("core.guiPreviewAssets.clientVersionFallback"))
  type Asset = { bytes: Uint8Array; source: string; layer: number; dirty: boolean }
  const cache = new Map<string, Promise<Asset | undefined>>()
  let totalBytes = 0, pixels = 0, outputBytes = 0
  const account = (size: number): void => { if (totalBytes + size > limits.totalBytes) throw new Error(uiText("core.guiPreviewAssets.guiResourcesAndUnsavedContentExceedThe")); totalBytes += size }
  const read = (file: string, maxLayer = roots.length - 1): Promise<Asset | undefined> => {
    const key = maxLayer + ':' + file, existing = cache.get(key); if (existing) return existing
    const pending = (async () => {
      for (let layer = 0; layer <= maxLayer; layer++) {
        let bytes = await assets.read(file, layer)
        if (!bytes) continue
        account(bytes.byteLength)
        const source = path.join(roots[layer], ...file.split('/'))
        let dirty = false
        if (!file.endsWith('.png')) {
          const live = options.overlay?.text?.(source)
          if (live !== undefined) {
            const size = Buffer.byteLength(live)
            if (size > Math.min(assets.limits.maxJsonBytes, limits.fileBytes)) throw new Error(uiText("core.guiPreviewAssets.unsavedMetadataExceedingReadBudget"))
            account(size); bytes = Buffer.from(live); dirty = true
          }
        }
        return { bytes, source, layer, dirty }
      }
      return undefined
    })()
    cache.set(key, pending); return pending
  }
  const textures = new Map<string, GuiTexture>(), sprites: GuiPreviewData['sprites'] = []
  for (const spec of guiSpriteSpecs(scene, options.selected)) {
    try {
      const useLegacy = era === 'legacy' && !!spec.legacy
      let file = useLegacy ? spec.legacy!.path : spec.modern, resource = await read(file)
      let region = useLegacy ? spec.legacy : spec.region, old = useLegacy
      if (!resource && era === 'unknown' && spec.legacy) { file = spec.legacy.path; resource = await read(file); region = spec.legacy; old = true }
      if (!resource) { warn(uiText("core.guiPreviewAssets.missing", spec.label, file)); continue }
      let texture = textures.get(file)
      if (!texture) {
        if (pixels >= limits.totalPixels) throw new Error(uiText("core.guiPreviewAssets.guiSceneIsDecodedPixelBudget"))
        const live = options.overlay?.png?.(resource.source, Math.min(limits.texturePixels, limits.totalPixels - pixels))
        let bytes = resource.bytes, dirty = resource.dirty
        if (!live) assertPngDimensionsWithinLimit(bytes)
        const header = !live ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : undefined
        const width = live?.width ?? header!.getUint32(16), height = live?.height ?? header!.getUint32(20), size = width * height
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || size > limits.texturePixels || pixels + size > limits.totalPixels || live && (!(live.pixels instanceof Uint8Array) || live.pixels.length !== size * 4)) throw new Error(uiText("core.guiPreviewAssets.guiProfileSizeOrPixelLengthInvalid"))
        // 编码与解码前预留像素，失败也保留预算以限制重复处理
        pixels += size
        if (live) {
          bytes = PNG.sync.write({ width, height, data: Buffer.from(live.pixels) } as PNG)
          if (bytes.byteLength > limits.fileBytes) throw new Error(uiText("core.guiPreviewAssets.unsavedPngEncodedExceedingSingleFileByte"))
          account(bytes.byteLength); dirty = true
        }
        if (outputBytes + bytes.byteLength > limits.outputBytes) throw new Error(uiText("core.guiPreviewAssets.guiSceneTransferExceedingByteBudget"))
        PNG.sync.read(Buffer.from(bytes), { checkCRC: true })
        outputBytes += bytes.byteLength
        texture = { key: file, path: file, source: resource.source, sourceLabel: resource.layer === 0 ? uiText("gui.currentPack") : uiText("gui.baseOrVanillaCache"), dirty, width, height, png: 'data:image/png;base64,' + Buffer.from(bytes).toString('base64') }
        textures.set(file, texture)
      }
      let metadata: unknown
      if (!region) {
        const meta = await read(file + '.mcmeta', resource.layer)
        if (meta) {
          try { metadata = JSON.parse(Buffer.from(meta.bytes).toString('utf8')) } catch { warn(file + uiText("core.guiPreviewAssets.mcmetaJsonSyntaxInvalidDefaultScalingUsed")) }
          if (meta.dirty) texture.dirty = true
        }
      }
      const frame = firstGuiFrame(metadata, texture.width, texture.height)
      if (frame.animated) warn(file + uiText("core.guiPreviewAssets.animatedSpritePreview"))
      const source = region ? { x: region.rect.x * texture.width / region.width, y: region.rect.y * texture.height / region.height, w: region.rect.w * texture.width / region.width, h: region.rect.h * texture.height / region.height } : frame.rect
      let scaling
      try { scaling = old ? spec.legacy?.scaling ?? { type: 'stretch' as const } : region ? { type: 'stretch' as const } : parseGuiScaling(metadata) } catch (error) { warn(file + '.mcmeta：' + (error instanceof Error ? error.message : String(error))); scaling = { type: 'stretch' as const } }
      sprites.push({ id: spec.id, texture: file, rect: source, scaling })
    } catch (error) { warn(spec.label + uiText("core.guiPreviewAssets.readingFailed") + (error instanceof Error ? error.message : String(error))) }
  }
  if (scene === 'texture' && !options.selected) warn(uiText("core.guiPreviewAssets.pleaseOpenThisSceneFromPngIn"))
  return { scene, version: options.version, selected: options.selected, textures: [...textures.values()], sprites, warnings }
}
