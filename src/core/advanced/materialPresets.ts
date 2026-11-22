import { uiText } from '../../i18n/messages'
import type { MaterialGraph } from './materialGraph'

export const MATERIAL_GRAPH_PRESETS: ReadonlyArray<{ id: string; label: string; graph: MaterialGraph }> = [
  { id: 'original', label: uiText("core.advanced.materialPresets.originalMaterial"), graph: { version: 1, nodes: [{ id: 'output', type: 'output' }], output: 'output' } },
  { id: 'pulse', label: uiText("core.advanced.materialPresets.pulsingEmission"), graph: { version: 1, output: 'output', nodes: [
    { id: 'time', type: 'time' }, { id: 'wave', type: 'sine', inputs: { value: 'time' }, params: { frequency: 0.35 } },
    { id: 'color', type: 'texture', params: { channel: 'albedo' } },
    { id: 'emission', type: 'multiply', inputs: { a: 'color', b: 'wave' } },
    { id: 'output', type: 'output', inputs: { emissive: 'emission' } }
  ] } },
  { id: 'rim', label: uiText("core.advanced.materialPresets.edgeGlow"), graph: { version: 1, output: 'output', nodes: [
    { id: 'edge', type: 'fresnel', params: { power: 3 } },
    { id: 'color', type: 'color', params: { value: [0.2, 0.65, 1] } },
    { id: 'emission', type: 'multiply', inputs: { a: 'color', b: 'edge' } },
    { id: 'output', type: 'output', inputs: { emissive: 'emission' } }
  ] } },
  { id: 'checker', label: uiText("core.advanced.materialPresets.checkerboardRoughness"), graph: { version: 1, output: 'output', nodes: [
    { id: 'uv', type: 'uv' }, { id: 'checker', type: 'checker', inputs: { uv: 'uv' }, params: { scale: 8 } },
    { id: 'smooth', type: 'smoothstep', inputs: { value: 'checker' }, params: { min: 0.1, max: 0.9 } },
    { id: 'output', type: 'output', inputs: { roughness: 'smooth' } }
  ] } }
]
