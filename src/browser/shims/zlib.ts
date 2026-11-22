import { uiText } from '../../i18n/messages'
import { Inflate, Unzlib } from 'fflate'

interface InflateOptions { maxOutputLength?: number }
function decode(data: Uint8Array, options: InflateOptions = {}, raw = false): Buffer {
  const limit = options.maxOutputLength ?? 64 * 1024 * 1024
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512 * 1024 * 1024) throw new Error(uiText("browser.shims.zlib.theDepressiveOutputCapIsInvalid"))
  const chunks: Uint8Array[] = []
  let size = 0
  const Stream = raw ? Inflate : Unzlib
  const stream = new Stream(chunk => { size += chunk.length; if (size > limit) throw new Error(uiText("browser.shims.zlib.counterpressureOutputExceedingMaxoutputlength")); chunks.push(chunk.slice()) })
  for (let offset = 0; offset < data.length; offset += 4096) stream.push(data.subarray(offset, offset + 4096), offset + 4096 >= data.length)
  if (!data.length) stream.push(data, true)
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size)
}
export function inflateSync(data: Uint8Array, options?: InflateOptions): Buffer { return decode(data, options) }
export function inflateRawSync(data: Uint8Array, options?: InflateOptions): Buffer { return decode(data, options, true) }