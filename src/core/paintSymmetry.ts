export type SymmetryMode = 'x' | 'y' | 'origin'

// 坐标使用像素中心，动画条带始终围绕当前帧中心对称
export function symmetryPoint(x: number, y: number, width: number, frameHeight: number, mode: SymmetryMode): [number, number] {
  const top = Math.floor(y / frameHeight) * frameHeight
  return [mode === 'x' ? x : width - 1 - x, mode === 'y' ? y : top + frameHeight - 1 - (y - top)]
}
