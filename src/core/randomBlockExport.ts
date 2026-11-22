import { uiText } from '../i18n/messages'
import { createHash } from 'node:crypto'
import { PNG } from 'pngjs'
import { canMarkTexture, markMcrhPixels } from './mcrhMark'
import type { PixelDocument } from './document'
import type { ModelPreviewAssets } from './modelPreviewAssets'
import { generateRandomBlockTextures, type GeneratedFile } from './advanced/textures'
import { javaModelResourcePath, javaModelTextureReference, loadJavaModelSnapshot, resolveJavaModelTexture, validateJavaModelResourceId, type JavaModelData } from './javaModelResources'
import { animationFrameHeight, updateAnimationMetadata } from './pixelAnimation'
import { parsePackFormat, comparePackFormats } from './packFormatValue'
import { metadataSchemaForFormat } from './advanced/versionCapabilities'

export interface RandomBlockExportSpec {
  document: PixelDocument
  assets: ModelPreviewAssets
  texturePath: string
  block: string
  mode: 'vanilla' | 'optifine'
  symmetry?: 'all' | 'opposite' | 'none'
  linked?: boolean
  metadata: unknown
  animation?: unknown
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n'
const canonical = (id: string): string => id.includes(':') ? id : 'minecraft:' + id
const MAX_FILES = 4096
const MAX_BYTES = 64 * 1024 * 1024

export async function generateRandomBlockPatch(spec: RandomBlockExportSpec): Promise<GeneratedFile[]> {
  validateJavaModelResourceId(spec.block)
  const block = canonical(spec.block), texture = javaModelTextureReference(spec.texturePath)
  if (!object(spec.metadata) || !object(spec.metadata.pack)) throw new Error(uiText("core.randomBlockExport.sourcePackageLacksAValidPackMcmeta"))
  const metadata = spec.metadata.pack
  const minimum = parsePackFormat(metadata.min_format), maximum = parsePackFormat(metadata.max_format, true), legacy = parsePackFormat(metadata.pack_format)
  if (metadata.min_format !== undefined || metadata.max_format !== undefined) {
    if (!minimum || !maximum || comparePackFormats(minimum, maximum) > 0) throw new Error(uiText("core.randomBlockExport.minFormatMaxFormatIsInvalid"))
  } else if (!legacy || metadataSchemaForFormat('resource', legacy) === 'range') throw new Error(uiText("core.randomBlockExport.packMcmetaLacksTheValidFormatRange"))
  if (metadata.description === null || !['string', 'object'].includes(typeof metadata.description)) throw new Error(uiText("core.randomBlockExport.packMcmetaLacksAValidPackageDescription"))
  const candidates = spec.document.layers.filter(layer => layer.visible && layer.randomVariant && layer.randomVariant.weight > 0)
  if (candidates.length < 2) throw new Error(uiText("core.randomBlockExport.weNeedAtLeastTwoRandomCandidates"))
  if (candidates.length > 256) throw new Error(uiText("core.randomBlockExport.generateASingleNumberOfUpTo"))
  const weightTotal = candidates.reduce((sum, layer) => sum + layer.randomVariant!.weight, 0)
  if (!Number.isSafeInteger(weightTotal) || weightTotal > 0x7fffffff) throw new Error(uiText("core.randomBlockExport.theTotalWeightOfTheCandidateExceeds"))
  const namespace = block.split(':')[0], key = createHash('sha256').update(block + '\n' + texture).digest('hex').slice(0, 16)
  const directory = 'block/mcrh_random/' + key
  const files: GeneratedFile[] = [], paths = new Set<string>()
  let bytes = 0
  const add = (file: GeneratedFile): void => {
    if (paths.has(file.path)) throw new Error(uiText("core.randomBlockExport.generatingPathRepeat", file.path))
    bytes += typeof file.content === 'string' ? Buffer.byteLength(file.content) : file.content.byteLength
    if (files.length >= MAX_FILES || bytes > MAX_BYTES) throw new Error(uiText("core.randomBlockExport.generatePatchesExceedingTheNumberOfFiles"))
    paths.add(file.path); files.push(file)
  }
  add({ path: 'pack.mcmeta', content: json({ pack: metadata }) })
  if (object(spec.animation) && spec.animation.animation !== undefined && spec.document.frameHeight === undefined && animationFrameHeight(spec.animation, spec.document.width, spec.document.height) === undefined) throw new Error(uiText("core.randomBlockExport.theCurrentRandomEditorOnlySupportsA"))
  const animation = updateAnimationMetadata(spec.animation, spec.document.width, spec.document.frameHeight ?? (spec.document.frameCount > 1 ? spec.document.width : spec.document.height), spec.document.frameCount)
  const encode = (id?: string): Uint8Array => {
    const png = new PNG({ width: spec.document.width, height: spec.document.height })
    const pixels = spec.document.flatten(false, id)
    png.data.set(canMarkTexture(spec.texturePath) ? markMcrhPixels(spec.document.width, spec.document.height, pixels, spec.document.frameHeight ?? (spec.document.frameCount > 1 ? spec.document.width : spec.document.height)) : pixels)
    return PNG.sync.write(png)
  }
  add({ path: spec.texturePath, content: encode() })
  if (animation) add({ path: spec.texturePath + '.mcmeta', content: json(animation) })
  const images: Uint8Array[] = candidates.map(layer => encode(layer.id))
  if (spec.mode === 'optifine') {
    const name = 'mcrh_random_' + key
    const generated = generateRandomBlockTextures({ name, namespace, matchBlocks: block, matchTiles: texture, tiles: candidates.map((_, index) => String(index)), weights: candidates.map(layer => layer.randomVariant!.weight), symmetry: spec.symmetry ?? 'all', linked: spec.linked ?? false, images: images.map((content, index) => ({ name: index + '.png', content })) })
    for (const file of generated) add(file)
    if (animation) for (let index = 0; index < images.length; index++) add({ path: 'assets/' + namespace + '/optifine/ctm/' + name + '/' + index + '.png.mcmeta', content: json(animation) })
  } else {
    const blockPath = 'assets/' + namespace + '/blockstates/' + block.split(':')[1] + '.json'
    const state = await spec.assets.readJson(blockPath)
    if (!object(state)) throw new Error(uiText("core.randomBlockExport.noRealSquaresFoundFirstCacheThe", blockPath))
    if (state.multipart !== undefined) throw new Error(uiText("core.randomBlockExport.theSquareUsesMultipartSoTheOriginal"))
    if (!object(state.variants) || !Object.keys(state.variants).length) throw new Error(uiText("core.randomBlockExport.blockStateIsNotValidVarians"))
    const result = structuredClone(state), variants: Record<string, unknown> = Object.create(null)
    const cache = new Map<string, { ids?: string[] }>()
    let changed = false, modelIndex = 0, entries = 0
    for (let index = 0; index < images.length; index++) {
      add({ path: 'assets/' + namespace + '/textures/' + directory + '/v' + index + '.png', content: images[index] })
      if (animation) add({ path: 'assets/' + namespace + '/textures/' + directory + '/v' + index + '.png.mcmeta', content: json(animation) })
    }
    for (const [condition, raw] of Object.entries(state.variants)) {
      const inputs = Array.isArray(raw) ? raw : [raw], output: Record<string, unknown>[] = []
      let sum = 0
      if (!inputs.length) throw new Error(uiText("core.randomBlockExport.listOfSquaresIsEmpty"))
      for (const entry of inputs) {
        if (++entries > MAX_FILES || !object(entry) || typeof entry.model !== 'string') throw new Error(uiText("core.randomBlockExport.blockStateModelMissingOrTooMany"))
        const weight = entry.weight ?? 1
        if (!Number.isSafeInteger(weight) || Number(weight) < 1 || Number(weight) > 0x7fffffff) throw new Error(uiText("core.randomBlockExport.invalidWeightForOriginalBlockState"))
        const model = canonical(entry.model)
        let cached = cache.get(model)
        if (!cached) {
          if (cache.size >= 256) throw new Error(uiText("core.randomBlockExport.tooManyAssociatedModelsPleaseGenerateIn"))
          const snapshot = await loadJavaModelSnapshot(spec.assets, javaModelResourcePath(model, 'models'))
          if (snapshot.warnings.length) throw new Error(uiText("core.randomBlockExport.modelReliesOnUnsolvedComplete", snapshot.warnings.join('; ')))
          const original = snapshot.effective, textures = (original.textures ?? {}) as JavaModelData
          const affectedSlots = Object.keys(textures).filter(slot => resolveJavaModelTexture(textures, '#' + slot).resolved === texture)
          const elements = (original.elements ?? []) as JavaModelData[]
          const direct = elements.some(element => Object.values((element.faces ?? {}) as JavaModelData).some(face => object(face) && typeof face.texture === 'string' && !face.texture.startsWith('#') && canonical(face.texture) === texture))
          cached = {}
          if (affectedSlots.length || direct) {
            if (!elements.length) throw new Error(uiText("core.randomBlockExport.theModelDoesNotHaveAnExpanded", model))
            cached.ids = []
            for (let index = 0; index < candidates.length; index++) {
              const generated = structuredClone(original), reference = namespace + ':' + directory + '/v' + index
              const slots = generated.textures as JavaModelData
              for (const slot of affectedSlots) slots[slot] = object(slots[slot]) ? { ...(slots[slot] as JavaModelData), sprite: reference } : reference
              for (const element of generated.elements as JavaModelData[]) for (const face of Object.values((element.faces ?? {}) as JavaModelData)) {
                if (object(face) && typeof face.texture === 'string' && !face.texture.startsWith('#') && canonical(face.texture) === texture) face.texture = reference
              }
              const id = namespace + ':' + directory + '/m' + modelIndex + '_v' + index
              add({ path: javaModelResourcePath(id, 'models'), content: json(generated) }); cached.ids.push(id)
            }
            modelIndex++
          }
          cache.set(model, cached)
        }
        if (cached.ids) {
          changed = true
          for (let index = 0; index < cached.ids.length; index++) {
            const combined = Number(weight) * candidates[index].randomVariant!.weight
            if (!Number.isSafeInteger(combined) || combined > 0x7fffffff) throw new Error(uiText("core.randomBlockExport.groupWeightsAboveTheGameIntegerLimit"))
            output.push({ ...entry, model: cached.ids[index], weight: combined }); sum += combined
          }
        } else {
          const preserved = Number(weight) * weightTotal
          if (!Number.isSafeInteger(preserved) || preserved > 0x7fffffff) throw new Error(uiText("core.randomBlockExport.groupWeightsAboveTheGameIntegerLimit"))
          output.push({ ...entry, weight: preserved }); sum += preserved
        }
        if (output.length > MAX_FILES || sum > 0x7fffffff) throw new Error(uiText("core.randomBlockExport.canNotDeleteFolderSNoSuch"))
      }
      variants[condition] = output
    }
    if (!changed) throw new Error(uiText("core.randomBlockExport.theTargetSquareModelDoesNotRefer"))
    result.variants = variants; add({ path: blockPath, content: json(result) })
  }
  const description = typeof metadata.description === 'string' ? metadata.description : JSON.stringify(metadata.description)
  const rows = candidates.map((layer, index) => uiText("core.randomBlockExport.weights", index, layer.name.replace(/[\r\n]/g, ' '), layer.randomVariant!.weight, (layer.randomVariant!.weight / weightTotal * 100).toFixed(2)))
  add({ path: 'README.md', content: uiText("core.randomBlockExport.randomBlockResourcePatchTargetSquaresTarget", block, texture, (spec.mode === 'optifine' ? uiText("core.randomBlockExport.modelsThatRequireOptifineOrCompatibleWith") : ''), description, JSON.stringify(metadata.pack_format ?? { min_format: metadata.min_format, max_format: metadata.max_format }), rows.join('\n')) })
  return files
}
