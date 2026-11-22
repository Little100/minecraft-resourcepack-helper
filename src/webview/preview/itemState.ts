import { uiText } from '../../i18n/messages'
export type ItemState = Record<string, unknown>

export function parseItemState(text: string): ItemState {
  if (new TextEncoder().encode(text).byteLength > 32 * 1024) throw new Error(uiText("webview.preview.itemState.theObjectSStateParametersCannotBe"))
  let value: unknown
  try { value = JSON.parse(text) }
  catch { throw new Error(uiText("webview.preview.itemState.theObjectSStateParametersMustBe")) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(uiText("webview.preview.itemState.theRootNodeOfTheObjectS"))
  const pending = [{ value, depth: 1 }]
  let count = 0
  while (pending.length) {
    const entry = pending.pop()!
    if (++count > 4096) throw new Error(uiText("webview.preview.itemState.theObjectSStateParametersCannotExceed"))
    if (entry.depth > 16) throw new Error(uiText("webview.preview.itemState.theObjectSStateParametersCannotBe_abd21d"))
    if (typeof entry.value === 'number' && !Number.isFinite(entry.value)) throw new Error(uiText("webview.preview.itemState.theObjectSStateParametersCanOnly"))
    if (entry.value && typeof entry.value === 'object') {
      for (const [key, child] of Object.entries(entry.value)) {
        if (key === '__proto__') throw new Error(uiText("webview.preview.itemState.theObjectSStateParameterCannotContain"))
        pending.push({ value: child, depth: entry.depth + 1 })
      }
    }
  }
  return value as ItemState
}

function object(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(location + uiText("webview.preview.itemState.mustBeAnObject"))
  return value as Record<string, unknown>
}

// 检查库会静默跳过的定义类型，具体分支选择仍由库处理
export function validateItemDefinition(value: unknown, path: string): void {
  const definition = object(value, path)
  const pending = [{ value: definition.model, location: path + '.model', depth: 1 }]
  let count = 0
  while (pending.length) {
    const entry = pending.pop()!
    if (++count > 4096 || entry.depth > 64) throw new Error(uiText("webview.preview.itemState.theDefinitionOfTheItemIsToo", path))
    const model = object(entry.value, entry.location)
    if (typeof model.type !== 'string') throw new Error(uiText("webview.preview.itemState.theObjectModelTypeMustBeA", entry.location))
    const type = model.type.replace(/^minecraft:/, '')
    const add = (value: unknown, suffix: string): void => { pending.push({ value, location: entry.location + suffix, depth: entry.depth + 1 }) }
    const optional = (value: unknown, suffix: string): void => { if (value !== undefined) add(value, suffix) }
    const reference = (value: unknown, field: string): void => {
      if (typeof value !== 'string' || !/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(value) || value.split('/').includes('..')) throw new Error(uiText("webview.preview.itemState.theItemModelResourceIdentifierIsInvalid", entry.location, field))
    }
    switch (type) {
      case 'model': reference(model.model, 'model'); break
      case 'special': {
        reference(model.base, 'base')
        const special = object(model.model, entry.location + '.model')
        if (typeof special.type !== 'string' || !special.type) throw new Error(uiText("webview.preview.itemState.specialModelTypeMustBeAString", entry.location))
        break
      }
      case 'composite':
        if (!Array.isArray(model.models)) throw new Error(uiText("webview.preview.itemState.compositeModelsMustBeAnArray", entry.location))
        model.models.forEach((child, index) => add(child, '.models[' + index + ']'))
        break
      case 'condition': add(model.on_true, '.on_true'); add(model.on_false, '.on_false'); break
      case 'select':
      case 'range_dispatch': {
        const field = type === 'select' ? 'cases' : 'entries'
        if (!Array.isArray(model[field])) throw new Error(type + '.' + field + uiText("webview.preview.itemState.mustBeAnArray") + entry.location)
        model[field].forEach((child: unknown, index: number) => add(object(child, entry.location).model, '.' + field + '[' + index + '].model'))
        optional(model.fallback, '.fallback')
        break
      }
      case 'empty':
      case 'bundle/selected_item': break
      default: throw new Error(uiText("webview.preview.itemState.nonSupportedItemsModelType", model.type, entry.location))
    }
  }
}
