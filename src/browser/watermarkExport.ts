import { uiText } from '../i18n/messages'
import { embedTextureWatermark } from '../core/textureWatermark'
import { parseTextureWatermarkSettings } from '../core/textureWatermarkSettings'
import { readTextureWatermarkSettings } from '../webview/watermarkTools'
import { decodePng, encodePng, errorText, textDecoder, type BrowserFile } from './files'

export async function watermarkExport(files: readonly BrowserFile[], report: (text: string) => void): Promise<readonly BrowserFile[]> {
  const settings = parseTextureWatermarkSettings(readTextureWatermarkSettings(document))
  if (!settings) return files
  let marked = 0, skipped = 0, failed = 0
  const output: BrowserFile[] = [], byPath = new Map(files.map(file => [file.path, file]))
  for (const file of files) {
    if (!/^assets\/[^/]+\/textures\/.+\.png$/i.test(file.path) || /\/textures\/(?:colormap|font)\//i.test(file.path) || /_(?:n|s|e|r|m|ao|h|height|normal|roughness|metallic|emissive)\.png$/i.test(file.path)) { output.push(file); if (/\.png$/i.test(file.path)) skipped++; continue }
    if (typeof file.content === 'string') { output.push(file); skipped++; continue }
    const animation = byPath.get(file.path + '.mcmeta')
    if (animation) {
      try { const metadata = JSON.parse(typeof animation.content === 'string' ? animation.content : textDecoder.decode(animation.content)); if (metadata && Object.hasOwn(metadata, 'animation')) { output.push(file); skipped++; continue } }
      catch { output.push(file); skipped++; continue }
    }
    let image
    try { image = decodePng(file.content) } catch { output.push(file); skipped++; continue }
    let opaque = true
    for (let index = 3; index < image.data.length; index += 4) if (image.data[index] !== 255) { opaque = false; break }
    if (image.width < 256 || image.height < 256 || !opaque) { output.push(file); skipped++; continue }
    try { const result = await embedTextureWatermark({ width: image.width, height: image.height, data: image.data }, settings); output.push({ path: file.path, content: encodePng(result.image.width, result.image.height, new Uint8Array(result.image.data)) }); marked++ }
    catch (error) { output.push(file); failed++; report(uiText("browser.watermarkExport.watermarksNotApplied", file.path, errorText(error))) }
  }
  report(uiText("browser.watermarkExport.exportWatermarksProcessedSkipSizeTransparencyPbr", marked, skipped, failed))
  return output
}
