import { uiText } from '../i18n/messages'
import { inspectReferenceImage } from '../core/referenceImageFormats'
import { referenceAbort } from '../core/referenceImages'

export async function decodeReferenceImage(blob: Blob, signal: AbortSignal, reserve?: (bytes: number) => void): Promise<ImageBitmap> {
  referenceAbort(signal)
  const buffer = await blob.arrayBuffer(), info = inspectReferenceImage(new Uint8Array(buffer))
  referenceAbort(signal)
  reserve?.(info.width * info.height * 4)
  let bitmap: ImageBitmap
  if (info.format === 'tiff') {
    const tiff = await import('utif'), image = tiff.decode(buffer)[0]
    if (!image || Number((image.t256 as number[])?.[0]) !== info.width || Number((image.t257 as number[])?.[0]) !== info.height) throw new Error(uiText("webview.referenceImageDecoder.tiffImageSizeInvalid"))
    const channels = (image.t277 as number[] | undefined)?.[0] ?? 1
    const depths = image.t258 as number[] | undefined
    if (channels < 1 || channels > 4 || depths?.some(value => value < 1 || value > 16)) throw new Error(uiText("webview.referenceImageDecoder.tiffColourChannelOrBitDeepNot"))
    referenceAbort(signal); tiff.decodeImage(buffer, image)
    const rgba = tiff.toRGBA8(image)
    if (rgba.length !== info.width * info.height * 4) throw new Error(uiText("webview.referenceImageDecoder.tiffPixelDataIncomplete"))
    bitmap = await createImageBitmap(new ImageData(Uint8ClampedArray.from(rgba), info.width, info.height))
  } else {
    try { bitmap = await createImageBitmap(new Blob([buffer], { type: info.mime })) }
    catch {
      const url = URL.createObjectURL(new Blob([buffer], { type: info.mime })), image = new Image()
      try { image.src = url; await image.decode(); referenceAbort(signal); bitmap = await createImageBitmap(image) }
      catch { referenceAbort(signal); throw new Error(uiText("webview.referenceImageDecoder.theCurrentEnvironmentCannotDecodePictureTry", info.format.toUpperCase())) }
      finally { image.src = ''; URL.revokeObjectURL(url) }
    }
  }
  if (signal.aborted) { bitmap.close(); referenceAbort(signal) }
  const rotated = info.orientation !== undefined && info.orientation >= 5 && info.orientation <= 8
  if (!(bitmap.width === info.width && bitmap.height === info.height || rotated && bitmap.width === info.height && bitmap.height === info.width)) { bitmap.close(); throw new Error(uiText("webview.referenceImageDecoder.referenceDiagramSizesNotMatched")) }
  return bitmap
}

export function pickReferencePixel(canvas: HTMLCanvasElement, event: PointerEvent, pick?: (color: [number, number, number, number]) => void): boolean {
  if (!pick || !event.altKey || event.button !== 0 || !canvas.width || !canvas.height) return false
  event.preventDefault(); event.stopPropagation()
  const bounds = canvas.getBoundingClientRect()
  const x = Math.floor((event.clientX - bounds.left) * canvas.width / bounds.width), y = Math.floor((event.clientY - bounds.top) * canvas.height / bounds.height)
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return true
  const rgba = canvas.getContext('2d')!.getImageData(x, y, 1, 1).data
  pick([rgba[0], rgba[1], rgba[2], rgba[3]])
  return true
}
