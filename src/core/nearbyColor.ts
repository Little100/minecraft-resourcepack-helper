import { uiText } from '../i18n/messages'
export type NearbyRgba = readonly [number, number, number, number]

// 用共同明暗偏移保持主色，只加入少量通道差异
export function nearbyColor(color: NearbyRgba, range: number, random: () => number = Math.random): [number, number, number, number] {
  const amplitude = Number.isFinite(range) ? Math.max(0, Math.min(64, range)) : 0
  const shared = (random() * 2 - 1) * amplitude * .8
  const channel = (value: number): number => Math.max(0, Math.min(255, Math.round(value + shared + (random() * 2 - 1) * amplitude * .2)))
  return [channel(color[0]), channel(color[1]), channel(color[2]), color[3]]
}

// 每个符合条件的像素只抽样一次，避免重复坐标偏置和额外索引缓冲
export function scatterNearby(pixels: Uint8Array, color: NearbyRgba, range: number, density: number, mask?: Uint8Array, opaqueOnly = true, random: () => number = Math.random): number {
  if (pixels.length % 4 || (mask && mask.length !== pixels.length / 4)) throw new Error(uiText("core.nearbyColor.randomPixelsOrConstituencySizeNotMatched"))
  const probability = Number.isFinite(density) ? Math.max(0, Math.min(100, density)) / 100 : 0
  if (!probability) return 0
  let count = 0
  for (let index = 0; index < pixels.length / 4; index++) {
    if ((mask && !mask[index]) || (opaqueOnly && !pixels[index * 4 + 3]) || random() >= probability) continue
    pixels.set(nearbyColor(color, range, random), index * 4)
    count++
  }
  return count
}

// 字符种子生成稳定随机序列，便于反复比较和复现打点
export function seededRandom(seed: string): () => number {
  let value = 2166136261
  for (let index = 0; index < seed.length; index++) value = Math.imul(value ^ seed.charCodeAt(index), 16777619)
  return () => {
    value = (value + 0x6D2B79F5) | 0
    let mixed = Math.imul(value ^ value >>> 15, value | 1)
    mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, mixed | 61)
    return ((mixed ^ mixed >>> 14) >>> 0) / 4294967296
  }
}
