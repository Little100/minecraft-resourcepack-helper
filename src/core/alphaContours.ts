export interface ContourSpan { axis: 0 | 1; sign: -1 | 1; cell: number; start: number; end: number; value: number }

// 仅合并非透明区域与透明区域之间的相邻边，数值变化只影响侧面贴图来源
export function* edgeSpans(width: number, height: number, edgeAt: (x: number, y: number, axis: 0 | 1, sign: -1 | 1) => number): Generator<ContourSpan> {
  for (const axis of [1, 0] as const) for (const sign of [-1, 1] as const) {
    const normal = axis === 0 ? width : height, tangent = axis === 0 ? height : width
    for (let cell = 0; cell < normal; cell++) {
      let start = 0, active = 0
      for (let offset = 0; offset <= tangent; offset++) {
        const x = axis === 0 ? cell : offset, y = axis === 0 ? offset : cell
        const value = offset < tangent ? edgeAt(x, y, axis, sign) : 0
        if (value === active) continue
        if (active) yield { axis, sign, cell, start, end: offset, value: active }
        start = offset; active = value
      }
    }
  }
}

export function contourSpans(width: number, height: number, mask: ArrayLike<number>): Generator<ContourSpan> {
  return edgeSpans(width, height, (x, y, axis, sign) => {
    const nx = x + (axis === 0 ? sign : 0), ny = y + (axis === 1 ? sign : 0)
    return nx < 0 || nx >= width || ny < 0 || ny >= height || !mask[ny * width + nx] ? mask[y * width + x]! : 0
  })
}

export interface MaskRectangle { x0: number; y0: number; x1: number; y1: number }

// 合并连续同宽行段，仅覆盖外露区域，不按颜色拆分内部像素
export function* maskRectangles(width: number, height: number, mask: ArrayLike<number>): Generator<MaskRectangle> {
  let active = new Map<string, MaskRectangle>()
  for (let y = 0; y <= height; y++) {
    const next = new Map<string, MaskRectangle>()
    for (let x = 0; y < height && x < width;) {
      if (!mask[y * width + x]) { x++; continue }
      const x0 = x
      while (x < width && mask[y * width + x]) x++
      const key = x0 + ':' + x, previous = active.get(key)
      next.set(key, previous ? { ...previous, y1: y + 1 } : { x0, y0: y, x1: x, y1: y + 1 })
      active.delete(key)
    }
    yield* active.values()
    active = next
  }
}
