// 与 WebGL 无关的共享类型, 纯数据便于布局与测试模块直接引用
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type Rgba = [number, number, number, number]

export interface FrameSample {
  frame: number
  nextFrame: number
  mix: number
  frameScale: number
}
