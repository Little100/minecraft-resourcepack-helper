import { uiText } from '../i18n/messages'
import { Inflate } from 'pako'

export class PngInspectionLimitError extends Error {}

// 在交给图像解码器前限制 IDAT 实际展开量，包含 Adam7 的所有扫描线
export function validatePngInflation(bytes: Uint8Array): void {
  if (bytes.length < 33) throw new Error(uiText("core.pngInflation.pngHeadHasBeenCutOff"))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16), height = view.getUint32(20), depth = bytes[24]!, type = bytes[25]!, interlace = bytes[28]!
  const channels = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]).get(type)
  const depths = type === 0 ? [1, 2, 4, 8, 16] : type === 3 ? [1, 2, 4, 8] : [8, 16]
  if (!channels || !depths.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || interlace > 1 || !width || !height) throw new Error(uiText("core.pngInflation.invalidPngPixelFormat"))
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]]
  let expected = 0
  const scanlines: { bytes: number; rows: number }[] = []
  for (const [x, y, dx, dy] of passes) {
    const columns = Math.max(0, Math.ceil((width - x!) / dx!)), rows = Math.max(0, Math.ceil((height - y!) / dy!))
    if (columns && rows) { const rowBytes = Math.ceil(columns * channels * depth / 8) + 1; expected += rowBytes * rows; scanlines.push({ bytes: rowBytes, rows }) }
  }
  if (!Number.isSafeInteger(expected) || expected > 128 * 1024 * 1024) throw new PngInspectionLimitError(uiText("core.pngInflation.pngExpandScanLinesOverMibCheck"))
  const chunks: Uint8Array[] = []
  let offset = 8, containerEnded = false
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error(uiText("core.pngInflation.pngDataBlockBlocked"))
    const length = view.getUint32(offset), end = offset + length + 12
    if (end > bytes.length) throw new Error(uiText("core.pngInflation.invalidPngDataBlockLength"))
    const kind = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (offset === 8 && (kind !== 'IHDR' || length !== 13) || kind === 'IHDR' && (offset !== 8 || length !== 13)) throw new Error(uiText("core.pngInflation.pngHeadersMustBeUniqueAndLocated"))
    if (kind === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length))
    offset = end
    if (kind === 'IEND') { if (length || end !== bytes.length) throw new Error(uiText("core.pngInflation.pngEndBlockInvalid")); containerEnded = true; break }
  }
  if (!containerEnded || !chunks.length) throw new Error(uiText("core.pngInflation.pngMissingIendOrIdat"))
  let actual = 0, pass = 0, rowOffset = 0, row = 0, adlerA = 1, adlerB = 0
  let ended = false
  const stream = new Inflate({ raw: true, chunkSize: 64 * 1024 })
  stream.onEnd = status => { if (status !== 0) throw new Error(uiText("core.pngInflation.pngImageCompressionStreamInvalid", stream.msg)); ended = true }
  stream.onData = chunk => {
    if (!(chunk instanceof Uint8Array)) throw new Error(uiText("core.pngInflation.pngDepressurizationTypeInvalid"))
    actual += chunk.length
    if (actual > expected) throw new Error(uiText("core.pngInflation.pngActualDecompressionExceedingScannerBudget"))
    for (let start = 0; start < chunk.length; start += 5552) {
      const end = Math.min(start + 5552, chunk.length)
      for (let index = start; index < end; index++) { adlerA += chunk[index]!; adlerB += adlerA }
      adlerA %= 65521; adlerB %= 65521
    }
    let cursor = 0
    while (cursor < chunk.length) {
      const current = scanlines[pass]!
      if (!rowOffset && chunk[cursor]! > 4) throw new Error(uiText("core.pngInflation.pngScanLineFilterTypeInvalid"))
      const count = Math.min(chunk.length - cursor, current.bytes - rowOffset)
      cursor += count; rowOffset += count
      if (rowOffset === current.bytes) { rowOffset = 0; if (++row === current.rows) { pass++; row = 0 } }
    }
  }
  const compressedBytes = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const byteAt = (position: number): number => { for (const chunk of chunks) { if (position < chunk.length) return chunk[position]!; position -= chunk.length }; throw new Error(uiText("core.pngInflation.pngZlibDataBlocked")) }
  if (compressedBytes < 7) throw new Error(uiText("core.pngInflation.pngZlibDataBlocked"))
  const cmf = byteAt(0), flags = byteAt(1)
  if ((cmf & 15) !== 8 || cmf >>> 4 > 7 || ((cmf << 8) + flags) % 31 || flags & 32) throw new Error(uiText("core.pngInflation.invalidPngZlibImageHeader"))
  const payloadEnd = compressedBytes - 4
  let position = 0
  for (const chunk of chunks) {
    let cursor = Math.max(0, 2 - position)
    const end = Math.min(chunk.length, payloadEnd - position)
    while (cursor < end) {
      const remaining = payloadEnd - position - cursor
      const count = Math.min(end - cursor, remaining > 1024 ? Math.min(1024, remaining - 1024) : 1)
      if (ended) throw new Error(uiText("core.pngInflation.pngContainsExcessDataAfterCompressionStream"))
      stream.push(chunk.subarray(cursor, cursor + count), position + cursor + count === payloadEnd)
      cursor += count
      if (ended && position + cursor !== payloadEnd) throw new Error(uiText("core.pngInflation.pngCompressionStreamContainsRedundantDataBetween"))
    }
    position += chunk.length
  }
  if (!ended) throw new Error(uiText("core.pngInflation.thePngImageCompressionStreamIsNot"))
  if (actual !== expected) throw new Error(uiText("core.pngInflation.pngActualScanningLineLengthUnmatched"))
  const trailer = new Uint8Array(4)
  let remaining = 4
  for (let index = chunks.length - 1; index >= 0 && remaining; index--) { const chunk = chunks[index]!, count = Math.min(remaining, chunk.length); remaining -= count; trailer.set(chunk.subarray(chunk.length - count), remaining) }
  if (remaining || new DataView(trailer.buffer).getUint32(0) !== ((adlerB << 16 | adlerA) >>> 0)) throw new Error(uiText("core.pngInflation.pngImageDataAdlerVerificationFailed"))
}
