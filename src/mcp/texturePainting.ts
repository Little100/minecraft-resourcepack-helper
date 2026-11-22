import { uiText } from '../i18n/messages'
import { z } from 'zod'
import { PixelDocument } from '../core/document'
import { assertEditSize } from '../core/pixelGeometry'
import { applyPolygon, applyShape, polygonSelectionMask } from '../webview/painting'
import { rgbaSchema } from './contracts'

export const MAX_PIXEL_MATRIX_EDGE = 256
export const PIXEL_SYMBOLS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-'
const coordinate = z.number().int().min(0).max(8191)
const point = z.tuple([coordinate, coordinate])
const color = z.string().regex(/^[A-Za-z0-9_-]$/).describe(uiText("mcp.texturePainting.singleCharKeysInPalettesTransparentColors"))
const rectangle = { x: coordinate, y: coordinate, width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192) }
export const paintOperationsSchema = z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('matrix'), x: coordinate.default(0), y: coordinate.default(0), rows: z.array(z.string().min(1).max(MAX_PIXEL_MATRIX_EDGE).regex(/^[A-Za-z0-9_.-]+$/)).min(1).max(MAX_PIXEL_MATRIX_EDGE) }).strict(),
  z.object({ type: z.literal('rect'), ...rectangle, color, filled: z.boolean().default(true) }).strict(),
  z.object({ type: z.literal('ellipse'), ...rectangle, color, filled: z.boolean().default(true) }).strict(),
  z.object({ type: z.literal('line'), from: point, to: point, color, radius: z.number().int().min(0).max(8).default(0) }).strict(),
  z.object({ type: z.literal('polygon'), points: z.array(point).min(3).max(64), color, filled: z.boolean().default(true) }).strict()
])).min(1).max(128).describe(uiText("mcp.texturePainting.drawSequentiallyMatrixOneCharacterPerLine"))
export const paintPaletteSchema = z.record(z.string().regex(/^[A-Za-z0-9_-]$/), rgbaSchema).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= PIXEL_SYMBOLS.length, uiText("mcp.texturePainting.colourPaletteRequiresToColours")).describe(uiText("mcp.texturePainting.mapOfSingleCharactersToRG"))
type Operation = z.infer<typeof paintOperationsSchema>[number]
export interface TexturePainting { layer_id?: string; layer_name?: string; clear: boolean; palette: z.infer<typeof paintPaletteSchema>; operations: Operation[] }

// 所有绘图在独立副本中完成，任意命令无效时不修改编辑器
export function prepareTexturePainting(document: PixelDocument, input: TexturePainting): { document: PixelDocument; layerId: string } {
  if (Boolean(input.layer_id) === Boolean(input.layer_name)) throw new Error(uiText("mcp.texturePainting.pleaseProvideOnlyPlayerIdOrPlayer"))
  assertEditSize(document.width, document.height, document.layers.length + (input.layer_name ? 1 : 0))
  if (input.layer_name && document.layers.length >= 128) throw new Error(uiText("mcp.texturePainting.stageUpToMcpBudget"))
  const snapshot = document.snapshot(), next = PixelDocument.fromLayers(snapshot.width, snapshot.height, snapshot.layers, snapshot.activeLayerId)
  next.frameHeight = snapshot.frameHeight
  const layer = input.layer_id ? next.findLayer(input.layer_id) : next.insertLayer(0, input.layer_name!)
  if (!layer) throw new Error(uiText("mcp.texturePainting.stageDoesNotExistPleaseRereadThe"))
  next.setActiveLayer(layer.id)
  let budget = input.clear ? next.width * next.height : 0
  const charge = (amount: number): void => { budget += amount; if (budget > 1048576) throw new Error(uiText("mcp.texturePainting.singleDrawingsExceedMPixelBudgetPlease")) }
  const bounds = (x: number, y: number, width = 1, height = 1): void => { if (x + width > next.width || y + height > next.height) throw new Error(uiText("mcp.texturePainting.drawAreaExceedingTheOriginalCanvasAnd")) }
  const rgba = (key: string): [number, number, number, number] => { if (!Object.hasOwn(input.palette, key)) throw new Error(uiText("mcp.texturePainting.theUndefinedColourOfThePaletteIs", key)); return input.palette[key] }
  const put = (x: number, y: number, value: [number, number, number, number]): void => { layer.pixels.set(value, (y * next.width + x) * 4) }
  charge(0)
  if (input.clear) layer.pixels.fill(0)
  for (const operation of input.operations) {
    if (operation.type === 'matrix') {
      const width = operation.rows[0].length
      if (operation.rows.some(row => row.length !== width)) throw new Error(uiText("mcp.texturePainting.chartLinesMustBeKeptWideDot"))
      bounds(operation.x, operation.y, width, operation.rows.length); charge(width * operation.rows.length)
      for (const [y, row] of operation.rows.entries()) for (const [x, symbol] of [...row].entries()) if (symbol !== '.') put(operation.x + x, operation.y + y, rgba(symbol))
      continue
    }
    const value = rgba(operation.color)
    if (operation.type === 'line') {
      bounds(...operation.from); bounds(...operation.to)
      charge((Math.max(Math.abs(operation.to[0] - operation.from[0]), Math.abs(operation.to[1] - operation.from[1])) + 1) * (2 * operation.radius + 1) ** 2)
      applyShape(layer.pixels, next, 'line', operation.from, operation.to, operation.radius, value)
      continue
    }
    if (operation.type === 'polygon') {
      for (const p of operation.points) bounds(...p)
      const x = Math.min(...operation.points.map(p => p[0])), y = Math.min(...operation.points.map(p => p[1]))
      const width = Math.max(...operation.points.map(p => p[0])) - x + 1, height = Math.max(...operation.points.map(p => p[1])) - y + 1
      charge(width * height * operation.points.length)
      if (!operation.filled) applyPolygon(layer.pixels, next, operation.points, 0, value)
      else {
        const mask = polygonSelectionMask({ width, height }, operation.points.map(p => [p[0] - x, p[1] - y] as const))
        if (mask) for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) if (mask[py * width + px]) put(x + px, y + py, value)
      }
      continue
    }
    bounds(operation.x, operation.y, operation.width, operation.height); charge(operation.width * operation.height)
    if (!operation.filled && operation.type === 'rect') {
      applyShape(layer.pixels, next, operation.type, [operation.x, operation.y], [operation.x + operation.width - 1, operation.y + operation.height - 1], 0, value)
      continue
    }
    const inside = (x: number, y: number): boolean => ((x + .5 - operation.width / 2) / (operation.width / 2)) ** 2 + ((y + .5 - operation.height / 2) / (operation.height / 2)) ** 2 <= 1
    for (let y = 0; y < operation.height; y++) for (let x = 0; x < operation.width; x++) {
      if (operation.type === 'ellipse' && (!inside(x, y) || !operation.filled && inside(x - 1, y) && inside(x + 1, y) && inside(x, y - 1) && inside(x, y + 1))) continue
      put(operation.x + x, operation.y + y, value)
    }
  }
  return { document: next, layerId: layer.id }
}

export function encodePixelMatrix(pixels: Uint8Array, width: number, x: number, y: number, cropWidth: number, cropHeight: number) {
  if (cropWidth > MAX_PIXEL_MATRIX_EDGE || cropHeight > MAX_PIXEL_MATRIX_EDGE) return { available: false as const, reason: uiText("mcp.texturePainting.exactCharacterDrawingsAreTheMostUnilateral", MAX_PIXEL_MATRIX_EDGE) }
  if (cropWidth * cropHeight > 4096) return { available: false as const, reason: uiText("mcp.texturePainting.accurateCharactersCanReadUpToPixels") }
  const symbols = new Map<string, string>(), palette: Record<string, number[]> = {}, rows: string[] = []
  for (let py = 0; py < cropHeight; py++) {
    let row = ''
    for (let px = 0; px < cropWidth; px++) {
      const index = ((py + y) * width + px + x) * 4, color = Array.from(pixels.subarray(index, index + 4)), key = color.join(',')
      let symbol = symbols.get(key)
      if (symbol === undefined) {
        if (symbols.size >= PIXEL_SYMBOLS.length) return { available: false as const, reason: uiText("mcp.texturePainting.moreThanColoursReduceTheCroppingArea") }
        symbol = PIXEL_SYMBOLS[symbols.size]; symbols.set(key, symbol); palette[symbol] = color
      }
      row += symbol
    }
    rows.push(row)
  }
  return { available: true as const, x, y, palette, rows, note: uiText("mcp.texturePainting.coordinatesCorrespondToTheFullOriginalCanvas") }
}
