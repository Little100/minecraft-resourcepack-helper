// 曼哈顿距离扩展选区，帧边界之间不传播
export function selectionMargin(mask: Uint8Array | undefined, width: number, height: number, frameWidth: number, frameHeight: number, radius: number): Uint8Array | undefined {
  if (!mask || !radius) return mask
  const output = mask.slice(), distance = new Uint8Array(frameWidth * frameHeight), limit = radius + 1
  for (let fy = 0; fy < height; fy += frameHeight) for (let fx = 0; fx < width; fx += frameWidth) {
    for (let y = 0; y < frameHeight; y++) for (let x = 0; x < frameWidth; x++) {
      const index = y * frameWidth + x, selected = mask[(fy + y) * width + fx + x]
      distance[index] = selected ? 0 : Math.min(limit, x ? distance[index - 1] + 1 : limit, y ? distance[index - frameWidth] + 1 : limit)
    }
    for (let y = frameHeight - 1; y >= 0; y--) for (let x = frameWidth - 1; x >= 0; x--) {
      const index = y * frameWidth + x
      distance[index] = Math.min(distance[index], x + 1 < frameWidth ? distance[index + 1] + 1 : limit, y + 1 < frameHeight ? distance[index + frameWidth] + 1 : limit)
      if (distance[index] <= radius) output[(fy + y) * width + fx + x] = 1
    }
  }
  return output
}
