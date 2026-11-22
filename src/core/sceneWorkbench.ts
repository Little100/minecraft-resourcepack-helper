import { uiText } from '../i18n/messages'
import { z } from 'zod'
import { PBR_PREVIEW_PROFILES, type PbrPreviewProfile } from './advanced/pbrPreview'

export const SCENE_WORKBENCH_LIMITS = Object.freeze({
  maxBlocks: 4096,
  maxCoordinate: 30_000_000,
  maxInstanceIdLength: 128,
  maxIdLength: 256,
  maxProperties: 64,
  maxMaterialProfiles: 4096,
  maxPropertyKeyLength: 64,
  maxPropertyValueLength: 256,
  maxHistory: 100,
  maxJsonLength: 128 * 1024 * 1024,
  maxGraphDepth: 32,
  maxGraphNodes: 65_536,
  maxGraphStringLength: 65_536
})

export type ScenePosition = readonly [number, number, number]
export type JsonValue = string | number | boolean | null | JsonObject | readonly JsonValue[]
export interface JsonObject { readonly [key: string]: JsonValue }

export interface PreviewBlock {
  readonly instanceId: string
  readonly id: string
  readonly position: ScenePosition
  readonly properties: Readonly<Record<string, string>>
}

export interface PreviewScene {
  readonly version: 1
  readonly blocks: readonly PreviewBlock[]
  readonly camera: {
    readonly position: ScenePosition
    readonly target: ScenePosition
    readonly projection: 'perspective' | 'orthographic'
  }
  readonly lighting: {
    readonly sunDirection: ScenePosition
    readonly sunIntensity: number
    readonly ambientIntensity: number
    readonly exposure: number
    readonly environmentIntensity: number
    readonly shadows: boolean
  }
}

export interface SceneAppearance {
  readonly previewProfile: PbrPreviewProfile
  readonly materialProfiles: Readonly<Record<string, PbrPreviewProfile>>
}

export interface SceneWorkbenchProject {
  readonly version: 1
  readonly scene: PreviewScene
  readonly materialGraph: JsonObject | null
  readonly previewProfile?: PbrPreviewProfile
  readonly materialProfiles?: Readonly<Record<string, PbrPreviewProfile>>
}

export interface SceneSnapshot {
  readonly scene: PreviewScene
  readonly selection: readonly string[]
  readonly appearance: SceneAppearance
}

const historyBrand: unique symbol = Symbol('SceneHistory')
export interface SceneHistory {
  readonly [historyBrand]: true
  readonly past: readonly SceneSnapshot[]
  readonly present: SceneSnapshot
  readonly future: readonly SceneSnapshot[]
  readonly limit: number
}

export type SceneWorkbenchErrorCode =
  | 'INVALID_DOCUMENT' | 'INVALID_BLOCK' | 'INVALID_POSITION' | 'INVALID_PROPERTIES'
  | 'INVALID_SELECTION' | 'INVALID_HISTORY' | 'INVALID_APPEARANCE' | 'INVALID_PROJECT' | 'INVALID_JSON'
  | 'PROTOTYPE_POLLUTION' | 'LIMIT_EXCEEDED' | 'DUPLICATE_INSTANCE_ID'
  | 'POSITION_OCCUPIED' | 'BLOCK_NOT_FOUND'

export class SceneWorkbenchError extends Error {
  constructor(public readonly code: SceneWorkbenchErrorCode, message: string) {
    super(message)
    this.name = 'SceneWorkbenchError'
  }
}

const limits = SCENE_WORKBENCH_LIMITS
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor'])
const coordinate = z.number().finite().int().min(-limits.maxCoordinate).max(limits.maxCoordinate).transform(value => value === 0 ? 0 : value)
const component = z.number().finite().min(-limits.maxCoordinate).max(limits.maxCoordinate).transform(value => value === 0 ? 0 : value)
const positionSchema = z.tuple([coordinate, coordinate, coordinate])
const vectorSchema = z.tuple([component, component, component])
const instanceIdSchema = z.string().min(1).max(limits.maxInstanceIdLength).regex(/^[^\s\u0000-\u001f\u007f]+$/)
const idSchema = z.string().min(1).max(limits.maxIdLength)
  .regex(/^(?:[a-z0-9_.-]+:)?[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*$/)
  .refine(value => !value.split(/[:/]/).some(part => part === '.' || part === '..'))
const propertyKeySchema = z.string().min(1).max(limits.maxPropertyKeyLength).regex(/^[a-z0-9_]+$/)
const propertyValueSchema = z.string().min(1).max(limits.maxPropertyValueLength).regex(/^[a-z0-9_.-]+$/)
const propertiesSchema = z.record(propertyKeySchema, propertyValueSchema)
  .refine(value => Object.keys(value).length <= limits.maxProperties)
const blockSchema = z.strictObject({
  instanceId: instanceIdSchema.optional(),
  uid: instanceIdSchema.optional(),
  id: idSchema,
  position: positionSchema,
  properties: propertiesSchema.default({})
}).refine(block => Boolean(block.instanceId || block.uid) && (!block.instanceId || !block.uid || block.instanceId === block.uid), {
  message: uiText("core.sceneWorkbench.uniqueBlockInstanceId")
})
const cameraSchema = z.strictObject({
  position: vectorSchema.default([8, 6, 8]),
  target: vectorSchema.default([0.5, 0.5, 0.5]),
  projection: z.enum(['perspective', 'orthographic']).default('perspective')
}).refine(camera => camera.position.some((value, axis) => value !== camera.target[axis]), { message: uiText("core.sceneWorkbench.cameraPositionCannotOverlapWithTarget") })
const lightingSchema = z.strictObject({
  sunDirection: vectorSchema.default([-0.4, 1, 0.6]),
  sunIntensity: z.number().finite().min(0).max(20).default(3),
  ambientIntensity: z.number().finite().min(0).max(20).default(0.5),
  exposure: z.number().finite().min(0.01).max(20).default(1),
  environmentIntensity: z.number().finite().min(0).max(20).default(0.6),
  shadows: z.boolean().default(true)
}).refine(lighting => lighting.sunDirection.some(value => value !== 0), { message: uiText("core.sceneWorkbench.theLightCanTBeZero") })
const sceneSchema = z.strictObject({
  version: z.literal(1),
  blocks: z.array(blockSchema).max(limits.maxBlocks),
  camera: cameraSchema.prefault({}),
  lighting: lightingSchema.prefault({})
})

function fail(code: SceneWorkbenchErrorCode, message: string): never {
  throw new SceneWorkbenchError(code, message)
}

// 在结构校验前拒绝访问器、继承字段和危险键
function assertData(input: unknown, code: SceneWorkbenchErrorCode, depth = 0, ancestors = new Set<object>()): void {
  if (input === null || typeof input !== 'object') {
    if (input !== null && !['string', 'number', 'boolean', 'undefined'].includes(typeof input)) fail(code, uiText("core.sceneWorkbench.onlyNormalJsonDataCanBeUsed"))
    return
  }
  if (depth > 8 || ancestors.has(input)) fail(code, uiText("core.sceneWorkbench.dataEmbeddedTooDeepOrThereIs"))
  const array = Array.isArray(input)
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) fail('PROTOTYPE_POLLUTION', uiText("core.sceneWorkbench.banCustomPrototypes"))
  if (array && input.length > limits.maxBlocks) fail('LIMIT_EXCEEDED', uiText("core.sceneWorkbench.theLengthOfTheArrayExceedsThe"))
  const keys = Reflect.ownKeys(input)
  if (!array && keys.length > limits.maxProperties) fail('LIMIT_EXCEEDED', uiText("core.sceneWorkbench.objectFieldNumberExceedingUpperLimit"))
  if (array && keys.length !== input.length + 1) fail(code, uiText("core.sceneWorkbench.numericalsCannotContainEmptyOrExtraFields"))
  ancestors.add(input)
  for (const key of keys) {
    if (array && key === 'length') continue
    if (typeof key !== 'string') fail(code, uiText("core.sceneWorkbench.disableSymbolFields"))
    if (forbiddenKeys.has(key)) fail('PROTOTYPE_POLLUTION', uiText("core.sceneWorkbench.banDangerousFields", key))
    if (array && !/^(0|[1-9]\d*)$/.test(key)) fail(code, uiText("core.sceneWorkbench.numericalsCannotContainExtraFields"))
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!
    if (!('value' in descriptor) || !descriptor.enumerable) fail(code, uiText("core.sceneWorkbench.disableAccessorOrHideField"))
    assertData(descriptor.value, code, depth + 1, ancestors)
  }
  ancestors.delete(input)
}

function parseData<T>(schema: z.ZodType<T>, input: unknown, code: SceneWorkbenchErrorCode): T {
  assertData(input, code)
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    fail(code, uiText("core.sceneWorkbench.invalidField", issue.path.join('.') || uiText("core.sceneWorkbench.document"), issue.message))
  }
  return parsed.data
}

function vector(input: readonly number[]): ScenePosition {
  return Object.freeze([input[0], input[1], input[2]]) as ScenePosition
}

function positionKey(position: ScenePosition): string {
  return position.join(',')
}

function comparePositions(left: ScenePosition, right: ScenePosition): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
}

function freezeBlock(block: z.infer<typeof blockSchema>): PreviewBlock {
  return Object.freeze({
    instanceId: block.instanceId ?? block.uid!,
    id: block.id,
    position: vector(block.position),
    properties: Object.freeze(Object.fromEntries(Object.keys(block.properties).sort().map(key => [key, block.properties[key]])))
  })
}

function makeScene(blocks: readonly PreviewBlock[], source: Pick<PreviewScene, 'camera' | 'lighting'>): PreviewScene {
  if (blocks.length > limits.maxBlocks) fail('LIMIT_EXCEEDED', uiText("core.advanced.shaderGraph.blockLimit", limits.maxBlocks))
  const ids = new Set<string>(), positions = new Set<string>()
  for (const block of blocks) {
    if (ids.has(block.instanceId)) fail('DUPLICATE_INSTANCE_ID', uiText("core.sceneWorkbench.exampleIdRepeat", block.instanceId))
    const key = positionKey(block.position)
    if (positions.has(key)) fail('POSITION_OCCUPIED', uiText("core.sceneWorkbench.coordinateAlreadyHasSquares", key))
    ids.add(block.instanceId)
    positions.add(key)
  }
  return Object.freeze({ version: 1, blocks: Object.freeze([...blocks].sort((a, b) => comparePositions(a.position, b.position))), camera: source.camera, lighting: source.lighting })
}

export function parsePreviewScene(input: unknown): PreviewScene {
  const parsed = parseData(sceneSchema, input, 'INVALID_DOCUMENT')
  return makeScene(parsed.blocks.map(freezeBlock), {
    camera: Object.freeze({ position: vector(parsed.camera.position), target: vector(parsed.camera.target), projection: parsed.camera.projection }),
    lighting: Object.freeze({ ...parsed.lighting, sunDirection: vector(parsed.lighting.sunDirection) })
  })
}

export function createPreviewScene(input: unknown = { version: 1, blocks: [] }): PreviewScene {
  return parsePreviewScene(Array.isArray(input) ? { version: 1, blocks: input } : input)
}

function requireBlock(scene: PreviewScene, instanceId: string): PreviewBlock {
  const id = parseData(instanceIdSchema, instanceId, 'INVALID_BLOCK')
  const block = scene.blocks.find(value => value.instanceId === id)
  if (!block) fail('BLOCK_NOT_FOUND', uiText("core.sceneWorkbench.exampleDoesNotExist", id))
  return block
}

export function addBlock(scene: PreviewScene, input: unknown): PreviewScene {
  const current = parsePreviewScene(scene)
  const block = freezeBlock(parseData(blockSchema, input, 'INVALID_BLOCK'))
  return makeScene([...current.blocks, block], current)
}

export function deleteBlock(scene: PreviewScene, instanceId: string): PreviewScene {
  const current = parsePreviewScene(scene)
  const block = requireBlock(current, instanceId)
  return makeScene(current.blocks.filter(value => value.instanceId !== block.instanceId), current)
}

export function moveBlock(scene: PreviewScene, instanceId: string, position: ScenePosition): PreviewScene {
  const current = parsePreviewScene(scene)
  const target = vector(parseData(positionSchema, position, 'INVALID_POSITION'))
  const block = requireBlock(current, instanceId)
  return makeScene(current.blocks.map(value => value.instanceId === block.instanceId ? Object.freeze({ ...block, position: target }) : value), current)
}

export function copyBlock(scene: PreviewScene, instanceId: string, newInstanceId: string, position: ScenePosition): PreviewScene {
  const current = parsePreviewScene(scene)
  const source = requireBlock(current, instanceId)
  const copy = freezeBlock(parseData(blockSchema, { ...source, instanceId: newInstanceId, position }, 'INVALID_BLOCK'))
  return makeScene([...current.blocks, copy], current)
}

// 属性更新采用完整替换，删除属性时省略相应键
export function updateBlockProperties(scene: PreviewScene, instanceId: string, properties: Readonly<Record<string, string>>): PreviewScene {
  const current = parsePreviewScene(scene)
  const block = requireBlock(current, instanceId)
  const replacement = freezeBlock({ ...block, position: [...block.position], properties: parseData(propertiesSchema, properties, 'INVALID_PROPERTIES') })
  return makeScene(current.blocks.map(value => value.instanceId === block.instanceId ? replacement : value), current)
}

export function getBlock(scene: PreviewScene, instanceId: string): PreviewBlock | undefined {
  const current = parsePreviewScene(scene)
  const id = parseData(instanceIdSchema, instanceId, 'INVALID_BLOCK')
  return current.blocks.find(block => block.instanceId === id)
}

export function getBlockAt(scene: PreviewScene, position: ScenePosition): PreviewBlock | undefined {
  const current = parsePreviewScene(scene)
  const key = positionKey(vector(parseData(positionSchema, position, 'INVALID_POSITION')))
  return current.blocks.find(block => positionKey(block.position) === key)
}

export function getAdjacentBlocks(scene: PreviewScene, position: ScenePosition): readonly PreviewBlock[] {
  const current = parsePreviewScene(scene)
  const center = parseData(positionSchema, position, 'INVALID_POSITION')
  return Object.freeze(current.blocks.filter(block => block.position.reduce((distance, value, axis) => distance + Math.abs(value - center[axis]), 0) === 1))
}

function dataProperties(input: unknown, code: SceneWorkbenchErrorCode, label: string): PropertyDescriptorMap {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(code, label + uiText("core.sceneWorkbench.mustBeAnObject"))
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) fail('PROTOTYPE_POLLUTION', label + uiText("core.sceneWorkbench.banCustomPrototypes"))
  const keys = Reflect.ownKeys(input)
  if (keys.some(key => typeof key === 'string' && forbiddenKeys.has(key))) fail('PROTOTYPE_POLLUTION', label + uiText("core.sceneWorkbench.dangerousFields"))
  if (keys.some(key => typeof key !== 'string')) fail(code, label + uiText("core.sceneWorkbench.disableSymbolFields"))
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (Object.values(descriptors).some(value => !('value' in value) || !value.enumerable)) fail(code, label + uiText("core.sceneWorkbench.disableAccessorOrHideField"))
  return descriptors
}

function parsePreviewProfile(input: unknown, code: SceneWorkbenchErrorCode): PbrPreviewProfile {
  if (typeof input !== 'string' || !PBR_PREVIEW_PROFILES.includes(input as PbrPreviewProfile)) fail(code, uiText("core.sceneWorkbench.unknownPbrPreviewEncoding"))
  return input as PbrPreviewProfile
}

function parseMaterialProfiles(input: unknown, code: SceneWorkbenchErrorCode): Readonly<Record<string, PbrPreviewProfile>> {
  const descriptors = dataProperties(input, code, uiText("core.sceneWorkbench.materialEncodingMap"))
  const keys = Object.keys(descriptors)
  if (keys.length > limits.maxMaterialProfiles) fail('LIMIT_EXCEEDED', uiText("core.sceneWorkbench.theNumberOfMaterialsCodedExceededThe"))
  return Object.freeze(Object.fromEntries(keys.sort().map(key => {
    if (!idSchema.safeParse(key).success) fail(code, uiText("core.sceneWorkbench.materialResourceIdInvalid", key))
    return [key, parsePreviewProfile(descriptors[key].value, code)]
  })))
}

const defaultAppearance: SceneAppearance = Object.freeze({ previewProfile: 'labPBR', materialProfiles: Object.freeze({}) })

function parseAppearance(input: unknown): SceneAppearance {
  const descriptors = dataProperties(input, 'INVALID_APPEARANCE', uiText("core.sceneWorkbench.sceneLook"))
  const keys = Object.keys(descriptors)
  if (keys.length !== 2 || !descriptors.previewProfile || !descriptors.materialProfiles) fail('INVALID_APPEARANCE', uiText("core.sceneWorkbench.theSceneMustContainOnlyTheViewprofile"))
  return Object.freeze({
    previewProfile: parsePreviewProfile(descriptors.previewProfile.value, 'INVALID_APPEARANCE'),
    materialProfiles: parseMaterialProfiles(descriptors.materialProfiles.value, 'INVALID_APPEARANCE')
  })
}

function makeSnapshot(scene: PreviewScene, instanceIds: readonly string[], appearance: SceneAppearance): SceneSnapshot {
  const ids = parseData(z.array(instanceIdSchema).max(limits.maxBlocks), instanceIds, 'INVALID_SELECTION')
  const available = new Set(scene.blocks.map(block => block.instanceId))
  for (const id of ids) if (!available.has(id)) fail('BLOCK_NOT_FOUND', uiText("core.sceneWorkbench.noExamplesOfChoosingAConcentration", id))
  return Object.freeze({ scene, selection: Object.freeze([...new Set(ids)].sort()), appearance })
}

// 历史状态由工厂创建并共享不可变快照
function makeHistory(past: readonly SceneSnapshot[], present: SceneSnapshot, future: readonly SceneSnapshot[], limit: number): SceneHistory {
  const result = { past: Object.freeze([...past]), present, future: Object.freeze([...future]), limit }
  Object.defineProperty(result, historyBrand, { value: true })
  return Object.freeze(result) as SceneHistory
}

function assertHistory(history: SceneHistory): void {
  if (!history || Object.getOwnPropertyDescriptor(history, historyBrand)?.value !== true || !Object.isFrozen(history)) fail('INVALID_HISTORY', uiText("core.sceneWorkbench.historyMustBeCreatedByCreatescenehistory"))
}

export function createSceneHistory(scene: PreviewScene = createPreviewScene(), limit: number = limits.maxHistory, appearance: SceneAppearance = defaultAppearance): SceneHistory {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > limits.maxHistory) fail('INVALID_HISTORY', uiText("core.sceneWorkbench.theHistoricalCapacityMustBe", limits.maxHistory))
  return makeHistory([], makeSnapshot(parsePreviewScene(scene), [], parseAppearance(appearance)), [], limit)
}

export function selectBlocks(history: SceneHistory, instanceIds: readonly string[]): SceneHistory {
  assertHistory(history)
  return makeHistory(history.past, makeSnapshot(history.present.scene, instanceIds, history.present.appearance), history.future, history.limit)
}

export function commitScene(history: SceneHistory, scene: PreviewScene, selection?: readonly string[], appearance?: SceneAppearance): SceneHistory {
  assertHistory(history)
  const current = parsePreviewScene(scene)
  const available = new Set(current.blocks.map(block => block.instanceId))
  const present = makeSnapshot(current, selection ?? history.present.selection.filter(id => available.has(id)), appearance === undefined ? history.present.appearance : parseAppearance(appearance))
  if (JSON.stringify(current) === JSON.stringify(history.present.scene) && JSON.stringify(present.appearance) === JSON.stringify(history.present.appearance)) return makeHistory(history.past, present, history.future, history.limit)
  return makeHistory([...history.past, history.present].slice(-history.limit), present, [], history.limit)
}

export function undo(history: SceneHistory): SceneHistory {
  assertHistory(history)
  const previous = history.past.at(-1)
  if (!previous) return history
  return makeHistory(history.past.slice(0, -1), previous, [history.present, ...history.future], history.limit)
}

export function redo(history: SceneHistory): SceneHistory {
  assertHistory(history)
  const next = history.future[0]
  if (!next) return history
  return makeHistory([...history.past, history.present].slice(-history.limit), next, history.future.slice(1), history.limit)
}

export function canUndo(history: SceneHistory): boolean {
  assertHistory(history)
  return history.past.length > 0
}

export function canRedo(history: SceneHistory): boolean {
  assertHistory(history)
  return history.future.length > 0
}

function parseJson(text: string): unknown {
  if (typeof text !== 'string') fail('INVALID_JSON', uiText("core.sceneWorkbench.jsonInputMustBeStringed"))
  if (text.length > limits.maxJsonLength) fail('LIMIT_EXCEEDED', uiText("core.sceneWorkbench.jsonLengthInExcessOfMaximum"))
  try { return JSON.parse(text) } catch { return fail('INVALID_JSON', uiText("core.sceneWorkbench.jsonCouldNotParse")) }
}

export function serializePreviewScene(scene: PreviewScene): string {
  return `${JSON.stringify(parsePreviewScene(scene), null, 2)}\n`
}

export function deserializePreviewScene(json: string): PreviewScene {
  return parsePreviewScene(parseJson(json))
}

// 材质图保留宿主定义的格式，仅接受有界的安全 JSON 数据
function cloneGraph(input: unknown): JsonObject | null {
  let nodes = 0
  const ancestors = new Set<object>()
  function visit(value: unknown, depth: number): JsonValue {
    if (++nodes > limits.maxGraphNodes || depth > limits.maxGraphDepth) fail('LIMIT_EXCEEDED', uiText("core.sceneWorkbench.materialMapSizeOrDepthAboveUpper"))
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value === 0 ? 0 : value
    if (typeof value === 'string') {
      if (value.length > limits.maxGraphStringLength) fail('LIMIT_EXCEEDED', uiText("core.sceneWorkbench.theMaterialMapStringExceedsTheUpper"))
      return value
    }
    if (typeof value !== 'object' || ancestors.has(value)) fail('INVALID_PROJECT', uiText("core.sceneWorkbench.theMaterialMapMustBeANon"))
    const array = Array.isArray(value)
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) fail('PROTOTYPE_POLLUTION', uiText("core.sceneWorkbench.materialMapBanCustomPrototypes"))
    const keys = Reflect.ownKeys(value)
    if (keys.length > limits.maxGraphNodes || (array && (value.length > limits.maxGraphNodes || keys.length !== value.length + 1))) fail('INVALID_PROJECT', uiText("core.sceneWorkbench.invalidMaterialMapArrayOrObjectStructure"))
    ancestors.add(value)
    const entries: Array<readonly [string, JsonValue]> = []
    for (const key of keys) {
      if (array && key === 'length') continue
      if (typeof key !== 'string') fail('INVALID_PROJECT', uiText("core.sceneWorkbench.materialMapBanSymbolsFields"))
      if (forbiddenKeys.has(key)) fail('PROTOTYPE_POLLUTION', uiText("core.sceneWorkbench.materialMapBanDangerousFields", key))
      if (key.length > limits.maxGraphStringLength || (array && !/^(0|[1-9]\d*)$/.test(key))) fail('INVALID_PROJECT', uiText("core.sceneWorkbench.invalidMaterialMapField"))
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if (!('value' in descriptor) || !descriptor.enumerable) fail('INVALID_PROJECT', uiText("core.sceneWorkbench.materialMapForbidsAccessorOrHideField"))
      entries.push([key, visit(descriptor.value, depth + 1)])
    }
    ancestors.delete(value)
    if (array) return Object.freeze(entries.map(entry => entry[1]))
    entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    return Object.freeze(Object.fromEntries(entries))
  }
  if (input === null) return null
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_PROJECT', uiText("core.sceneWorkbench.materiangraphMustBeAJsonObjectOr"))
  return visit(input, 0) as JsonObject
}

export function createSceneWorkbenchProject(scene: PreviewScene, materialGraph: JsonObject | null = null, previewProfile?: PbrPreviewProfile, materialProfiles?: Readonly<Record<string, PbrPreviewProfile>>): SceneWorkbenchProject {
  return Object.freeze({
    version: 1,
    scene: parsePreviewScene(scene),
    materialGraph: cloneGraph(materialGraph),
    ...(previewProfile === undefined ? {} : { previewProfile: parsePreviewProfile(previewProfile, 'INVALID_PROJECT') }),
    ...(materialProfiles === undefined ? {} : { materialProfiles: parseMaterialProfiles(materialProfiles, 'INVALID_PROJECT') })
  })
}

function parseProject(input: unknown): SceneWorkbenchProject {
  const descriptors = dataProperties(input, 'INVALID_PROJECT', uiText("core.sceneWorkbench.desktopProject"))
  const keys = Object.keys(descriptors)
  if (keys.length < 3 || keys.length > 5 || keys.some(key => !['version', 'scene', 'materialGraph', 'previewProfile', 'materialProfiles'].includes(key))) fail('INVALID_PROJECT', uiText("core.sceneWorkbench.workspaceProjectWithUnknownFields"))
  if (!descriptors.version || !descriptors.scene || !descriptors.materialGraph) fail('INVALID_PROJECT', uiText("core.sceneWorkbench.theWorkspaceProjectMissingTheNecessaryFields"))
  if (descriptors.version.value !== 1) fail('INVALID_PROJECT', uiText("core.sceneWorkbench.theDesktopProjectVersionIsNotSupported"))
  return createSceneWorkbenchProject(descriptors.scene.value, descriptors.materialGraph.value, descriptors.previewProfile?.value, descriptors.materialProfiles?.value)
}

export function serializeSceneWorkbenchProject(project: SceneWorkbenchProject): string {
  const json = `${JSON.stringify(parseProject(project), null, 2)}\n`
  if (json.length > limits.maxJsonLength) fail('LIMIT_EXCEEDED', uiText("core.sceneWorkbench.workspaceProjectLengthExceedingUpperLimit"))
  return json
}

export function deserializeSceneWorkbenchProject(json: string): SceneWorkbenchProject {
  return parseProject(parseJson(json))
}
