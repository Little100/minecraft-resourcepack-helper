import { uiText } from '../i18n/messages'
import { assertEditSize } from './pixelGeometry'
import { recolorEdges } from './edgeRecolor'

export interface RecolorLayer { pixels: Uint8Array; opacity: number }

// 在合成图上找边缘，只改参与合成的图层
export function recolorLayerComposite(layers: readonly RecolorLayer[], width: number, height: number, input: unknown, mask?: Uint8Array): Uint8Array[] {
  assertEditSize(width, height, Math.max(1, layers.length))
  if (!layers.length) return []
  const bytes = width * height * 4
  if (layers.some(layer => layer.pixels.length !== bytes || !Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1)) throw new Error(uiText("core.layerEdgeRecolor.theColoredLayerDataIsInvalid"))
  const composite = new Uint8Array(bytes)
  const weights = new Float64Array(layers.length)
  const sample = (offset: number): number => {
    let remaining = 1
    for (let index = 0; index < layers.length; index++) {
      const layer = layers[index], alpha = layer.pixels[offset + 3] / 255 * layer.opacity
      weights[index] = remaining * alpha; remaining *= 1 - alpha
    }
    return 1 - remaining
  }
  for (let offset = 0; offset < bytes; offset += 4) {
    const alpha = sample(offset)
    if (!alpha) continue
    for (let channel = 0; channel < 3; channel++) {
      let value = 0
      for (let index = 0; index < layers.length; index++) value += layers[index].pixels[offset + channel] * weights[index]
      composite[offset + channel] = Math.round(value / alpha)
    }
    composite[offset + 3] = Math.round(alpha * 255)
  }
  const adjusted = recolorEdges(composite, width, height, input, mask)
  const output = layers.map(layer => layer.pixels)
  for (let offset = 0; offset < bytes; offset += 4) {
    if (adjusted[offset] === composite[offset] && adjusted[offset + 1] === composite[offset + 1] && adjusted[offset + 2] === composite[offset + 2]) continue
    const alpha = sample(offset)
    if (!alpha) continue
    for (let channel = 0; channel < 3; channel++) {
      if (adjusted[offset + channel] === composite[offset + channel]) continue
      const target = adjusted[offset + channel]
      let original = 0
      for (let index = 0; index < layers.length; index++) original += layers[index].pixels[offset + channel] * weights[index] / alpha
      let delta = target - original
      if (layers.some((layer, index) => weights[index] > 0 && (layer.pixels[offset + channel] + delta < 0 || layer.pixels[offset + channel] + delta > 255))) {
        let low = -255, high = 255
        for (let step = 0; step < 16; step++) {
          delta = (low + high) / 2
          let value = 0
          for (let index = 0; index < layers.length; index++) value += Math.max(0, Math.min(255, layers[index].pixels[offset + channel] + delta)) * weights[index] / alpha
          if (value < target) low = delta; else high = delta
        }
        delta = (low + high) / 2
      }
      for (let index = 0; index < layers.length; index++) {
        if (!weights[index]) continue
        const source = layers[index].pixels, value = Math.max(0, Math.min(255, Math.round(source[offset + channel] + delta)))
        if (value === source[offset + channel]) continue
        if (output[index] === source) output[index] = source.slice()
        output[index][offset + channel] = value
      }
    }
  }
  return output
}
