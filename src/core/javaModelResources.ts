import { uiText } from '../i18n/messages'
import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { z } from 'zod'
import type { ModelPreviewAssets } from './modelPreviewAssets'

export type JavaModelData = Record<string, unknown>

export interface JavaModelTexture {
  slot: string
  reference: string
  resolved?: string
  path?: string
  source?: string
  missing?: boolean
}

export interface JavaModelSnapshot {
  path: string
  raw: JavaModelData
  effective: JavaModelData
  inherited?: JavaModelData
  revision: string
  localExists: boolean
  textures: JavaModelTexture[]
  warnings: string[]
}

export const JAVA_MODEL_LIMITS = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxDepth: 64,
  maxNodes: 200_000,
  maxString: 32_768,
  maxPath: 512,
  maxElements: 4096,
  maxTextures: 4096,
  maxParents: 64
})

const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor'])
const directions = ['north', 'south', 'east', 'west', 'up', 'down'] as const
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)
const object = (value: unknown): value is JavaModelData => value !== null && typeof value === 'object' && !Array.isArray(value)
const segment = /^[a-z0-9_.-]+$/
const device = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

function safeParts(value: string): boolean {
  return value.split('/').every(part => segment.test(part) && part !== '.' && part !== '..' && !part.endsWith('.') && !device.test(part))
}

export function validJavaModelTextureSlot(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && /^[A-Za-z0-9_.-]+$/.test(value) && !dangerousKeys.has(value) && value !== '.' && value !== '..'
}

export function validateJavaModelResourceId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > JAVA_MODEL_LIMITS.maxPath) throw new Error(uiText("core.javaModelResources.resourceIdMustBeALimitedString"))
  const parts = value.split(':')
  if (parts.length > 2 || !parts.every(safeParts) || (parts.length === 2 && parts[0].includes('/'))) throw new Error(uiText("core.javaModelResources.resourceIdContainsAnIllegalNamespacePath"))
}

export function javaModelResourcePath(value: string, category: 'models' | 'textures'): string {
  validateJavaModelResourceId(value)
  const parts = value.split(':')
  const namespace = parts.length === 2 ? parts[0] : 'minecraft'
  return `assets/${namespace}/${category}/${parts.at(-1)}${category === 'models' ? '.json' : '.png'}`
}

export function validJavaModelResourcePath(value: unknown, category: 'models' | 'textures' = 'models'): value is string {
  if (typeof value !== 'string' || value.length > JAVA_MODEL_LIMITS.maxPath || !safeParts(value)) return false
  const parts = value.split('/')
  const suffix = category === 'models' ? '.json' : '.png'
  return parts.length >= 4 && parts[0] === 'assets' && parts[2] === category
    && parts.at(-1)!.endsWith(suffix) && parts.at(-1)!.length > suffix.length
}

export function javaModelTextureReference(relative: string): string {
  if (!validJavaModelResourcePath(relative, 'textures')) throw new Error(uiText("core.javaModelResources.pasteMustBeAValidPngPath"))
  const parts = relative.split('/')
  return parts[1] + ':' + parts.slice(3).join('/').slice(0, -4)
}

export function javaModelTextureSprite(value: unknown): string | undefined {
  return typeof value === 'string' ? value : object(value) && typeof value.sprite === 'string' ? value.sprite : undefined
}

function textureReference(value: unknown): boolean {
  const reference = javaModelTextureSprite(value)
  if (reference === undefined) return false
  if (reference.startsWith('#')) return validJavaModelTextureSlot(reference.slice(1))
  try { validateJavaModelResourceId(reference); return true } catch { return false }
}

const finite = z.number().finite()
const bounded = (min: number, max: number) => finite.min(min).max(max)
const vector = (min: number, max: number) => z.tuple([bounded(min, max), bounded(min, max), bounded(min, max)])
const rotationSchema = z.object({
  origin: vector(-1024, 1024).optional(),
  axis: z.enum(['x', 'y', 'z']).optional(),
  angle: bounded(-360, 360).optional(),
  x: bounded(-360, 360).optional(),
  y: bounded(-360, 360).optional(),
  z: bounded(-360, 360).optional(),
  rescale: z.boolean().optional()
}).passthrough().refine(value => (value.axis !== undefined && value.angle !== undefined)
  || value.x !== undefined || value.y !== undefined || value.z !== undefined, uiText("core.javaModelResources.rotationRequiresASingleOrMultiAxis"))
const faceSchema = z.object({
  texture: z.string().refine(textureReference, uiText("core.javaModelResources.textureReferenceInvalid")),
  uv: z.tuple([bounded(-1024, 1024), bounded(-1024, 1024), bounded(-1024, 1024), bounded(-1024, 1024)]).optional(),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
  cullface: z.enum(directions).optional(),
  tintindex: finite.int().min(-1).max(65535).optional()
}).passthrough()
const elementSchema = z.object({
  from: vector(-16, 32),
  to: vector(-16, 32),
  rotation: rotationSchema.optional(),
  faces: z.partialRecord(z.enum(directions), faceSchema).optional(),
  shade: z.boolean().optional(),
  light_emission: finite.int().min(0).max(15).optional()
}).passthrough()
const displaySchema = z.object({
  rotation: vector(-360, 360).optional(),
  translation: vector(-80, 80).optional(),
  scale: vector(-4, 4).optional()
}).passthrough()
const modelSchema = z.object({
  parent: z.string().refine(value => { try { validateJavaModelResourceId(value); return true } catch { return false } }, uiText("core.javaModelResources.invalidParentResourceId")).optional(),
  textures: z.record(z.string().refine(validJavaModelTextureSlot, uiText("core.javaModelResources.textureSlotNameInvalid")), z.unknown().refine(textureReference, uiText("core.javaModelResources.textureRequiresAValidReferenceOrSprite")))
    .refine(value => Object.keys(value).length <= JAVA_MODEL_LIMITS.maxTextures, uiText("core.javaModelResources.tooManyTextureSlots")).optional(),
  elements: z.array(elementSchema).max(JAVA_MODEL_LIMITS.maxElements).optional(),
  display: z.record(z.string(), displaySchema).optional(),
  ambientocclusion: z.boolean().optional(),
  gui_light: z.enum(['front', 'side']).optional()
}).passthrough()

// 检查整个 JSON 树，未知字段也不能携带危险键或非 JSON 值
export function validateJavaModel(value: unknown): asserts value is JavaModelData {
  if (!object(value)) throw new Error(uiText("core.javaModelResources.javaModelMustBeAJsonObject"))
  const visited = new Set<object>()
  let nodes = 0
  let serializedBytes = 0
  const consume = (bytes: number): void => {
    serializedBytes += bytes
    if (serializedBytes > JAVA_MODEL_LIMITS.maxBytes) throw new Error(uiText("core.javaModelResources.modelJsonExceedsSizeLimit"))
  }
  const walk = (item: unknown, depth: number): void => {
    if (++nodes > JAVA_MODEL_LIMITS.maxNodes || depth > JAVA_MODEL_LIMITS.maxDepth) throw new Error(uiText("core.javaModelResources.theModelIsTooBigOrEmbedded"))
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error(uiText("core.javaModelResources.modelNumbersMustBeLimited"))
      consume(Buffer.byteLength(JSON.stringify(item), 'utf8'))
      return
    }
    if (typeof item === 'string') {
      if (item.length > JAVA_MODEL_LIMITS.maxString) throw new Error(uiText("core.javaModelResources.modelStringTooLong"))
      consume(Buffer.byteLength(JSON.stringify(item), 'utf8'))
      return
    }
    if (item === null || typeof item === 'boolean') { consume(item === null || item === true ? 4 : 5); return }
    if (typeof item !== 'object') throw new Error(uiText("core.javaModelResources.modelCanOnlyContainJsonData"))
    if (visited.has(item)) throw new Error(uiText("core.javaModelResources.modelCannotContainCircularObjects"))
    visited.add(item)
    const proto: unknown = Object.getPrototypeOf(item)
    if (Array.isArray(item) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new Error(uiText("core.javaModelResources.modelContainsNonOrdinaryObjects"))
    const array = Array.isArray(item)
    if (array && item.length > JAVA_MODEL_LIMITS.maxNodes) throw new Error(uiText("core.javaModelResources.modelArraysAreTooBig"))
    const keys = Object.keys(item)
    if (keys.length > JAVA_MODEL_LIMITS.maxNodes) throw new Error(uiText("core.javaModelResources.theModelObjectIsTooBig"))
    if (array && (keys.length !== item.length || keys.some((key, index) => key !== String(index)))) throw new Error(uiText("core.javaModelResources.modelArraysCannotContainEmptySpacesOr"))
    consume(2 + Math.max(0, keys.length - 1))
    if (Reflect.ownKeys(item).some(key => typeof key !== 'string')) throw new Error(uiText("core.javaModelResources.modelCannotContainSymbolKey"))
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && key === 'length') continue
      if (dangerousKeys.has(key) || key.length > 256 || !descriptor.enumerable || !own(descriptor, 'value')) throw new Error(uiText("core.javaModelResources.modelContainsHazardKeysOrProperties"))
      if (!array) consume(Buffer.byteLength(JSON.stringify(key), 'utf8') + 1)
      walk(descriptor.value, depth + 1)
    }
    visited.delete(item)
  }
  walk(value, 0)
  if (object(value.meta) && typeof value.meta.model_format === 'string' && Array.isArray(value.outliner) || own(value, 'minecraft:geometry')) throw new Error(uiText("core.javaModelResources.onlyJavaModelsJsonSupportedNotBbmodel"))
  const result = modelSchema.safeParse(value)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new Error(uiText("core.javaModelResources.javaModelFieldIsInvalid", issue.path.join('.'), issue.message))
  }
}

export interface JavaModelTextureResolution { resolved?: string; path?: string; warning?: string }

export function resolveJavaModelTexture(textures: JavaModelData, reference: string): JavaModelTextureResolution {
  let current = reference
  const seen = new Set<string>()
  while (current.startsWith('#')) {
    const slot = current.slice(1)
    if (!validJavaModelTextureSlot(slot)) return { warning: uiText("core.javaModelResources.textureSlotNameInvalid_6e05c0", slot) }
    if (seen.has(slot)) return { warning: uiText("core.javaModelResources.textureAliasesCycle", [...seen, slot].join(' -> ')) }
    if (seen.size >= JAVA_MODEL_LIMITS.maxParents) return { warning: uiText("core.javaModelResources.theTextureOfTheAliasesIsToo", slot) }
    seen.add(slot)
    const next = own(textures, slot) ? javaModelTextureSprite(textures[slot]) : undefined
    if (next === undefined) return { warning: uiText("core.javaModelResources.missingTextureSlot", slot) }
    current = next
  }
  validateJavaModelResourceId(current)
  return { resolved: current.includes(':') ? current : 'minecraft:' + current, path: javaModelResourcePath(current, 'textures') }
}

export async function loadJavaModelSnapshot(assets: ModelPreviewAssets, relative: string): Promise<JavaModelSnapshot> {
  if (!validJavaModelResourcePath(relative)) throw new Error(uiText("core.javaModelResources.theModelPathMustBeJavaModers"))
  const warnings = new Set<string>()
  const revision = createHash('sha256')
  const loaded = new Map<string, { raw: JavaModelData; layer: number } | undefined>()
  let localExists = false
  const read = async (file: string): Promise<{ raw: JavaModelData; layer: number } | undefined> => {
    if (loaded.has(file)) return loaded.get(file)
    for (let layer = 0; layer < assets.roots.length; layer++) {
      const bytes = await assets.read(file, layer)
      if (bytes === undefined) continue
      if (bytes.byteLength > JAVA_MODEL_LIMITS.maxBytes) throw new Error(uiText("core.javaModelResources.modelJsonExceedsSizeLimit"))
      const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''))
      validateJavaModel(raw)
      revision.update(JSON.stringify([file, layer, bytes.byteLength])).update(bytes)
      const result = { raw, layer }
      loaded.set(file, result)
      return result
    }
    revision.update(JSON.stringify([file, 'missing']))
    loaded.set(file, undefined)
    return undefined
  }
  let inherited: JavaModelData = {}
  const merge = async (file: string, ancestors: Set<string>): Promise<JavaModelData> => {
    if (ancestors.has(file)) { warnings.add(uiText("core.javaModelResources.modelParentInheritanceCycle", file)); return {} }
    if (ancestors.size >= Math.min(assets.limits.maxModelDepth, JAVA_MODEL_LIMITS.maxParents)) { warnings.add(uiText("core.javaModelResources.modelParentInheritsTooDeep", file)); return {} }
    const entry = await read(file)
    if (!entry) { warnings.add(uiText("core.javaModelResources.missingModel", file)); return {} }
    const raw = entry.raw
    let parent: JavaModelData = {}
    if (typeof raw.parent === 'string') {
      const parentPath = javaModelResourcePath(raw.parent, 'models')
      if (!/^assets\/minecraft\/models\/builtin\/(?:generated|entity)\.json$/.test(parentPath)) parent = await merge(parentPath, new Set([...ancestors, file]))
    }
    if (file === relative && ancestors.size === 0) inherited = parent
    const effective: JavaModelData = { ...parent, ...raw, textures: { ...(parent.textures as JavaModelData | undefined), ...(raw.textures as JavaModelData | undefined) } }
    if (parent.display !== undefined || raw.display !== undefined) effective.display = { ...(parent.display as JavaModelData | undefined), ...(raw.display as JavaModelData | undefined) }
    delete effective.parent
    return effective
  }
  const initial = await read(relative)
  localExists = initial?.layer === 0
  const effective = await merge(relative, new Set())
  validateJavaModel(effective)
  validateJavaModel(inherited)
  const raw = initial?.raw ?? {}
  const variables = (effective.textures ?? {}) as JavaModelData
  const references = new Map<string, string>(Object.entries(variables).map(([slot, value]) => [slot, javaModelTextureSprite(value)!]))
  for (const element of (effective.elements ?? []) as JavaModelData[]) {
    for (const face of Object.values((element.faces ?? {}) as JavaModelData) as JavaModelData[]) {
      const reference = face.texture as string
      if (reference.startsWith('#')) {
        const slot = reference.slice(1)
        if (!references.has(slot)) references.set(slot, reference)
      } else if (!references.has(reference)) references.set(reference, reference)
    }
  }
  const locations = new Map<string, string | undefined>()
  const textures: JavaModelTexture[] = []
  for (const [slot, reference] of references) {
    const resolution = resolveJavaModelTexture(variables, reference)
    if (resolution.warning) warnings.add(resolution.warning)
    let source: string | undefined
    if (resolution.path) {
      if (!locations.has(resolution.path)) {
        let located: string | undefined
        for (let layer = 0; layer < assets.roots.length; layer++) {
          if (await assets.read(resolution.path, layer) !== undefined) { located = layer === 0 ? 'pack' : 'base'; break }
        }
        locations.set(resolution.path, located)
      }
      source = locations.get(resolution.path)
      if (!source) warnings.add(uiText("core.javaModelResources.missingPaste", resolution.path))
    }
    textures.push({ slot, reference, ...(resolution.resolved ? { resolved: resolution.resolved, path: resolution.path } : {}), ...(source ? { source } : {}), ...(!source ? { missing: true } : {}) })
  }
  // 修改复制出来的草稿不会改到父模型
  return { path: relative, raw: structuredClone(raw), effective: structuredClone(effective), inherited: structuredClone(inherited), revision: revision.digest('hex'), localExists, textures, warnings: [...warnings] }
}





