import { uiText } from '../i18n/messages'
import type { JSONPath } from 'jsonc-parser'
import { ATLAS_FIELDS, FONT_FIELDS, ITEM_DEFINITION_FIELDS, type ResourceSnippet } from '../core/advanced/resourceSyntax'
import { MCMETA_FIELDS, MODEL_FIELDS } from './resourceDocs'

const field = (name: string, value: string, detail = uiText("ui.resourceCompletionFields.resourceStructureFields")): ResourceSnippet => ({ name, detail, snippet: JSON.stringify(name) + ': ' + value })
const pick = (fields: readonly ResourceSnippet[], names: string[]): ResourceSnippet[] => fields.filter(value => names.includes(value.name))
const modelRoot = ['parent', 'textures', 'elements', 'display', 'gui_light', 'ambientocclusion']
const transforms = [field('rotation', '[${1:0}, ${2:0}, ${3:0}]'), field('translation', '[${1:0}, ${2:0}, ${3:0}]'), field('scale', '[${1:1}, ${2:1}, ${3:1}]')]
const face = [field('uv', '[${1:0}, ${2:0}, ${3:16}, ${4:16}]'), field('texture', '"${1:#all}"'), field('cullface', '"${1|down,up,north,south,west,east|}"'), field('rotation', '${1|0,90,180,270|}'), field('tintindex', '${1:0}')]
const itemExtra = [field('cases', '[{"when": "${1:value}", "model": {"type": "minecraft:empty"}}]'), field('threshold', '${1:0}'), field('when', '"${1:value}"'), field('index', '${1:0}'), field('value', '${1:16777215}')]

export function resourceFields(file: string, scope: JSONPath): ResourceSnippet[] {
  const path = file.replace(/\\/g, '/').toLowerCase(), key = scope.join('.')
  if (/\/textures\/.*\.mcmeta$/.test(path)) {
    if (!scope.length) return pick(MCMETA_FIELDS, ['animation', 'texture'])
    if (key === 'animation') return pick(MCMETA_FIELDS, ['frametime', 'interpolate', 'frames', 'width', 'height'])
    if (key === 'texture') return pick(MCMETA_FIELDS, ['blur', 'clamp', 'mipmaps'])
    if (scope[0] === 'animation' && scope[1] === 'frames' && typeof scope[2] === 'number') return [field('index', '${1:0}'), field('time', '${1:4}')]
    return []
  }
  if (/\/assets\/[^/]+\/items\/.*\.json$/.test(path)) {
    if (!scope.length) return pick(ITEM_DEFINITION_FIELDS, ['model'])
    if (scope.at(-2) === 'tints' && typeof scope.at(-1) === 'number' && itemNodePath(scope.slice(0, -2))) return [field('type', '"${1:minecraft:constant}"', uiText("ui.resourceCompletionFields.textureColourSourceType")), ...pick(itemExtra, ['index', 'value'])]
    if ((scope.at(-2) === 'entries' || scope.at(-2) === 'cases') && typeof scope.at(-1) === 'number' && itemNodePath(scope.slice(0, -2))) return [field('model', '{"type": "minecraft:empty"}'), ...pick(itemExtra, scope.at(-2) === 'entries' ? ['threshold'] : ['when'])]
    if (!itemNodePath(scope)) return []
    return [...ITEM_DEFINITION_FIELDS.filter(field => field.name !== 'model'), field('model', '"${1:minecraft:item/diamond_sword}"', uiText("ui.resourceCompletionFields.actualModelResourcesInModelsDirectoryId")), ...pick(itemExtra, ['cases'])]
  }
  if (/\/assets\/[^/]+\/atlases\/.*\.json$/.test(path)) return !scope.length ? pick(ATLAS_FIELDS, ['sources']) : scope[0] === 'sources' && typeof scope[1] === 'number' && scope.length === 2 ? ATLAS_FIELDS.filter(value => value.name !== 'sources') : []
  if (/\/assets\/[^/]+\/font\/.*\.json$/.test(path)) return !scope.length ? pick(FONT_FIELDS, ['providers']) : scope[0] === 'providers' && typeof scope[1] === 'number' && scope.length === 2 ? FONT_FIELDS.filter(value => value.name !== 'providers') : []
  if (/\/blockstates\/.*\.json$/.test(path)) {
    if (!scope.length) return pick(MODEL_FIELDS, ['variants', 'multipart'])
    if (scope[0] === 'variants' && (scope.length === 2 || scope.length === 3 && typeof scope[2] === 'number') || scope[0] === 'multipart' && scope[2] === 'apply' && (scope.length === 3 || scope.length === 4 && typeof scope[3] === 'number')) return [...pick(MODEL_FIELDS, ['model', 'x', 'y', 'uvlock', 'weight']), field('z', '${1|0,90,180,270|}')]
    if (scope[0] === 'multipart' && scope.length === 2) return [field('when', '{}'), field('apply', '{"model": "${1:minecraft:block/stone}"}')]
    return []
  }
  if (!/\/models\/.*\.json$/.test(path)) return []
  if (!scope.length) return pick(MODEL_FIELDS, modelRoot)
  if (key === 'textures') return [field('all', '"${1:minecraft:block/stone}"', uiText("ui.resourceCompletionFields.textureVariablesForParentModel")), field('layer0', '"${1:minecraft:item/diamond_sword}"', uiText("ui.resourceCompletionFields.baseLayerOfThegeneratedObject")), field('particle', '"${1:#all}"', uiText("ui.resourceCompletionFields.squareParticleTexture"))]
  if (key === 'display') return ['thirdperson_righthand', 'thirdperson_lefthand', 'firstperson_righthand', 'firstperson_lefthand', 'gui', 'head', 'ground', 'fixed'].map(name => field(name, '{\n\t"rotation": [0, 0, 0],\n\t"translation": [0, 0, 0],\n\t"scale": [1, 1, 1]\n}'))
  if (scope[0] === 'display' && scope.length === 2) return transforms
  if (scope[0] === 'elements' && typeof scope[1] === 'number') {
    if (scope.length === 2) return [field('from', '[${1:0}, ${2:0}, ${3:0}]'), field('to', '[${1:16}, ${2:16}, ${3:16}]'), field('faces', '{}'), field('rotation', '{"origin": [8, 8, 8], "axis": "${1:y}", "angle": ${2:0}, "rescale": false}'), field('shade', '${1:true}'), field('light_emission', '${1:0}')]
    if (scope[2] === 'faces' && scope.length === 3) return ['down', 'up', 'north', 'south', 'west', 'east'].map(name => field(name, '{"texture": "${1:#all}"}'))
    if (scope[2] === 'faces' && scope.length === 4) return face
    if (scope[2] === 'rotation' && scope.length === 3) return [field('origin', '[${1:8}, ${2:8}, ${3:8}]'), field('axis', '"${1|x,y,z|}"'), field('angle', '${1:0}'), field('rescale', '${1:false}')]
  }
  if (scope[0] === 'overrides' && typeof scope[1] === 'number' && scope.length === 2) return [field('predicate', '{}'), field('model', '"${1:minecraft:item/diamond_sword}"')]
  return []
}

export function referenceFolder(file: string, path: JSONPath): 'models' | 'textures' | undefined {
  const normalized = file.replace(/\\/g, '/').toLowerCase(), last = path.at(-1)
  if (/\/models\/.*\.json$/.test(normalized)) {
    if (path.length === 1 && last === 'parent' || path[0] === 'overrides' && path.length === 3 && last === 'model') return 'models'
    if (path[0] === 'textures' && path.length === 2 || path[0] === 'elements' && path.length === 5 && path[2] === 'faces' && last === 'texture') return 'textures'
  }
  if (/\/blockstates\/.*\.json$/.test(normalized) && last === 'model' && (path[0] === 'variants' && (path.length === 3 || path.length === 4 && typeof path[2] === 'number') || path[0] === 'multipart' && path[2] === 'apply' && (path.length === 4 || path.length === 5 && typeof path[3] === 'number'))) return 'models'
  if (/\/assets\/[^/]+\/items\/.*\.json$/.test(normalized) && last === 'model' && itemNodePath(path.slice(0, -1))) return 'models'
  if (/\/assets\/[^/]+\/atlases\/.*\.json$/.test(normalized) && path[0] === 'sources' && path.length === 3 && last === 'resource') return 'textures'
  return undefined
}

function itemNodePath(path: JSONPath): boolean {
  if (path[0] !== 'model') return false
  let index = 1
  while (index < path.length) {
    if (['on_true', 'on_false', 'fallback'].includes(String(path[index]))) { index++; continue }
    if (path[index] === 'models' && typeof path[index + 1] === 'number') { index += 2; continue }
    if ((path[index] === 'cases' || path[index] === 'entries') && typeof path[index + 1] === 'number' && path[index + 2] === 'model') { index += 3; continue }
    return false
  }
  return true
}
