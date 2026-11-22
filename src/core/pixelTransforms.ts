import { uiText } from '../i18n/messages'
import { newLayerId, type DocumentSnapshot } from './document'
import { assertEditSize, placePixels, scalePixels } from './pixelGeometry'
export { EDIT_PIXEL_BUDGET, assertEditSize, placePixels, scalePixels } from './pixelGeometry'

export function resizeSnapshot(snapshot: DocumentSnapshot, width: number, height: number, scale: boolean): DocumentSnapshot {
  assertEditSize(width, height, snapshot.layers.length)
  return { ...snapshot, width, height, frameHeight: height, layers: snapshot.layers.map(layer => ({
    ...layer,
    pixels: scale ? scalePixels(layer.pixels, snapshot.width, snapshot.height, width, height) : placePixels(layer.pixels, snapshot.width, snapshot.height, width, height, 0, 0)
  })) }
}

export function snapshotFrameHeight(snapshot: DocumentSnapshot): number {
  const height = snapshot.frameHeight ?? (snapshot.height % snapshot.width === 0 ? Math.min(snapshot.width, snapshot.height) : snapshot.height)
  if (!Number.isSafeInteger(height) || height < 1 || snapshot.height % height) throw new Error(uiText("core.pixelTransforms.currentSingleFrameHeightInvalid"))
  return height
}

export function resizeAnimatedSnapshot(snapshot: DocumentSnapshot, width: number, frameHeight: number, scale: boolean): DocumentSnapshot {
  const sourceHeight = snapshotFrameHeight(snapshot), count = snapshot.height / sourceHeight
  const height = frameHeight * count
  assertEditSize(width, height, snapshot.layers.length)
  assertEditSize(width, frameHeight)
  const frameBytes = snapshot.width * sourceHeight * 4, outputBytes = width * frameHeight * 4
  return { ...snapshot, width, height, frameHeight, layers: snapshot.layers.map(layer => {
    const pixels = new Uint8Array(width * height * 4)
    for (let index = 0; index < count; index++) {
      const frame = layer.pixels.subarray(index * frameBytes, (index + 1) * frameBytes)
      const resized = scale ? scalePixels(frame, snapshot.width, sourceHeight, width, frameHeight) : placePixels(frame, snapshot.width, sourceHeight, width, frameHeight, 0, 0)
      pixels.set(resized, index * outputBytes)
    }
    return { ...layer, pixels }
  }) }
}

export function arrangeFrames(snapshot: DocumentSnapshot, frameHeight: number, order: number[]): DocumentSnapshot {
  if (!Number.isSafeInteger(frameHeight) || frameHeight < 1 || snapshot.height % frameHeight || !order.length || order.some(index => !Number.isSafeInteger(index) || index < -1 || index >= snapshot.height / frameHeight)) throw new Error(uiText("core.pixelTransforms.faceSizeOrFrameOrderInvalid"))
  const height = frameHeight * order.length
  assertEditSize(snapshot.width, height, snapshot.layers.length)
  const frameBytes = snapshot.width * frameHeight * 4
  return { ...snapshot, height, frameHeight, layers: snapshot.layers.map(layer => {
    const pixels = new Uint8Array(frameBytes * order.length)
    order.forEach((index, position) => { if (index >= 0) pixels.set(layer.pixels.subarray(index * frameBytes, (index + 1) * frameBytes), position * frameBytes) })
    return { ...layer, pixels }
  }) }
}

export function transformLayers(snapshot: DocumentSnapshot, layerIds: string[], x: number, y: number, width: number, height: number, rotation = 0): DocumentSnapshot {
  assertEditSize(snapshot.width, snapshot.height, snapshot.layers.length)
  const selected = new Set(layerIds)
  if (!selected.size || selected.size !== layerIds.length || layerIds.some(id => typeof id !== 'string' || !snapshot.layers.some(layer => layer.id === id))) throw new Error(uiText("core.document.pleaseSelectAValidAndNonDuplicative"))
  return { ...snapshot, layers: snapshot.layers.map(layer => selected.has(layer.id) ? {
    ...layer,
    pixels: placePixels(layer.pixels, snapshot.width, snapshot.height, snapshot.width, snapshot.height, x, y, width, height, rotation)
  } : layer) }
}

export function insertPixels(snapshot: DocumentSnapshot, source: Uint8Array, sw: number, sh: number, x: number, y: number, width: number, height: number, name: string, rotation = 0): DocumentSnapshot {
  assertEditSize(snapshot.width, snapshot.height, snapshot.layers.length + 1)
  const pixels = placePixels(source, sw, sh, snapshot.width, snapshot.height, x, y, width, height, rotation), id = newLayerId()
  return { ...snapshot, activeLayerId: id, layers: [{ id, name: name.trim().slice(0, 40) || uiText("core.pixelTransforms.importLayer"), visible: true, opacity: 1, pixels }, ...snapshot.layers] }
}
