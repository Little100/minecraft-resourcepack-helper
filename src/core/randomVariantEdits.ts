import { uiText } from '../i18n/messages'
import type { PixelDocument } from './document'
import { assertEditSize } from './pixelGeometry'
import { parseRandomVariant, type VariantEdit } from './randomVariants'

export function editRandomVariant(doc: PixelDocument, edit: VariantEdit): void {
  const layer = doc.findLayer(edit.layerId)
  if (!layer) throw new Error(uiText("core.randomVariantEdits.noLayerFound"))
  if (edit.action === 'duplicate') assertEditSize(doc.width, doc.height, doc.layers.length + 1)
  if (edit.action === 'disable') { delete layer.randomVariant; return }
  if (edit.action === 'weight') { layer.randomVariant = parseRandomVariant({ ...layer.randomVariant, weight: edit.weight }); return }
  if (!layer.randomVariant) layer.randomVariant = { weight: 1, base: !doc.layers.some(item => item.randomVariant) }
  if (edit.action === 'default') {
    for (const item of doc.layers) if (item.randomVariant) item.randomVariant = { ...item.randomVariant, base: item === layer }
  }
  if (edit.action === 'duplicate') {
    const duplicate = doc.insertLayer(doc.layers.indexOf(layer), (layer.name.slice(0, 32) + uiText("core.randomVariantEdits.variable")), new Uint8Array(layer.pixels))
    duplicate.opacity = layer.opacity
    duplicate.visible = true
    duplicate.randomVariant = { weight: layer.randomVariant.weight }
    doc.setActiveLayer(duplicate.id)
  }
}

