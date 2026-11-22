import type { PreviewMode } from '../messages'
import { MODES } from './modes'

export type KeyAction =
  | { type: 'rotate'; deltaYaw: number; deltaPitch: number }
  | { type: 'zoom'; factor: number }
  | { type: 'mode'; mode: PreviewMode }
  | { type: 'togglePlay' }
  | { type: 'reset' }

const ROTATE_STEP = (5 * Math.PI) / 180
const ZOOM_STEP = 1.1

export function keyAction(key: string): KeyAction | undefined {
  switch (key) {
    case 'ArrowLeft':
      return { type: 'rotate', deltaYaw: -ROTATE_STEP, deltaPitch: 0 }
    case 'ArrowRight':
      return { type: 'rotate', deltaYaw: ROTATE_STEP, deltaPitch: 0 }
    case 'ArrowUp':
      return { type: 'rotate', deltaYaw: 0, deltaPitch: -ROTATE_STEP }
    case 'ArrowDown':
      return { type: 'rotate', deltaYaw: 0, deltaPitch: ROTATE_STEP }
    case '+':
    case '=':
      return { type: 'zoom', factor: ZOOM_STEP }
    case '-':
      return { type: 'zoom', factor: 1 / ZOOM_STEP }
    case ' ':
      return { type: 'togglePlay' }
    case 'r':
    case 'R':
      return { type: 'reset' }
    default:
      return modeAction(key)
  }
}

function modeAction(key: string): KeyAction | undefined {
  const index = Number(key) - 1
  if (!Number.isInteger(index) || index < 0 || index >= MODES.length) return undefined
  return { type: 'mode', mode: MODES[index].id }
}
