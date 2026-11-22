import { uiText } from '../i18n/messages'

export interface RandomVariant { weight: number; base?: boolean }
export interface VariantLayer { id: string; randomVariant?: RandomVariant }
export const MAX_VARIANT_WEIGHT = 1_000_000

export function parseRandomVariant(value: unknown): RandomVariant | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(uiText("core.randomVariants.randomCandidacyIsInvalid"))
  const input = value as Record<string, unknown>
  if (!Number.isSafeInteger(input.weight) || Number(input.weight) < 0 || Number(input.weight) > MAX_VARIANT_WEIGHT || (input.base !== undefined && typeof input.base !== 'boolean')) throw new Error(uiText("core.randomVariants.randomWeightRequiresIntegersOfToMillion"))
  return { weight: Number(input.weight), ...(input.base === undefined ? {} : { base: input.base }) }
}

export function defaultVariantId(layers: readonly VariantLayer[]): string | undefined {
  return layers.find(layer => layer.randomVariant?.base)?.id ?? layers.find(layer => layer.randomVariant)?.id
}

// 普通图层共用，候选图层互斥，保留原合成顺序与对象引用
export function variantLayers<T extends VariantLayer>(layers: readonly T[], requested?: string): T[] {
  const id = layers.some(layer => layer.id === requested && layer.randomVariant) ? requested : defaultVariantId(layers)
  return layers.filter(layer => !layer.randomVariant || layer.id === id)
}

export type VariantEdit = { command: 'editRandomVariant'; layerId: string; action: 'enable' | 'disable' | 'duplicate' | 'default' | 'weight'; weight?: number }

export function cloneVariantLayer<T extends { pixels: Uint8Array; randomVariant?: RandomVariant }>(layer: T): T {
  return { ...layer, randomVariant: parseRandomVariant(layer.randomVariant), pixels: new Uint8Array(layer.pixels) }
}
