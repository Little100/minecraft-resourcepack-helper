import { uiText } from '../i18n/messages'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { z } from 'zod'
import { compileMaterialGraph } from '../core/advanced/materialGraph'
export type SceneWorkbenchDebugMode = 'final' | 'base' | 'normal' | 'roughness' | 'metallic' | 'emissive' | 'ao'
export type SceneWorkbenchVector3 = [number, number, number]
export type SceneWorkbenchTextureChannel = 'albedo' | 'normal' | 'roughness' | 'metallic' | 'emissive' | 'ao'

export interface SceneWorkbenchRgbaTexture {
  width: number
  height: number
  data: Uint8Array
}

// 缺省通道保持不变，null 移除通道
export type SceneWorkbenchTextures = Partial<Record<SceneWorkbenchTextureChannel, SceneWorkbenchRgbaTexture | null>>

export interface SceneWorkbenchShader {
  vertexShader: string
  fragmentShader: string
}

export interface SceneWorkbenchBlock {
  id: string
  position: SceneWorkbenchVector3
  resource?: string
  properties?: Record<string, string>
  color?: number | SceneWorkbenchVector3
  size?: SceneWorkbenchVector3
  rotation?: SceneWorkbenchVector3
}

export interface SceneWorkbenchCamera {
  position: SceneWorkbenchVector3
  target: SceneWorkbenchVector3
  projection: 'perspective'
  fov: number
  aspect: number
  near: number
  far: number
  exposure: number
}

export interface SceneWorkbenchScene {
  version: 1
  blocks: SceneWorkbenchBlock[]
  camera?: { position: SceneWorkbenchVector3; target: SceneWorkbenchVector3 }
  lighting?: { sunDirection?: SceneWorkbenchVector3; sunIntensity?: number; ambientIntensity?: number; exposure?: number; environmentIntensity?: number; shadows?: boolean }
}

// 工厂转移对象所有权，共享缓存资源请提供实例副本
export type SceneWorkbenchBlockFactory = (block: SceneWorkbenchBlock) => Promise<THREE.Object3D>

export interface SceneWorkbenchOptions {
  scene?: SceneWorkbenchScene
  textures?: SceneWorkbenchTextures
  shader?: SceneWorkbenchShader
  debug?: SceneWorkbenchDebugMode
  blockFactory?: SceneWorkbenchBlockFactory
  messageBridge?: boolean
  postMessage?: (message: SceneWorkbenchOutboundMessage) => void
}

export interface SceneWorkbenchApi {
  setScene(scene: SceneWorkbenchScene): void
  setLighting(lighting: NonNullable<SceneWorkbenchScene['lighting']>): void
  getScene(): SceneWorkbenchScene
  getCamera(): SceneWorkbenchCamera
  setSelection(id?: string): void
  setActive(active: boolean): void
  setTextures(textures: SceneWorkbenchTextures): void
  setResourceTextures(resource: string, textures: SceneWorkbenchTextures | null): void
  clearResourceTextures(): void
  setShader(shader: SceneWorkbenchShader): void
  setDebug(mode: SceneWorkbenchDebugMode): void
  setBlockFactory(factory?: SceneWorkbenchBlockFactory): void
  resize(): void
  dispose(): void
}

export type SceneWorkbenchOutboundMessage =
  | { command: 'sceneWorkbenchReady' }
  | { command: 'sceneWorkbenchSelectionChanged'; id?: string; normal?: SceneWorkbenchVector3; point?: SceneWorkbenchVector3 }
  | { command: 'sceneWorkbenchSceneChanged'; scene: SceneWorkbenchScene; reason: 'place' | 'delete' | 'move' }
  | { command: 'sceneWorkbenchError'; error: string }

// 调试视图数值与材质图编译器一致
export const SCENE_WORKBENCH_DEBUG_VALUES: Record<SceneWorkbenchDebugMode, number> = {
  final: 0, base: 1, normal: 2, roughness: 3, metallic: 4, emissive: 5, ao: 6
}

const defaultShader = compileMaterialGraph({ version: 1, nodes: [{ id: 'output', type: 'output' }], output: 'output' })
export const SCENE_WORKBENCH_DEFAULT_VERTEX_SHADER = defaultShader.vertexShader
export const SCENE_WORKBENCH_DEFAULT_FRAGMENT_SHADER = defaultShader.fragmentShader

const vectorSchema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])
const blockSchema = z.object({
  id: z.string().min(1).max(256),
  position: vectorSchema,
  resource: z.string().max(512).optional(),
  properties: z.record(z.string(), z.string()).optional(),
  color: z.union([z.number().int().min(0).max(0xffffff), vectorSchema]).optional(),
  size: z.tuple([z.number().positive().finite(), z.number().positive().finite(), z.number().positive().finite()]).optional(),
  rotation: vectorSchema.optional()
})
const sceneSchema = z.object({
  version: z.literal(1),
  blocks: z.array(blockSchema).max(4096).refine(blocks => new Set(blocks.map(block => block.id)).size === blocks.length, uiText("webview.sceneWorkbench.cubeIdCannotBeRepeated")),
  camera: z.object({ position: vectorSchema, target: vectorSchema }).optional(),
  lighting: z.object({
    sunDirection: vectorSchema.optional(),
    sunIntensity: z.number().min(0).max(100).optional(),
    ambientIntensity: z.number().finite().min(0).max(20).optional(),
    exposure: z.number().finite().min(0.01).max(20).optional(),
    environmentIntensity: z.number().finite().min(0).max(20).optional(),
    shadows: z.boolean().optional()
  }).optional()
})
const shaderSchema = z.object({ vertexShader: z.string().trim().min(1).max(500000), fragmentShader: z.string().trim().min(1).max(500000) })
const debugSchema = z.enum(['final', 'base', 'normal', 'roughness', 'metallic', 'emissive', 'ao'])
const messageSchema = z.union([
  z.object({ command: z.enum(['sceneWorkbenchInit', 'sceneWorkbenchSetScene']), scene: sceneSchema }),
  z.object({ command: z.literal('sceneWorkbenchPlaceBlock'), block: blockSchema }),
  z.object({ command: z.literal('sceneWorkbenchDeleteBlock'), id: z.string() }),
  z.object({ command: z.literal('sceneWorkbenchMoveBlock'), id: z.string(), position: vectorSchema }),
  z.object({ command: z.literal('sceneWorkbenchSetDebug'), mode: debugSchema }),
  z.object({ command: z.literal('sceneWorkbenchSetShader'), shader: shaderSchema })
])

const DEFAULT_CAMERA = { position: [7, 6, 8] as SceneWorkbenchVector3, target: [0, 0, 0] as SceneWorkbenchVector3 }
const CHANNEL_DEFAULTS: Record<SceneWorkbenchTextureChannel, number[]> = {
  albedo: [255, 255, 255, 255], normal: [128, 128, 255, 255], roughness: [180, 180, 180, 255],
  metallic: [0, 0, 0, 255], emissive: [0, 0, 0, 255], ao: [255, 255, 255, 255]
}
const CHANNEL_UNIFORMS: Record<SceneWorkbenchTextureChannel, string> = {
  albedo: 'uAlbedo', normal: 'uNormal', roughness: 'uRoughness', metallic: 'uMetallic', emissive: 'uEmissive', ao: 'uAo'
}
const CHANNELS = Object.keys(CHANNEL_DEFAULTS) as SceneWorkbenchTextureChannel[]
type TextureSet = Record<SceneWorkbenchTextureChannel, THREE.DataTexture>
interface BlockEntry { block: SceneWorkbenchBlock; wrapper: THREE.Group; object: THREE.Object3D; owned: OwnedResources }
interface OwnedResources { geometries: Set<THREE.BufferGeometry>; materials: Set<THREE.Material>; textures: Set<THREE.Texture> }
interface MaterialBinding { mesh: THREE.Mesh; original: THREE.Material | THREE.Material[]; previews?: THREE.ShaderMaterial[]; parent?: string }

export function createSceneWorkbench(container: HTMLElement, options: SceneWorkbenchOptions = {}): SceneWorkbenchApi {
  let sceneData: SceneWorkbenchScene = sceneSchema.parse(options.scene ?? { version: 1, blocks: [] })
  let shader = options.shader ? shaderSchema.parse(options.shader) : undefined
  let debug = debugSchema.parse(options.debug ?? 'final')
  let factory = options.blockFactory
  let disposed = false
  let active = true
  let revision = 0
  let selectedId: string | undefined
  let frame = 0
  const entries = new Map<string, BlockEntry>()
  const bindings = new Map<THREE.Mesh, MaterialBinding>()
  const canvas = document.createElement('canvas')
  canvas.className = 'mcrh-scene-workbench__canvas'
  canvas.setAttribute('aria-label', uiText("webview.sceneWorkbench.sitePreview"))
  canvas.tabIndex = 0
  container.classList.add('mcrh-scene-workbench')
  container.append(canvas)
  const context = canvas.getContext('webgl2', { alpha: false, antialias: true })
  if (!context) {
    canvas.remove()
    container.classList.remove('mcrh-scene-workbench')
    throw new Error(uiText("webview.sceneWorkbench.theCurrentEnvironmentDoesNotSupportWebgl2"))
  }
  const renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.toneMapping = THREE.ReinhardToneMapping
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  const world = new THREE.Scene()
  world.background = new THREE.Color(0x0a0e14)
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000)
  camera.position.fromArray(DEFAULT_CAMERA.position)
  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.minDistance = 0.5
  controls.maxDistance = 200
  const blockRoot = new THREE.Group()
  world.add(blockRoot)
  const grid = new THREE.GridHelper(24, 24, 0x526c83, 0x263544)
  grid.position.y = -0.499
  const axes = new THREE.AxesHelper(0.75)
  axes.position.y = -0.49
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(24, 24), new THREE.MeshStandardMaterial({ color: 0x121b26, roughness: 0.9 }))
  ground.rotation.x = -Math.PI / 2
  ground.position.y = -0.501
  ground.receiveShadow = true
  const ambient = new THREE.AmbientLight(0xffffff, 0.6)
  const sun = new THREE.DirectionalLight(0xffffff, 1)
  sun.position.set(-5, 8, 4)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.camera.left = sun.shadow.camera.bottom = -14
  sun.shadow.camera.right = sun.shadow.camera.top = 14
  sun.shadow.camera.far = 60
  sun.shadow.normalBias = 0.025
  sun.shadow.bias = -0.0002
  world.add(grid, axes, ground, ambient, sun)
  const selection = new THREE.Box3Helper(new THREE.Box3(), 0x7cf6ff)
  selection.visible = false
  world.add(selection)
  let textures = createTextures()
  const resourceTextures = new Map<string, Partial<TextureSet>>()
  let material = makeMaterial()
  let textureOverride = false
  let albedoOverride = false
  let lastFrameTime = performance.now()
  let elapsedSeconds = 0
  const report = (error: unknown) => emit({ command: 'sceneWorkbenchError', error: error instanceof Error ? error.message : String(error) })
  const emit = (message: SceneWorkbenchOutboundMessage) => {
    if (!disposed) options.postMessage?.(message)
  }
  renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
    report(new Error([gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)].filter(Boolean).join('\n')))
  }

  function assertAlive(): void {
    if (disposed) throw new Error(uiText("webview.sceneWorkbench.theSceneTableHasBeenDestroyed"))
  }

  function makeMaterial(): THREE.ShaderMaterial {
    let vertexShader = shader?.vertexShader ?? SCENE_WORKBENCH_DEFAULT_VERTEX_SHADER
    let fragmentShader = shader?.fragmentShader ?? SCENE_WORKBENCH_DEFAULT_FRAGMENT_SHADER
    const shadowHook = 'float mcrhShadowMask() { return 1.0; }'
    if (fragmentShader.includes(shadowHook) && vertexShader.includes('gl_Position = projectionMatrix * mvPosition;')) {
      vertexShader = '#include <common>\n#include <shadowmap_pars_vertex>\n' + vertexShader.replace('gl_Position = projectionMatrix * mvPosition;', 'vec3 transformed = position;\nvec3 transformedNormal = normalMatrix * normal;\n#include <worldpos_vertex>\n#include <shadowmap_vertex>\ngl_Position = projectionMatrix * mvPosition;')
      fragmentShader = '#include <common>\n#include <packing>\n#include <lights_pars_begin>\n#include <shadowmap_pars_fragment>\n#include <shadowmask_pars_fragment>\n' + fragmentShader.replace(shadowHook, 'float mcrhShadowMask() { return getShadowMask(); }')
    }
    const uniforms: Record<string, THREE.IUniform> = {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.lights),
      uTime: { value: 0 }, uDebug: { value: SCENE_WORKBENCH_DEBUG_VALUES[debug] },
      uSunDirection: { value: new THREE.Vector3().fromArray(sceneData.lighting?.sunDirection ?? [-0.4, 1, 0.6]) },
      uAmbientIntensity: { value: sceneData.lighting?.ambientIntensity ?? 0.5 },
      uEnvironmentIntensity: { value: sceneData.lighting?.environmentIntensity ?? 0.6 },
      uExposure: { value: sceneData.lighting?.exposure ?? 1 },
      uSunIntensity: { value: sceneData.lighting?.sunIntensity ?? 1.4 }, uAlphaTest: { value: 0.1 }
    }
    for (const channel of CHANNELS) uniforms[CHANNEL_UNIFORMS[channel]] = { value: textures[channel] }
    return new THREE.ShaderMaterial({
      vertexShader, fragmentShader,
      uniforms,
      vertexColors: true,
      lights: true,
      side: THREE.DoubleSide
    })
  }

  function releasePreviews(binding: MaterialBinding): void {
    for (const preview of binding.previews ?? []) {
      ;(preview.userData.sourceAlbedo as THREE.Texture | undefined)?.dispose()
      preview.dispose()
    }
  }

  function bindMaterials(): void {
    for (const binding of bindings.values()) binding.mesh.material = binding.original
    for (const entry of entries.values()) {
      entry.object.traverse(node => {
        if (!(node as THREE.Mesh).isMesh) return
        const mesh = node as THREE.Mesh
        mesh.castShadow = true
        mesh.receiveShadow = true
        if (!bindings.has(mesh)) bindings.set(mesh, { mesh, original: mesh.material })
        const overrides = entry.block.resource ? resourceTextures.get(entry.block.resource) : undefined
        if (shader || textureOverride || overrides || (debug !== 'base' && debug !== 'final') || entry.object.userData.sceneWorkbenchFallback) {
          const binding=bindings.get(mesh)!
          if(binding.parent!==material.uuid){
            releasePreviews(binding)
            const originals=Array.isArray(binding.original)?binding.original:[binding.original]
            binding.previews=originals.map(source=>{
              const original=source as THREE.Material & {map?:THREE.Texture;uniforms?:Record<string,THREE.IUniform>}
              const sourceMap=original.map ?? original.uniforms?.map?.value as THREE.Texture | undefined
              const map=sourceMap?.clone()
              if(map){map.colorSpace=THREE.NoColorSpace;map.needsUpdate=true}
              const preview=material.clone()
              preview.transparent=source.transparent
              preview.depthWrite=source.depthWrite
              preview.alphaTest=source.alphaTest||0.1
              preview.side=source.side
              preview.uniforms={...material.uniforms,uAlbedo:{value:albedoOverride?textures.albedo:map??textures.albedo},uAlphaTest:{value:source.alphaTest||0.1}}
              preview.userData.sourceAlbedo=map
              preview.userData.sourceTextures=source.userData.sceneWorkbenchTextures
              return preview
            })
            binding.parent=material.uuid
          }
          for (const preview of binding.previews!) {
            const source = preview.userData.sourceTextures as Partial<TextureSet> | undefined
            for (const channel of CHANNELS) {
              const value = overrides?.[channel] ?? (channel === 'albedo' ? (albedoOverride ? textures.albedo : preview.userData.sourceAlbedo) : source?.[channel]) ?? textures[channel]
              preview.uniforms[CHANNEL_UNIFORMS[channel]] = { value }
              if (channel === 'albedo') (preview as THREE.ShaderMaterial & { map?: THREE.Texture }).map = value
            }
          }
          mesh.material=Array.isArray(binding.original)?binding.previews!:binding.previews![0]
        }
      })
    }
  }

  function releaseEntry(entry: BlockEntry): void {
    entry.object.traverse(node => {
      const binding = bindings.get(node as THREE.Mesh)
      if (binding) { binding.mesh.material = binding.original; releasePreviews(binding); bindings.delete(binding.mesh) }
    })
    entry.wrapper.removeFromParent()
    const dispose = entry.object.userData.studioDispose as (() => void) | undefined
    if (dispose) dispose()
    else releaseOwned(entry.owned)
  }

  function refreshSelection(): void {
    const entry = selectedId ? entries.get(selectedId) : undefined
    selection.visible = Boolean(entry)
    if (entry) selection.box.setFromObject(entry.wrapper)
    if (selectedId) container.dataset.selectedId = selectedId
    else delete container.dataset.selectedId
  }

  function setSelection(id?: string): void {
    assertAlive()
    if (id !== undefined && !sceneData.blocks.some(block => block.id === id)) throw new Error(uiText("webview.sceneWorkbench.missingSelectedBlock"))
    selectedId = id
    bindMaterials()
    refreshSelection()
  }

  function select(id?: string, hit?: THREE.Intersection): void {
    setSelection(id)
    const normal=hit?.face?.normal.clone().transformDirection(hit.object.matrixWorld)
    emit({ command: 'sceneWorkbenchSelectionChanged', ...(id ? { id } : {}), ...(normal?{normal:normal.toArray()}:{}), ...(hit?{point:hit.point.toArray()}:{}) })
  }

  async function rebuild(): Promise<void> {
    const current = ++revision
    const snapshot = sceneData.blocks.map(cloneBlock)
    const currentFactory = factory
    for (const entry of entries.values()) releaseEntry(entry)
    entries.clear()
    container.dataset.blockCount = '0'
    container.dataset.loading = 'true'
    refreshSelection()
    await Promise.all(snapshot.map(async block => {
      let object: THREE.Object3D
      try {
        if(!currentFactory && block.resource) throw new Error(uiText("webview.sceneWorkbench.readTheResourcePackFirst", block.resource))
        object = currentFactory ? await currentFactory(cloneBlock(block)) : makeCube(block)
        if (!object?.isObject3D) throw new Error(uiText("webview.sceneWorkbench.blockfactoryMustReturnThreeObject3d"))
      } catch (error) {
        if (current === revision && !disposed) report(error)
        return
      }
      const owned = collectOwned(object)
      if (disposed || current !== revision) { const release=object.userData.studioDispose as (()=>void)|undefined; if(release) release(); else releaseOwned(owned); return }
      const latest = sceneData.blocks.find(item => item.id === block.id)
      if (!latest) { const release=object.userData.studioDispose as (()=>void)|undefined; if(release) release(); else releaseOwned(owned); return }
      const wrapper = new THREE.Group()
      wrapper.position.fromArray(latest.position)
      if (latest.rotation) wrapper.rotation.set(...latest.rotation)
      wrapper.userData.sceneBlockId = latest.id
      wrapper.add(object)
      blockRoot.add(wrapper)
      entries.set(block.id, { block: latest, object, wrapper, owned })
      bindMaterials()
      refreshSelection()
      container.dataset.blockCount = String(entries.size)
    }))
    if (!disposed && current === revision) {
      if (selectedId && !entries.has(selectedId)) selectedId = undefined
      bindMaterials()
      refreshSelection()
      container.dataset.loading = 'false'
    }
  }

  function applyScene(): void {
    if (sceneData.camera) {
      camera.position.fromArray(sceneData.camera.position)
      controls.target.fromArray(sceneData.camera.target)
      controls.update()
    }
    applyLighting()
    void rebuild().catch(report)
  }

  function applyLighting(): void {
    ambient.intensity = sceneData.lighting?.ambientIntensity ?? 0.5
    sun.intensity = sceneData.lighting?.sunIntensity ?? 1.4
    sun.position.fromArray(sceneData.lighting?.sunDirection ?? [-0.55, 0.78, 0.34]).multiplyScalar(10)
    sun.position.normalize().multiplyScalar(24)
    sun.castShadow = sceneData.lighting?.shadows ?? true
    renderer.shadowMap.enabled = sun.castShadow
    renderer.toneMappingExposure = sceneData.lighting?.exposure ?? 1
    material.uniforms.uSunIntensity.value = sun.intensity
    material.uniforms.uSunDirection.value.copy(sun.position).normalize()
    material.uniforms.uAmbientIntensity.value = ambient.intensity
    material.uniforms.uEnvironmentIntensity.value = sceneData.lighting?.environmentIntensity ?? 0.6
    material.uniforms.uExposure.value = renderer.toneMappingExposure
  }

  function setLighting(lighting: NonNullable<SceneWorkbenchScene['lighting']>): void {
    assertAlive()
    const next = sceneSchema.shape.lighting.unwrap().parse(lighting)
    if (next.sunDirection?.every(value => value === 0)) throw new Error(uiText("core.sceneWorkbench.theLightCanTBeZero"))
    sceneData = { ...sceneData, lighting: next }
    applyLighting()
  }

  function setScene(scene: SceneWorkbenchScene): void {
    assertAlive()
    sceneData = sceneSchema.parse(scene)
    applyScene()
  }

  function getScene(): SceneWorkbenchScene {
    return {
      ...sceneSchema.parse(sceneData),
      camera: { position: camera.position.toArray(), target: controls.target.toArray() }
    }
  }

  function getCamera(): SceneWorkbenchCamera {
    return {
      position: camera.position.toArray(),
      target: controls.target.toArray(),
      projection: 'perspective',
      fov: camera.fov,
      aspect: camera.aspect,
      near: camera.near,
      far: camera.far,
      exposure: renderer.toneMappingExposure
    }
  }

  function setActive(next: boolean): void {
    assertAlive()
    if (typeof next !== 'boolean') throw new Error(uiText("webview.sceneWorkbench.activityStatusMustBeABooleanValue"))
    if (active === next) return
    active = next
    controls.enabled = active
    pointerStart = undefined
    container.dataset.active = String(active)
    if (active) {
      lastFrameTime = performance.now()
      tick(lastFrameTime)
    } else {
      cancelAnimationFrame(frame)
      frame = 0
    }
  }

  function setTextures(input: SceneWorkbenchTextures): void {
    assertAlive()
    const next = { ...textures }
    const replacements = new Map<SceneWorkbenchTextureChannel, THREE.DataTexture>()
    try {
      for (const channel of CHANNELS) {
        if (Object.prototype.hasOwnProperty.call(input, channel)) replacements.set(channel, makeTexture(channel, input[channel] ?? undefined))
      }
    } catch (error) {
      for (const texture of replacements.values()) texture.dispose()
      throw error
    }
    for (const [channel, texture] of replacements) {
      next[channel] = texture
      material.uniforms[CHANNEL_UNIFORMS[channel]].value = texture
      textures[channel].dispose()
    }
    textures = next
    textureOverride = true
    if (Object.prototype.hasOwnProperty.call(input,'albedo')) albedoOverride = input.albedo != null
    bindMaterials()
  }

  function setResourceTextures(resource: string, input: SceneWorkbenchTextures | null): void {
    assertAlive()
    if (typeof resource !== 'string' || !resource.length || resource.length > 256) throw new Error(uiText("webview.sceneWorkbench.materialResourceIdInvalid"))
    const previous = resourceTextures.get(resource)
    const next: Partial<TextureSet> = { ...previous }
    const replacements = new Map<SceneWorkbenchTextureChannel, THREE.DataTexture | undefined>()
    try {
      for (const channel of CHANNELS) {
        if (input === null) replacements.set(channel, undefined)
        else if (Object.prototype.hasOwnProperty.call(input, channel)) replacements.set(channel, input[channel] ? makeTexture(channel, input[channel]!) : undefined)
      }
    } catch (error) { for (const texture of replacements.values()) texture?.dispose(); throw error }
    for (const [channel, texture] of replacements) {
      previous?.[channel]?.dispose()
      if (texture) next[channel] = texture
      else delete next[channel]
    }
    if (Object.keys(next).length) resourceTextures.set(resource, next)
    else resourceTextures.delete(resource)
    bindMaterials()
  }

  function clearResourceTextures(): void {
    assertAlive()
    for (const values of resourceTextures.values()) for (const texture of Object.values(values)) texture.dispose()
    resourceTextures.clear()
    bindMaterials()
  }

  function setShader(input: SceneWorkbenchShader): void {
    assertAlive()
    const next = shaderSchema.parse(input)
    shader = next
    const previous = material
    material = makeMaterial()
    material.uniforms.uTime.value = previous.uniforms.uTime.value
    bindMaterials()
    previous.dispose()
  }

  function setDebug(mode: SceneWorkbenchDebugMode): void {
    assertAlive()
    debug = debugSchema.parse(mode)
    material.uniforms.uDebug.value = SCENE_WORKBENCH_DEBUG_VALUES[debug]
    container.dataset.debug = debug
    bindMaterials()
  }

  function setBlockFactory(next?: SceneWorkbenchBlockFactory): void {
    assertAlive()
    factory = next
    void rebuild().catch(report)
  }

  function resize(): void {
    if (disposed) return
    const width = Math.max(1, container.clientWidth)
    const height = Math.max(1, container.clientHeight)
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }

  let pointerStart: { x: number; y: number; button: number } | undefined
  const onPointerDown = (event: PointerEvent) => {
    if (active) pointerStart = { x: event.clientX, y: event.clientY, button: event.button }
  }
  const onPointerUp = (event: PointerEvent) => {
    if (!active || !pointerStart || pointerStart.button !== 0 || Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 4) return
    pointerStart = undefined
    const rect = canvas.getBoundingClientRect()
    const pointer = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1)
    const ray = new THREE.Raycaster()
    world.updateMatrixWorld(true)
    ray.setFromCamera(pointer, camera)
    const hit = ray.intersectObjects(blockRoot.children, true)[0]
    let node: THREE.Object3D | null = hit?.object ?? null
    while (node && !node.userData.sceneBlockId) node = node.parent
    select(node?.userData.sceneBlockId as string | undefined, hit)
  }
  const onMessage = (event: MessageEvent<unknown>) => {
    if (event.source !== window && event.source !== window.parent) return
    const raw = event.data as { command?: unknown } | null
    if (!raw || typeof raw.command !== 'string' || !raw.command.startsWith('sceneWorkbench')) return
    const result = messageSchema.safeParse(raw)
    if (!result.success) { report(new Error(uiText("webview.sceneWorkbench.theSceneMessageFormatIsInvalid"))); return }
    const message = result.data
    try {
      if (message.command === 'sceneWorkbenchInit' || message.command === 'sceneWorkbenchSetScene') setScene(message.scene)
      else if (message.command === 'sceneWorkbenchSetDebug') setDebug(message.mode)
      else if (message.command === 'sceneWorkbenchSetShader') setShader(message.shader)
      else {
        let reason: 'place' | 'delete' | 'move'
        if (message.command === 'sceneWorkbenchPlaceBlock') {
          if (sceneData.blocks.some(block => block.id === message.block.id)) throw new Error(uiText("webview.sceneWorkbench.cubeIdAlreadyExists"))
          if (sceneData.blocks.length >= 4096) throw new Error(uiText("webview.sceneWorkbench.theNumberOfSceneBlocksExceededThe"))
          sceneData.blocks.push(cloneBlock(message.block))
          selectedId = message.block.id
          reason = 'place'
          void rebuild().catch(report)
        } else if (message.command === 'sceneWorkbenchDeleteBlock') {
          sceneData.blocks = sceneData.blocks.filter(block => block.id !== message.id)
          const entry = entries.get(message.id)
          if (entry) { releaseEntry(entry); entries.delete(message.id) }
          if (selectedId === message.id) select(undefined)
          container.dataset.blockCount = String(entries.size)
          reason = 'delete'
        } else if (message.command === 'sceneWorkbenchMoveBlock') {
          const block = sceneData.blocks.find(block => block.id === message.id)
          if (!block) return
          block.position = [...message.position]
          entries.get(message.id)?.wrapper.position.fromArray(message.position)
          refreshSelection()
          reason = 'move'
        } else return
        emit({ command: 'sceneWorkbenchSceneChanged', scene: getScene(), reason })
      }
    } catch (error) { report(error) }
  }
  const observer = new ResizeObserver(resize)
  observer.observe(container)
  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointerup', onPointerUp)
  if (options.messageBridge !== false) window.addEventListener('message', onMessage)
  function tick(time = performance.now()): void {
    frame = 0
    if (disposed || !active) return
    elapsedSeconds += Math.max(0, time - lastFrameTime) / 1000
    lastFrameTime = time
    material.uniforms.uTime.value = elapsedSeconds
    controls.update()
    renderer.render(world, camera)
    frame = requestAnimationFrame(tick)
  }
  container.dataset.state = 'ready'
  container.dataset.active = 'true'
  container.dataset.debug = debug
  container.dataset.blockCount = '0'
  if (options.textures) setTextures(options.textures)
  applyScene()
  resize()
  tick()
  emit({ command: 'sceneWorkbenchReady' })
  return {
    setScene, setLighting, getScene, getCamera, setSelection, setActive, setTextures, setResourceTextures, clearResourceTextures, setShader, setDebug, setBlockFactory, resize,
    dispose() {
      if (disposed) return
      disposed = true
      revision++
      cancelAnimationFrame(frame)
      observer.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('message', onMessage)
      controls.dispose()
      for (const entry of entries.values()) releaseEntry(entry)
      entries.clear()
      for (const values of resourceTextures.values()) for (const texture of Object.values(values)) texture.dispose()
      resourceTextures.clear()
      for (const texture of Object.values(textures)) texture.dispose()
      material.dispose()
      releaseOwned(collectOwned(grid))
      releaseOwned(collectOwned(axes))
      releaseOwned(collectOwned(ground))
      releaseOwned(collectOwned(selection))
      sun.shadow.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
      container.classList.remove('mcrh-scene-workbench')
      container.dataset.state = 'disposed'
      container.dataset.active = 'false'
      container.dataset.blockCount = '0'
      delete container.dataset.selectedId
      delete container.dataset.loading
    }
  }
}

function cloneBlock(block: SceneWorkbenchBlock): SceneWorkbenchBlock {
  return blockSchema.parse(block)
}

function makeCube(block: SceneWorkbenchBlock): THREE.Object3D {
  const geometry = new THREE.BoxGeometry(...(block.size ?? [1, 1, 1]))
  const color = Array.isArray(block.color) ? new THREE.Color(...block.color) : new THREE.Color(block.color ?? 0x74b8ff)
  const values = new Float32Array(geometry.attributes.position.count * 3)
  for (let i = 0; i < values.length; i += 3) values.set([color.r, color.g, color.b], i)
  geometry.setAttribute('color', new THREE.BufferAttribute(values, 3))
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.7 }))
  mesh.userData.sceneWorkbenchFallback = true
  return mesh
}

function createTextures(): TextureSet {
  return Object.fromEntries(CHANNELS.map(channel => [channel, makeTexture(channel)])) as TextureSet
}

function makeTexture(channel: SceneWorkbenchTextureChannel, input?: SceneWorkbenchRgbaTexture): THREE.DataTexture {
  if (input && (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width < 1 || input.height < 1 || input.width > 4096 || input.height > 4096 || !(input.data instanceof Uint8Array) || input.data.length !== input.width * input.height * 4)) throw new Error(uiText("webview.sceneWorkbench.theTextureSizeOrByteLengthOf"))
  const texture = new THREE.DataTexture(input ? new Uint8Array(input.data) : new Uint8Array(CHANNEL_DEFAULTS[channel]), input?.width ?? 1, input?.height ?? 1, THREE.RGBAFormat)
  texture.colorSpace = THREE.NoColorSpace
  texture.flipY = true
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.needsUpdate = true
  return texture
}

function collectOwned(object: THREE.Object3D): OwnedResources {
  const owned: OwnedResources = { geometries: new Set(), materials: new Set(), textures: new Set() }
  object.traverse(node => {
    const mesh = node as THREE.Mesh
    if (mesh.geometry) owned.geometries.add(mesh.geometry)
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
    for (const material of materials) {
      owned.materials.add(material)
      for (const value of Object.values(material)) if (value?.isTexture && !value.userData?.cached) owned.textures.add(value)
      if ((material as THREE.ShaderMaterial).isShaderMaterial) {
        for (const uniform of Object.values((material as THREE.ShaderMaterial).uniforms)) {
          const texture = uniform.value as THREE.Texture | undefined
          if (texture?.isTexture && !texture.userData?.cached) owned.textures.add(texture)
        }
      }
    }
  })
  return owned
}

function releaseOwned(owned: OwnedResources): void {
  for (const geometry of owned.geometries) geometry.dispose()
  for (const material of owned.materials) material.dispose()
  for (const texture of owned.textures) texture.dispose()
}
