import { uiText } from '../i18n/messages'
export const REFERENCE_LIMITS = Object.freeze({
  fileBytes: 16 * 1024 * 1024,
  dimension: 8192,
  pixels: 16 * 1024 * 1024,
  pageSize: 20,
  batchSize: 128,
  cacheEntries: 2,
  cacheBytes: 96 * 1024 * 1024
})

export interface ReferenceLayout { x: number; y: number; width: number; hidden: boolean; locked: boolean; pinned: boolean }
export interface ReferenceEntry { id: string; name: string; size: number; layout?: ReferenceLayout }
export interface ReferenceImageInfo { width: number; height: number }
export type ReferenceKind = 'files' | 'folder'
export interface ReferenceSource {
  restore?(signal: AbortSignal, receive: (entries: ReferenceEntry[]) => void): Promise<void>
  saveLayout?(id: string, layout: ReferenceLayout): void
  append(kind: ReferenceKind, signal: AbortSignal, receive: (entries: ReferenceEntry[]) => void): Promise<number>
  read(id: string, signal: AbortSignal): Promise<Blob>
  remove(id: string): void
  clear(): void
  dispose(): void
}
export interface ReferenceRequest {
  command: 'referenceImages'
  requestId: string
  operation: 'choose' | 'read' | 'remove' | 'clear' | 'cancel' | 'dispose' | 'restore' | 'layout'
  layout?: ReferenceLayout
  token?: string
  kind?: ReferenceKind
  id?: string
  target?: string
}
export interface ReferenceReply {
  command: 'referenceImagesResult'
  requestId: string
  done: boolean
  token?: string
  entries?: ReferenceEntry[]
  skipped?: number
  base64?: string
  error?: string
}

export function referenceAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException(uiText("core.referenceImages.referenceDiagramOperationCancelled"), 'AbortError')
}

const signature = [137, 80, 78, 71, 13, 10, 26, 10]
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  return crc >>> 0
})
function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff
  for (let index = start; index < end; index++) crc = crcTable[(crc ^ bytes[index]) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

// 检查 PNG 容器与尺寸，不展开压缩像素
export function inspectReferencePng(bytes: Uint8Array, allowAnimation = false): ReferenceImageInfo {
  if (bytes.byteLength < 57 || bytes.byteLength > REFERENCE_LIMITS.fileBytes || !signature.every((value, index) => bytes[index] === value)) throw new Error(uiText("core.referenceImages.referenceDiagramsMustBeValidPngAnd"))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8, width = 0, height = 0, color = -1, depth = 0, palette = false, data = false, endedData = false
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset), end = offset + length + 12
    if (end > bytes.length) throw new Error(uiText("core.referenceImages.pngDataBlockIncomplete"))
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (!/^[A-Za-z]{4}$/.test(type) || (bytes[offset + 6] & 32) || crc32(bytes, offset + 4, end - 4) !== view.getUint32(end - 4)) throw new Error(uiText("core.referenceImages.pngDataBlockOrCrcVerificationFailed"))
    if (offset === 8 && type !== 'IHDR') throw new Error(uiText("core.referenceImages.pngMissingHeader"))
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) throw new Error(uiText("core.referenceImages.pngHeaderInvalid"))
      width = view.getUint32(offset + 8); height = view.getUint32(offset + 12)
      depth = bytes[offset + 16]; color = bytes[offset + 17]
      const validDepths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
      if (!width || !height || width > REFERENCE_LIMITS.dimension || height > REFERENCE_LIMITS.dimension || width * height > REFERENCE_LIMITS.pixels) throw new Error(uiText("core.referenceImageFormats.theSizeOfTheReferenceFigureCannot"))
      if (!validDepths[color]?.includes(depth) || bytes[offset + 18] || bytes[offset + 19] || bytes[offset + 20] > 1) throw new Error(uiText("core.referenceImages.invalidPngEncodingParameter"))
    } else if (type === 'PLTE') {
      if (palette || data || color === 0 || color === 4 || !length || length % 3 || length > 768 || (color === 3 && length / 3 > 2 ** depth)) throw new Error(uiText("core.referenceImages.pngPaletteInvalid"))
      palette = true
    } else if (type === 'IDAT') {
      if (endedData || (color === 3 && !palette)) throw new Error(uiText("core.referenceImages.pngDataOrderInvalid"))
      data = true
    } else if (type === 'IEND') {
      if (length || !data || end !== bytes.length) throw new Error(uiText("core.pngInflation.pngEndBlockInvalid"))
      return { width, height }
    } else {
      if (!allowAnimation && (type === 'acTL' || type === 'fcTL' || type === 'fdAT')) throw new Error(uiText("core.referenceImages.theReferencePanelOnlyAcceptsStaticPng"))
      if (!(bytes[offset + 4] & 32)) throw new Error(uiText("core.referenceImages.pngContainsUnsupportedKeyBlocks"))
    }
    if (data && type !== 'IDAT') endedData = true
    offset = end
  }
  throw new Error(uiText("core.pngInspection.pngMissingEndBlock"))
}

export class ReferenceCache<T extends { bytes: number; dispose(): void }> {
  private readonly entries = new Map<string, T>()
  private used = 0
  constructor(private readonly limit = REFERENCE_LIMITS.cacheBytes, private readonly count = REFERENCE_LIMITS.cacheEntries) {}
  get(id: string): T | undefined {
    const value = this.entries.get(id)
    if (value) { this.entries.delete(id); this.entries.set(id, value) }
    return value
  }
  reserve(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > this.limit) throw new Error(uiText("core.referenceImages.referenceFigureExceedsPreviewMemoryLimit"))
    while (this.entries.size && (this.entries.size >= this.count || this.used + bytes > this.limit)) this.delete(this.entries.keys().next().value!)
  }
  set(id: string, value: T): void {
    this.delete(id)
    if (value.bytes > this.limit) { value.dispose(); throw new Error(uiText("core.referenceImages.referenceFigureExceedsPreviewMemoryLimit")) }
    this.reserve(value.bytes)
    this.entries.set(id, value); this.used += value.bytes
  }
  delete(id: string): void {
    const value = this.entries.get(id)
    if (!value) return
    this.entries.delete(id); this.used -= value.bytes; value.dispose()
  }
  clear(): void { for (const id of this.entries.keys()) this.delete(id) }
  get size(): number { return this.entries.size }
  get bytes(): number { return this.used }
}
