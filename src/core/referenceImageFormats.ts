import { uiText } from '../i18n/messages'
import { imageSize } from 'image-size'
import { REFERENCE_LIMITS, inspectReferencePng, type ReferenceImageInfo } from './referenceImages'

export const REFERENCE_IMAGE_EXTENSIONS = ['png', 'apng', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'bmp', 'dib', 'avif', 'svg', 'ico', 'cur', 'tif', 'tiff', 'heic', 'heif', 'jxl', 'psd', 'tga', 'dds', 'ktx', 'pnm', 'pbm', 'pgm', 'ppm', 'icns', 'j2c', 'jp2']
export const REFERENCE_IMAGE_ACCEPT = 'image/*,' + REFERENCE_IMAGE_EXTENSIONS.map(value => '.' + value).join(',')
const mimeTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon', cur: 'image/x-icon', tiff: 'image/tiff', heif: 'image/heif', heic: 'image/heic', jxl: 'image/jxl', psd: 'image/vnd.adobe.photoshop', tga: 'image/x-tga' }
export interface ReferenceImageMetadata extends ReferenceImageInfo { mime: string; format: string; orientation?: number }

export function isReferenceImageName(name: string): boolean {
  return REFERENCE_IMAGE_EXTENSIONS.includes(name.split('.').pop()?.toLowerCase() ?? '')
}

export function inspectReferenceImage(bytes: Uint8Array): ReferenceImageMetadata {
  if (bytes.length < 8 || bytes.length > REFERENCE_LIMITS.fileBytes) throw new Error(uiText("core.referenceImageFormats.referenceFigureFileIsEmptyOrMore"))
  let size: ReturnType<typeof imageSize>
  try { size = imageSize(bytes) } catch { throw new Error(uiText("core.referenceImageFormats.couldNotRecognizeTheImageContentThe")) }
  const width = Math.ceil(size.width), height = Math.ceil(size.height)
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width > REFERENCE_LIMITS.dimension || height > REFERENCE_LIMITS.dimension || width * height > REFERENCE_LIMITS.pixels) throw new Error(uiText("core.referenceImageFormats.theSizeOfTheReferenceFigureCannot"))
  if (size.type === 'png') inspectReferencePng(bytes, true)
  return { width, height, mime: mimeTypes[size.type ?? ''] ?? 'application/octet-stream', format: size.type ?? '', orientation: size.orientation }
}
