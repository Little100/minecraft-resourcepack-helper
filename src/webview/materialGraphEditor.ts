import { uiText } from '../i18n/messages'
import * as Blockly from 'blockly/core'
import {
  compileMaterialGraph, MATERIAL_GRAPH_LIMITS, MaterialGraphValidationError,
  type CompiledMaterialGraph, type MaterialGraph, type MaterialGraphNode, type MaterialNodeType, type MaterialValueType
} from '../core/advanced/materialGraph'

export interface MaterialGraphEditorOptions {
  media?: string
  onChange(graph: MaterialGraph | null, compiled: CompiledMaterialGraph | null, error: MaterialGraphValidationError | null): void
}

export interface MaterialGraphEditor {
  getGraph(): MaterialGraph
  setGraph(graph: unknown): void
  reset(): void
  resize(): void
  dispose(): void
}

const PREFIX = 'mcrh_material_'
const REFERENCE = `${PREFIX}reference`
const TYPES: MaterialNodeType[] = ['scalar', 'color', 'uv', 'time', 'texture', 'add', 'multiply', 'mix', 'clamp', 'scroll', 'rotate', 'noise', 'sine', 'smoothstep', 'fresnel', 'checker', 'tint', 'output']
const VALUE_TYPES: MaterialValueType[] = ['float', 'vec2', 'vec3', 'vec4']
const numeric = (name: string, value: number) => ({ type: 'field_number', name, value, min: -MATERIAL_GRAPH_LIMITS.maxNumber, max: MATERIAL_GRAPH_LIMITS.maxNumber })
const valueInput = (name: string, check: string | string[]) => ({ type: 'input_value', name, check })
const typeField = (values = VALUE_TYPES, name = 'valueType') => ({ type: 'field_dropdown', name, options: values.map(type => [type, type]) })
const rgbaFields = () => [numeric('r', 1), numeric('g', 1), numeric('b', 1), numeric('a', 1)]

function updateConnectionTypes(block: Blockly.Block, field?: string, value?: string): void {
  const type = block.type.slice(PREFIX.length)
  const selected = (field === 'valueType' ? value : block.getField('valueType') ? block.getFieldValue('valueType') : 'float') as MaterialValueType
  if (type === 'texture') {
    const channel = (field === 'channel' ? value : block.getFieldValue('channel')) as string
    block.outputConnection?.setCheck(channel === 'albedo' ? 'vec4' : channel === 'normal' || channel === 'emissive' ? 'vec3' : 'float')
  } else if (type === 'color' || type === 'reference') {
    block.outputConnection?.setCheck(selected)
  } else if (['add', 'multiply', 'mix', 'clamp'].includes(type)) {
    block.outputConnection?.setCheck(selected)
    for (const name of ['a', 'b', 'value', 'min', 'max']) {
      const allowScalar = type === 'add' || type === 'multiply' || name === 'min' || name === 'max'
      block.getInput(name)?.setCheck(allowScalar && selected !== 'float' ? [selected, 'float'] : selected)
    }
  } else if (type === 'tint') {
    const source = block.getInputTargetBlock('color')
    const check = source?.outputConnection?.getCheck()
    block.outputConnection?.setCheck(check?.length === 1 && check[0] === 'vec3' ? 'vec3' : 'vec4')
  }
}

export function registerMaterialGraphBlocks(): void {
  if (Blockly.Blocks[`${PREFIX}scalar`]) return
  Blockly.defineBlocksWithJsonArray([
    { type: `${PREFIX}scalar`, message0: uiText("webview.materialGraphEditor.value"), args0: [numeric('value', 0.5)], output: 'float', colour: 210 },
    { type: `${PREFIX}color`, message0: uiText("webview.materialGraphEditor.colourRGBA"), args0: [typeField(['vec4', 'vec3']), ...rgbaFields()], output: 'vec4', colour: 35 },
    { type: `${PREFIX}uv`, message0: uiText("webview.materialGraphEditor.uvScaleXYOffsetXY"), args0: [numeric('scaleX', 1), numeric('scaleY', 1), numeric('offsetX', 0), numeric('offsetY', 0)], output: 'vec2', colour: 185 },
    { type: `${PREFIX}time`, message0: uiText("webview.materialGraphEditor.timeSec"), output: 'float', colour: 185 },
    { type: `${PREFIX}texture`, message0: uiText("webview.materialGraphEditor.textureUv"), args0: [{ type: 'field_dropdown', name: 'channel', options: [[uiText("webview.materialGraphEditor.bottomColor"), 'albedo'], [uiText("webview.materialGraphEditor.normals"), 'normal'], [uiText("webview.advanced.roughness"), 'roughness'], [uiText("webview.advanced.metallic"), 'metallic'], [uiText("webview.advanced.autolight"), 'emissive'], [uiText("webview.materialGraphEditor.environmentMask"), 'ao']] }, valueInput('uv', 'vec2')], output: 'vec4', colour: 35 },
    ...(['add', 'multiply'] as const).map(type => ({ type: `${PREFIX}${type}`, message0: `${type === 'add' ? uiText("webview.materialGraphEditor.add") : uiText("webview.materialGraphEditor.multiplication")} %1 A %2 B %3`, args0: [typeField(), valueInput('a', 'float'), valueInput('b', 'float')], output: 'float', colour: 230 })),
    { type: `${PREFIX}mix`, message0: uiText("webview.materialGraphEditor.mixedAB"), args0: [typeField(), valueInput('a', 'float'), valueInput('b', 'float'), valueInput('factor', 'float')], output: 'float', colour: 230 },
    { type: `${PREFIX}clamp`, message0: uiText("webview.materialGraphEditor.limitValueLowerLimitUpperLimitDefault"), args0: [typeField(), valueInput('value', 'float'), valueInput('min', 'float'), valueInput('max', 'float'), numeric('min', 0), numeric('max', 1)], output: 'float', colour: 230 },
    { type: `${PREFIX}scroll`, message0: uiText("webview.materialGraphEditor.mobileUvTimeSpeedXY"), args0: [valueInput('uv', 'vec2'), valueInput('time', 'float'), numeric('speedX', 0.04), numeric('speedY', 0.02)], output: 'vec2', colour: 185 },
    { type: `${PREFIX}rotate`, message0: uiText("webview.materialGraphEditor.rotateUvRadiansCenterXY"), args0: [valueInput('uv', 'vec2'), valueInput('angle', 'float'), numeric('centerX', 0.5), numeric('centerY', 0.5)], output: 'vec2', colour: 185 },
    { type: `${PREFIX}noise`, message0: uiText("webview.materialGraphEditor.noiseUvFrequency"), args0: [valueInput('uv', 'vec2'), numeric('scale', 4)], output: 'float', colour: 265 },
    { type: `${PREFIX}sine`, message0: uiText("webview.materialGraphEditor.respiratoryWaveFrequencyHzPhase"), args0: [valueInput('value', 'float'), numeric('frequency', 1), numeric('phase', 0)], output: 'float', colour: 185 },
    { type: `${PREFIX}smoothstep`, message0: uiText("webview.materialGraphEditor.smoothThresholdValueLowerLimitUpperLimit"), args0: [valueInput('value', 'float'), numeric('min', 0), numeric('max', 1)], output: 'float', colour: 230 },
    { type: `${PREFIX}fresnel`, message0: uiText("webview.materialGraphEditor.peripheryIndex"), args0: [numeric('power', 5)], output: 'float', colour: 265 },
    { type: `${PREFIX}checker`, message0: uiText("webview.materialGraphEditor.chessboardUvDensity"), args0: [valueInput('uv', 'vec2'), numeric('scale', 8)], output: 'float', colour: 265 },
    { type: `${PREFIX}tint`, message0: uiText("webview.materialGraphEditor.colourRGBA_0cadc6"), args0: [valueInput('color', ['vec3', 'vec4']), ...rgbaFields()], output: ['vec3', 'vec4'], colour: 35 },
    { type: `${PREFIX}output`, message0: uiText("webview.materialGraphEditor.materialOutputBaseColourRoughnessMetalDegree"), args0: [valueInput('baseColor', ['vec3', 'vec4']), valueInput('roughness', 'float'), valueInput('metallic', 'float'), valueInput('emissive', ['vec3', 'vec4']), valueInput('normal', 'vec3'), valueInput('ao', 'float')], colour: 130 },
    { type: REFERENCE, message0: uiText("webview.materialGraphEditor.sharedNodeType"), args0: [{ type: 'field_input', name: 'target', text: '' }, typeField()], output: 'float', colour: 160 }
  ])
  for (const name of [...TYPES.map(type => `${PREFIX}${type}`), REFERENCE]) {
    const definition = Blockly.Blocks[name]
    definition.saveExtraState = function (this: Blockly.Block): { valueType?: string } {
      return { valueType: this.outputConnection?.getCheck()?.[0] }
    }
    definition.loadExtraState = function (this: Blockly.Block, state: { valueType?: string }): void {
      if (!VALUE_TYPES.includes(state.valueType as MaterialValueType)) return
      updateConnectionTypes(this, 'valueType', state.valueType)
      this.outputConnection?.setCheck(state.valueType!)
    }
    const init = definition.init
    definition.init = function (this: Blockly.Block): void {
      init.call(this)
      this.setInputsInline(false)
      for (const name of ['valueType', 'channel']) {
        const field = this.getField(name) as Blockly.FieldDropdown | null
        field?.setValidator(value => { updateConnectionTypes(this, name, value); return value })
      }
      updateConnectionTypes(this)
      this.setOnChange(event => {
        if (event.isUiEvent) return
        updateConnectionTypes(this)
      })
    }
  }
}

export function createDefaultMaterialGraph(): MaterialGraph {
  return {
    version: 1,
    nodes: [
      { id: 'uv', type: 'uv' },
      { id: 'time', type: 'time' },
      { id: 'scroll', type: 'scroll', inputs: { uv: 'uv', time: 'time' }, params: { speed: [0.04, 0.02] } },
      { id: 'texture', type: 'texture', inputs: { uv: 'scroll' }, params: { channel: 'albedo' } },
      { id: 'tint', type: 'tint', inputs: { color: 'texture' }, params: { color: [0.8, 0.9, 1, 1] } },
      { id: 'output', type: 'output', inputs: { baseColor: 'tint' } }
    ],
    output: 'output'
  }
}

function blockParams(block: Blockly.Block, type: MaterialNodeType): Record<string, unknown> {
  const number = (name: string) => Number(block.getFieldValue(name))
  const color = () => ['r', 'g', 'b', 'a'].map(number)
  switch (type) {
    case 'scalar': return { value: number('value') }
    case 'color': return { value: color().slice(0, block.getFieldValue('valueType') === 'vec3' ? 3 : 4) }
    case 'uv': return { scale: [number('scaleX'), number('scaleY')], offset: [number('offsetX'), number('offsetY')] }
    case 'texture': return { channel: block.getFieldValue('channel') }
    case 'add':
    case 'multiply':
    case 'mix': return { type: block.getFieldValue('valueType') }
    case 'clamp': return { type: block.getFieldValue('valueType'), min: number('min'), max: number('max') }
    case 'scroll': return { speed: [number('speedX'), number('speedY')] }
    case 'rotate': return { center: [number('centerX'), number('centerY')] }
    case 'noise': return { scale: number('scale') }
    case 'sine': return { frequency: number('frequency'), phase: number('phase') }
    case 'smoothstep': return { min: number('min'), max: number('max') }
    case 'fresnel': return { power: number('power') }
    case 'checker': return { scale: number('scale') }
    case 'tint': return { color: color() }
    default: return {}
  }
}

export function materialGraphFromWorkspace(workspace: Blockly.Workspace): MaterialGraph {
  const roots = workspace.getTopBlocks(false).filter(block => block.type === `${PREFIX}output`)
  if (roots.length !== 1) throw new MaterialGraphValidationError('INVALID_GRAPH', uiText("webview.materialGraphEditor.thereMustBeAndOnlyOneMaterial"))
  const nodes: MaterialGraphNode[] = []
  const visiting = new Set<string>()
  const emitted = new Set<string>()
  const visit = (block: Blockly.Block): string => {
    if (visiting.has(block.id)) throw new MaterialGraphValidationError('CYCLE', uiText("webview.materialGraphEditor.shareNodeReferencesToGenerateLoops"), block.id)
    if (emitted.has(block.id)) return block.id
    visiting.add(block.id)
    if (visiting.size > MATERIAL_GRAPH_LIMITS.maxDepth) throw new MaterialGraphValidationError('BUDGET_EXCEEDED', uiText("webview.materialGraphEditor.nodeTreeTooDeep"), block.id)
    if (block.type === REFERENCE) {
      const target = workspace.getBlockById(String(block.getFieldValue('target')))
      if (!target || target.type === `${PREFIX}output`) throw new MaterialGraphValidationError('UNKNOWN_REFERENCE', uiText("webview.materialGraphEditor.sharedNodeTargetDoesNotExistOr"), block.id)
      const id = visit(target)
      visiting.delete(block.id)
      return id
    }
    const type = block.type.slice(PREFIX.length) as MaterialNodeType
    if (!block.type.startsWith(PREFIX) || !TYPES.includes(type)) throw new MaterialGraphValidationError('UNKNOWN_NODE', uiText("webview.materialGraphEditor.couldNotExportTheBuildingBlocks", block.type), block.id)
    const inputs: Record<string, string> = {}
    for (const input of block.inputList) {
      const target = input.connection?.targetBlock()
      if (target) inputs[input.name] = visit(target)
    }
    nodes.push({ id: block.id, type, inputs, params: blockParams(block, type) })
    if (nodes.length > MATERIAL_GRAPH_LIMITS.maxNodes) throw new MaterialGraphValidationError('BUDGET_EXCEEDED', uiText("webview.materialGraphEditor.numberOfNodesExceededBudget"), block.id)
    visiting.delete(block.id)
    emitted.add(block.id)
    return block.id
  }
  const output = visit(roots[0])
  return { version: 1, nodes, output }
}

function fieldsForNode(node: MaterialGraphNode, compiled: CompiledMaterialGraph): Record<string, unknown> {
  const params = node.params ?? {}
  const vector = (name: string, fallback: number[]) => (params[name] ?? fallback) as number[]
  const color = (name: string) => {
    const value = vector(name, [1, 1, 1, 1])
    return { r: value[0], g: value[1], b: value[2], a: value[3] ?? 1 }
  }
  switch (node.type) {
    case 'scalar': return { value: params.value ?? 0 }
    case 'color': return { ...color('value'), valueType: compiled.nodeTypes[node.id] }
    case 'uv': {
      const scale = vector('scale', [1, 1]), offset = vector('offset', [0, 0])
      return { scaleX: scale[0], scaleY: scale[1], offsetX: offset[0], offsetY: offset[1] }
    }
    case 'texture': return { channel: params.channel ?? 'albedo' }
    case 'add':
    case 'multiply':
    case 'mix': return { valueType: compiled.nodeTypes[node.id] }
    case 'clamp': return { valueType: compiled.nodeTypes[node.id], min: params.min ?? 0, max: params.max ?? 1 }
    case 'scroll': { const speed = vector('speed', [0.04, 0.02]); return { speedX: speed[0], speedY: speed[1] } }
    case 'rotate': { const center = vector('center', [0.5, 0.5]); return { centerX: center[0], centerY: center[1] } }
    case 'noise': return { scale: params.scale ?? 4 }
    case 'sine': return { frequency: params.frequency ?? 1, phase: params.phase ?? 0 }
    case 'smoothstep': return { min: params.min ?? 0, max: params.max ?? 1 }
    case 'fresnel': return { power: params.power ?? 5 }
    case 'checker': return { scale: params.scale ?? 8 }
    case 'tint': return color('color')
    default: return {}
  }
}

function graphState(graph: MaterialGraph, compiled: CompiledMaterialGraph): Blockly.serialization.blocks.State {
  const byId = new Map(graph.nodes.map(node => [node.id, node]))
  const expanded = new Set<string>()
  const visit = (id: string): Blockly.serialization.blocks.State => {
    if (expanded.has(id)) return { type: REFERENCE, fields: { target: id, valueType: compiled.nodeTypes[id] }, extraState: { valueType: compiled.nodeTypes[id] } }
    const node = byId.get(id)!
    expanded.add(id)
    return {
      type: `${PREFIX}${node.type}`, id, fields: fieldsForNode(node, compiled), extraState: { valueType: compiled.nodeTypes[id] },
      inputs: Object.fromEntries(Object.entries(node.inputs ?? {}).map(([name, ref]) => [name, { block: visit(ref) }]))
    }
  }
  return { ...visit(graph.output), x: 32, y: 32 }
}

export function createMaterialGraphEditor(container: HTMLElement, options: MaterialGraphEditorOptions): MaterialGraphEditor {
  registerMaterialGraphBlocks()
  const workspace = Blockly.inject(container, {
    renderer: 'mcrh_static', theme: Blockly.Theme.defineTheme('mcrh', { name: 'mcrh', base: Blockly.Themes.Classic, componentStyles: { workspaceBackgroundColour: getComputedStyle(container).getPropertyValue('--mcrh-bg').trim() || '#1e1e1e', flyoutBackgroundColour: getComputedStyle(container).getPropertyValue('--mcrh-surface').trim() || '#252526', flyoutOpacity: 1, scrollbarColour: '#67717d' } }), media: options.media,
    css: false, sounds: false, trashcan: true, maxBlocks: MATERIAL_GRAPH_LIMITS.maxNodes * 2,
    toolbox: { kind: 'flyoutToolbox', contents: [...TYPES, 'reference'].map(type => ({ kind: 'block', type: `${PREFIX}${type}` })) },
    zoom: { controls: true, wheel: true, startScale: 0.85, minScale: 0.25, maxScale: 1.5 },
    grid: { spacing: 24, length: 1, colour: '#3c4854', snap: true }
  })
  let disposed = false
  let pending = false
  let updating = false
  const assertLive = () => { if (disposed) throw new Error(uiText("webview.materialGraphEditor.materialMapEditorReleased")) }
  const notify = () => {
    if (disposed || updating) return
    let graph: MaterialGraph | null = null
    let compiled: CompiledMaterialGraph | null = null
    let error: MaterialGraphValidationError | null = null
    try { graph = materialGraphFromWorkspace(workspace); compiled = compileMaterialGraph(graph) }
    catch (cause) { error = cause instanceof MaterialGraphValidationError ? cause : new MaterialGraphValidationError('INVALID_GRAPH', cause instanceof Error ? cause.message : String(cause)) }
    for (const block of workspace.getAllBlocks(false)) block.setWarningText(error?.nodeId === block.id ? error.message : null)
    options.onChange(graph, compiled, error)
  }
  const listener = (event: Blockly.Events.Abstract) => {
    if (event.isUiEvent || updating || disposed || pending) return
    pending = true
    queueMicrotask(() => { pending = false; notify() })
  }
  const setGraph = (input: unknown) => {
    assertLive()
    const compiled = compileMaterialGraph(input)
    const state = graphState(input as MaterialGraph, compiled)
    const backup = Blockly.serialization.workspaces.save(workspace)
    updating = true
    Blockly.Events.disable()
    try {
      workspace.clear()
      const block = Blockly.serialization.blocks.append(state, workspace)
      for (const child of block.getDescendants(false).reverse()) updateConnectionTypes(child)
      compileMaterialGraph(materialGraphFromWorkspace(workspace))
      workspace.clearUndo()
      workspace.scrollCenter()
    } catch (error) {
      Blockly.serialization.workspaces.load(backup, workspace)
      throw error
    } finally { Blockly.Events.enable(); updating = false }
    notify()
  }
  const resize = () => { if (!disposed) Blockly.svgResize(workspace) }
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize)
  observer?.observe(container)
  workspace.addChangeListener(listener)
  try { setGraph(createDefaultMaterialGraph()) }
  catch (error) { observer?.disconnect(); workspace.dispose(); throw error }
  return {
    getGraph() { assertLive(); return materialGraphFromWorkspace(workspace) },
    setGraph,
    reset() { setGraph(createDefaultMaterialGraph()) },
    resize,
    dispose() {
      if (disposed) return
      disposed = true
      observer?.disconnect()
      workspace.removeChangeListener(listener)
      workspace.dispose()
    }
  }
}
