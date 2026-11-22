import { uiText } from '../i18n/messages'
import { applyEdits, modify, parse, parseTree, type ParseError } from 'jsonc-parser'
import { resourceId } from './customModelData'

export interface VanillaTemplate { id: string; label: string; description: string; directory: string; defaultName: string; build(namespace: string, name: string): Record<string, unknown> }
export const VANILLA_TEMPLATES: readonly VanillaTemplate[] = [
  { id: 'sounds', label: uiText("template.sounds.label"), description: uiText("template.sounds.description"), directory: 'sounds', defaultName: 'custom.idle', build: () => ({}) },
  { id: 'block', label: uiText("template.block.label"), description: uiText("template.block.description"), directory: 'models/block', defaultName: 'custom_block', build: (namespace, name) => ({ parent: 'minecraft:block/cube_all', textures: { all: namespace + ':block/' + name } }) },
  { id: 'item', label: uiText("template.item.label"), description: uiText("template.item.description"), directory: 'models/item', defaultName: 'custom_item', build: (namespace, name) => ({ parent: 'minecraft:item/generated', textures: { layer0: namespace + ':item/' + name } }) },
  { id: 'blockstate', label: uiText("template.blockstate.label"), description: uiText("template.blockstate.description"), directory: 'blockstates', defaultName: 'custom_block', build: (namespace, name) => ({ variants: { '': { model: namespace + ':block/' + name } } }) },
  { id: 'lang', label: uiText("template.lang.label"), description: uiText("template.lang.description"), directory: 'lang', defaultName: 'zh_cn', build: () => ({}) },
  { id: 'particle', label: uiText("template.particle.label"), description: uiText("template.particle.description"), directory: 'particles', defaultName: 'custom_particle', build: (namespace, name) => ({ textures: [namespace + ':' + name] }) },
  { id: 'atlas', label: uiText("template.atlas.label"), description: uiText("template.atlas.description"), directory: 'atlases', defaultName: 'blocks', build: (namespace, name) => ({ sources: [{ type: 'minecraft:single', resource: namespace + ':block/' + name, sprite: namespace + ':block/' + name }] }) }
]

export function templatePathProblem(value: string): string | undefined {
  return !value || value.includes(':') || !resourceId(value) || value.endsWith('.json') || value.endsWith('.ogg') ? uiText("template.invalidPath") : undefined
}
export function jsonObject(text: string): Record<string, unknown> {
  const errors: ParseError[] = [], value: unknown = parse(text, errors)
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error(uiText("template.invalidJson"))
  return value as Record<string, unknown>
}
export function addSoundEvent(text: string | undefined, event: string, sound: string): string {
  if (!/^[a-z0-9_.-]+$/.test(event) || event === '.' || event === '..' || !resourceId(sound)) throw new Error(uiText("template.invalidSound"))
  const current = text ?? '{}\n'
  jsonObject(current)
  const tree = parseTree(current)!
  if (tree.children?.some(property => property.children?.[0]?.value === event)) throw new Error(uiText("template.duplicateSound") + event)
  const content = { sounds: [{ name: sound, stream: false }] }
  return applyEdits(current, modify(current, [event], content, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: current.includes('\r\n') ? '\r\n' : '\n' } }))
}
