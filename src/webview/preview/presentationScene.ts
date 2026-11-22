import { uiText } from '../../i18n/messages'
import * as THREE from 'three'

export interface PresentationScene {
  group: THREE.Group
  bounds: THREE.Box3
  cameraBase: { yaw: number; pitch: number }
  label: string
}

const BLOCK_SIZE = 16
const PIXEL = BLOCK_SIZE / 16
const BACKPLANE_Z = -BLOCK_SIZE / 2 - PIXEL / 8
const HOTBAR = { slots: 9, selected: 4, pitch: 18 * PIXEL, aperture: 16 * PIXEL }
const FRAME = { side: 12 * PIXEL, rim: PIXEL, depth: PIXEL }

// 空包围盒或非法坐标采用一个方块的范围，传入的模型包围盒保持不变
function usableBounds(bounds: THREE.Box3): THREE.Box3 {
  const halfBlock = BLOCK_SIZE / 2
  const values = [...bounds.min.toArray(), ...bounds.max.toArray(), ...bounds.getSize(new THREE.Vector3()).toArray()]
  return !bounds.isEmpty() && values.every(Number.isFinite)
    ? bounds.clone()
    : new THREE.Box3(new THREE.Vector3(-halfBlock, -halfBlock, -halfBlock), new THREE.Vector3(halfBlock, halfBlock, halfBlock))
}

// 每次创建单独持有材质与几何，父场景可统一遍历释放
function meshFactory() {
  const materials = new Map<number, THREE.MeshBasicMaterial>()
  const geometries = new Map<string, THREE.BoxGeometry>()
  return (parent: THREE.Group, name: string, size: [number, number, number], center: [number, number], front: number, color: number): THREE.Mesh => {
    const key = size.join(',')
    let geometry = geometries.get(key)
    if (!geometry) { geometry = new THREE.BoxGeometry(...size); geometries.set(key, geometry) }
    let material = materials.get(color)
    if (!material) {
      material = new THREE.MeshBasicMaterial({ color, toneMapped: false })
      materials.set(color, material)
    }
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = name
    mesh.position.set(center[0], center[1], front - size[2] / 2)
    mesh.userData.presentationDecoration = true
    mesh.raycast = () => {}
    parent.add(mesh)
    return mesh
  }
}

type AddMesh = ReturnType<typeof meshFactory>

function ring(add: AddMesh, parent: THREE.Group, name: string, width: number, height: number, rim: number, front: number, depth: number, colors: [number, number, number, number]): void {
  add(parent, name + '-top', [width, rim, depth], [0, (height - rim) / 2], front, colors[0])
  add(parent, name + '-left', [rim, height - rim * 2, depth], [-(width - rim) / 2, 0], front, colors[1])
  add(parent, name + '-bottom', [width, rim, depth], [0, -(height - rim) / 2], front, colors[2])
  add(parent, name + '-right', [rim, height - rim * 2, depth], [(width - rim) / 2, 0], front, colors[3])
}

function createHotbar(group: THREE.Group, add: AddMesh): void {
  const hotbar = new THREE.Group()
  hotbar.name = 'presentation-gui-hotbar'
  hotbar.userData.selectedSlot = HOTBAR.selected
  group.add(hotbar)
  const front = BACKPLANE_Z
  add(hotbar, 'presentation-gui-chassis', [HOTBAR.pitch * HOTBAR.slots + 2 * PIXEL, 20 * PIXEL, PIXEL / 2], [0, 0], front - PIXEL / 2, 0x242424)
  for (let index = 0; index < HOTBAR.slots; index++) {
    const slot = new THREE.Group()
    slot.name = 'presentation-gui-slot-' + index
    slot.position.x = (index - HOTBAR.selected) * HOTBAR.pitch
    slot.userData.slotIndex = index
    slot.userData.apertureSize = HOTBAR.aperture
    hotbar.add(slot)
    add(slot, slot.name + '-well', [HOTBAR.aperture, HOTBAR.aperture, PIXEL / 8], [0, 0], front - PIXEL / 4, 0x8b8b8b)
    ring(add, slot, slot.name + '-rim', 18 * PIXEL, 18 * PIXEL, PIXEL, front - PIXEL / 8, PIXEL / 4, [0x373737, 0x373737, 0xc6c6c6, 0xc6c6c6])
  }
  const selection = new THREE.Group()
  selection.name = 'presentation-gui-selection'
  hotbar.add(selection)
  ring(add, selection, selection.name, 20 * PIXEL, 20 * PIXEL, 2 * PIXEL, front, PIXEL / 4, [0xf0f0f0, 0xd8d8d8, 0xb0b0b0, 0xc6c6c6])
}

function createFrame(group: THREE.Group, add: AddMesh): void {
  const side = FRAME.side
  const frameFront = BACKPLANE_Z
  const wallFront = frameFront - FRAME.depth - PIXEL / 8
  const wall = new THREE.Group()
  wall.name = 'presentation-fixed-wall'
  group.add(wall)
  const width = BLOCK_SIZE * 3, height = BLOCK_SIZE * 2
  add(wall, 'presentation-fixed-wall-mortar', [width, height, PIXEL], [0, 0], wallFront - PIXEL / 8, 0x53534f)
  const columns = 3, rows = 2, tileWidth = width / columns, tileHeight = height / rows
  const shades = [0x85857d, 0x7c7d77, 0x898980, 0x7f8079, 0x8b8b83, 0x82837c]
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x = (column - (columns - 1) / 2) * tileWidth, y = ((rows - 1) / 2 - row) * tileHeight
      const name = 'presentation-fixed-wall-tile-' + row + '-' + column
      add(wall, name, [tileWidth - PIXEL / 4, tileHeight - PIXEL / 4, PIXEL / 4], [x, y], wallFront, shades[row * columns + column])
      add(wall, name + '-top', [tileWidth - PIXEL / 4, PIXEL / 2, PIXEL / 16], [x, y + tileHeight / 2 - 3 * PIXEL / 8], wallFront + PIXEL / 32, 0x99998f)
      add(wall, name + '-bottom', [tileWidth - PIXEL / 4, PIXEL / 2, PIXEL / 16], [x, y - tileHeight / 2 + 3 * PIXEL / 8], wallFront + PIXEL / 32, 0x6a6b64)
    }
  }
  const frame = new THREE.Group()
  frame.name = 'presentation-fixed-frame'
  group.add(frame)
  add(frame, 'presentation-fixed-hanger', [PIXEL, 2 * PIXEL, PIXEL / 4], [0, side / 2 + PIXEL / 2], frameFront - FRAME.depth / 2, 0x3d3932)
  add(frame, 'presentation-fixed-backing', [side - 2 * FRAME.rim, side - 2 * FRAME.rim, PIXEL / 2], [0, 0], frameFront - PIXEL / 4, 0x947348)
  ring(add, frame, 'presentation-fixed-wood', side, side, FRAME.rim, frameFront - PIXEL / 8, FRAME.depth, [0xc19958, 0xa57b40, 0x634523, 0x7d582e])
  ring(add, frame, 'presentation-fixed-lip', side - FRAME.rim, side - FRAME.rim, PIXEL / 4, frameFront, PIXEL / 8, [0xe0ba75, 0xc49a57, 0x78562c, 0x936934])
}

// 装饰固定在世界原点与背景平面，模型包围盒仅用于相机取景
export function createPresentationScene(context: 'gui' | 'fixed', modelBounds: THREE.Box3): PresentationScene {
  const bounds = usableBounds(modelBounds)
  const group = new THREE.Group()
  group.name = 'presentation-' + context
  group.userData.presentationDecoration = true
  group.userData.presentationContext = context
  const add = meshFactory()
  if (context === 'gui') createHotbar(group, add)
  else createFrame(group, add)
  group.updateMatrixWorld(true)
  const viewBounds = new THREE.Box3().setFromObject(group).union(bounds)
  return {
    group,
    bounds: viewBounds,
    cameraBase: context === 'gui' ? { yaw: 0, pitch: 0 } : { yaw: 15, pitch: 8 },
    label: context === 'gui' ? uiText("webview.preview.presentationScene.itemsBarNineCellShortcut") : uiText("webview.preview.presentationScene.presentationBoxStandingWallScene")
  }
}
