export interface GuideAnchors { x: number[]; y: number[] }
export interface ActiveGuides { x?: number; y?: number }

// 只提取不透明轮廓的长线端点，内部色阶不作为对齐锚点
export function detectGuideAnchors(pixels: Uint8ClampedArray | Uint8Array, width: number, height: number): GuideAnchors {
  if (pixels.length !== width * height * 4 || width < 1 || height < 1) return { x: [], y: [] }
  const xs = new Map<number, number>(), ys = new Map<number, number>(), stride = Math.max(1, Math.ceil(width * height / 262144))
  const add = (scores: Map<number, number>, position: number, length: number): void => { scores.set(position, (scores.get(position) ?? 0) + Math.min(length, 64)) }
  const scan = (vertical: boolean): void => {
    const outer = vertical ? width : height, length = vertical ? height : width, scores = vertical ? ys : xs
    for (let row = 0; row < outer; row += stride) {
      const offset = (position: number): number => (vertical ? position * width + row : row * width + position) * 4
      let start = 0
      while (start < length) {
        const first = offset(start)
        if (pixels[first + 3] <= 16) { start++; continue }
        let end = start + 1
        while (end < length && pixels[offset(end) + 3] > 16) end++
        if (end - start >= 3) { add(scores, start, end - start); add(scores, end - 1, end - start) }
        start = end
      }
    }
  }
  scan(false); scan(true)
  const best = (scores: Map<number, number>): number[] => [...scores].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 128).map(([position]) => position)
  return { x: best(xs), y: best(ys) }
}

export function nearbyGuides(anchors: GuideAnchors, x: number, y: number, tolerance: number): ActiveGuides {
  const nearest = (values: number[], point: number): number | undefined => {
    let found: number | undefined, distance = tolerance + 1e-9
    for (const value of values) { const next = Math.abs(value - point); if (next < distance) { found = value; distance = next } }
    return found
  }
  return { x: nearest(anchors.x, x), y: nearest(anchors.y, y) }
}

export interface GuideMeasurement { axis: 'x' | 'y'; from: number; to: number; at: number; pixels: number }

// 量取光标像素中心到相邻锚点的距离，帧内坐标不受缩放影响
export function guideMeasurements(anchors: GuideAnchors, guides: ActiveGuides, x: number, y: number, width: number, height: number): GuideMeasurement[] {
  const result: GuideMeasurement[] = []
  const spans = (axis: 'x' | 'y', positions: number[], point: number, at: number, maximum: number): void => {
    const values = [...new Set([0, maximum - 1, ...positions])].filter(value => Number.isFinite(value) && value >= 0 && value < maximum).sort((a, b) => a - b)
    const before = values.filter(value => value < point).at(-1), after = values.find(value => value > point)
    for (const target of [before, after]) if (target !== undefined) result.push({ axis, from: Math.min(target, point), to: Math.max(target, point), at, pixels: Math.abs(target - point) })
  }
  if (guides.y !== undefined) spans('x', anchors.x, x, y, width)
  if (guides.x !== undefined) spans('y', anchors.y, y, x, height)
  return result
}
