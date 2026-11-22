import { uiText } from '../../i18n/messages'
import type { DisplayTransform, ResolvedModel } from 'block-model-renderer'
import type { VanillaPreviewInit } from '../vanillaPreviewProtocol'
import { MODEL_DISPLAY_CONTEXTS, displayContextTransform, displayVector } from './modelDisplay'

export type Presentation = 'block' | 'model' | typeof MODEL_DISPLAY_CONTEXTS[number] | 'dropped' | 'entity'
export interface PresentationEntry { id: Presentation; label: string }
const ITEM_PRESENTATIONS: readonly PresentationEntry[] = [
  { id: 'firstperson_righthand', label: uiText("webview.preview.presentations.firstPersonHeld") },
  { id: 'firstperson_lefthand', label: uiText("webview.preview.presentations.firstPersonLeftHand") },
  { id: 'thirdperson_righthand', label: uiText("webview.preview.presentations.thirdPersonHeld") },
  { id: 'thirdperson_lefthand', label: uiText("webview.preview.presentations.thirdPersonLeftHand") },
  { id: 'gui', label: uiText("webview.preview.modes.itemsBar") },
  { id: 'model', label: uiText("webview.preview.presentations.dModel") },
  { id: 'fixed', label: uiText("webview.preview.modes.presentationBox") },
  { id: 'ground', label: uiText("webview.preview.presentations.fallingObject") },
  { id: 'head', label: uiText("webview.preview.presentations.head") },
  { id: 'dropped', label: uiText("webview.preview.presentations.fallingFromThePropertyScene") }
]
export function presentations(init: VanillaPreviewInit): readonly PresentationEntry[] {
  if (init.target.kind === 'block') return [{ id: 'block', label: uiText("ui.resourceDocs.blockState") }, ...ITEM_PRESENTATIONS]
  if (init.target.kind === 'entity') return [{ id: 'entity', label: uiText("webview.preview.presentations.physicalStatus") }]
  const choices = init.target.kind === 'model' && !/^[^:]+:(?:item|block)\//.test(init.target.id)
    ? [{ id: 'gui' as const, label: uiText("webview.preview.presentations.modelView") }, { id: 'model' as const, label: uiText("webview.preview.presentations.dModel") }, ...ITEM_PRESENTATIONS.filter(entry => entry.id !== 'gui' && entry.id !== 'model')]
    : ITEM_PRESENTATIONS
  return [...choices, ...(init.vehicle ? [{ id: 'entity' as const, label: uiText("webview.preview.presentations.physicalStatus") }] : [])]
}
export function modelDisplay(model: ResolvedModel, presentation: Presentation, pose: { yaw: number; pitch: number; zoom: number }): DisplayTransform {
  if (presentation === 'model') return { rotation: [pose.pitch, pose.yaw, 0], translation: [0, 0, 0], scale: [pose.zoom, pose.zoom, pose.zoom] }
  const context = presentation === 'block' || presentation === 'entity' ? 'gui' : presentation === 'dropped' ? 'ground' : presentation
  const transform = displayContextTransform(model, context)
  const rotation = displayVector(transform, 'rotation')
  const scale = displayVector(transform, 'scale')
  // BMR 将显式向量覆盖到选中场景，合并后只应用一次变换
  return { ...transform, display: context, rotation: [rotation[0] + pose.pitch, rotation[1] + pose.yaw, rotation[2]], scale: [scale[0] * pose.zoom, scale[1] * pose.zoom, scale[2] * pose.zoom] }
}

