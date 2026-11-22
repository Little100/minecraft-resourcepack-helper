import { uiText } from '../i18n/messages'
import { PNG } from 'pngjs'
import { assertPngDimensionsWithinLimit } from './document'
import { resourceId } from './customModelData'

export interface FontGlyph {
  char: string
  font: string
  provider: string
  source: string
  sourceLayer?: number
  texture?: string
  width: number
  height: number
  ascent: number
  advance: number
  pixelWidth?: number
  pixelHeight?: number
  pixels?: ArrayBuffer
}
export interface FontGlyphResult { glyphs: FontGlyph[]; warnings: string[]; missingRootDefinition: boolean }
export interface FontAssetReader { read(path: string): Promise<Uint8Array | undefined>; readFonts?(path: string): Promise<Array<{ bytes: Uint8Array; layer: number }>> }
function assetPath(id: string, folder: string, suffix: string): string {
  if (!resourceId(id)) throw new Error(uiText("core.fontGlyphs.fontResourceIdentifierInvalid", id))
  const [namespace, name] = id.includes(':') ? id.split(':') : ['minecraft', id]
  return 'assets/' + namespace + '/' + folder + '/' + name + suffix
}
export function unicodeLabel(char: string): string {
  return 'U+' + (char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')
}
export function unicodeEscape(char: string): string {
  return Array.from({ length: char.length }, (_, index) => '\\u' + char.charCodeAt(index).toString(16).padStart(4, '0')).join('')
}
// 同一字体按 provider 声明顺序命中，引用循环和贴图分配都有预算
export async function loadFontGlyphs(reader: FontAssetReader, font = 'minecraft:default', requested?: ReadonlySet<string>, search = ''): Promise<FontGlyphResult> {
  const glyphs = new Map<string, FontGlyph>(), warnings: string[] = []
  const query = search.trim().toLowerCase()
  const matches = (char: string, source: string, texture = ''): boolean => (!requested || requested.has(char)) && (!query || [unicodeLabel(char), unicodeEscape(char), char, source, texture].some(value => value.toLowerCase().includes(query)))
  let definitions = 0, pixels = 0, scanned = 0, missingRootDefinition = false
  const warning = (text: string): void => { if (warnings.length < 24 && !warnings.includes(text)) warnings.push(text) }
  const walk = async (id: string, stack: ReadonlySet<string>): Promise<void> => {
    if (stack.has(id) || stack.size >= 16) { warning(uiText("core.fontGlyphs.fontReferenceLoopOrEmbeddedDepth", id)); return }
    if (++definitions > 128) throw new Error(uiText("core.fontGlyphs.fontDefinitionExceedingReadBudget"))
    const source = assetPath(id, 'font', '.json')
    const single = reader.readFonts ? undefined : await reader.read(source)
    const layers = reader.readFonts ? await reader.readFonts(source) : single ? [{ bytes: single, layer: undefined }] : []
    if (!layers.length) {
      if (!stack.size) missingRootDefinition = true
      warning(uiText("core.fontGlyphs.missingFontDefinition", source))
      return
    }
    const providers: Array<{ value: unknown; layer?: number }> = []
    for (const entry of layers) {
      const { bytes } = entry
      if (bytes.length > 2 * 1024 * 1024) throw new Error(uiText("core.fontGlyphs.fontJsonExceededReadLimit"))
      const parsed = JSON.parse(new TextDecoder().decode(bytes))
      if (!parsed || !Array.isArray(parsed.providers)) { warning(uiText("core.fontGlyphs.fontsMissing", source)); continue }
      for (const value of parsed.providers) { if (providers.length >= 1024) { warning(uiText("core.fontGlyphs.fontProgramrExceedingPreviewBudget")); break } providers.push({ value, layer: entry.layer }) }
    }
    const next = new Set([...stack, id])
    for (const entry of providers) {
      const rawProvider = entry.value
      if (!rawProvider || typeof rawProvider !== 'object') continue
      const provider = rawProvider as Record<string, unknown>
      const type = String(provider.type).replace(/^minecraft:/, '')
      const filter = provider.filter && typeof provider.filter === 'object' ? provider.filter as Record<string, unknown> : undefined
      if (filter && (filter.uniform === true || filter.jp === true)) { warning(uiText("core.fontGlyphs.fontProjecterWithClientFilterConditionsPreview")); continue }
      if (type === 'reference' && typeof provider.id === 'string') { await walk(provider.id, next); continue }
      if (type === 'space' && provider.advances && typeof provider.advances === 'object') {
        for (const [char, advance] of Object.entries(provider.advances)) if (Array.from(char).length === 1 && typeof advance === 'number' && Number.isFinite(advance) && Math.abs(advance) <= 65536 && !glyphs.has(char) && matches(char, source)) {
          if (glyphs.size >= (requested ? 2048 : 512)) { warning(uiText("core.fontGlyphs.theCharacterListHasReachedThePreview")); return }
          glyphs.set(char, { char, font, provider: type, source, sourceLayer: entry.layer, width: 0, height: 0, ascent: 0, advance })
        }
        continue
      }
      if (type !== 'bitmap') { warning(uiText("core.fontGlyphs.thisFontProgramrCannotBeDrawn", type, source)); continue }
      if (typeof provider.file !== 'string' || !Array.isArray(provider.chars) || !provider.chars.length || provider.chars.some((row: unknown) => typeof row !== 'string')) { warning(uiText("core.fontGlyphs.bitmapFontParameterInvalid", source)); continue }
      const rows: string[][] = provider.chars.map(row => Array.from(row as string)), columns = rows[0].length
      if (!columns || rows.some(row => row.length !== columns) || rows.length * columns > 65536) { warning(uiText("core.fontGlyphs.fontCharsGridIrregularOrTooBig", source)); continue }
      scanned += rows.length * columns
      if (scanned > 131072) throw new Error(uiText("core.fontGlyphs.fontCharacterScannedMoreThanBudget"))
      const texture = assetPath(provider.file, 'textures', '')
      const selected = rows.flat().some(char => char !== '\0' && !glyphs.has(char) && matches(char, source, texture))
      if (!selected) continue
      const imageBytes = await reader.read(texture)
      if (!imageBytes) { warning(uiText("core.fontGlyphs.otherOrganiser", texture)); continue }
      assertPngDimensionsWithinLimit(imageBytes)
      const declaredPixels = new DataView(imageBytes.buffer, imageBytes.byteOffset, imageBytes.byteLength).getUint32(16) * new DataView(imageBytes.buffer, imageBytes.byteOffset, imageBytes.byteLength).getUint32(20)
      if (declaredPixels > 4 * 1024 * 1024) throw new Error(uiText("core.fontGlyphs.fontPasteMoreThanPixelsReadBudget"))
      const image = PNG.sync.read(Buffer.from(imageBytes)), cellWidth = image.width / columns, cellHeight = image.height / rows.length
      const height = provider.height === undefined ? 8 : typeof provider.height === 'number' ? provider.height : NaN, ascent = typeof provider.ascent === 'number' ? provider.ascent : NaN
      if (!Number.isInteger(cellWidth) || !Number.isInteger(cellHeight) || !cellWidth || !cellHeight || !Number.isInteger(height) || height <= 0 || height > 1024 || !Number.isInteger(ascent) || ascent > height || ascent < -1024) { warning(uiText("core.fontGlyphs.fontSizeOrAscentInvalid", source)); continue }
      for (let y = 0; y < rows.length; y++) for (let x = 0; x < columns; x++) {
        const char = rows[y][x]
        if (char === '\0' || glyphs.has(char) || !matches(char, source, texture)) continue
        if (glyphs.size >= (requested ? 2048 : 512)) { warning(uiText("core.fontGlyphs.theCharacterListHasReachedThePreview_439493")); return }
        pixels += cellWidth * cellHeight
        if (pixels > 4 * 1024 * 1024) throw new Error(uiText("core.fontGlyphs.fontPixelsExceedPreviewBudget"))
        const data = new Uint8Array(cellWidth * cellHeight * 4)
        let right = -1
        for (let cy = 0; cy < cellHeight; cy++) for (let cx = 0; cx < cellWidth; cx++) {
          const offset = ((y * cellHeight + cy) * image.width + x * cellWidth + cx) * 4
          data.set(image.data.subarray(offset, offset + 4), (cy * cellWidth + cx) * 4)
          if (image.data[offset + 3]) right = Math.max(right, cx)
        }
        glyphs.set(char, { char, font, provider: type, source, sourceLayer: entry.layer, texture, width: cellWidth * height / cellHeight, height, pixelWidth: cellWidth, pixelHeight: cellHeight, ascent, advance: Math.floor((right + 1) * height / cellHeight + 0.5) + 1, pixels: data.buffer })
      }
    }
  }
  try { await walk(font, new Set()) } catch (error) { warning(error instanceof Error ? error.message : String(error)) }
  return { glyphs: [...glyphs.values()], warnings, missingRootDefinition }
}
