import type { ResolvedModel } from 'block-model-renderer'

// generated物品的厚度固定为模型单位，与贴图分辨率无关
export function normalizeGeneratedGeometry(model: ResolvedModel): ResolvedModel {
  if (!model.generated || !model.elements) return model
  return { ...model, elements: model.elements.map(element => ({ ...element,
    from: [element.from[0], element.from[1], 7.5], to: [element.to[0], element.to[1], 8.5]
  })) }
}
