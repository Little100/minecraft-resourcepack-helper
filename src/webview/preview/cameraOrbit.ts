import * as THREE from 'three'

export type OrbitRotation = [number, number, number, number]
interface OrbitPose { yaw: number; pitch: number; rotation?: OrbitRotation }
export function wrapOrbitDegrees(value: number): number { return ((value + 180) % 360 + 360) % 360 - 180 }
function orientation(yaw: number, pitch: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(-THREE.MathUtils.degToRad(wrapOrbitDegrees(pitch)), THREE.MathUtils.degToRad(wrapOrbitDegrees(yaw)), 0, 'YXZ'))
}

// 旋转使用连续的相机局部基，经过极点后也不会倒向或锁住水平拖动
export function placeOrbitCamera(camera: THREE.Camera, center: THREE.Vector3, distance: number, yaw: number, pitch: number, rotation?: OrbitRotation): void {
  const quaternion = rotation ? new THREE.Quaternion(...rotation).normalize() : orientation(yaw, pitch)
  camera.position.copy(new THREE.Vector3(0, 0, distance).applyQuaternion(quaternion).add(center))
  camera.up.copy(new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion))
  camera.quaternion.copy(quaternion)
  camera.updateMatrixWorld()
}

export function dragOrbit(start: OrbitPose, dx: number, dy: number): OrbitPose & { rotation: OrbitRotation } {
  const initial = start.rotation ? new THREE.Quaternion(...start.rotation).normalize() : orientation(start.yaw, start.pitch)
  const delta = new THREE.Quaternion().setFromEuler(new THREE.Euler(-THREE.MathUtils.degToRad(dy * 0.4), -THREE.MathUtils.degToRad(dx * 0.5), 0, 'YXZ'))
  return { yaw: start.yaw - dx * 0.5, pitch: start.pitch + dy * 0.4, rotation: initial.multiply(delta).normalize().toArray() }
}
