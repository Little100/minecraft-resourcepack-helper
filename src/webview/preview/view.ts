import { multiply, perspective, rotateX, rotateY, scale, translate, type Mat4 } from '../gl/math'
import { BLOCK_VIEW, HAND_FOV_DEG, type HandPose } from './layout'

export interface ViewState {
  yaw: number
  pitch: number
  zoom: number
  rotation?: Mat4
}

// 限制放大，避免相机切掉模型前侧
export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 2.5

const NEAR_PLANE = 0.05
const FAR_PLANE = 20

export const DEFAULT_VIEW: ViewState = { yaw: deg(BLOCK_VIEW.yawDeg), pitch: deg(BLOCK_VIEW.pitchDeg), zoom: 1 }

// 使用屏幕相对轴累积物体旋转，保留正角向右下的语义
export function rotateView(view: ViewState, deltaYaw: number, deltaPitch: number): ViewState {
  const previous = view.rotation ?? multiply(rotateX(view.pitch), rotateY(view.yaw))
  const delta = multiply(rotateX(deltaPitch), rotateY(deltaYaw))
  return { ...view, yaw: view.yaw + deltaYaw, pitch: view.pitch + deltaPitch, rotation: multiply(delta, previous) }
}

export function zoomView(view: ViewState, factor: number): ViewState {
  return { ...view, zoom: clamp(view.zoom * factor, ZOOM_MIN, ZOOM_MAX) }
}

export function blockMvp(view: ViewState, aspect: number): Mat4 {
  const widthFit = Math.max(1, 1.2 / aspect)
  const distance = (BLOCK_VIEW.distance * widthFit) / view.zoom
  const projection = perspective(deg(BLOCK_VIEW.fovyDeg), aspect, NEAR_PLANE, FAR_PLANE)
  const model = view.rotation ?? multiply(rotateX(view.pitch), rotateY(view.yaw))
  return multiply(projection, multiply(translate(0, 0, -distance), model))
}

export function handMvp(pose: HandPose, aspect: number): Mat4 {
  const projection = perspective(deg(HAND_FOV_DEG), aspect, NEAR_PLANE, FAR_PLANE)
  const orientation = multiply(rotateX(deg(pose.pitchDeg)), rotateY(deg(pose.yawDeg)))
  const model = multiply(translate(...pose.offset), multiply(orientation, scale(pose.scale, pose.scale, pose.scale)))
  return multiply(projection, model)
}

function deg(value: number): number {
  return (value * Math.PI) / 180
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
