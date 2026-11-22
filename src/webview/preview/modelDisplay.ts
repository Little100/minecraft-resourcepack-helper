export const MODEL_DISPLAY_CONTEXTS = ['gui', 'ground', 'fixed', 'head', 'firstperson_righthand', 'firstperson_lefthand', 'thirdperson_righthand', 'thirdperson_lefthand'] as const
export type ModelDisplayContext = typeof MODEL_DISPLAY_CONTEXTS[number]
type Transform = Record<string, unknown>
const object = (value: unknown): Transform => value && typeof value === 'object' && !Array.isArray(value) ? value as Transform : {}

export function displayContextTransform(model: Record<string, unknown>, context: ModelDisplayContext): Transform {
  const display = object(model.display)
  const value = display[context] ?? (context.endsWith('_lefthand') ? display[context.replace('_lefthand', '_righthand')] : undefined)
  return object(value)
}

export function displayVector(transform: Transform, channel: 'rotation' | 'translation' | 'scale'): [number, number, number] {
  const values = transform[channel], fallback = channel === 'scale' ? 1 : 0
  return [0, 1, 2].map(axis => Array.isArray(values) && Number.isFinite(values[axis]) ? Number(values[axis]) : fallback) as [number, number, number]
}
