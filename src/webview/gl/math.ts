// 列主序 4x4 矩阵工具, 与 WebGL 的 uniformMatrix4fv 约定一致, 不依赖 DOM 便于 Node 验证
export type Mat4 = Float32Array

export function identity(): Mat4 {
  const out = new Float32Array(16)
  out[0] = 1
  out[5] = 1
  out[10] = 1
  out[15] = 1
  return out
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16)
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k]
      out[col * 4 + row] = sum
    }
  }
  return out
}

// 透视投影, fovy 为弧度的竖直视场角, 深度范围映射到 [-1, 1]
export function perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const out = new Float32Array(16)
  const f = 1 / Math.tan(fovy / 2)
  out[0] = f / aspect
  out[5] = f
  out[10] = (far + near) / (near - far)
  out[11] = -1
  out[14] = (2 * far * near) / (near - far)
  return out
}

export function translate(x: number, y: number, z: number): Mat4 {
  const out = identity()
  out[12] = x
  out[13] = y
  out[14] = z
  return out
}

export function scale(x: number, y: number, z: number): Mat4 {
  const out = identity()
  out[0] = x
  out[5] = y
  out[10] = z
  return out
}

// 绕 X 轴旋转, 角度为弧度, 右手系
export function rotateX(angle: number): Mat4 {
  const out = identity()
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  out[5] = c
  out[6] = s
  out[9] = -s
  out[10] = c
  return out
}

// 绕 Y 轴旋转, 角度为弧度, 右手系
export function rotateY(angle: number): Mat4 {
  const out = identity()
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  out[0] = c
  out[2] = -s
  out[8] = s
  out[10] = c
  return out
}

export function transformPoint(m: Mat4, point: readonly [number, number, number]): [number, number, number, number] {
  const [x, y, z] = point
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15]
  ]
}
