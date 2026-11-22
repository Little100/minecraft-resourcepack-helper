import { uiText } from '../i18n/messages'
import { selectionMargin } from './selectionMargin'
import { recolorTransitions } from './edgeTransition'

export interface EdgeRecolorOptions {
  radius: number
  strength: number
  hueShift: number
  mode: 'bevel' | 'darken' | 'lighten' | 'transition'
  transitionSource: 'nearby' | 'mix'
  transitionSide: 'lighter' | 'darker' | 'both'
  transitionSteps: number
  light: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  colorEdges: boolean
  tolerance: number
  selectionBoundary: boolean
  selectionExpansion: number
  sampleOutside: boolean
  sampleMargin: number
  frameWidth?: number
  frameHeight?: number
}
export const DEFAULT_EDGE_RECOLOR: Readonly<EdgeRecolorOptions> = Object.freeze({ radius: 2, strength: 0.25, hueShift: 6, mode: 'bevel', light: 'top-left', colorEdges: false, tolerance: 48, selectionBoundary: true, transitionSource: 'nearby', transitionSide: 'lighter', transitionSteps: 2, selectionExpansion: 0, sampleOutside: true, sampleMargin: 1 })
export function edgeRecolorOptions(value: unknown): EdgeRecolorOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(uiText("core.edgeRecolor.versionallyHeavyColoredParametersInvalid"))
  const input = value as Record<string, unknown>, options = { ...DEFAULT_EDGE_RECOLOR, ...input } as EdgeRecolorOptions
  const allowed = new Set([...Object.keys(DEFAULT_EDGE_RECOLOR), 'frameWidth', 'frameHeight'])
  if (Object.keys(input).some(key => !allowed.has(key)) || !Number.isInteger(options.radius) || options.radius < 1 || options.radius > 32 || !Number.isFinite(options.strength) || options.strength < 0 || options.strength > 1 || !Number.isFinite(options.hueShift) || Math.abs(options.hueShift) > 60 || !['bevel', 'darken', 'lighten', 'transition'].includes(options.mode) || !['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(options.light) || typeof options.colorEdges !== 'boolean' || typeof options.selectionBoundary !== 'boolean' || !Number.isFinite(options.tolerance) || options.tolerance < 0 || options.tolerance > 255) throw new Error(uiText("core.edgeRecolor.improblemsForEdgeWidthColourOrLight"))
  if (!['nearby', 'mix'].includes(options.transitionSource) || !['lighter', 'darker', 'both'].includes(options.transitionSide) || !Number.isInteger(options.transitionSteps) || options.transitionSteps < 1 || options.transitionSteps > 8) throw new Error(uiText("core.edgeRecolor.invalidMidColourTransitionParameters"))
  if (!Number.isInteger(options.selectionExpansion) || options.selectionExpansion < 0 || options.selectionExpansion > 8 || typeof options.sampleOutside !== 'boolean' || !Number.isInteger(options.sampleMargin) || options.sampleMargin < 1 || options.sampleMargin > 4) throw new Error(uiText("core.edgeRecolor.invalidExteriorOrColourRangeOfThe"))
  for (const edge of [options.frameWidth, options.frameHeight]) if (edge !== undefined && (!Number.isInteger(edge) || edge < 1 || edge > 8192)) throw new Error(uiText("core.edgeRecolor.ejectColoredFrameSizeIsInvalid"))
  return options
}
function hue(rgb: number[], degrees: number): number[] {
  if (!degrees) return rgb
  const max = Math.max(...rgb), min = Math.min(...rgb), delta = max - min
  if (!delta) return rgb
  let h = (max === rgb[0] ? (rgb[1] - rgb[2]) / delta : max === rgb[1] ? 2 + (rgb[2] - rgb[0]) / delta : 4 + (rgb[0] - rgb[1]) / delta) * 60
  h = ((h + degrees) % 360 + 360) % 360 / 60
  const x = delta * (1 - Math.abs(h % 2 - 1)), sectors = [[delta, x, 0], [x, delta, 0], [0, delta, x], [0, x, delta], [x, 0, delta], [delta, 0, x]]
  return sectors[Math.floor(h)].map(channel => channel + min)
}

// 多源距离场沿轮廓向内衰减，每帧和每层独立计算且不改 Alpha
export function recolorEdges(pixels: Uint8Array, width: number, height: number, input: unknown, mask?: Uint8Array): Uint8Array {
  const options = edgeRecolorOptions(input), fw = options.frameWidth ?? width, fh = options.frameHeight ?? height
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 16_777_216 || pixels.length !== width * height * 4 || width % fw || height % fh || mask && mask.length !== width * height) throw new Error(uiText("core.edgeRecolor.impossibleImageOrConstituencySizeOnEdge"))
  mask = selectionMargin(mask, width, height, fw, fh, options.selectionExpansion)
  const samplingMask = selectionMargin(mask, width, height, fw, fh, options.sampleOutside ? options.sampleMargin : 0)
  if (options.mode === 'transition') return recolorTransitions(pixels, width, height, options, mask, samplingMask)
  const output = pixels.slice(), count = fw * fh, distance = new Uint8Array(count), lighting = new Int8Array(count), queue = new Uint32Array(count)
  const lx = options.light.endsWith('left') ? -Math.SQRT1_2 : Math.SQRT1_2, ly = options.light.startsWith('top') ? -Math.SQRT1_2 : Math.SQRT1_2
  const directions = [[-1, 0], [1, 0], [0, -1], [0, 1]]
  for (let fy = 0; fy < height; fy += fh) for (let fx = 0; fx < width; fx += fw) {
    distance.fill(0); lighting.fill(0)
    let head = 0, tail = 0
    const imageIndex = (x: number, y: number) => (fy + y) * width + fx + x
    const eligible = (x: number, y: number): boolean => { const index = imageIndex(x, y); return Boolean(pixels[index * 4 + 3] && (!options.selectionBoundary || !mask || mask[index])) }
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
      if (!eligible(x, y)) continue
      const source = imageIndex(x, y) * 4
      let nx = 0, ny = 0, edges = 0
      for (const [dx, dy] of directions) {
        const tx = x + dx, ty = y + dy
        let boundary = tx < 0 || ty < 0 || tx >= fw || ty >= fh
        if (!boundary) {
          const adjacent = imageIndex(tx, ty)
          boundary = !pixels[adjacent * 4 + 3] || Boolean(options.selectionBoundary && mask && !mask[adjacent])
          if (!boundary && options.colorEdges) boundary = Math.max(...[0, 1, 2].map(channel => Math.abs(pixels[source + channel] - pixels[adjacent * 4 + channel]))) > options.tolerance
        }
        if (boundary) { nx += dx; ny += dy; edges++ }
      }
      if (!edges) continue
      const index = y * fw + x, length = Math.hypot(nx, ny)
      distance[index] = 1; lighting[index] = Math.round((length ? (nx * lx + ny * ly) / length : -0.25) * 127); queue[tail++] = index
    }
    while (head < tail) {
      const index = queue[head++], step = distance[index]
      if (step >= options.radius) continue
      const x = index % fw, y = Math.floor(index / fw)
      for (const [dx, dy] of directions) {
        const tx = x + dx, ty = y + dy, next = ty * fw + tx
        if (tx < 0 || ty < 0 || tx >= fw || ty >= fh || distance[next] || !eligible(tx, ty)) continue
        distance[next] = step + 1; lighting[next] = lighting[index]; queue[tail++] = next
      }
    }
    for (let index = 0; index < count; index++) {
      if (!distance[index]) continue
      const sourceIndex = imageIndex(index % fw, Math.floor(index / fw)), offset = sourceIndex * 4
      if (mask && !mask[sourceIndex]) continue
      const falloff = (options.radius - distance[index] + 1) / options.radius
      const signed = options.mode === 'darken' ? -1 : options.mode === 'lighten' ? 1 : lighting[index] / 127
      const shade = signed * options.strength * falloff
      const adjusted = hue([pixels[offset], pixels[offset + 1], pixels[offset + 2]], options.hueShift * falloff * (signed < 0 ? -1 : 1))
      for (let channel = 0; channel < 3; channel++) output[offset + channel] = Math.max(0, Math.min(255, Math.round(shade >= 0 ? adjusted[channel] + (255 - adjusted[channel]) * shade : adjusted[channel] * (1 + shade))))
    }
  }
  return output
}
