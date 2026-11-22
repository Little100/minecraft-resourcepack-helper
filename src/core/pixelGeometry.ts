import { uiText } from '../i18n/messages'
export const MAX_PNG_EDGE = 8192
export const MAX_PNG_PIXELS = MAX_PNG_EDGE * MAX_PNG_EDGE
export const EDIT_PIXEL_BUDGET = Math.min(MAX_PNG_PIXELS, 16_777_216)

export function assertEditSize(width: number, height: number, layers = 1): void {
  if (![width, height, layers].every(Number.isSafeInteger) || width < 1 || height < 1 || layers < 1 || width > MAX_PNG_EDGE || height > MAX_PNG_EDGE || width * height * layers > EDIT_PIXEL_BUDGET) throw new Error(uiText("core.pixelGeometry.sizeOrLayerTotalPixelsExceedEditorial"))
}

export function scalePixels(pixels: Uint8Array, sw: number, sh: number, width: number, height: number): Uint8Array {
  assertEditSize(width, height)
  assertEditSize(sw, sh)
  if (pixels.length !== sw * sh * 4) throw new Error(uiText("core.pixelGeometry.sourcePixelLengthInvalid"))
  const output = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = (Math.min(sh - 1, Math.floor(y * sh / height)) * sw + Math.min(sw - 1, Math.floor(x * sw / width))) * 4
    output.set(pixels.subarray(source, source + 4), (y * width + x) * 4)
  }
  return output
}

// 只采样画布内的最近邻像素，移动已有图层不会占用新增图层预算
export function placePixels(source: Uint8Array, sw: number, sh: number, canvasWidth: number, canvasHeight: number, x: number, y: number, width = sw, height = sh, rotation = 0): Uint8Array {
  assertEditSize(canvasWidth, canvasHeight)
  assertEditSize(sw, sh)
  assertEditSize(width, height)
  if (source.length !== sw * sh * 4) throw new Error(uiText("core.pixelGeometry.sourcePixelLengthInvalid"))
  if (![x, y].every(Number.isSafeInteger) || Math.abs(x) > MAX_PNG_EDGE || Math.abs(y) > MAX_PNG_EDGE) throw new Error(uiText("core.pixelGeometry.theLayerPositionIsInvalid"))
  if (!Number.isFinite(rotation)) throw new Error(uiText("core.pixelGeometry.theRotationAngleMustBeALimited"))
  if (rotation % 360 !== 0) return rotatePlacedPixels(source, sw, sh, canvasWidth, canvasHeight, x, y, width, height, rotation)
  const pixels = new Uint8Array(canvasWidth * canvasHeight * 4)
  const x0 = Math.max(0, x), y0 = Math.max(0, y)
  const x1 = Math.min(canvasWidth, x + width), y1 = Math.min(canvasHeight, y + height)
  for (let dy = y0; dy < y1; dy++) for (let dx = x0; dx < x1; dx++) {
    const sx = Math.floor((dx - x) * sw / width), sy = Math.floor((dy - y) * sh / height)
    const index = (sy * sw + sx) * 4
    pixels.set(source.subarray(index, index + 4), (dy * canvasWidth + dx) * 4)
  }
  return pixels
}

export function rotatedBounds(x: number, y: number, width: number, height: number, rotation: number): { x: number; y: number; width: number; height: number } {
  if (!Number.isFinite(rotation)) throw new Error(uiText("core.pixelGeometry.theRotationAngleMustBeALimited"))
  const { cosine, sine } = rotationComponents(rotation)
  const w = Math.abs(cosine) * width + Math.abs(sine) * height, h = Math.abs(sine) * width + Math.abs(cosine) * height
  return { x: x + (width - w) / 2, y: y + (height - h) / 2, width: w, height: h }
}

function rotationComponents(rotation: number): { cosine: number; sine: number } {
  const radians = (rotation % 360) * Math.PI / 180
  const snap = (value: number): number => Math.abs(value) < 1e-12 ? 0 : Math.abs(Math.abs(value) - 1) < 1e-12 ? Math.sign(value) : value
  return { cosine: snap(Math.cos(radians)), sine: snap(Math.sin(radians)) }
}

// 逆向采样保留像素硬边，正角度绕变换矩形中心顺时针旋转
function rotatePlacedPixels(source: Uint8Array, sw: number, sh: number, cw: number, ch: number, x: number, y: number, width: number, height: number, rotation: number): Uint8Array {
  const pixels = new Uint8Array(cw * ch * 4), { cosine, sine } = rotationComponents(rotation)
  const bounds = rotatedBounds(x, y, width, height, rotation), cx = x + width / 2, cy = y + height / 2
  const x0 = Math.max(0, Math.floor(bounds.x)), y0 = Math.max(0, Math.floor(bounds.y))
  const x1 = Math.min(cw, Math.ceil(bounds.x + bounds.width)), y1 = Math.min(ch, Math.ceil(bounds.y + bounds.height))
  for (let dy = y0; dy < y1; dy++) for (let dx = x0; dx < x1; dx++) {
    const rx = dx + .5 - cx, ry = dy + .5 - cy
    const u = cosine * rx + sine * ry + width / 2, v = -sine * rx + cosine * ry + height / 2
    const sx = Math.floor(u * sw / width + 1e-10), sy = Math.floor(v * sh / height + 1e-10)
    if (sx < 0 || sx >= sw || sy < 0 || sy >= sh) continue
    const index = (sy * sw + sx) * 4
    pixels.set(source.subarray(index, index + 4), (dy * cw + dx) * 4)
  }
  return pixels
}
