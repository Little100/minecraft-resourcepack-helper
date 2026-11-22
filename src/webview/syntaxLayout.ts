export function fitWithin(width: number, height: number, edge: number): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= 0) return { width: 0, height: 0 }
  const scale = edge / longest
  return { width: width * scale, height: height * scale }
}
