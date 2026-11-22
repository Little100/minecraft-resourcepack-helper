import { uiText } from '../../i18n/messages'
import { filterMcrhEditorData, isMcrhEditorDataPath, type McrhEditorDataExportOptions } from './editorDataExportPolicy'
import { PNG } from 'pngjs'
import { decodeTexturePng } from './pngCodec'
import { withPackRequirements } from './packRequirements'
import { applyVanillaExportPolicy, readVanillaExportBase } from './exportPolicy'
import { canMarkTexture, markMcrhPixels, MCRH_MARK_MIN_SIDE } from '../mcrhMark'
import { embedTextureWatermark, extractTextureWatermark, TEXTURE_WATERMARK_DEFAULTS } from '../textureWatermark'
import { parseTextureWatermarkSettings } from '../textureWatermarkSettings'
import type { GeneratedFile } from './safeExport'

export interface ExportTextureProcessingOptions extends McrhEditorDataExportOptions { includeVanillaTextures?: boolean; watermark?: unknown }

function canAuthenticateTexture(file: GeneratedFile, metadata: GeneratedFile | undefined, image: PNG): boolean {
  if (!/^assets\/[^/]+\/textures\/.+\.png$/i.test(file.path) || /_h\.png$/i.test(file.path)) return false
  if (image.width < TEXTURE_WATERMARK_DEFAULTS.minimumSide || image.height < TEXTURE_WATERMARK_DEFAULTS.minimumSide) return false
  if (metadata) {
    try {
      const value = JSON.parse(typeof metadata.content === 'string' ? metadata.content : new TextDecoder().decode(metadata.content))
      if (value && Object.hasOwn(value, 'animation')) return false
    } catch { return false }
  }
  for (let index = 3; index < image.data.length; index += 4) if (image.data[index] !== 255) return false
  return true
}

export async function processExportTextures(files: GeneratedFile[], basePath: string | undefined, options: ExportTextureProcessingOptions = {}, availableBasePaths: readonly string[] = []) {
  if (options.includeVanillaTextures !== undefined && typeof options.includeVanillaTextures !== 'boolean') throw new Error(uiText("core.advanced.exportPolicy.theOriginalPosterExportOptionMustBe"))
  let watermark: ReturnType<typeof parseTextureWatermarkSettings>
  try { watermark = parseTextureWatermarkSettings(options.watermark) }
  catch { throw new Error(uiText("core.advanced.exportTextureProcessing.validationOfWatermarksIsInvalidPleaseCheck")) }
  const editorData = filterMcrhEditorData(files, options)
  files = editorData.files
  const vanilla = options.includeVanillaTextures ? new Map<string, Uint8Array>() : await readVanillaExportBase(basePath, files)
  const result = applyVanillaExportPolicy(files, vanilla, options)
  const warnings = result.omitted.length ? [uiText("core.advanced.exportTextureProcessing.ignoreConfirmedUnmodifiedOriginalStickersAndAssociated", result.omitted.length)] : []
  if (editorData.omitted.length) warnings.push(uiText("core.advanced.exportTextureProcessing.excludedEditingDataInternalOrSupportingDocuments", editorData.omitted.length))
  const output: GeneratedFile[] = [], byPath = new Map(result.files.map(file => [file.path, file]))
  let embedded = 0, skipped = 0, authenticated = 0, authenticationSkipped = 0, authenticationFailed = 0
  for (const file of result.files) {
    if (isMcrhEditorDataPath(file.path) || !canMarkTexture(file.path)) {
      output.push(file)
      if (watermark && /\.png$/i.test(file.path)) authenticationSkipped++
      continue
    }
    if (typeof file.content === 'string') throw new Error(uiText("core.advanced.exportTextureProcessing.pagesMustBePngBytes"))
    const image = decodeTexturePng(file.content, file.path, TEXTURE_WATERMARK_DEFAULTS.maximumPixels)
    if (image.width < MCRH_MARK_MIN_SIDE || image.height < MCRH_MARK_MIN_SIDE) {
      skipped++; if (watermark) authenticationSkipped++
      output.push(file); continue
    }
    const metadata = byPath.get(file.path + '.mcmeta')
    const frameHeight = metadata && image.height % image.width === 0 ? image.width : image.height
    let pixels = markMcrhPixels(image.width, image.height, image.data, frameHeight)
    if (watermark) {
      if (canAuthenticateTexture(file, metadata, image)) {
        try {
          const marked = await embedTextureWatermark(image, watermark)
          // 认证水印之后写入弱标记，并核对实际交付像素的认证结果
          const combined = markMcrhPixels(image.width, image.height, new Uint8Array(marked.image.data), frameHeight)
          const verified = await extractTextureWatermark({ ...marked.image, data: combined }, { key: watermark.key })
          if (!verified.authenticated || verified.id !== watermark.id) throw new Error(uiText("core.advanced.exportTextureProcessing.accreditationOfWatermarkingFailed"))
          pixels = combined; authenticated++
          warnings.push(...marked.warnings)
        } catch { authenticationFailed++ }
      } else authenticationSkipped++
    }
    const png = new PNG({ width: image.width, height: image.height })
    png.data = Buffer.from(pixels)
    output.push({ ...file, content: new Uint8Array(PNG.sync.write(png)) }); embedded++
  }
  warnings.push(uiText("core.advanced.exportTextureProcessing.mcdhPixelsTagZhangLessThanX8", embedded, skipped))
  if (watermark) warnings.push(uiText("core.advanced.exportTextureProcessing.certifiedWatermarkSuccessfulChangSkipSizesTransparency", authenticated, authenticationSkipped, authenticationFailed))
  const required = withPackRequirements(output, [...availableBasePaths, ...result.omitted])
  return { files: required.files, omittedEditorData: editorData.omitted, warnings: [...new Set([...warnings, ...required.warnings])] }
}
