import { uiText } from '../i18n/messages'
import { inflateRawSync } from 'node:zlib'

export interface ZipEntry {
  name: string
  /** 未压缩数据 */
  data: Buffer
}

export interface ZipReadOptions {
  /** 返回 true 的条目才会解压, 省略时解压全部条目 */
  keep?: (name: string) => boolean
}

export interface ZipReadResult {
  entries: ZipEntry[]
  /** 因加密, 损坏或超限而未能解压的条目名 */
  failed: string[]
}

// 单个条目解压后的体积上限, 正常贴图与语言文件都远小于该值, 借此拦截压缩炸弹避免解压时耗尽内存
const MAX_ENTRY_SIZE = 256 * 1024 * 1024

const ZIP64_MARKER = 0xffffffff

// 中央目录签名, 条目循环与条目数上限判断共用
const CENTRAL_SIGNATURE = 0x02014b50

// 兼容旧调用返回条目数组, 需要失败统计时改用 readZipDetailed
export function readZip(buffer: Buffer, options?: ZipReadOptions): ZipEntry[] {
  return readZipDetailed(buffer, options).entries
}

export function readZipDetailed(buffer: Buffer, options?: ZipReadOptions): ZipReadResult {
  const eocd = findEndOfCentralDirectory(buffer)
  if (eocd < 0) throw new Error(uiText("core.zip.notAValidZipFile"))

  // 条目数超过 65535 时 eocd 存的是上限值, 此时靠签名失配结束循环
  const declared = buffer.readUInt16LE(eocd + 10)
  const limit = declared === 0xffff ? Number.MAX_SAFE_INTEGER : declared
  let offset = readOffset(buffer, eocd + 16, uiText("core.zip.centralDirectoryStartingPosition"))
  const entries: ZipEntry[] = []
  const failed: string[] = []

  for (let index = 0; index < limit; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = readOffset(buffer, offset + 20, uiText("core.zip.entriesCompressedSize"))
    const uncompressedSize = readOffset(buffer, offset + 24, uiText("core.zip.entryDepressionSize"))
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = readOffset(buffer, offset + 42, uiText("core.zip.localHeaderPositionOfEntries"))
    const name = decodeName(buffer, offset + 46, nameLength, flags)

    collect(buffer, { name, flags, method, compressedSize, uncompressedSize, localOffset }, options, entries, failed)

    offset += 46 + nameLength + extraLength + commentLength
  }

  return { entries, failed }
}

function collect(
  buffer: Buffer,
  meta: { name: string; flags: number; method: number; compressedSize: number; uncompressedSize: number; localOffset: number },
  options: ZipReadOptions | undefined,
  entries: ZipEntry[],
  failed: string[]
): void {
  if (meta.name.endsWith('/')) return
  if (options?.keep && !options.keep(meta.name)) return

  if ((meta.flags & 0x0001) !== 0) {
    failed.push(meta.name)
    return
  }

  if (meta.uncompressedSize > MAX_ENTRY_SIZE) {
    failed.push(meta.name)
    return
  }

  try {
    const raw = readEntryData(buffer, meta.localOffset, meta.compressedSize)
    const data = meta.method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_SIZE })
    // 解压后复核实际长度, 声明与实际不符或超出上限都判为失败
    if (data.length > MAX_ENTRY_SIZE) {
      failed.push(meta.name)
      return
    }
    entries.push({ name: meta.name, data })
  } catch {
    // 单个条目损坏不应中断整包解析
    failed.push(meta.name)
  }
}

// 按中央目录给出的压缩大小与本地头长度定位数据区, 长度越界或本地头缺失都视为不可解压
function readEntryData(buffer: Buffer, localOffset: number, compressedSize: number): Buffer {
  if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new Error(uiText("core.zip.localFileHeaderMissing"))
  }
  const localNameLength = buffer.readUInt16LE(localOffset + 26)
  const localExtraLength = buffer.readUInt16LE(localOffset + 28)
  const dataStart = localOffset + 30 + localNameLength + localExtraLength
  if (dataStart + compressedSize > buffer.length) throw new Error(uiText("core.zip.entryDataCrossed"))
  return buffer.subarray(dataStart, dataStart + compressedSize)
}

// 位 11 置位表示文件名按 UTF-8 编码, 未置位时按 latin1 解码避免 GBK 等文件名乱码
function decodeName(buffer: Buffer, start: number, length: number, flags: number): string {
  const raw = buffer.subarray(start, start + length)
  return raw.toString((flags & 0x0800) !== 0 ? 'utf8' : 'latin1')
}

function readOffset(buffer: Buffer, position: number, label: string): number {
  const value = buffer.readUInt32LE(position)
  if (value === ZIP64_MARKER) throw new Error(uiText("core.zip.zip64UnableToParseTheCompressionPackage", label))
  return value
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06])
  for (let index = buffer.length - 22; index >= 0; index--) {
    if (buffer.compare(signature, 0, 4, index, index + 4) === 0) return index
  }
  return -1
}

export function filterByPrefix(entries: ZipEntry[], prefix: string): ZipEntry[] {
  const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`
  return entries.filter(entry => entry.name.startsWith(normalized))
}
