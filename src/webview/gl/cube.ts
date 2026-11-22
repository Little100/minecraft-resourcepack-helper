export type Vec3 = [number, number, number]
export type Vec2 = [number, number]

export interface CubeFace {
  /** 面的外法线, 指向相机侧 */
  normal: Vec3
  /** 由法线推出的明暗系数, 与原版方块的分级一致 */
  shade: number
  /** 四个角按 CCW 排列, 从外侧看去为正面 */
  corners: Vec3[]
  /** 与 corners 一一对应的局部 UV, 原点在左上, 对应单帧内的坐标 */
  uvs: Vec2[]
}

export interface CubeMesh {
  positions: Float32Array
  uvs: Float32Array
  shades: Float32Array
  indices: Uint16Array
}

const FACE_AXES: Array<{ normal: Vec3; u: Vec3; v: Vec3 }> = [
  { normal: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { normal: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { normal: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] }
]

const CORNER_SIGNS: Array<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]]

// 原版方块的明暗分级, 顶面最亮, 底面最暗, 东西向比南北向略暗
function shadeFor(normal: Vec3): number {
  if (normal[1] > 0) return 1
  if (normal[1] < 0) return 0.5
  return normal[0] !== 0 ? 0.6 : 0.8
}

export const CUBE_FACES: readonly CubeFace[] = FACE_AXES.map(({ normal, u, v }) => {
  const corners: Vec3[] = []
  const uvs: Vec2[] = []
  for (const [su, sv] of CORNER_SIGNS) {
    corners.push([
      normal[0] * 0.5 + u[0] * su * 0.5 + v[0] * sv * 0.5,
      normal[1] * 0.5 + u[1] * su * 0.5 + v[1] * sv * 0.5,
      normal[2] * 0.5 + u[2] * su * 0.5 + v[2] * sv * 0.5
    ])
    uvs.push([(su + 1) / 2, (1 - sv) / 2])
  }
  return { normal, shade: shadeFor(normal), corners, uvs }
})

export function buildCubeMesh(): CubeMesh {
  const positions = new Float32Array(CUBE_FACES.length * 4 * 3)
  const uvs = new Float32Array(CUBE_FACES.length * 4 * 2)
  const shades = new Float32Array(CUBE_FACES.length * 4)
  const indices = new Uint16Array(CUBE_FACES.length * 6)
  CUBE_FACES.forEach((face, faceIndex) => {
    face.corners.forEach((corner, cornerIndex) => {
      const vertex = faceIndex * 4 + cornerIndex
      positions.set(corner, vertex * 3)
      uvs.set(face.uvs[cornerIndex], vertex * 2)
      shades[vertex] = face.shade
    })
    indices.set([0, 1, 2, 0, 2, 3].map(offset => faceIndex * 4 + offset), faceIndex * 6)
  })
  return { positions, uvs, shades, indices }
}

