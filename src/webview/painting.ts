
export type Rgba = [number, number, number, number]

export interface CanvasSize {
  width: number
  height: number
}

export interface SelectionRect {
  x: number
  y: number
  width: number
  height: number
}

export type Shape = 'line' | 'rect' | 'ellipse'

export interface CompositeLayer {
  pixels: Uint8Array
  opacity: number
  visible: boolean
}

const MIN_PRESSURE = 0.2

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function stamp(
  pixels: Uint8Array,
  canvas: CanvasSize,
  x: number,
  y: number,
  radius: number,
  erase: boolean,
  rgba: Rgba
): void {
  forEachStampPixel(canvas, x, y, radius, (px, py) => {
    const i = (py * canvas.width + px) * 4
    if (erase) pixels.fill(0, i, i + 4)
    else pixels.set(rgba, i)
  })
}

// 预览与落笔共享相同圆形覆盖范围
export function forEachStampPixel(canvas: CanvasSize, x: number, y: number, radius: number, visit: (x: number, y: number) => void): void {
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    if (dx * dx + dy * dy > radius * radius) continue
    const px = x + dx, py = y + dy
    if (px >= 0 && py >= 0 && px < canvas.width && py < canvas.height) visit(px, py)
  }
}

export function strokeOn(
  target: Uint8Array,
  canvas: CanvasSize,
  from: [number, number],
  to: [number, number],
  radius: number,
  erase: boolean,
  rgba: Rgba
): void {
  for (const [x, y] of linePoints(from[0], from[1], to[0], to[1])) {
    stamp(target, canvas, x, y, radius, erase, rgba)
  }
}

export function applyShape(
  target: Uint8Array,
  canvas: CanvasSize,
  shape: Shape,
  origin: [number, number],
  head: [number, number],
  radius: number,
  rgba: Rgba,
  erase = false
): void {
  if (shape === 'line') {
    strokeOn(target, canvas, origin, head, radius, erase, rgba)
    return
  }
  if (shape === 'rect') {
    const x0 = Math.min(origin[0], head[0])
    const x1 = Math.max(origin[0], head[0])
    const y0 = Math.min(origin[1], head[1])
    const y1 = Math.max(origin[1], head[1])
    for (let x = x0; x <= x1; x++) {
      stamp(target, canvas, x, y0, radius, erase, rgba)
      stamp(target, canvas, x, y1, radius, erase, rgba)
    }
    for (let y = y0; y <= y1; y++) {
      stamp(target, canvas, x0, y, radius, erase, rgba)
      stamp(target, canvas, x1, y, radius, erase, rgba)
    }
    return
  }
  const rx = Math.max(1, Math.floor(Math.abs(head[0] - origin[0]) / 2))
  const ry = Math.max(1, Math.floor(Math.abs(head[1] - origin[1]) / 2))
  const cx = Math.round((origin[0] + head[0]) / 2)
  const cy = Math.round((origin[1] + head[1]) / 2)
  for (const [x, y] of ellipsePoints(cx, cy, rx, ry)) {
    stamp(target, canvas, x, y, radius, erase, rgba)
  }
}

// 把多边形轮廓描边到目标像素缓冲
export function applyPolygon(
  target: Uint8Array,
  canvas: CanvasSize,
  points: Array<[number, number]>,
  radius: number,
  rgba: Rgba
): void {
  if (points.length < 2) return
  for (let i = 0; i < points.length - 1; i++) {
    strokeOn(target, canvas, points[i], points[i + 1], radius, false, rgba)
  }
  if (points.length >= 3) strokeOn(target, canvas, points[points.length - 1], points[0], radius, false, rgba)
}

// 同一直线上的边按端点奇偶抵消, 保留合法自交路径的面积
function hasPolygonArea(points: ReadonlyArray<readonly [number, number]>): boolean {
  const lines: Array<{ x: number; y: number; dx: number; dy: number; heights: number[] }> = []
  for (let index = 0; index < points.length; index++) {
    const [x, y] = points[index], [nextX, nextY] = points[(index + 1) % points.length]
    const dx = nextX - x, dy = nextY - y
    if (dy === 0) continue
    let line = lines.find(item => item.dx * dy === dx * item.dy && item.dx * (y - item.y) === item.dy * (x - item.x))
    if (!line) {
      line = { x, y, dx, dy, heights: [] }
      lines.push(line)
    }
    line.heights.push(y, nextY)
  }
  for (const line of lines) {
    line.heights.sort((a, b) => a - b)
    for (let index = 0; index < line.heights.length; index += 2) {
      if (line.heights[index] !== line.heights[index + 1]) return true
    }
  }
  return false
}

// 以像素中心扫描闭合路径, 奇偶填充支持凹多边形与自交路径
export function polygonSelectionMask(canvas: CanvasSize, points: ReadonlyArray<readonly [number, number]>): Uint8Array | undefined {
  const { width, height } = canvas
  if (width <= 0 || height <= 0 || points.length < 3 || points.some(point => !point.every(Number.isFinite))) return undefined
  if (!hasPolygonArea(points)) return undefined
  const mask = new Uint8Array(width * height)
  let minY = height, maxY = -1
  for (const point of points) { minY = Math.min(minY, point[1]); maxY = Math.max(maxY, point[1]) }
  const epsilon = 1e-9
  const fill = (y: number, left: number, right: number): void => {
    const start = Math.max(0, Math.ceil(left - epsilon)), end = Math.min(width - 1, Math.floor(right + epsilon))
    if (start <= end) mask.fill(1, y * width + start, y * width + end + 1)
  }
  for (let y = Math.max(0, Math.ceil(minY)); y <= Math.min(height - 1, Math.floor(maxY)); y++) {
    const crossings: number[] = []
    for (let i = 0; i < points.length; i++) {
      const [ax, ay] = points[i], [bx, by] = points[(i + 1) % points.length]
      if (ay === by) {
        if (y === ay) fill(y, Math.min(ax, bx), Math.max(ax, bx))
        continue
      }
      if (y < Math.min(ay, by) || y > Math.max(ay, by)) continue
      const x = ax + (y - ay) * (bx - ax) / (by - ay)
      if (Math.abs(x - Math.round(x)) < epsilon) fill(y, Math.round(x), Math.round(x))
      if ((ay > y) !== (by > y)) crossings.push(x)
    }
    crossings.sort((a, b) => a - b)
    for (let i = 0; i + 1 < crossings.length; i += 2) fill(y, crossings[i], crossings[i + 1])
  }
  return mask.some(value => value === 1) ? mask : undefined
}

// 只读取数位笔压感，笔压为零时仍用最低值
export function pressureOf(event: { pointerType: string; pressure: number }): number {
  if (event.pointerType !== 'pen') return 1
  const pressure = event.pressure
  if (!Number.isFinite(pressure) || pressure <= 0) return MIN_PRESSURE
  return clamp(pressure, MIN_PRESSURE, 1)
}

export function brushRadius(size: number, event: { pointerType: string; pressure: number }): number {
  return Math.max(0, Math.floor((size * pressureOf(event)) / 2))
}

export function linePoints(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  const points: Array<[number, number]> = []
  let x = Math.round(x0)
  let y = Math.round(y0)
  const targetX = Math.round(x1)
  const targetY = Math.round(y1)
  const dx = Math.abs(targetX - x)
  const dy = Math.abs(targetY - y)
  const sx = x < targetX ? 1 : -1
  const sy = y < targetY ? 1 : -1
  let err = dx - dy
  for (;;) {
    points.push([x, y])
    if (x === targetX && y === targetY) break
    const e2 = 2 * err
    if (e2 > -dy) { err -= dy; x += sx }
    if (e2 < dx) { err += dx; y += sy }
  }
  return points
}

export function ellipsePoints(cx: number, cy: number, rx: number, ry: number): Array<[number, number]> {
  const seen = new Set<string>()
  const out: Array<[number, number]> = []
  const push = (x: number, y: number) => {
    const key = `${x},${y}`
    if (seen.has(key)) return
    seen.add(key)
    out.push([x, y])
  }
  let x = 0
  let y = Math.round(ry)
  const rx2 = rx * rx
  const ry2 = ry * ry
  let d1 = ry2 - rx2 * ry + rx2 / 4
  let dx = 2 * ry2 * x
  let dy = 2 * rx2 * y
  while (dx < dy) {
    push(cx + x, cy + y); push(cx - x, cy + y); push(cx + x, cy - y); push(cx - x, cy - y)
    x++
    if (d1 < 0) { d1 += 2 * ry2 * x + ry2 } else { y--; d1 += 2 * ry2 * x - 2 * rx2 * y + ry2 }
    dx = 2 * ry2 * x
    dy = 2 * rx2 * y
  }
  let d2 = ry2 * (x + 0.5) * (x + 0.5) + rx2 * (y - 1) * (y - 1) - rx2 * ry2
  while (y >= 0) {
    push(cx + x, cy + y); push(cx - x, cy + y); push(cx + x, cy - y); push(cx - x, cy - y)
    y--
    if (d2 > 0) { d2 += rx2 - 2 * rx2 * y } else { x++; d2 += rx2 - 2 * rx2 * y + 2 * ry2 * x }
  }
  return out
}
// 记录起点颜色的数值副本, 之后比较只读副本, 填充写入不会改变判定基准
function matcherAt(data: Uint8Array, pixel: number, tolerance: number): (candidate: number) => boolean {
  const i = pixel * 4
  const r = data[i]
  const g = data[i + 1]
  const b = data[i + 2]
  const a = data[i + 3]
  return candidate => {
    const j = candidate * 4
    return Math.abs(data[j] - r) <= tolerance &&
      Math.abs(data[j + 1] - g) <= tolerance &&
      Math.abs(data[j + 2] - b) <= tolerance &&
      Math.abs(data[j + 3] - a) <= tolerance
  }
}

function floodRegion(
  width: number,
  height: number,
  seedX: number,
  seedY: number,
  accept: (pixel: number) => boolean
): Uint8Array {
  const mask = new Uint8Array(width * height)
  const queued = new Uint8Array(width * height)
  const stack: number[] = []
  const enqueue = (pixel: number) => {
    if (queued[pixel] === 1) return
    queued[pixel] = 1
    stack.push(pixel)
  }
  enqueue(seedY * width + seedX)
  while (stack.length > 0) {
    const pixel = stack.pop()!
    if (!accept(pixel)) continue
    mask[pixel] = 1
    const x = pixel % width
    const y = (pixel - x) / width
    if (x > 0) enqueue(pixel - 1)
    if (x < width - 1) enqueue(pixel + 1)
    if (y > 0) enqueue(pixel - width)
    if (y < height - 1) enqueue(pixel + width)
  }
  return mask
}

export function floodFill(
  data: Uint8Array,
  width: number,
  height: number,
  startX: number,
  startY: number,
  fill: Rgba,
  tolerance = 0,
  limit?: Uint8Array
): SelectionRect | undefined {
  const sx = clamp(Math.round(startX), 0, width - 1)
  const sy = clamp(Math.round(startY), 0, height - 1)
  const matches = matcherAt(data, sy * width + sx, tolerance)
  const accept = limit ? (pixel: number) => limit[pixel] === 1 && matches(pixel) : matches
  const mask = floodRegion(width, height, sx, sy, accept)
  for (let p = 0; p < mask.length; p++) {
    if (mask[p] === 1) data.set(fill, p * 4)
  }
  return maskBounds(mask, width, height)
}

export function magicWandSelect(
  data: Uint8Array,
  width: number,
  height: number,
  startX: number,
  startY: number,
  tolerance: number,
  contiguous = true
): Uint8Array {
  const sx = clamp(Math.round(startX), 0, width - 1)
  const sy = clamp(Math.round(startY), 0, height - 1)
  const matches = matcherAt(data, sy * width + sx, tolerance)
  if (contiguous) return floodRegion(width, height, sx, sy, matches)
  const mask = new Uint8Array(width * height)
  for (let p = 0; p < mask.length; p++) {
    if (matches(p)) mask[p] = 1
  }
  return mask
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

export function cropPixels(
  pixels: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  rect: SelectionRect
): { pixels: Uint8Array; width: number; height: number } {
  const x0 = clamp(Math.min(rect.x, rect.x + rect.width), 0, sourceWidth - 1)
  const y0 = clamp(Math.min(rect.y, rect.y + rect.height), 0, sourceHeight - 1)
  const x1 = clamp(Math.max(rect.x, rect.x + rect.width), 0, sourceWidth)
  const y1 = clamp(Math.max(rect.y, rect.y + rect.height), 0, sourceHeight)
  const width = Math.max(1, x1 - x0)
  const height = Math.max(1, y1 - y0)
  const out = new Uint8Array(width * height * 4)
  const rowLen = Math.min(width, sourceWidth - x0) * 4
  for (let y = 0; y < Math.min(height, sourceHeight - y0); y++) {
    const src = ((y + y0) * sourceWidth + x0) * 4
    out.set(pixels.subarray(src, src + rowLen), y * width * 4)
  }
  return { pixels: out, width, height }
}

export function clearSelection(pixels: Uint8Array, width: number, mask: Uint8Array): void {
  if (width <= 0 || mask.length % width !== 0) return
  const count = Math.min(mask.length, Math.floor(pixels.length / 4))
  for (let p = 0; p < count; p++) {
    if (mask[p] === 1) pixels.fill(0, p * 4, p * 4 + 4)
  }
}

function boundsOf(width: number, height: number, isHit: (pixel: number) => boolean): SelectionRect | undefined {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let p = 0; p < width * height; p++) {
    if (!isHit(p)) continue
    const x = p % width
    const y = (p - x) / width
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  if (maxX < 0) return undefined
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

export function maskBounds(mask: Uint8Array, width: number, height: number): SelectionRect | undefined {
  return boundsOf(width, height, pixel => mask[pixel] === 1)
}

export function diffBounds(before: Uint8Array, after: Uint8Array, width: number): SelectionRect | undefined {
  const height = Math.floor(after.length / 4 / width)
  return boundsOf(width, height, pixel => {
    const i = pixel * 4
    return before[i] !== after[i] || before[i + 1] !== after[i + 1] ||
      before[i + 2] !== after[i + 2] || before[i + 3] !== after[i + 3]
  })
}

export function compositeAt(layers: readonly CompositeLayer[], width: number, x: number, y: number, override?: { layer: CompositeLayer; color: Rgba }): Rgba {
  const i = (y * width + x) * 4
  let r = 0
  let g = 0
  let b = 0
  let a = 0
  for (let k = layers.length - 1; k >= 0; k--) {
    const layer = layers[k]
    if (!layer.visible) continue
    const color = override?.layer === layer ? override.color : undefined
    const sourceAlpha = ((color ? color[3] : layer.pixels[i + 3]) / 255) * clamp01(layer.opacity)
    if (sourceAlpha <= 0) continue
    const outAlpha = sourceAlpha + a * (1 - sourceAlpha)
    r = ((color ? color[0] : layer.pixels[i]) * sourceAlpha + r * a * (1 - sourceAlpha)) / outAlpha
    g = ((color ? color[1] : layer.pixels[i + 1]) * sourceAlpha + g * a * (1 - sourceAlpha)) / outAlpha
    b = ((color ? color[2] : layer.pixels[i + 2]) * sourceAlpha + b * a * (1 - sourceAlpha)) / outAlpha
    a = outAlpha
  }
  return [Math.round(r), Math.round(g), Math.round(b), Math.round(a * 255)]
}
