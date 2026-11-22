import { uiText } from '../../i18n/messages'
import { z } from 'zod'

export const SUPPORTED_SHADER_TARGETS = Object.freeze([
  '1.17', '1.17.1', '1.18', '1.18.1', '1.18.2',
  '1.19', '1.19.1', '1.19.2', '1.19.3', '1.19.4',
  '1.20', '1.20.1', '1.20.2', '1.20.3', '1.20.4'
] as const)

export const SHADER_GRAPH_LIMITS = Object.freeze({
  maxBlocks: 64,
  uvScale: Object.freeze({ min: 0.01, max: 64 }),
  scroll: Object.freeze({ min: -16, max: 16 }),
  rotate: Object.freeze({ min: -32, max: 32 }),
  stars: Object.freeze({ densityMin: 1, densityMax: 256, brightnessMin: 0, brightnessMax: 8 }),
  vortex: Object.freeze({ min: -32, max: 32 }),
  tint: Object.freeze({ min: 0, max: 1 })
})

export type ShaderGraphBlock =
  | { type: 'uvScale'; x: number; y: number }
  | { type: 'scroll'; x: number; y: number }
  | { type: 'rotate'; speed: number }
  | { type: 'stars'; density?: number; brightness?: number }
  | { type: 'vortex'; strength: number }
  | { type: 'tint'; r: number; g: number; b: number }
  | { type: 'output' }

export interface CompileShaderGraphOptions {
  targetVersion: string
  blocks: readonly ShaderGraphBlock[]
  targetStage?: 'textureSnippet'
}

export interface ShaderGraphFile {
  path: string
  content: string
}

export interface CompiledShaderGraph {
  files: ShaderGraphFile[]
  warnings: string[]
}

export type ShaderGraphErrorCode = 'UNSUPPORTED_TARGET' | 'INVALID_GRAPH' | 'INVALID_ORDER'

export class ShaderGraphValidationError extends Error {
  constructor(public readonly code: ShaderGraphErrorCode, message: string) {
    super(message)
    this.name = 'ShaderGraphValidationError'
  }
}

const bounded = (min: number, max: number) => z.number().finite().min(min).max(max)
const limits = SHADER_GRAPH_LIMITS
const blockSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('uvScale'), x: bounded(limits.uvScale.min, limits.uvScale.max), y: bounded(limits.uvScale.min, limits.uvScale.max) }),
  z.strictObject({ type: z.literal('scroll'), x: bounded(limits.scroll.min, limits.scroll.max), y: bounded(limits.scroll.min, limits.scroll.max) }),
  z.strictObject({ type: z.literal('rotate'), speed: bounded(limits.rotate.min, limits.rotate.max) }),
  z.strictObject({ type: z.literal('stars'), density: bounded(limits.stars.densityMin, limits.stars.densityMax).int().default(32), brightness: bounded(limits.stars.brightnessMin, limits.stars.brightnessMax).default(1) }),
  z.strictObject({ type: z.literal('vortex'), strength: bounded(limits.vortex.min, limits.vortex.max) }),
  z.strictObject({ type: z.literal('tint'), r: bounded(limits.tint.min, limits.tint.max), g: bounded(limits.tint.min, limits.tint.max), b: bounded(limits.tint.min, limits.tint.max) }),
  z.strictObject({ type: z.literal('output') })
])
const optionsSchema = z.strictObject({
  targetVersion: z.enum(SUPPORTED_SHADER_TARGETS),
  targetStage: z.literal('textureSnippet').default('textureSnippet'),
  blocks: z.array(blockSchema).min(1).max(limits.maxBlocks)
})
type ParsedGraph = z.infer<typeof optionsSchema>
const uvTypes = new Set(['uvScale', 'scroll', 'rotate', 'vortex'])
const exportRoot = 'shader-graph'
const referenceName = 'mcrh_graph_reference'

function parseGraph(input: unknown): ParsedGraph {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ShaderGraphValidationError('INVALID_GRAPH', uiText("core.advanced.shaderGraph.colourchartingConfigurationMustBeAnObject"))
  }
  const raw = input as Record<string, unknown>
  if (!(SUPPORTED_SHADER_TARGETS as readonly unknown[]).includes(raw.targetVersion)) {
    throw new ShaderGraphValidationError('UNSUPPORTED_TARGET', uiText("core.advanced.shaderGraph.onlyTheClearlyListedJavaOfficialVersion"))
  }
  if (Array.isArray(raw.blocks) && raw.blocks.length > limits.maxBlocks) {
    throw new ShaderGraphValidationError('INVALID_GRAPH', uiText("core.advanced.shaderGraph.blockLimit", limits.maxBlocks))
  }
  const parsed = optionsSchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new ShaderGraphValidationError('INVALID_GRAPH', uiText("core.advanced.shaderGraph.colorchartingFieldIsInvalid", issue.path.join('.') || uiText("core.advanced.shaderGraph.configure"), issue.message))
  }
  const graph = parsed.data
  const outputs = graph.blocks.filter(block => block.type === 'output')
  if (outputs.length !== 1 || graph.blocks[graph.blocks.length - 1].type !== 'output') {
    throw new ShaderGraphValidationError('INVALID_ORDER', uiText("core.advanced.shaderGraph.thereMustBeAndOnlyOneOutput"))
  }
  let colorStarted = false
  for (const block of graph.blocks) {
    if (uvTypes.has(block.type) && colorStarted) {
      throw new ShaderGraphValidationError('INVALID_ORDER', uiText("core.advanced.shaderGraph.uvSquaresMustBePlacedBeforeStars"))
    }
    if (block.type === 'stars' || block.type === 'tint') colorStarted = true
  }
  return graph
}

function glslNumber(value: number): string {
  if (Object.is(value, -0)) return '0.0'
  const text = String(value)
  const [mantissa, exponent] = text.toLowerCase().split('e')
  return `${mantissa.includes('.') ? mantissa : `${mantissa}.0`}${exponent === undefined ? '' : `e${exponent}`}`
}

const rotateHelper = `vec2 mcrh_rotate_uv(vec2 uv, float angle) {
    vec2 centered = uv - vec2(0.5);
    float c = cos(angle);
    float s = sin(angle);
    return mat2(c, s, -s, c) * centered + vec2(0.5);
}`

const sampleHelper = `vec4 mcrh_sample_tile(sampler2D sourceTexture, vec2 localUv, vec4 atlasBounds, vec4 originalColor) {
    vec2 halfTexel = vec2(0.5) / vec2(textureSize(sourceTexture, 0));
    vec2 inset = min(halfTexel, atlasBounds.zw * 0.5);
    vec2 lower = atlasBounds.xy + inset;
    vec2 upper = atlasBounds.xy + atlasBounds.zw - inset;
    vec2 atlasUv = mix(lower, upper, fract(localUv));
    return vec4(texture(sourceTexture, atlasUv).rgb, originalColor.a);
}`

const starsHelper = `float mcrh_hash(vec2 point) {
    return fract(sin(dot(point, vec2(127.1, 311.7))) * 43758.5453);
}

float mcrh_stars(vec2 uv, float density, float timeSeconds) {
    vec2 cell = floor(uv * density);
    vec2 point = fract(uv * density);
    vec2 offset = vec2(mcrh_hash(cell), mcrh_hash(cell + vec2(19.19, 73.73)));
    vec2 center = vec2(0.1) + offset * 0.8;
    float radius = mix(0.025, 0.085, mcrh_hash(cell + vec2(4.0, 17.0)));
    float sparkle = 0.65 + 0.35 * sin(timeSeconds * 2.0 + mcrh_hash(cell) * 6.2831853);
    return (1.0 - smoothstep(0.0, radius, length(point - center))) * sparkle;
}`

function createSnippet(graph: ParsedGraph): string {
  const usesUv = graph.blocks.some(block => uvTypes.has(block.type))
  const usesRotate = graph.blocks.some(block => block.type === 'rotate' || block.type === 'vortex')
  const usesStars = graph.blocks.some(block => block.type === 'stars')
  const helpers = [usesRotate ? rotateHelper : '', usesUv ? sampleHelper : '', usesStars ? starsHelper : ''].filter(Boolean)
  const body = ['    vec2 mcrhUv = localUv;']
  let sampled = false
  for (const block of graph.blocks) {
    if (!uvTypes.has(block.type) && !sampled) {
      body.push(`    vec4 mcrhColor = ${usesUv ? 'mcrh_sample_tile(sourceTexture, mcrhUv, atlasBounds, originalColor)' : 'originalColor'};`)
      sampled = true
    }
    switch (block.type) {
      case 'uvScale':
        body.push(`    mcrhUv = (mcrhUv - vec2(0.5)) * vec2(${glslNumber(block.x)}, ${glslNumber(block.y)}) + vec2(0.5);`)
        break
      case 'scroll':
        body.push(`    mcrhUv += vec2(${glslNumber(block.x)}, ${glslNumber(block.y)}) * timeSeconds;`)
        break
      case 'rotate':
        body.push(`    mcrhUv = mcrh_rotate_uv(mcrhUv, ${glslNumber(block.speed)} * timeSeconds);`)
        break
      case 'vortex':
        body.push(`    mcrhUv = mcrh_rotate_uv(mcrhUv, ${glslNumber(block.strength)} * exp(-length(mcrhUv - vec2(0.5)) * 4.0));`)
        break
      case 'stars':
        body.push(`    mcrhColor.rgb += vec3(mcrh_stars(mcrhUv, ${glslNumber(block.density)}, timeSeconds) * ${glslNumber(block.brightness)});`)
        break
      case 'tint':
        body.push(`    mcrhColor.rgb *= vec3(${glslNumber(block.r)}, ${glslNumber(block.g)}, ${glslNumber(block.b)});`)
        break
      case 'output':
        body.push('    return vec4(clamp(mcrhColor.rgb, vec3(0.0), vec3(1.0)), originalColor.a);')
        break
    }
  }
  const apply = `vec4 mcrh_apply_graph(sampler2D sourceTexture, vec2 localUv, vec4 atlasBounds, float timeSeconds, vec4 originalColor) {\n${body.join('\n')}\n}`
  return `${['// Manual integration snippet; no main or global uniforms.', ...helpers, apply].join('\n\n')}\n`
}

function createVertex(hasFogShape: boolean): string {
  return `#version 150

in vec3 Position;
in vec4 Color;
in vec2 UV0;
in ivec2 UV1;
in ivec2 UV2;
in vec3 Normal;

uniform sampler2D Sampler2;
uniform mat4 ModelViewMat;
uniform mat4 ProjMat;
uniform vec3 Light0_Direction;
uniform vec3 Light1_Direction;
${hasFogShape ? 'uniform int FogShape;\n' : ''}
out float vertexDistance;
out vec4 vertexColor;
out vec2 texCoord0;

void main() {
    vec4 viewPosition = ModelViewMat * vec4(Position, 1.0);
    gl_Position = ProjMat * viewPosition;
    float diffuse = min(1.0, (max(0.0, dot(Light0_Direction, Normal)) + max(0.0, dot(Light1_Direction, Normal))) * 0.6 + 0.4);
    vertexColor = vec4(Color.rgb * diffuse, Color.a) * texelFetch(Sampler2, UV2 / 16, 0);
    texCoord0 = UV0;
    vertexDistance = ${hasFogShape ? 'FogShape == 0 ? length(viewPosition.xyz) : max(length(viewPosition.xz), abs(viewPosition.y))' : 'length(viewPosition.xyz)'};
}
`
}

function createFragment(snippet: string): string {
  return `#version 150

uniform sampler2D Sampler0;
uniform vec4 ColorModulator;
uniform float FogStart;
uniform float FogEnd;
uniform vec4 FogColor;
uniform float GameTime;
uniform int McrhGraphEnabled;
uniform vec4 McrhUvRect;

in float vertexDistance;
in vec4 vertexColor;
in vec2 texCoord0;

out vec4 fragColor;

${snippet}
void main() {
    vec4 originalColor = texture(Sampler0, texCoord0);
    vec4 color = originalColor;
    if (McrhGraphEnabled != 0 && all(greaterThan(McrhUvRect.zw, vec2(0.0)))) {
        vec2 localUv = (texCoord0 - McrhUvRect.xy) / McrhUvRect.zw;
        color = mcrh_apply_graph(Sampler0, localUv, McrhUvRect, GameTime * 1200.0, originalColor);
    }
    color *= vertexColor * ColorModulator;
    if (color.a < 0.1) discard;
    float fogFactor = FogEnd > FogStart ? smoothstep(FogStart, FogEnd, vertexDistance) : step(FogEnd, vertexDistance);
    fragColor = vec4(mix(color.rgb, FogColor.rgb, fogFactor * FogColor.a), color.a);
}
`
}

function createProgram(hasFogShape: boolean): string {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const uniform = (name: string, type: string, values: number[]) => ({ name, type, count: values.length, values })
  const uniforms = [
    uniform('ModelViewMat', 'matrix4x4', identity),
    uniform('ProjMat', 'matrix4x4', [...identity]),
    uniform('ColorModulator', 'float', [1, 1, 1, 1]),
    uniform('Light0_Direction', 'float', [0, 1, 0]),
    uniform('Light1_Direction', 'float', [0, 1, 0]),
    uniform('FogStart', 'float', [0]),
    uniform('FogEnd', 'float', [1]),
    uniform('FogColor', 'float', [0, 0, 0, 0]),
    uniform('GameTime', 'float', [0]),
    uniform('McrhGraphEnabled', 'int', [0]),
    uniform('McrhUvRect', 'float', [0, 0, 1, 1])
  ]
  if (hasFogShape) uniforms.push(uniform('FogShape', 'int', [0]))
  return `${JSON.stringify({
    blend: { func: 'add', srcrgb: 'srcalpha', dstrgb: '1-srcalpha' },
    vertex: referenceName,
    fragment: referenceName,
    attributes: ['Position', 'Color', 'UV0', 'UV1', 'UV2', 'Normal'],
    samplers: [{ name: 'Sampler0' }, { name: 'Sampler2' }],
    uniforms
  }, null, 2)}\n`
}

function createReadme(graph: ParsedGraph): string {
  return uiText("core.advanced.shaderGraph.colourImageIntegrationSnippetsThisIsNot", graph.targetVersion, graph.targetVersion, referenceName)
}

export function compileShaderGraph(options: CompileShaderGraphOptions): CompiledShaderGraph
export function compileShaderGraph(options: unknown): CompiledShaderGraph
export function compileShaderGraph(options: unknown): CompiledShaderGraph {
  const graph = parseGraph(options)
  const hasFogShape = !graph.targetVersion.startsWith('1.17')
  const snippet = createSnippet(graph)
  const warnings = [
    uiText("core.advanced.shaderGraph.exportOnlyAnIntegratedSegmentWhichDoes"),
    uiText("core.advanced.shaderGraph.objectiveAnOldConservativeWhiteListOf", graph.targetVersion),
    uiText("core.advanced.shaderGraph.theOriginalTextureVerticalColourIdentificationOf"),
    uiText("core.advanced.shaderGraph.browserCanvasPreviewIsOnlyApproximateApproximate")
  ]
  if (graph.blocks.some(block => block.type === 'scroll' || block.type === 'rotate' || block.type === 'stars')) {
    warnings.push(uiText("core.advanced.shaderGraph.timeInputIsInSecondsTheOld"))
  }
  return {
    files: [
      { path: `${exportRoot}/mcrh_graph.glsl`, content: snippet },
      { path: `${exportRoot}/reference/${referenceName}.vsh`, content: createVertex(hasFogShape) },
      { path: `${exportRoot}/reference/${referenceName}.fsh`, content: createFragment(snippet) },
      { path: `${exportRoot}/reference/${referenceName}.json`, content: createProgram(hasFogShape) },
      { path: `${exportRoot}/graph.json`, content: `${JSON.stringify({ formatVersion: 1, ...graph }, null, 2)}\n` },
      { path: `${exportRoot}/README.md`, content: createReadme(graph) }
    ],
    warnings
  }
}