import type { PreviewRenderer } from '../gl/renderer'
import type { FrameSample } from '../gl/types'
import type { PreviewMode } from '../messages'
import { sampleFrame } from './frames'
import { HAND_POSES } from './layout'
import type { PreviewModel } from './model'
import { drawOverlay } from './overlay'
import { blockMvp, handMvp, type ViewState } from './view'

export interface SceneInput {
  mode: PreviewMode
  view: ViewState
  playhead: number
}

export function drawScene(renderer: PreviewRenderer, model: PreviewModel, input: SceneInput, width: number, height: number): void {
  const frame = sampleFrame(model.schedule, input.playhead, model.interpolate)
  const sample: FrameSample = { ...frame, frameScale: model.layout.frameScale }
  const aspect = width / Math.max(1, height)
  const { mode, view } = input
  if (mode === 'block') {
    renderer.drawCube(blockMvp(view, aspect), sample)
  } else if (mode === 'hand-first' || mode === 'hand-third') {
    renderer.drawCube(handMvp(HAND_POSES[mode], aspect), sample)
  } else {
    drawOverlay(renderer, width, height, {
      mode,
      sample,
      frameWidth: model.width,
      frameHeight: model.layout.frameHeight,
      zoom: view.zoom
    })
  }
}
