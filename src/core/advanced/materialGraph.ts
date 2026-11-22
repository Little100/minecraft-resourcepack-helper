import { uiText } from '../../i18n/messages'
import { z } from 'zod'
import { PBR_LIGHTING_GLSL } from './pbrLighting'

export const MATERIAL_GRAPH_LIMITS = Object.freeze({
  maxNodes: 128,
  maxIdLength: 128,
  maxExpressionLength: 120000,
  maxNumber: 1000000,
  maxDepth: 128
})

export const MATERIAL_DEBUG_MODES = Object.freeze({
  final: 0,
  baseColor: 1,
  normal: 2,
  roughness: 3,
  metallic: 4,
  emissive: 5,
  ao: 6
} as const)

export type MaterialValueType = 'float' | 'vec2' | 'vec3' | 'vec4'
export type MaterialNodeType = 'scalar' | 'color' | 'uv' | 'time' | 'texture' | 'add' | 'multiply' | 'mix' | 'clamp' | 'scroll' | 'rotate' | 'noise' | 'sine' | 'smoothstep' | 'fresnel' | 'checker' | 'tint' | 'output'
export type MaterialPort = 'baseColor' | 'roughness' | 'metallic' | 'emissive' | 'normal' | 'ao'
export type MaterialTextureChannel = 'albedo' | 'normal' | 'roughness' | 'metallic' | 'emissive' | 'ao'

export interface MaterialGraphNode {
  id: string
  type: MaterialNodeType
  inputs?: Record<string, string>
  params?: Record<string, unknown>
}

export interface MaterialGraph {
  version: 1
  nodes: MaterialGraphNode[]
  output: string
}

export type MaterialUniformName = 'uTime' | 'uAlbedo' | 'uNormal' | 'uRoughness' | 'uMetallic' | 'uEmissive' | 'uAo' | 'uDebug' | 'uSunIntensity' | 'uAlphaTest' | 'uSunDirection' | 'uAmbientIntensity' | 'uEnvironmentIntensity' | 'uExposure'

export interface MaterialUniformValue {
  value: unknown
}

export interface CompiledMaterialGraph {
  vertexShader: string
  fragmentShader: string
  uniforms: Readonly<Record<MaterialUniformName, MaterialUniformValue>>
  debugModes: typeof MATERIAL_DEBUG_MODES
  dependencies: readonly MaterialTextureChannel[]
  nodeTypes: Readonly<Record<string, MaterialValueType>>
  textureDefaults: Readonly<Record<MaterialTextureChannel, readonly [number, number, number, number]>>
  colorSpace: 'srgb-input-linear-lighting-srgb-output'
}

export type MaterialGraphErrorCode = 'INVALID_GRAPH' | 'UNSUPPORTED_VERSION' | 'INVALID_NODE' | 'DUPLICATE_NODE' | 'UNKNOWN_NODE' | 'UNKNOWN_INPUT' | 'MISSING_INPUT' | 'UNKNOWN_REFERENCE' | 'TYPE_MISMATCH' | 'CYCLE' | 'UNREACHABLE_NODE' | 'INVALID_NUMBER' | 'BUDGET_EXCEEDED'

export class MaterialGraphValidationError extends Error {
  constructor(public readonly code: MaterialGraphErrorCode, message: string, public readonly nodeId?: string, public readonly inputName?: string) {
    super(message)
    this.name = 'MaterialGraphValidationError'
  }
}

interface NormalizedNode extends MaterialGraphNode {
  inputs: Record<string, string>
  params: Record<string, unknown>
}

interface ParsedGraph {
  nodes: NormalizedNode[]
  output: string
}

const NODE_TYPES = new Set<MaterialNodeType>(['scalar', 'color', 'uv', 'time', 'texture', 'add', 'multiply', 'mix', 'clamp', 'scroll', 'rotate', 'noise', 'sine', 'smoothstep', 'fresnel', 'checker', 'tint', 'output'])
const INPUT_NAMES: Record<MaterialNodeType, readonly string[]> = {
  scalar: [], color: [], uv: [], time: [], texture: ['uv'], add: ['a', 'b'], multiply: ['a', 'b'], mix: ['a', 'b', 'factor'], clamp: ['value', 'min', 'max'], scroll: ['uv', 'time'], rotate: ['uv', 'angle'], noise: ['uv'], sine: ['value'], smoothstep: ['value'], fresnel: [], checker: ['uv'], tint: ['color'], output: ['baseColor', 'roughness', 'metallic', 'emissive', 'normal', 'ao']
}
const REQUIRED_INPUTS: Record<MaterialNodeType, readonly string[]> = {
  scalar: [], color: [], uv: [], time: [], texture: [], add: ['a', 'b'], multiply: ['a', 'b'], mix: ['a', 'b', 'factor'], clamp: ['value'], scroll: ['uv'], rotate: ['uv'], noise: ['uv'], sine: ['value'], smoothstep: ['value'], fresnel: [], checker: ['uv'], tint: ['color'], output: []
}
const PORT_TYPES: Record<MaterialPort, readonly MaterialValueType[]> = {
  baseColor: ['vec3', 'vec4'], roughness: ['float'], metallic: ['float'], emissive: ['vec3', 'vec4'], normal: ['vec3'], ao: ['float']
}
const DEFAULT_TEXTURE_CHANNEL: MaterialTextureChannel = 'albedo'
export const MATERIAL_TEXTURE_DEFAULTS = Object.freeze({
  albedo: [255, 255, 255, 255], normal: [128, 128, 255, 255], roughness: [255, 255, 255, 255],
  metallic: [0, 0, 0, 255], emissive: [0, 0, 0, 255], ao: [255, 255, 255, 255]
} as const)

const numberSchema = z.number().finite().min(-MATERIAL_GRAPH_LIMITS.maxNumber).max(MATERIAL_GRAPH_LIMITS.maxNumber)
const colorSchema = z.union([z.tuple([numberSchema, numberSchema, numberSchema]), z.tuple([numberSchema, numberSchema, numberSchema, numberSchema])])
const vec2Schema = z.tuple([numberSchema, numberSchema])
const annotation = z.enum(['float', 'vec2', 'vec3', 'vec4']).optional()
const PARAM_SCHEMAS = {
  scalar: z.strictObject({ value: numberSchema.default(0) }),
  color: z.strictObject({ value: colorSchema.default([1, 1, 1, 1]) }),
  uv: z.strictObject({ scale: vec2Schema.default([1, 1]), offset: vec2Schema.default([0, 0]) }),
  time: z.strictObject({}),
  sine: z.strictObject({ frequency: numberSchema.default(1), phase: numberSchema.default(0) }),
  smoothstep: z.strictObject({ min: numberSchema.default(0), max: numberSchema.default(1) }).refine(p => p.min < p.max, { message: uiText("core.advanced.materialGraph.theLowerLimitOfTheSmoothThreshold") }),
  fresnel: z.strictObject({ power: z.number().finite().min(0.01).max(32).default(5) }),
  checker: z.strictObject({ scale: z.number().finite().min(0.01).max(1024).default(8) }),
  texture: z.strictObject({ channel: z.enum(['albedo', 'normal', 'roughness', 'metallic', 'emissive', 'ao']).default('albedo') }),
  add: z.strictObject({ type: annotation }),
  multiply: z.strictObject({ type: annotation }),
  mix: z.strictObject({ type: annotation }),
  clamp: z.strictObject({ type: annotation, min: numberSchema.default(0), max: numberSchema.default(1) }),
  scroll: z.strictObject({ speed: vec2Schema.default([0.04, 0.02]) }),
  rotate: z.strictObject({ center: vec2Schema.default([0.5, 0.5]) }),
  noise: z.strictObject({ scale: numberSchema.default(4) }),
  tint: z.strictObject({ color: colorSchema.default([1, 1, 1, 1]) }),
  output: z.strictObject({})
}

function fail(code: MaterialGraphErrorCode, message: string, nodeId?: string, inputName?: string): never {
  throw new MaterialGraphValidationError(code, message, nodeId, inputName)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value: unknown, label: string, nodeId?: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MATERIAL_GRAPH_LIMITS.maxNumber) fail('INVALID_NUMBER', uiText("core.advanced.colormap.mustBeLimited", label), nodeId)
  return value
}

function numberArray(value: unknown, label: string, lengths: readonly number[], nodeId?: string): number[] {
  if (!Array.isArray(value) || !lengths.includes(value.length)) fail('INVALID_NODE', uiText("core.advanced.materialGraph.itMustBeLongNumericalArrays", label, lengths.join(uiText("core.advanced.materialGraph.or"))), nodeId)
  return value.map((entry, index) => finiteNumber(entry, `${label}[${index}]`, nodeId))
}

function parseParams(value: unknown, nodeId: string, type: MaterialNodeType): Record<string, unknown> {
  const result = PARAM_SCHEMAS[type].safeParse(value === undefined ? {} : value)
  if (!result.success) {
    const issue = result.error.issues[0]
    fail(issue.code === 'invalid_type' && issue.expected === 'number' || issue.code === 'too_big' || issue.code === 'too_small' ? 'INVALID_NUMBER' : 'INVALID_NODE', uiText("core.advanced.materialGraph.nodesParametersAreInvalid", nodeId, issue.path.join('.'), issue.message), nodeId)
  }
  return result.data
}

function parseInputs(value: unknown, nodeId: string): Record<string, string> {
  if (value === undefined) return {}
  if (!isRecord(value)) fail('INVALID_NODE', uiText("core.advanced.materialGraph.inputsMustBeAnObject"), nodeId)
  const inputs: Record<string, string> = Object.create(null)
  for (const [name, ref] of Object.entries(value)) {
    if (typeof ref !== 'string' || ref.length === 0) fail('INVALID_GRAPH', uiText("core.advanced.materialGraph.enterNodeMustBeQuotedId", name), nodeId, name)
    inputs[name] = ref
  }
  return inputs
}

function parseGraph(input: unknown): ParsedGraph {
  if (!isRecord(input)) fail('INVALID_GRAPH', uiText("core.advanced.materialGraph.theMaterialMapMustBeAnObject"))
  for (const key of Object.keys(input)) if (!['version', 'nodes', 'output'].includes(key)) fail('INVALID_GRAPH', uiText("core.advanced.materialGraph.unsupportedDrawingFields", key))
  if (input.version !== 1) fail('UNSUPPORTED_VERSION', uiText("core.advanced.materialGraph.textureOnlySupportedForVersion"))
  if (!Array.isArray(input.nodes)) fail('INVALID_GRAPH', uiText("core.advanced.materialGraph.nodesMustBeAnArray"))
  if (input.nodes.length === 0 || input.nodes.length > MATERIAL_GRAPH_LIMITS.maxNodes) fail('BUDGET_EXCEEDED', uiText("core.advanced.materialGraph.theNumberOfNodesMustBeTo", MATERIAL_GRAPH_LIMITS.maxNodes))
  if (typeof input.output !== 'string' || input.output.length === 0) fail('INVALID_GRAPH', uiText("core.advanced.materialGraph.outputMustBeTheOutputNodeId"))
  const nodes: NormalizedNode[] = []
  const ids = new Set<string>()
  for (const raw of input.nodes) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.type !== 'string') fail('INVALID_NODE', uiText("core.advanced.materialGraph.everyNodeNeedsIdAndType"))
    const id = raw.id
    for (const key of Object.keys(raw)) if (!['id', 'type', 'inputs', 'params'].includes(key)) fail('INVALID_NODE', uiText("core.advanced.materialGraph.unsupportedNodeFields", key), id)
    if (id.trim().length === 0 || id.length > MATERIAL_GRAPH_LIMITS.maxIdLength) fail('INVALID_NODE', uiText("core.advanced.materialGraph.nodeIdMustBeToNonEmpty", MATERIAL_GRAPH_LIMITS.maxIdLength), id)
    if (ids.has(id)) fail('DUPLICATE_NODE', uiText("core.advanced.materialGraph.nodeIdRepeat", id), id)
    ids.add(id)
    if (!NODE_TYPES.has(raw.type as MaterialNodeType)) fail('UNKNOWN_NODE', uiText("core.advanced.materialGraph.nodeTypeNotSupported", raw.type), id)
    const type = raw.type as MaterialNodeType
    const inputs = parseInputs(raw.inputs, id)
    for (const name of Object.keys(inputs)) if (!INPUT_NAMES[type].includes(name)) fail('UNKNOWN_INPUT', uiText("core.advanced.materialGraph.nodesInputNotAccepted", type, name), id, name)
    nodes.push({ id, type, inputs, params: parseParams(raw.params, id, type) })
  }
  if (!ids.has(input.output)) fail('UNKNOWN_REFERENCE', uiText("core.advanced.materialGraph.outputQuotesNonExistentNodes", input.output))
  const outputNodes = nodes.filter(node => node.type === 'output')
  if (outputNodes.length !== 1 || outputNodes[0].id !== input.output) fail('INVALID_GRAPH', uiText("core.advanced.materialGraph.theMaterialMapMustHaveOnlyOne"))
  return { nodes, output: input.output }
}

function requiredInput(node: NormalizedNode, name: string): string {
  const ref = node.inputs[name]
  if (!ref) fail('MISSING_INPUT', uiText("core.advanced.materialGraph.notConnected", node.type, name), node.id, name)
  return ref
}

function optionalInput(node: NormalizedNode, name: string): string | undefined {
  return node.inputs[name]
}

function textureType(params: Record<string, unknown>): MaterialValueType {
  switch ((params.channel ?? DEFAULT_TEXTURE_CHANNEL) as MaterialTextureChannel) {
    case 'normal': return 'vec3'
    case 'emissive': return 'vec3'
    case 'roughness':
    case 'metallic':
    case 'ao': return 'float'
    default: return 'vec4'
  }
}

function inferType(node: NormalizedNode, types: ReadonlyMap<string, MaterialValueType>): MaterialValueType | null {
  const inputType = (name: string): MaterialValueType => {
    const ref = requiredInput(node, name)
    const type = types.get(ref)
    if (!type) fail('INVALID_GRAPH', uiText("core.advanced.materialGraph.iCanTDeduceItType", ref), node.id, name)
    return type
  }
  const same = (left: MaterialValueType, right: MaterialValueType, name: string): MaterialValueType => {
    if (left !== right) fail('TYPE_MISMATCH', uiText("core.advanced.materialGraph.theTypeMustBeConsistentCopyThat", node.type, name, left, right), node.id, name)
    return left
  }
  switch (node.type) {
    case 'scalar': return 'float'
    case 'color': {
      const value = node.params.value
      return value === undefined ? 'vec4' : numberArray(value, 'color.value', [3, 4], node.id).length === 3 ? 'vec3' : 'vec4'
    }
    case 'uv': return 'vec2'
    case 'time': return 'float'
    case 'fresnel': return 'float'
    case 'sine':
    case 'smoothstep':
      if (inputType('value') !== 'float') fail('TYPE_MISMATCH', node.type + uiText("core.advanced.materialGraph.valueMustBeFloat"), node.id, 'value')
      return 'float'
    case 'checker':
      if (inputType('uv') !== 'vec2') fail('TYPE_MISMATCH', uiText("core.advanced.materialGraph.checkerUvMustBeVec2"), node.id, 'uv')
      return 'float'
    case 'texture': return textureType(node.params)
    case 'add':
    case 'multiply': {
      const a = inputType('a'), b = inputType('b')
      return a === 'float' ? b : b === 'float' ? a : same(a, b, 'b')
    }
    case 'mix': {
      const valueType = same(inputType('a'), inputType('b'), 'b')
      if (inputType('factor') !== 'float') fail('TYPE_MISMATCH', uiText("core.advanced.materialGraph.mixFactorMustBeFloat"), node.id, 'factor')
      return valueType
    }
    case 'clamp': {
      const valueType = inputType('value')
      for (const name of ['min', 'max']) {
        if (node.inputs[name] && inputType(name) !== 'float') same(valueType, inputType(name), name)
      }
      return valueType
    }
    case 'scroll':
      if (inputType('uv') !== 'vec2') fail('TYPE_MISMATCH', uiText("core.advanced.materialGraph.scrollUvMustBeVec2"), node.id, 'uv')
      if (node.inputs.time && inputType('time') !== 'float') fail('TYPE_MISMATCH', uiText("core.advanced.materialGraph.scrollTimeMustBeAFloat"), node.id, 'time')
      return 'vec2'
    case 'rotate':
      if (inputType('uv') !== 'vec2') fail('TYPE_MISMATCH', uiText("core.advanced.materialGraph.rotatteUvMustBeVec2"), node.id, 'uv')
      if (node.inputs.angle && inputType('angle') !== 'float') fail('TYPE_MISMATCH', uiText("core.advanced.materialGraph.rotateAngleMustBeAFloat"), node.id, 'angle')
      return 'vec2'
    case 'noise':
      if (inputType('uv') !== 'vec2') fail('TYPE_MISMATCH', uiText("core.advanced.materialGraph.noiseUvMustBeVec2"), node.id, 'uv')
      return 'float'
    case 'tint': {
      const colorType = inputType('color')
      if (colorType !== 'vec3' && colorType !== 'vec4') fail('TYPE_MISMATCH', uiText("core.advanced.materialGraph.tintColorMustBeVec3OrVec4"), node.id, 'color')
      return colorType
    }
    case 'output': return null
  }
}

function topologicalOrder(graph: ParsedGraph): NormalizedNode[] {
  const byId = new Map(graph.nodes.map(node => [node.id, node]))
  const state = new Map<string, 0 | 1 | 2>()
  const order: NormalizedNode[] = []
  const visit = (id: string, depth: number, trail: readonly string[]): void => {
    if (depth > MATERIAL_GRAPH_LIMITS.maxDepth) fail('BUDGET_EXCEEDED', uiText("core.advanced.materialGraph.nodeDepthCannotBeExceeded", MATERIAL_GRAPH_LIMITS.maxDepth))
    const current = state.get(id) ?? 0
    if (current === 1) fail('CYCLE', uiText("core.advanced.materialGraph.cycleDetected", [...trail, id].join(' -> ')), id)
    if (current === 2) return
    const node = byId.get(id)
    if (!node) fail('UNKNOWN_REFERENCE', uiText("core.advanced.materialGraph.enterReferencesToNonExistentNodes", id))
    for (const name of REQUIRED_INPUTS[node.type]) requiredInput(node, name)
    for (const [name, ref] of Object.entries(node.inputs)) {
      if (!byId.has(ref)) fail('UNKNOWN_REFERENCE', uiText("core.advanced.materialGraph.enterQuoteNonExistentNodes", name, ref), node.id, name)
    }
    state.set(id, 1)
    for (const ref of Object.values(node.inputs)) visit(ref, depth + 1, [...trail, id])
    state.set(id, 2)
    order.push(node)
  }
  visit(graph.output, 0, [])
  if (order.length !== graph.nodes.length) {
    const orphan = graph.nodes.find(node => !state.has(node.id))
    fail('UNREACHABLE_NODE', uiText("core.advanced.materialGraph.nodesNotConnectedToOutput", orphan?.id ?? 'unknown'), orphan?.id)
  }
  return order
}

function glslNumber(value: number): string {
  if (Object.is(value, -0)) return '0.0'
  const text = String(value)
  if (/[eE]/.test(text)) {
    const [mantissa, exponent] = text.toLowerCase().split('e')
    return `${mantissa.includes('.') ? mantissa : `${mantissa}.0`}e${exponent}`
  }
  return text.includes('.') ? text : `${text}.0`
}

function vectorConstructor(type: MaterialValueType, values: readonly number[]): string {
  return `${type}(${values.map(glslNumber).join(', ')})`
}

function paramsColor(node: NormalizedNode, name: string): number[] {
  const value = node.params[name]
  if (value === undefined) return [1, 1, 1, 1]
  return numberArray(value, `${node.type}.${name}`, [3, 4], node.id)
}

function inputExpression(node: NormalizedNode, expressions: ReadonlyMap<string, string>, name: string): string {
  const ref = requiredInput(node, name)
  const expression = expressions.get(ref)
  if (!expression) fail('INVALID_GRAPH', uiText("core.advanced.materialGraph.cannotGenerateExpressions", ref), node.id, name)
  return expression
}

function optionalExpression(node: NormalizedNode, expressions: ReadonlyMap<string, string>, name: string, fallback: string): string {
  const ref = optionalInput(node, name)
  if (!ref) return fallback
  const expression = expressions.get(ref)
  if (!expression) fail('INVALID_GRAPH', uiText("core.advanced.materialGraph.cannotGenerateExpressions", ref), node.id, name)
  return expression
}

function coerceExpression(expression: string, from: MaterialValueType, to: MaterialValueType): string {
  return from === 'float' && to !== 'float' ? `${to}(${expression})` : expression
}

function renderNode(node: NormalizedNode, types: ReadonlyMap<string, MaterialValueType>, expressions: ReadonlyMap<string, string>): string {
  const type = types.get(node.id)
  const input = (name: string) => inputExpression(node, expressions, name)
  switch (node.type) {
    case 'scalar': return glslNumber(typeof node.params.value === 'number' ? node.params.value : 0)
    case 'color': {
      const values = node.params.value === undefined ? [1, 1, 1, 1] : numberArray(node.params.value, 'color.value', [3, 4], node.id)
      return vectorConstructor(values.length === 3 ? 'vec3' : 'vec4', values)
    }
    case 'uv': {
      const scale = node.params.scale === undefined ? [1, 1] : numberArray(node.params.scale, 'uv.scale', [2], node.id)
      const offset = node.params.offset === undefined ? [0, 0] : numberArray(node.params.offset, 'uv.offset', [2], node.id)
      return `(vUv * ${vectorConstructor('vec2', scale)} + ${vectorConstructor('vec2', offset)})`
    }
    case 'time': return 'uTime'
    case 'texture': {
      const channel = (node.params.channel ?? DEFAULT_TEXTURE_CHANNEL) as MaterialTextureChannel
      const uv = optionalExpression(node, expressions, 'uv', 'vUv')
      return `mcrhSample${channel[0].toUpperCase()}${channel.slice(1)}(${uv})`
    }
    case 'add':
    case 'multiply': {
      const valueType = type ?? 'float'
      const a = coerceExpression(input('a'), types.get(node.inputs.a) ?? valueType, valueType)
      const b = coerceExpression(input('b'), types.get(node.inputs.b) ?? valueType, valueType)
      return `(${a} ${node.type === 'add' ? '+' : '*'} ${b})`
    }
    case 'mix': return `mix(${input('a')}, ${input('b')}, ${input('factor')})`
    case 'clamp': {
      const value = input('value')
      const valueType = type ?? 'float'
      const min = node.inputs.min ? coerceExpression(input('min'), types.get(node.inputs.min) ?? valueType, valueType) : constantForType(valueType, typeof node.params.min === 'number' ? node.params.min : 0)
      const max = node.inputs.max ? coerceExpression(input('max'), types.get(node.inputs.max) ?? valueType, valueType) : constantForType(valueType, typeof node.params.max === 'number' ? node.params.max : 1)
      return `clamp(${value}, ${min}, ${max})`
    }
    case 'scroll': {
      const speed = node.params.speed === undefined ? [0.04, 0.02] : numberArray(node.params.speed, 'scroll.speed', [2], node.id)
      const time = optionalExpression(node, expressions, 'time', 'uTime')
      return `(${input('uv')} + ${vectorConstructor('vec2', speed)} * ${time})`
    }
    case 'rotate': {
      const angle = optionalExpression(node, expressions, 'angle', '0.0')
      const center = vectorConstructor('vec2', numberArray(node.params.center, 'rotate.center', [2], node.id))
      return `(mat2(cos(${angle}), sin(${angle}), -sin(${angle}), cos(${angle})) * (${input('uv')} - ${center}) + ${center})`
    }
    case 'sine': return `(sin(${input('value')} * ${glslNumber(Number(node.params.frequency))} * 6.2831853 + ${glslNumber(Number(node.params.phase))}) * 0.5 + 0.5)`
    case 'smoothstep': return `smoothstep(${glslNumber(Number(node.params.min))}, ${glslNumber(Number(node.params.max))}, ${input('value')})`
    case 'fresnel': return `pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition))), ${glslNumber(Number(node.params.power))})`
    case 'checker': return `mod(floor(${input('uv')}.x * ${glslNumber(Number(node.params.scale))}) + floor(${input('uv')}.y * ${glslNumber(Number(node.params.scale))}), 2.0)`
    case 'noise': return `mcrhNoise(${input('uv')} * ${glslNumber(typeof node.params.scale === 'number' ? node.params.scale : 4)})`
    case 'tint': {
      const color = input('color')
      const tint = paramsColor(node, 'color')
      if (type === 'vec3') return `(${color} * ${vectorConstructor('vec3', tint.slice(0, 3))})`
      return `vec4(${color}.rgb * ${vectorConstructor('vec3', tint.slice(0, 3))}, ${color}.a * ${glslNumber(tint[3] ?? 1)})`
    }
    case 'output': return ''
  }
}

function constantForType(type: MaterialValueType, value: number): string {
  if (type === 'float') return glslNumber(value)
  return vectorConstructor(type, Array.from({ length: Number(type.slice(3)) }, () => value))
}

function asPortExpression(port: MaterialPort, expression: string, type: MaterialValueType): string {
  if (port === 'baseColor' && type === 'vec3') return `vec4(${expression}, 1.0)`
  if (port === 'emissive' && type === 'vec4') return `${expression}.rgb`
  if (!PORT_TYPES[port].includes(type)) {
    fail('TYPE_MISMATCH', uiText("core.advanced.materialGraph.notAccepted", port, type))
  }
  return expression
}

function outputExpression(node: NormalizedNode, port: MaterialPort, expressions: ReadonlyMap<string, string>, types: ReadonlyMap<string, MaterialValueType>): string {
  const ref = node.inputs[port]
  if (!ref) {
    return {
      baseColor: 'mcrhSampleAlbedo(vUv)', roughness: 'mcrhSampleRoughness(vUv)',
      metallic: 'mcrhSampleMetallic(vUv)', emissive: 'mcrhSampleEmissive(vUv)',
      normal: 'mcrhSampleNormal(vUv)', ao: 'mcrhSampleAo(vUv)'
    }[port]
  }
  const expression = expressions.get(ref)
  const type = types.get(ref)
  if (!expression || !type) fail('INVALID_GRAPH', uiText("core.advanced.materialGraph.couldNotParseOutput", port), node.id, port)
  return asPortExpression(port, expression, type)
}

function buildNoiseFunction(): string {
  return `float mcrhNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
  float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
  float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}`
}

function buildVertexShader(): string {
  return `varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewPosition;
varying vec3 vColor;

void main() {
  vUv = uv;
  vColor = vec3(1.0);
#ifdef USE_COLOR
  vColor = color.rgb;
#endif
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vViewPosition = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
}`
}

function buildFragmentShader(baseColor: string, roughness: string, metallic: string, emissive: string, normal: string, ao: string, expressions: readonly string[]): string {
  const declarations = expressions.map(value => `  ${value}`).join('\n')
  return `uniform float uTime;
uniform sampler2D uAlbedo;
uniform sampler2D uNormal;
uniform sampler2D uRoughness;
uniform sampler2D uMetallic;
uniform sampler2D uEmissive;
uniform sampler2D uAo;
uniform int uDebug;
uniform float uSunIntensity;
uniform float uAlphaTest;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewPosition;
varying vec3 vColor;

${buildNoiseFunction()}
${PBR_LIGHTING_GLSL}

vec3 mcrhSrgbToLinear(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, step(c, vec3(0.04045)));
}
vec3 mcrhLinearToSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, c * 12.92, step(c, vec3(0.0031308)));
}
vec4 mcrhSampleAlbedo(vec2 uv) { vec4 c = texture2D(uAlbedo, uv); return vec4(mcrhSrgbToLinear(c.rgb), c.a); }
vec3 mcrhSampleNormal(vec2 uv) { return texture2D(uNormal, uv).xyz * 2.0 - 1.0; }
float mcrhSampleRoughness(vec2 uv) { return texture2D(uRoughness, uv).r; }
float mcrhSampleMetallic(vec2 uv) { return texture2D(uMetallic, uv).r; }
vec3 mcrhSampleEmissive(vec2 uv) { return mcrhSampleAlbedo(uv).rgb * texture2D(uEmissive, uv).rgb; }
float mcrhSampleAo(vec2 uv) { return texture2D(uAo, uv).r; }
vec3 mcrhSafeNormal(vec3 v, vec3 fallbackNormal) {
  return dot(v, v) > 0.00000001 ? normalize(v) : fallbackNormal;
}
vec3 mcrhTangentNormal(vec3 mapNormal) {
  vec3 N = mcrhSafeNormal(vNormal, vec3(0.0, 0.0, 1.0));
  N *= gl_FrontFacing ? 1.0 : -1.0;
  vec3 dp1 = dFdx(-vViewPosition);
  vec3 dp2 = dFdy(-vViewPosition);
  vec2 duv1 = dFdx(vUv);
  vec2 duv2 = dFdy(vUv);
  vec3 dp2perp = cross(dp2, N);
  vec3 dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float magnitude = max(dot(T, T), dot(B, B));
  if (magnitude < 0.00000001) return N;
  float inverseScale = inversesqrt(magnitude);
  return mcrhSafeNormal(mat3(T * inverseScale, B * inverseScale, N) * mcrhSafeNormal(mapNormal, vec3(0.0, 0.0, 1.0)), N);
}

void main() {
${declarations}
  vec4 mcrhBaseColor = ${baseColor};
  mcrhBaseColor.rgb *= vColor;
  if (mcrhBaseColor.a < uAlphaTest) discard;
  float mcrhRoughness = clamp(${roughness}, 0.0, 1.0);
  float mcrhMetallic = clamp(${metallic}, 0.0, 1.0);
  vec3 mcrhEmissive = ${emissive};
  vec3 mcrhNormalInput = ${normal};
  float mcrhAo = clamp(${ao}, 0.0, 1.0);
  vec3 N = mcrhTangentNormal(mcrhNormalInput);
  vec3 V = mcrhSafeNormal(vViewPosition, vec3(0.0, 0.0, 1.0));
  vec3 finalColor = mcrhShadePbr(mcrhBaseColor.rgb, N, V, mcrhRoughness, mcrhMetallic, mcrhAo) + mcrhEmissive;
  finalColor *= max(uExposure, 0.01);
  if (uDebug == 1) gl_FragColor = vec4(mcrhLinearToSrgb(mcrhBaseColor.rgb), mcrhBaseColor.a);
  else if (uDebug == 2) gl_FragColor = vec4(N * 0.5 + 0.5, 1.0);
  else if (uDebug == 3) gl_FragColor = vec4(vec3(mcrhRoughness), 1.0);
  else if (uDebug == 4) gl_FragColor = vec4(vec3(mcrhMetallic), 1.0);
  else if (uDebug == 5) gl_FragColor = vec4(mcrhLinearToSrgb(mcrhEmissive), 1.0);
  else if (uDebug == 6) gl_FragColor = vec4(vec3(mcrhAo), 1.0);
  else gl_FragColor = vec4(mcrhLinearToSrgb(finalColor / (vec3(1.0) + max(finalColor, vec3(0.0)))), mcrhBaseColor.a);
}`
}

export function compileMaterialGraph(input: unknown): CompiledMaterialGraph {
  const graph = parseGraph(input)
  const order = topologicalOrder(graph)
  const types = new Map<string, MaterialValueType>()
  for (const node of order) {
    if (node.type === 'texture' && node.inputs.uv && types.get(node.inputs.uv) !== 'vec2') fail('TYPE_MISMATCH', uiText("core.advanced.materialGraph.textureUvMustBeVec2"), node.id, 'uv')
    if (node.type === 'clamp' && !node.inputs.min && !node.inputs.max && Number(node.params.min) > Number(node.params.max)) fail('INVALID_NUMBER', uiText("core.advanced.materialGraph.noClampMinCanTBeBigger"), node.id)
    const type = inferType(node, types)
    if (node.params.type && node.params.type !== type) fail('TYPE_MISMATCH', uiText("core.advanced.materialGraph.declarationAndExtrapolatedInconsistencies", node.params.type, type), node.id)
    if (type) types.set(node.id, type)
  }
  const expressions = new Map<string, string>()
  const declarations: string[] = []
  const dependencies = new Set<MaterialTextureChannel>()
  for (const node of order) {
    if (node.type === 'output') continue
    const expression = renderNode(node, types, expressions)
    const type = types.get(node.id)
    if (!type) fail('INVALID_GRAPH', uiText("core.advanced.materialGraph.nodesNoOutputType", node.id), node.id)
    const variable = `mcrhNode${declarations.length}`
    declarations.push(`${type} ${variable} = ${expression};`)
    expressions.set(node.id, variable)
    if (node.type === 'texture') dependencies.add((node.params.channel ?? DEFAULT_TEXTURE_CHANNEL) as MaterialTextureChannel)
  }
  const output = graph.nodes.find(node => node.id === graph.output)
  if (!output) fail('UNKNOWN_REFERENCE', uiText("core.advanced.materialGraph.outputNodeNotFound", graph.output))
  for (const port of Object.keys(PORT_TYPES) as MaterialPort[]) {
    if (!output.inputs[port]) dependencies.add(port === 'baseColor' ? 'albedo' : port)
    const ref = output.inputs[port]
    if (ref && !PORT_TYPES[port].includes(types.get(ref)!)) fail('TYPE_MISMATCH', uiText("core.advanced.materialGraph.notAccepted", port, types.get(ref)), output.id, port)
  }
  const baseColor = outputExpression(output, 'baseColor', expressions, types)
  const roughness = outputExpression(output, 'roughness', expressions, types)
  const metallic = outputExpression(output, 'metallic', expressions, types)
  const emissive = outputExpression(output, 'emissive', expressions, types)
  const normal = outputExpression(output, 'normal', expressions, types)
  const ao = outputExpression(output, 'ao', expressions, types)
  const vertexShader = buildVertexShader()
  const fragmentShader = buildFragmentShader(baseColor, roughness, metallic, emissive, normal, ao, declarations)
  if (vertexShader.length + fragmentShader.length > MATERIAL_GRAPH_LIMITS.maxExpressionLength) fail('BUDGET_EXCEEDED', uiText("core.advanced.materialGraph.generatedGlslBudgetBeyondLength"))
  return {
    vertexShader,
    fragmentShader,
    uniforms: {
      uTime: { value: 0 }, uAlbedo: { value: null }, uNormal: { value: null }, uRoughness: { value: null }, uMetallic: { value: null }, uEmissive: { value: null }, uAo: { value: null }, uDebug: { value: 0 }, uSunIntensity: { value: 1 }, uAlphaTest: { value: 0.1 }, uSunDirection: { value: [0.35, 0.82, 0.45] }, uAmbientIntensity: { value: 0.3 }, uEnvironmentIntensity: { value: 0.6 }, uExposure: { value: 1 }
    },
    debugModes: MATERIAL_DEBUG_MODES,
    dependencies: [...dependencies],
    nodeTypes: Object.fromEntries(types),
    textureDefaults: MATERIAL_TEXTURE_DEFAULTS,
    colorSpace: 'srgb-input-linear-lighting-srgb-output'
  }
}
