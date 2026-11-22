import { uiText } from '../../i18n/messages'
import * as THREE from 'three'
import { readFile, type PreparedAssets } from 'block-model-renderer'
import type { VehiclePreview } from '../../core/previewContexts'
import models from './vehicleModels.json'

type Triple = [number, number, number]
interface Cube { uv: number[]; from: number[]; size: number[] }
export interface VehicleScene { group: THREE.Group; bounds: THREE.Box3; dispose(): void }

// 按实体 ModelPart 的展开图生成独立面，保留各面的方向与 UV
export function vehicleCubeGeometry(cube: Cube, width: number, height: number): THREE.BufferGeometry {
  const [x, y, z] = cube.from, [dx, dy, dz] = cube.size, [u, v] = cube.uv
  const vertices = [[x,y,z],[x+dx,y,z],[x+dx,y+dy,z],[x,y+dy,z],[x,y,z+dz],[x+dx,y,z+dz],[x+dx,y+dy,z+dz],[x,y+dy,z+dz]]
  const faces = [
    { indices: [5,4,0,1], uv: [u+dz,v,u+dz+dx,v+dz] },
    { indices: [2,3,7,6], uv: [u+dz+dx,v+dz,u+dz+dx*2,v] },
    { indices: [0,4,7,3], uv: [u,v+dz,u+dz,v+dz+dy] },
    { indices: [1,0,3,2], uv: [u+dz,v+dz,u+dz+dx,v+dz+dy] },
    { indices: [5,1,2,6], uv: [u+dz+dx,v+dz,u+dz*2+dx,v+dz+dy] },
    { indices: [4,5,6,7], uv: [u+dz*2+dx,v+dz,u+dz*2+dx*2,v+dz+dy] }
  ]
  const positions: number[] = [], uv: number[] = [], indices: number[] = []
  for (const face of faces) {
    const offset = positions.length / 3, [u1,v1,u2,v2] = face.uv
    for (const index of face.indices) positions.push(...vertices[index])
    uv.push(u2/width,v1/height,u1/width,v1/height,u1/width,v2/height,u2/width,v2/height)
    indices.push(offset,offset+1,offset+2,offset,offset+2,offset+3)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions,3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv,2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

export async function createVehicleScene(assets: PreparedAssets, vehicle: VehiclePreview, version?: string): Promise<VehicleScene> {
  if (version && /^1\.(?:[0-8])(?:\.|$)/.test(version)) throw new Error(uiText("webview.preview.vehicle.thisVersionOfTheOldShipPhysical"))
  if ((vehicle.chest || vehicle.shape === 'raft') && version && /^1\.(?:[0-9]|1[0-8])(?:\.|$)/.test(version)) throw new Error(uiText("webview.preview.vehicle.noTransportShipOrRaftEntityIn"))
  const bytes = await readFile(vehicle.texturePath, assets)
  if (!bytes) throw new Error(uiText("webview.preview.vehicle.lackOfPhysicalTextureHandheldObjectChart", vehicle.texturePath))
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], {type:'image/png'}))
  const image = new Image()
  try {
    await new Promise<void>((resolve,reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error(uiText("webview.preview.vehicle.entityTextureCannotBeDecoded", vehicle.texturePath))); image.src = url })
  } finally { URL.revokeObjectURL(url) }
  const size = vehicle.chest ? models.chestTextureSize : models.textureSize
  if (image.width * size[1] !== image.height * size[0]) throw new Error(uiText("webview.preview.vehicle.theEntityImageWidthRatioDoesNot", vehicle.texturePath))
  const texture = new THREE.Texture(image)
  texture.flipY = false; texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = THREE.NearestFilter; texture.minFilter = THREE.NearestFilter; texture.generateMipmaps = false; texture.needsUpdate = true
  const material = new THREE.MeshLambertMaterial({map:texture,alphaTest:0.1,side:THREE.FrontSide})
  const group = new THREE.Group(), geometries: THREE.BufferGeometry[] = []
  group.name = 'minecraft:' + vehicle.shape
  group.scale.set(-1,-1,1); group.rotation.y = Math.PI / 2; group.position.y = 6
  const parts = [...models.parts[vehicle.shape], ...(vehicle.chest ? models.parts.chest : [])]
  for (const part of parts) {
    const node = new THREE.Group()
    node.name = part.name
    node.position.set(...part.pivot as Triple)
    if (vehicle.shape === 'raft' && part.name.startsWith('chest_')) node.position.y += models.chestRaftOffset
    node.rotation.set(...part.rotation as Triple, 'ZYX')
    for (const cube of part.cubes) {
      const geometry = vehicleCubeGeometry(cube,size[0],size[1])
      geometries.push(geometry); node.add(new THREE.Mesh(geometry,material))
    }
    group.add(node)
  }
  group.updateMatrixWorld(true)
  return { group, bounds:new THREE.Box3().setFromObject(group), dispose() { for (const geometry of geometries) geometry.dispose(); material.dispose(); texture.dispose(); group.clear() } }
}
