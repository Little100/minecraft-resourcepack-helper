import { uiText } from '../../i18n/messages'
import { inflateSync } from 'node:zlib'
import { PNG } from 'pngjs'

const MAX_PNG_BYTES = 32 * 1024 * 1024
const MAX_PIXELS = 4 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export function decodeTexturePng(input: Uint8Array, name = uiText("core.advanced.pngCodec.paste"), maxPixels = MAX_PIXELS): PNG {
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > 16_777_216) throw new Error(uiText("core.advanced.pngCodec.pngPixelBudgetInvalid"))
  if (!(input instanceof Uint8Array) || input.byteLength < 33 || input.byteLength > MAX_PNG_BYTES) {
    throw new Error(uiText("core.advanced.pngCodec.mustBeAValidPngFileSize", name))
  }
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(8) !== 13) {
    throw new Error(uiText("core.advanced.pngCodec.notAValidPng", name))
  }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (!width || !height || width > 4096 || height > 4096 || width * height > maxPixels) {
    throw new Error(uiText("core.advanced.pngCodec.oversizeUnilateralCapAndTotalPixelCeiling", name, maxPixels))
  }
  let offset = 8
  let ended = false, paletteEntries = 0, transparency = false, chunks = 0
  const idat: Buffer[] = []
  while (offset + 12 <= bytes.length) {
    if (++chunks > 16384) throw new Error(uiText("core.advanced.pngCodec.pngBlocksExceededBudget", name))
    const size = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if (size > bytes.length - offset - 12) throw new Error(uiText("core.advanced.pngCodec.pngBlockSBeenCutOff", name))
    if (type === 'IHDR' && offset !== 8) throw new Error(uiText("core.advanced.pngCodec.pngIncludesRepeatIhdr", name))
    if (type === 'PLTE') {
      if (paletteEntries || size < 3 || size > 768 || size % 3 || bytes[25] === 0 || bytes[25] === 4 || idat.length) throw new Error(uiText("core.advanced.pngCodec.pngPaletteInvalid", name))
      paletteEntries = size / 3
      if (bytes[25] === 3 && paletteEntries > 2 ** bytes[24]) throw new Error(uiText("core.advanced.pngCodec.pngPaletteBeyondBitDepth", name))
    }
    if (type === 'tRNS') {
      const colorType = bytes[25]
      if (transparency || idat.length || (colorType === 3 ? !paletteEntries || size < 1 || size > paletteEntries : colorType === 0 ? size !== 2 : colorType === 2 ? size !== 6 : true)) throw new Error(uiText("core.advanced.pngCodec.thePngTransparencyTableIsInvalid", name))
      transparency = true
    }
    if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + size))
    if (type === 'acTL') throw new Error(uiText("core.advanced.pngCodec.noApngPleaseProvideASingleFrame", name))
    offset += size + 12
    if (type === 'IEND') {
      if (size !== 0) throw new Error(uiText("core.advanced.pngCodec.iendIsInvalidForPng", name))
      ended = true
      break
    }
  }
  if (!ended || offset !== bytes.length) throw new Error(uiText("core.advanced.pngCodec.pngLacksCompleteIendOrContainsTailing", name))
  try {
    if (bytes[28] === 1) inflateSync(Buffer.concat(idat), { maxOutputLength: width * height * 8 + height * 7 + 64 })
    return PNG.sync.read(bytes, { checkCRC: true })
  } catch (error) {
    throw new Error(uiText("core.advanced.pngCodec.pngDecodeFailed", name, error instanceof Error ? error.message : String(error)))
  }
}

