import { el } from './dom'
import type { LayerBuffer } from './state'

const THUMB_SIZE = 28

// 所有缩略图共用一块离屏画布作为像素源, 避免每个图层各自分配一份缓冲
let scratch: HTMLCanvasElement | undefined

export function createThumb(): HTMLCanvasElement {
  const canvas = el('canvas', 'mp-thumb mp-checker')
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(THUMB_SIZE * dpr)
  canvas.height = Math.round(THUMB_SIZE * dpr)
  canvas.style.width = `${THUMB_SIZE}px`
  canvas.style.height = `${THUMB_SIZE}px`
  return canvas
}

export function paintThumb(canvas: HTMLCanvasElement, layer: LayerBuffer, width: number, frameHeight: number): void {
  const ctx = canvas.getContext('2d')
  if (!ctx || width <= 0 || frameHeight <= 0) return
  const source = sourceCanvas(width, frameHeight)
  const sourceCtx = source.getContext('2d')
  if (!sourceCtx) return
  const bytes = width * frameHeight * 4
  const view = new Uint8ClampedArray(layer.pixels.buffer as ArrayBuffer, layer.pixels.byteOffset, bytes)
  sourceCtx.putImageData(new ImageData(view, width, frameHeight), 0, 0)
  const scale = Math.min(canvas.width / width, canvas.height / frameHeight)
  const drawWidth = width * scale
  const drawHeight = frameHeight * scale
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  // 放大时关闭平滑以保持像素边缘, 缩小时开启平滑避免闪烁
  ctx.imageSmoothingEnabled = scale < 1
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, width, frameHeight, (canvas.width - drawWidth) / 2, (canvas.height - drawHeight) / 2, drawWidth, drawHeight)
}

function sourceCanvas(width: number, height: number): HTMLCanvasElement {
  if (!scratch) scratch = el('canvas')
  if (scratch.width !== width) scratch.width = width
  if (scratch.height !== height) scratch.height = height
  return scratch
}
