import { uiText } from '../i18n/messages'
import { PNG } from 'pngjs'

export interface BrowserFile { path: string; content: string | Uint8Array }
export const FILE_LIMIT = 32 * 1024 * 1024
export const ARCHIVE_LIMIT = 384 * 1024 * 1024
export const textEncoder = new TextEncoder()
export const textDecoder = new TextDecoder('utf-8', { fatal: true })
export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
export const fileName = (path: string): string => path.split('/').at(-1) || 'resource'

export async function readFile(file: File, limit = FILE_LIMIT): Promise<Uint8Array> {
  if (!file.size || file.size > limit) throw new Error(uiText("browser.files.fileIsEmptyOrAboveTheSize", Math.round(limit / 1024 / 1024)))
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length > limit) throw new Error(uiText("browser.files.fileInExcessOfSizeLimit"))
  return bytes
}

export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = accept; input.multiple = multiple; input.hidden = true
    document.body.append(input)
    const finish = (files: File[]) => { input.remove(); resolve(files) }
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])), { once: true })
    input.addEventListener('cancel', () => finish([]), { once: true })
    input.click()
  })
}

export function decodePng(bytes: Uint8Array, maxPixels = 4 * 1024 * 1024): PNG {
  const buffer = Buffer.from(bytes)
  if (buffer.length < 33 || buffer.length > FILE_LIMIT || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error(uiText("browser.files.pleaseSelectAValidPngFile"))
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20)
  if (!width || !height || width > 4096 || height > 4096 || width * height > maxPixels) throw new Error(uiText("browser.files.pngIsTooBig"))
  return PNG.sync.read(buffer, { checkCRC: true })
}

export function encodePng(width: number, height: number, data: Uint8Array): Uint8Array {
  const image = new PNG({ width, height }); image.data.set(data)
  return PNG.sync.write(image)
}

export function imageUrl(bytes: Uint8Array): string { return 'data:image/png;base64,' + Buffer.from(bytes).toString('base64') }

export function download(bytes: Uint8Array | string, name: string, mime = 'application/octet-stream'): void {
  const content = typeof bytes === 'string' ? textEncoder.encode(bytes) : bytes
  const url = URL.createObjectURL(new Blob([Uint8Array.from(content)], { type: mime }))
  const link = document.createElement('a'); link.href = url; link.download = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
  document.body.append(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

export function yieldToBrowser(): Promise<void> { return new Promise(resolve => setTimeout(resolve, 0)) }