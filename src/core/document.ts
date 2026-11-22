import { uiText } from '../i18n/messages'
import { MAX_PNG_EDGE, MAX_PNG_PIXELS } from './pixelGeometry'
export { MAX_PNG_EDGE, MAX_PNG_PIXELS } from './pixelGeometry'
import { markMcrhPixels } from './mcrhMark'
import { PNG } from 'pngjs'
import * as UPNG from 'upng-js'
import { isPng, stripFrameCount } from './frameSource'
import { cloneVariantLayer, variantLayers, type RandomVariant } from './randomVariants'

export interface PixelRect {
  x: number
  y: number
  width: number
  height: number
}

export interface Layer {
  randomVariant?: RandomVariant
  id: string
  name: string
  visible: boolean
  opacity: number
  pixels: Uint8Array
}

export interface DocumentSnapshot {
  frameHeight?: number
  width: number
  height: number
  activeLayerId?: string
  layers: Layer[]
}

export const DEFAULT_LAYER_NAME = uiText("core.document.background")

interface DecodedImage { width: number; height: number; data: Uint8Array }


// PNG 解码共用同一尺寸上限
function assertDecodedSize(width: number, height: number): void {
  if (width > MAX_PNG_EDGE || height > MAX_PNG_EDGE || width * height > MAX_PNG_PIXELS) {
    throw new Error(uiText("core.document.pasteSizeExceedingLimitDeclareAsX", width, height, MAX_PNG_EDGE, MAX_PNG_PIXELS))
  }
}

// pngjs 对交织 PNG 走无界的 zlib.inflateSync, 必须在解码前读 IHDR 挡住声明尺寸超限的解压炸弹
export function assertPngDimensionsWithinLimit(bytes: Uint8Array): void {
  if (!isPng(bytes)) throw new Error(uiText("core.document.couldNotParseThePngFileMay"))
  if (bytes.length < 24) throw new Error(uiText("core.document.couldNotParseThePngMissingFull"))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // 首块必须是 IHDR, 长度固定 13, 宽高分别位于偏移 16 与 20 的大端无符号整数
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) throw new Error(uiText("core.document.couldNotParseThePngMissingA"))
  assertDecodedSize(view.getUint32(16), view.getUint32(20))
}

// pngjs 读不出时改用 UPNG
function decodeRgba(bytes: Uint8Array): DecodedImage {
  // 解码前检查尺寸，避免分配过多内存
  assertPngDimensionsWithinLimit(bytes)
  try {
    const png = PNG.sync.read(Buffer.from(bytes))
    return { width: png.width, height: png.height, data: new Uint8Array(png.data) }
  } catch {
    const img = UPNG.decode(new Uint8Array(bytes).buffer)
    // 生成像素前核对解码得到的尺寸
    assertDecodedSize(img.width, img.height)
    const frames = UPNG.toRGBA8(img)
    const first = frames[0]
    if (!first || img.width <= 0 || img.height <= 0) throw new Error(uiText("core.document.couldNotParseThePngFileMay"))
    return { width: img.width, height: img.height, data: new Uint8Array(first) }
  }
}

let layerSeq = 0

export function newLayerId(): string {
  layerSeq += 1
  return `L${Date.now().toString(36)}${layerSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

// 矩形要有面积，且不能超出画布
export function isRectInside(rect: PixelRect, width: number, height: number): boolean {
  return Number.isInteger(rect.x) && Number.isInteger(rect.y) &&
    Number.isInteger(rect.width) && Number.isInteger(rect.height) &&
    rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0 &&
    rect.x + rect.width <= width && rect.y + rect.height <= height
}

export function frameCountOf(width: number, height: number): number {
  return width > 0 && height % width === 0 ? Math.max(1, stripFrameCount(width, height)) : 1
}

function isPositiveSize(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
}

export class PixelDocument {
  width: number
  height: number
  layers: Layer[] = []
  activeLayerId?: string
  frameHeight?: number
  historyText?: string

  private constructor(width: number, height: number) {
    this.width = width
    this.height = height
  }

  static create(width: number, height: number): PixelDocument {
    if (!isPositiveSize(width, height)) throw new Error(uiText("core.document.theCanvasMustHaveAPositiveInteger"))
    const doc = new PixelDocument(width, height)
    doc.insertLayer(0, DEFAULT_LAYER_NAME, new Uint8Array(width * height * 4))
    return doc
  }

  static fromPng(bytes: Uint8Array): PixelDocument {
    if (!bytes || bytes.length === 0) return PixelDocument.create(16, 16)
    const decoded = decodeRgba(bytes)
    const doc = new PixelDocument(decoded.width, decoded.height)
    doc.insertLayer(0, DEFAULT_LAYER_NAME, decoded.data)
    return doc
  }

  static fromLayers(width: number, height: number, layers: Layer[], activeLayerId?: string): PixelDocument {
    if (!isPositiveSize(width, height)) throw new Error(uiText("core.document.theCanvasMustHaveAPositiveInteger"))
    if (layers.length === 0) throw new Error(uiText("core.document.atLeastOneLayerIsRequiredFor"))
    const expected = width * height * 4
    if (layers.some(layer => layer.pixels.length !== expected)) throw new Error(uiText("core.document.layerPixelsDoesNotMatchTheCanvas"))
    const doc = new PixelDocument(width, height)
    doc.layers = layers.map(cloneVariantLayer)
    doc.activeLayerId = doc.layers.some(layer => layer.id === activeLayerId) ? activeLayerId : doc.layers[0].id
    return doc
  }

  get frameCount(): number {
    return this.frameHeight && this.height % this.frameHeight === 0 ? this.height / this.frameHeight : frameCountOf(this.width, this.height)
  }

  findLayer(id: string): Layer | undefined {
    return this.layers.find(layer => layer.id === id)
  }

  activeLayer(): Layer | undefined {
    return this.activeLayerId ? this.findLayer(this.activeLayerId) : this.layers[0]
  }

  insertLayer(index: number, name: string, pixels?: Uint8Array, id?: string): Layer {
    const layer: Layer = {
      id: id ?? newLayerId(),
      name,
      visible: true,
      opacity: 1,
      pixels: pixels ?? new Uint8Array(this.width * this.height * 4)
    }
    const at = Number.isFinite(index) ? Math.min(this.layers.length, Math.max(0, Math.trunc(index))) : this.layers.length
    this.layers.splice(at, 0, layer)
    this.activeLayerId ??= layer.id
    return layer
  }

  // 保留至少一个图层，删掉当前层时选中附近的层
  removeLayer(id: string): void {
    const index = this.indexOf(id)
    if (this.layers.length <= 1) throw new Error(uiText("core.document.keepAtLeastOneLayer"))
    this.layers.splice(index, 1)
    if (this.activeLayerId === id) this.activeLayerId = this.layers[Math.min(index, this.layers.length - 1)].id
  }

  moveLayer(id: string, toIndex: number): void {
    const index = this.indexOf(id)
    if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= this.layers.length) throw new Error(uiText("core.document.targetPositionCrossedTheLine"))
    const [layer] = this.layers.splice(index, 1)
    this.layers.splice(toIndex, 0, layer)
  }

  renameLayer(id: string, name: string): void {
    this.requireLayer(id).name = name
  }

  setVisible(id: string, visible: boolean): void {
    this.requireLayer(id).visible = visible
  }

  setOpacity(id: string, opacity: number): void {
    this.requireLayer(id).opacity = Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1
  }

  setActiveLayer(id: string): void {
    this.requireLayer(id)
    this.activeLayerId = id
  }

  readRect(layerId: string, rect: PixelRect): Uint8Array {
    const layer = this.requireLayer(layerId)
    if (!isRectInside(rect, this.width, this.height)) throw new Error(uiText("core.document.rectangleCrossed"))
    const out = new Uint8Array(rect.width * rect.height * 4)
    const rowBytes = rect.width * 4
    for (let row = 0; row < rect.height; row++) {
      const src = ((rect.y + row) * this.width + rect.x) * 4
      out.set(layer.pixels.subarray(src, src + rowBytes), row * rowBytes)
    }
    return out
  }

  // 把矩形像素写入图层, 像素长度必须与矩形面积一致
  writeRect(layerId: string, rect: PixelRect, pixels: Uint8Array): void {
    const layer = this.requireLayer(layerId)
    if (!isRectInside(rect, this.width, this.height)) throw new Error(uiText("core.document.rectangleCrossed"))
    const rowBytes = rect.width * 4
    if (pixels.length !== rowBytes * rect.height) throw new Error(uiText("core.document.pixelsDoNotMatchTheRectangle"))
    for (let row = 0; row < rect.height; row++) {
      const dst = ((rect.y + row) * this.width + rect.x) * 4
      layer.pixels.set(pixels.subarray(row * rowBytes, (row + 1) * rowBytes), dst)
    }
  }

  // 帧条从帧边界裁剪时保留完整帧，不足一帧或偏移裁剪作为单帧
  cropTo(rect: PixelRect): void {
    if (!isRectInside(rect, this.width, this.height)) throw new Error(uiText("core.document.cropRectangleCrosses"))
    const previousFrameHeight = this.frameHeight
    const frameHeight = previousFrameHeight ?? rect.width
    const preserveFrames = previousFrameHeight === undefined || this.frameCount > 1 && rect.y % previousFrameHeight === 0
    let height = rect.height
    if (preserveFrames && height >= frameHeight) height = Math.floor(height / frameHeight) * frameHeight
    this.layers = this.layers.map(layer => cropLayer(layer, this.width, rect.x, rect.y, rect.width, height))
    this.width = rect.width
    this.height = height
    if (previousFrameHeight !== undefined) this.frameHeight = preserveFrames && height % frameHeight === 0 ? frameHeight : height
  }

  snapshot(): DocumentSnapshot {
    return {
      width: this.width,
      height: this.height,
      frameHeight: this.frameHeight,
      activeLayerId: this.activeLayerId,
      layers: this.layers.map(cloneVariantLayer)
    }
  }

  restore(snapshot: DocumentSnapshot): void {
    if (!isPositiveSize(snapshot.width, snapshot.height)) throw new Error(uiText("core.document.theSizeIsIllegal"))
    if (snapshot.layers.length === 0) throw new Error(uiText("core.document.atLeastOneLayerIsRequiredFor_d2821d"))
    this.width = snapshot.width
    this.height = snapshot.height
    this.frameHeight = snapshot.frameHeight
    this.layers = snapshot.layers.map(cloneVariantLayer)
    const active = snapshot.activeLayerId
    this.activeLayerId = active !== undefined && this.findLayer(active) ? active : this.layers[0].id
  }

  // 颜色和透明度四舍五入，避免截断使合成图偏暗
  flatten(includeHidden = false, variantId?: string): Uint8Array {
    return this.compositeLayers(variantLayers(this.layers, variantId), includeHidden)
  }

  // 所选图层使用独立文档，保留层序、帧高与属性，不带入源文件的撤销历史
  extractLayers(layerIds: readonly string[], merge = false): PixelDocument {
    const layers = this.selectedLayers(layerIds)
    const result = merge ? PixelDocument.create(this.width, this.height) : PixelDocument.fromLayers(this.width, this.height, layers, this.activeLayerId)
    if (merge) {
      result.layers[0].name = uiText("core.document.mergeLayer")
      result.layers[0].pixels = this.compositeLayers(variantLayers(layers))
    }
    result.frameHeight = this.frameHeight
    return result
  }

  // 所选候选仍互斥，隐藏层不参与 PNG 合成
  flattenSelectedLayers(layerIds: readonly string[]): Uint8Array {
    return this.compositeLayers(variantLayers(this.selectedLayers(layerIds)))
  }

  private selectedLayers(layerIds: readonly string[]): Layer[] {
    if (!layerIds.length || layerIds.length > this.layers.length || new Set(layerIds).size !== layerIds.length || layerIds.some(id => !this.findLayer(id))) throw new Error(uiText("core.document.pleaseSelectAValidAndNonDuplicative"))
    const selected = new Set(layerIds)
    return this.layers.filter(layer => selected.has(layer.id))
  }

  private compositeLayers(layers: readonly Layer[], includeHidden = false): Uint8Array {
    const out = new Uint8Array(this.width * this.height * 4)
    for (let index = layers.length - 1; index >= 0; index--) {
      const layer = layers[index]
      if ((!includeHidden && !layer.visible) || layer.opacity <= 0) continue
      const a = layer.opacity
      for (let i = 0; i < out.length; i += 4) {
        const sa = (layer.pixels[i + 3] / 255) * a
        if (sa <= 0) continue
        const da = out[i + 3] / 255
        const oa = sa + da * (1 - sa)
        if (oa <= 0) continue
        out[i] = Math.round((layer.pixels[i] * sa + out[i] * da * (1 - sa)) / oa)
        out[i + 1] = Math.round((layer.pixels[i + 1] * sa + out[i + 1] * da * (1 - sa)) / oa)
        out[i + 2] = Math.round((layer.pixels[i + 2] * sa + out[i + 2] * da * (1 - sa)) / oa)
        out[i + 3] = Math.round(oa * 255)
      }
    }
    return out
  }

  toPng(mark = false): Buffer {
    return this.encodePng(this.flatten(), mark)
  }

  toPngLayers(layerIds: readonly string[], mark = false): Buffer {
    return this.encodePng(this.flattenSelectedLayers(layerIds), mark)
  }

  private encodePng(pixels: Uint8Array, mark: boolean): Buffer {
    const png = new PNG({ width: this.width, height: this.height })
    png.data.set(mark ? markMcrhPixels(this.width, this.height, pixels, this.frameHeight ?? (this.frameCount > 1 ? this.width : this.height)) : pixels)
    return PNG.sync.write(png)
  }

  private indexOf(id: string): number {
    const index = this.layers.findIndex(layer => layer.id === id)
    if (index < 0) throw new Error(uiText("core.document.unknownLayer", id))
    return index
  }

  private requireLayer(id: string): Layer {
    const layer = this.findLayer(id)
    if (!layer) throw new Error(uiText("core.document.unknownLayer", id))
    return layer
  }
}

function cropLayer(layer: Layer, sourceWidth: number, x: number, y: number, width: number, height: number): Layer {
  const pixels = new Uint8Array(width * height * 4)
  const rowBytes = width * 4
  for (let row = 0; row < height; row++) {
    const src = ((y + row) * sourceWidth + x) * 4
    pixels.set(layer.pixels.subarray(src, src + rowBytes), row * rowBytes)
  }
  return { ...layer, pixels }
}
