import type { EdgeRecolorOptions } from './edgeRecolor'

const DIRECTIONS = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const
const MAX_SAMPLE_RADIUS = 4
const colorDifference = (pixels: Uint8Array, a: number, b: number): number => Math.max(Math.abs(pixels[a] - pixels[b]), Math.abs(pixels[a + 1] - pixels[b + 1]), Math.abs(pixels[a + 2] - pixels[b + 2]))
const brightness = (pixels: Uint8Array, offset: number): number => pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722
function allowedSide(pixels: Uint8Array, a: number, b: number, side: EdgeRecolorOptions['transitionSide']): boolean {
  if (side === 'both') return true
  const difference = brightness(pixels, a) - brightness(pixels, b)
  return side === 'lighter' ? difference > 0 : difference < 0
}

// 附近取色只遍历两色范围内连通的非透明像素
function nearbyColor(pixels: Uint8Array, width: number, fx: number, fy: number, fw: number, fh: number, x: number, y: number, radius: number, a: number, b: number, target: readonly number[], visited: Uint8Array, queue: Uint8Array, samplingMask?: Uint8Array): number {
  const [r, g, blue] = target, diameter = radius * 2 + 1
  let result = r << 16 | g << 8 | blue
  let error = Math.min((r - pixels[a]) ** 2 + (g - pixels[a + 1]) ** 2 + (blue - pixels[a + 2]) ** 2, (r - pixels[b]) ** 2 + (g - pixels[b + 1]) ** 2 + (blue - pixels[b + 2]) ** 2) / 2
  const minR = Math.min(pixels[a], pixels[b]), maxR = Math.max(pixels[a], pixels[b]), minG = Math.min(pixels[a + 1], pixels[b + 1]), maxG = Math.max(pixels[a + 1], pixels[b + 1]), minB = Math.min(pixels[a + 2], pixels[b + 2]), maxB = Math.max(pixels[a + 2], pixels[b + 2])
  visited.fill(0)
  let head = 0, tail = 0
  const start = radius * diameter + radius
  queue[tail++] = start; visited[start] = 1
  while (head < tail) {
    const index = queue[head++], sx = index % diameter, sy = Math.floor(index / diameter)
    const offset = ((fy + y + sy - radius) * width + fx + x + sx - radius) * 4
    const cr = pixels[offset], cg = pixels[offset + 1], cb = pixels[offset + 2]
    const candidate = (cr - r) ** 2 + (cg - g) ** 2 + (cb - blue) ** 2
    if (candidate < error) { error = candidate; result = cr << 16 | cg << 8 | cb; if (!error) return result }
    for (const [dx, dy] of DIRECTIONS) {
      const tx = sx + dx, ty = sy + dy, px = x + tx - radius, py = y + ty - radius, next = ty * diameter + tx
      if (tx < 0 || ty < 0 || tx >= diameter || ty >= diameter || px < 0 || py < 0 || px >= fw || py >= fh || visited[next]) continue
      visited[next] = 1
      const other = ((fy + py) * width + fx + px) * 4
      if (samplingMask && !samplingMask[other / 4] || !pixels[other + 3] || pixels[other] < minR || pixels[other] > maxR || pixels[other + 1] < minG || pixels[other + 1] > maxG || pixels[other + 2] < minB || pixels[other + 2] > maxB) continue
      queue[tail++] = next
    }
  }
  return result
}

// 色带沿实际交界法线向内延伸，窄色块保留原色中心
export function recolorTransitions(pixels: Uint8Array, width: number, height: number, options: EdgeRecolorOptions, mask?: Uint8Array, samplingMask?: Uint8Array): Uint8Array {
  const output = pixels.slice()
  if (!options.strength) return output
  const fw = options.frameWidth ?? width, fh = options.frameHeight ?? height, count = fw * fh
  const distance = new Uint8Array(count), adjacent = new Uint32Array(count), contrast = new Uint8Array(count), bandWidth = new Uint8Array(count), contour = new Uint8Array(count)
  const sampleRadius = Math.min(MAX_SAMPLE_RADIUS, Math.max(2, options.radius)), sampleCount = (sampleRadius * 2 + 1) ** 2
  const visited = new Uint8Array(sampleCount), sampleQueue = new Uint8Array(sampleCount)
  for (let fy = 0; fy < height; fy += fh) for (let fx = 0; fx < width; fx += fw) {
    distance.fill(0); contrast.fill(0); contour.fill(0)
    const imageIndex = (x: number, y: number): number => (fy + y) * width + fx + x
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
      const source = imageIndex(x, y) * 4
      if (!pixels[source + 3]) continue
      for (const [dx, dy] of DIRECTIONS) {
        const tx = x + dx, ty = y + dy
        if (tx < 0 || ty < 0 || tx >= fw || ty >= fh) continue
        const neighbor = imageIndex(tx, ty), other = neighbor * 4
        if (!pixels[other + 3] || !allowedSide(pixels, source, other, options.transitionSide)) continue
        const difference = colorDifference(pixels, source, other)
        if (difference <= options.tolerance) continue
        let length = 0, opposed = false, shadedContour = false
        for (let step = 0; step <= options.radius * 2; step++) {
          const px = x - dx * step, py = y - dy * step
          if (px < 0 || py < 0 || px >= fw || py >= fh) break
          const offset = imageIndex(px, py) * 4
          if (!pixels[offset + 3]) break
          if (colorDifference(pixels, source, offset) > options.tolerance) {
            const previous = imageIndex(px + dx, py + dy) * 4
            opposed = colorDifference(pixels, previous, offset) > options.tolerance && allowedSide(pixels, previous, offset, options.transitionSide)
            shadedContour = options.transitionSide === 'lighter' && brightness(pixels, offset) > brightness(pixels, source)
            break
          }
          length++
        }
        // 向内接到更亮区域时保留已有暗色轮廓，避免其他方向重复染色
        if (shadedContour) { contour[y * fw + x] = 1; continue }
        const limit = Math.min(options.radius, opposed ? Math.floor((length - 1) / 2) : length - 1)
        for (let step = 1; step <= limit; step++) {
          const px = x - dx * (step - 1), py = y - dy * (step - 1), index = py * fw + px
          if (distance[index] && (distance[index] < step || distance[index] === step && contrast[index] >= difference)) continue
          distance[index] = step; adjacent[index] = neighbor; contrast[index] = difference; bandWidth[index] = limit
        }
      }
    }
    for (let index = 0; index < count; index++) {
      if (!distance[index] || contour[index]) continue
      const x = index % fw, y = Math.floor(index / fw), sourceIndex = imageIndex(x, y), source = sourceIndex * 4, other = adjacent[index] * 4
      if (mask && !mask[sourceIndex] || samplingMask && !samplingMask[other / 4] || !allowedSide(pixels, source, other, options.transitionSide) || colorDifference(pixels, source, other) <= options.tolerance) continue
      const band = Math.ceil((bandWidth[index] - distance[index] + 1) * options.transitionSteps / bandWidth[index]) / options.transitionSteps
      const mix = options.strength * band / 2
      const color = [0, 1, 2].map(channel => Math.round(pixels[source + channel] + (pixels[other + channel] - pixels[source + channel]) * mix))
      if (options.transitionSource === 'nearby') {
        const sampled = nearbyColor(pixels, width, fx, fy, fw, fh, x, y, sampleRadius, source, other, color, visited, sampleQueue, samplingMask)
        color[0] = sampled >>> 16; color[1] = sampled >>> 8 & 255; color[2] = sampled & 255
      }
      output[source] = color[0]; output[source + 1] = color[1]; output[source + 2] = color[2]
    }
  }
  return output
}
