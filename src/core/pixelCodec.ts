import { uiText } from '../i18n/messages'
import { createHash } from 'crypto'
import type { Layer } from './document'
import { parseRandomVariant, type RandomVariant } from './randomVariants'

export interface LayerRecord {
  randomVariant?: RandomVariant
  id: string
  name: string
  visible: boolean
  opacity: number
  width: number
  height: number
  data: string
}

export const LAYER_NAME_MAX = 40

export function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]'
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function encodeLayer(layer: Layer, width: number, height: number): LayerRecord {
  return {
    randomVariant: parseRandomVariant(layer.randomVariant),
    id: layer.id,
    name: layer.name,
    visible: layer.visible,
    opacity: layer.opacity,
    width,
    height,
    data: Buffer.from(layer.pixels).toString('base64')
  }
}

export function decodeLayers(records: unknown, width: number, height: number): Layer[] {
  if (!Array.isArray(records) || records.length === 0) throw new Error(uiText("core.pixelCodec.layerListIsEmpty"))
  const seen = new Set<string>()
  const expected = width * height * 4
  return records.map((raw: unknown): Layer => {
    const record = raw as Partial<LayerRecord>
    if (typeof record.id !== 'string' || record.id.length === 0 || seen.has(record.id)) throw new Error(uiText("core.pixelCodec.layerIdIllegalOrDuplicate"))
    seen.add(record.id)
    if (typeof record.name !== 'string' || record.name.trim().length === 0 || record.name.length > LAYER_NAME_MAX) {
      throw new Error(uiText("core.pixelCodec.layerNameInvalid"))
    }
    if (typeof record.visible !== 'boolean') throw new Error(uiText("core.pixelCodec.layerVisibilityInvalid"))
    if (typeof record.opacity !== 'number' || !Number.isFinite(record.opacity) || record.opacity < 0 || record.opacity > 1) {
      throw new Error(uiText("core.pixelCodec.theLayerIsNotTransparent"))
    }
    if (record.width !== width || record.height !== height) throw new Error(uiText("core.pixelCodec.layerSizesDonTMatchCanvas"))
    if (typeof record.data !== 'string') throw new Error(uiText("core.pixelCodec.layerDataMissing"))
    const pixels = new Uint8Array(Buffer.from(record.data, 'base64'))
    if (pixels.length !== expected) throw new Error(uiText("core.pixelCodec.layerDataLengthDoesNotMatchCanvas"))
    return { id: record.id, name: record.name, visible: record.visible, opacity: record.opacity, pixels, randomVariant: parseRandomVariant(record.randomVariant) }
  })
}
