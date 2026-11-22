import { uiText } from '../i18n/messages'
import versions from './data/packFormats.json'

export type CustomModelDataSchema = 'unsupported' | 'nbt' | 'component-number' | 'component-lists'
export function compareMinecraftVersion(left: string, right: string): number {
  const parse = (value: string): number[] => {
    if (!/^\d+\.\d+(?:\.\d+)?$/.test(value)) throw new Error(uiText("core.customModelData.needAClearJavaOfficialVersionNumber"))
    return value.split('.').map(Number)
  }
  const a = parse(left), b = parse(right)
  for (let index = 0; index < 3; index++) { const delta = (a[index] ?? 0) - (b[index] ?? 0); if (delta) return delta }
  return 0
}
export function customModelDataSchema(version: string): CustomModelDataSchema {
  if (compareMinecraftVersion(version, '1.14') < 0) return 'unsupported'
  if (compareMinecraftVersion(version, '1.20.5') < 0) return 'nbt'
  return compareMinecraftVersion(version, '1.21.4') < 0 ? 'component-number' : 'component-lists'
}
export function customModelDataVersions(): string[] {
  return versions.versions.filter(value => value.type === 'release' && /^\d+\.\d+(?:\.\d+)?$/.test(value.id)).map(value => value.id)
}
export function resourceId(value: string): boolean {
  return typeof value === 'string' && value.length <= 512 && /^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(value) && value.split(/[/:]/).every(part => !!part && part !== '.' && part !== '..')
}
export function validateCustomModelData(value: number, version: string): void {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) throw new Error(uiText("core.customModelData.custommodeldataMustBeALimitedNumber"))
  if (customModelDataSchema(version) === 'unsupported') throw new Error(uiText("core.customModelData.thisVersionHasNoOriginalCustommodeldataSelect"))
  if (customModelDataSchema(version) !== 'component-lists' && (!Number.isInteger(value) || value > 2147483647 || value < -2147483648)) throw new Error(uiText("core.customModelData.thisVersionOfCustommodeldataRequiresASymbol"))
  if (customModelDataSchema(version) === 'component-lists' && Math.fround(value) !== value) throw new Error(uiText("core.customModelData.thisValueCannotBePreciselyExpressedIn"))
}
export function customModelDataState(value: number, version: string): Record<string, unknown> {
  validateCustomModelData(value, version)
  return { custom_model_data: customModelDataSchema(version) === 'component-lists' ? { floats: [value] } : value }
}
export function customModelDataCommand(item: string, value: number, version: string): string {
  if (!resourceId(item)) throw new Error(uiText("core.customModelData.theItemResourceIdentifierIsInvalid"))
  validateCustomModelData(value, version)
  const id = item.includes(':') ? item : 'minecraft:' + item
  const schema = customModelDataSchema(version)
  if (schema === 'nbt') return '/give @s ' + id + '{CustomModelData:' + value + '} 1'
  if (schema === 'component-number') return '/give @s ' + id + '[minecraft:custom_model_data=' + value + '] 1'
  return '/give @s ' + id + '[minecraft:custom_model_data={floats:[' + value + 'f]}] 1'
}
export function customModelDataDefinition(item: string, model: string, value: number, version: string): { path: string; content: Record<string, unknown> } {
  if (!resourceId(item) || !resourceId(model)) throw new Error(uiText("core.customModelData.ineffectiveIdentificationOfTheItemOrModel"))
  validateCustomModelData(value, version)
  const [namespace, id] = item.includes(':') ? item.split(':') : ['minecraft', item]
  if (customModelDataSchema(version) !== 'component-lists') return {
    path: 'assets/' + namespace + '/models/item/' + id + '.json',
    content: { parent: 'minecraft:item/generated', textures: { layer0: namespace + ':item/' + id }, overrides: [{ predicate: { custom_model_data: value }, model }] }
  }
  return { path: 'assets/' + namespace + '/items/' + id + '.json', content: {
    model: { type: 'minecraft:range_dispatch', property: 'minecraft:custom_model_data', index: 0,
      entries: [{ threshold: value, model: { type: 'minecraft:model', model } }], fallback: { type: 'minecraft:model', model: namespace + ':item/' + id } }
  } }
}
export interface CustomModelDataCase { label: string; state: Record<string, unknown> }
export function customModelDataCases(definition: unknown): CustomModelDataCase[] {
  const found: CustomModelDataCase[] = [], pending = [definition]
  let visited = 0
  while (pending.length && visited++ < 4096 && found.length < 128) {
    const value = pending.pop()
    if (!value || typeof value !== 'object') continue
    const node = value as Record<string, unknown>
    const predicate = node.predicate as Record<string, unknown> | undefined
    const predicateCmd = predicate?.custom_model_data ?? predicate?.['minecraft:custom_model_data']
    if (typeof predicateCmd === 'number') found.push({ label: 'CMD ' + predicateCmd, state: { custom_model_data: predicateCmd } })
    if (String(node.property).replace(/^minecraft:/, '') === 'custom_model_data') {
      const index = Number.isSafeInteger(node.index) && Number(node.index) >= 0 && Number(node.index) < 64 ? Number(node.index) : 0
      const add = (field: string, input: unknown, label: string): void => {
        const values = Array.from({ length: index + 1 }, () => field === 'strings' ? '' : field === 'flags' ? false : 0)
        values[index] = input as never
        found.push({ label, state: { custom_model_data: { [field]: values } } })
      }
      if (Array.isArray(node.entries)) for (const entry of node.entries) if (entry && typeof entry.threshold === 'number' && Number.isFinite(entry.threshold)) add('floats', entry.threshold, 'floats[' + index + '] ≥ ' + entry.threshold)
      if (Array.isArray(node.cases)) for (const entry of node.cases) for (const text of Array.isArray(entry?.when) ? entry.when : [entry?.when]) if (typeof text === 'string') add('strings', text, 'strings[' + index + '] = ' + text)
      if (String(node.type).endsWith('condition')) { add('flags', true, 'flags[' + index + '] = true'); add('flags', false, 'flags[' + index + '] = false') }
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) pending.push(...child.slice(0, 4096))
      else if (child && typeof child === 'object') pending.push(child)
    }
  }
  return found.slice(0, 128)
}

// 旧版按文件顺序取满足全部阈值的末个 override
export function legacyItemOverride(definition: unknown, state: Record<string, unknown>): string | undefined {
  if (!definition || typeof definition !== 'object') return undefined
  const overrides = (definition as { overrides?: unknown }).overrides
  if (!Array.isArray(overrides)) return undefined
  let selected: string | undefined
  for (const entry of overrides) {
    if (!entry || typeof entry !== 'object' || !entry.predicate || typeof entry.predicate !== 'object' || Array.isArray(entry.predicate) || !resourceId(entry.model ?? '')) continue
    if (Object.entries(entry.predicate).every(([key, threshold]) => {
      const normalized = key.replace(/^minecraft:/, '')
      let actual = state[normalized] ?? state[key]
      if (normalized === 'custom_model_data' && actual && typeof actual === 'object') actual = (actual as { floats?: number[] }).floats?.[0]
      if (actual === undefined) actual = 0
      if (typeof actual === 'boolean') actual = Number(actual)
      return typeof threshold === 'number' && Number.isFinite(threshold) && typeof actual === 'number' && Number.isFinite(actual) && actual >= threshold
    })) selected = entry.model
  }
  return selected
}
