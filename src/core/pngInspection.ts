import { uiText } from '../i18n/messages'
import { validatePngInflation } from './pngInflation'

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0)
  return value >>> 0
})

// 流式检查资源 PNG 的结构、校验和与扫描线，不分配整张 RGBA 图像
export function inspectResourcePng(bytes: Uint8Array): void {
  if (bytes.length < 33 || !SIGNATURE.every((value, index) => bytes[index] === value)) throw new Error(uiText("core.pngInspection.invalidSignatureOfPngFileOrBlocked"))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16), height = view.getUint32(20), type = bytes[25]!, depth = bytes[24]!
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) throw new Error(uiText("core.pngInspection.pngDeclaresThatTheDimensionsAreInvalid"))
  let offset = 8, palette = 0, data = false, dataClosed = false, ended = false, transparency = false
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error(uiText("core.pngInflation.pngDataBlockBlocked"))
    const length = view.getUint32(offset), end = offset + 12 + length
    if (length > 0x7fffffff || end > bytes.length) throw new Error(uiText("core.pngInflation.invalidPngDataBlockLength"))
    const kind = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (!/^[A-Za-z]{4}$/.test(kind) || kind[2] !== kind[2]!.toUpperCase()) throw new Error(uiText("core.pngInspection.invalidPngBlockType"))
    let crc = 0xffffffff
    for (let index = offset + 4; index < end - 4; index++) crc = CRC_TABLE[(crc ^ bytes[index]!) & 255]! ^ crc >>> 8
    if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(end - 4)) throw new Error(uiText("core.pngInspection.pngDataBlockCrcVerificationFailed", kind))
    if (offset === 8 && (kind !== 'IHDR' || length !== 13) || kind === 'IHDR' && (offset !== 8 || length !== 13)) throw new Error(uiText("core.pngInflation.pngHeadersMustBeUniqueAndLocated"))
    if (kind === 'PLTE') {
      if (palette || data || transparency || type === 0 || type === 4 || !length || length % 3 || length > 768 || type === 3 && length / 3 > 2 ** depth) throw new Error(uiText("core.pngInspection.pngPaletteInvalidOrSequencingError"))
      palette = length / 3
    } else if (kind === 'tRNS') {
      if (transparency || data || type === 3 && (!palette || !length || length > palette) || type === 0 && length !== 2 || type === 2 && length !== 6 || type === 4 || type === 6) throw new Error(uiText("core.pngInspection.pngTransparencyChannelDefinitionInvalid"))
      transparency = true
    } else if (kind === 'IDAT') {
      if (dataClosed || type === 3 && !palette) throw new Error(uiText("core.pngInspection.pngImageDataOrderOrPaletteInvalid"))
      data = true
    } else if (data) dataClosed = true
    if (!['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(kind) && kind[0] === kind[0]!.toUpperCase()) throw new Error(uiText("core.pngInspection.pngContainsUnknownKeyDataBlocks", kind))
    if (kind === 'IEND') {
      if (length || end !== bytes.length || !data) throw new Error(uiText("core.pngInspection.pngEndBlockInvalidOrImageData"))
      ended = true; break
    }
    offset = end
  }
  if (!ended) throw new Error(uiText("core.pngInspection.pngMissingEndBlock"))
  validatePngInflation(bytes)
}
