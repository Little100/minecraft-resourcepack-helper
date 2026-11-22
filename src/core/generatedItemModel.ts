import { uiText } from '../i18n/messages'
import { isDeepStrictEqual } from 'node:util'
import { ModelPreviewAssets } from './modelPreviewAssets'
import { decodeTexturePng } from './advanced/pngCodec'
import { GENERATED_BASE_FIELD, generatedItemElements } from './generatedItemGeometry'
import { JAVA_MODEL_LIMITS, javaModelResourcePath, resolveJavaModelTexture, validateJavaModel, validJavaModelResourcePath, type JavaModelData } from './javaModelResources'

const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)
const generatedPath = 'assets/minecraft/models/builtin/generated.json'
export interface GeneratedItemAddition { elements: JavaModelData[]; textures: Record<string, string>; marker?: JavaModelData; inheritedElements?: JavaModelData[]; reason?: string }

export async function planGeneratedItemAddition(assets: ModelPreviewAssets, relative: string, raw: JavaModelData, readTexture: (file: string) => Promise<Uint8Array | undefined> = file => assets.read(file)): Promise<GeneratedItemAddition> {
  if (!validJavaModelResourcePath(relative)) throw new Error(uiText("core.generatedItemModel.modelPathInvalid"))
  validateJavaModel(raw)
  if (own(raw, GENERATED_BASE_FIELD)) return { elements: [], textures: {}, reason: uiText("core.generatedItemModel.theModelHasOriginalGeneratedTagsSkipped") }
  const parentPath = typeof raw.parent === 'string' ? javaModelResourcePath(raw.parent, 'models') : undefined
  const parent = parentPath && parentPath !== generatedPath ? await assets.resolveModel(parentPath) : undefined
  if (parentPath !== generatedPath && !parent?.parents.includes(generatedPath)) throw new Error(uiText("core.generatedItemModel.theCurrentModelDoesNotInheritThe"))
  if (parent?.missingPaths.some(file => file.endsWith('.json'))) throw new Error(uiText("core.generatedItemModel.theParentChainOfTheModelIs"))
  const effective: JavaModelData = { ...parent?.model, ...raw, textures: { ...(parent?.model.textures as JavaModelData | undefined), ...(raw.textures as JavaModelData | undefined) } }
  validateJavaModel(effective)
  if (!Array.isArray(effective.elements)) return { elements: [], textures: {}, reason: uiText("core.generatedItemModel.theCurrentModelHasBeenProperlyGenerated") }
  const variables = effective.textures as JavaModelData, existing = effective.elements as JavaModelData[]
  const source: JavaModelData = { ...variables }
  if (!own(source, 'layer0')) {
    const original = assets.roots.length > 1 ? await new ModelPreviewAssets(assets.roots.slice(1), assets.limits).resolveModel(relative) : undefined
    if (original?.parents.includes(generatedPath) && original.model.elements === undefined) {
      for (let index = 0; index < 5; index++) {
        const slot = 'layer' + index
        if (!own(source, slot) && own(original.textures, slot)) {
          const texture = resolveJavaModelTexture(original.textures, '#' + slot)
          if (!texture.resolved) throw new Error(uiText("core.generatedItemModel.originalGeneratedPasteReferenceCannotBeParsed"))
          source[slot] = texture.resolved
        }
      }
    }
    if (!own(source, 'layer0')) {
      const file = relative.replace('/models/', '/textures/').replace(/\.json$/, '.png')
      if (!await readTexture(file)) throw new Error(uiText("core.generatedItemModel.noOriginalSourcedPasteFoundPleaseFill"))
      source.layer0 = file.replace(/^assets\/([^/]+)\/textures\//, '$1:').replace(/\.png$/, '')
    }
  }
  const elements: JavaModelData[] = [], textures: Record<string, string> = {}, layers: Record<string, string> = {}
  for (let index = 0; index < 5; index++) {
    const slot = 'layer' + index
    if (!own(source, slot)) break
    const texture = resolveJavaModelTexture(source, '#' + slot)
    if (!texture.resolved || !texture.path) throw new Error(uiText("core.generatedItemModel.generatedTheReferenceCouldNotBeParsed", slot))
    const bytes = await readTexture(texture.path)
    if (!bytes) throw new Error(uiText("core.generatedItemModel.originalSourcedStickerMissing", texture.path))
    const image = decodeTexturePng(bytes, uiText("core.generatedItemModel.originalSourcedPaste"))
    const metadata = await assets.readJson(texture.path + '.mcmeta')
    const generated = generatedItemElements(image, slot, index, metadata, JAVA_MODEL_LIMITS.maxElements - existing.length - elements.length)
    for (const element of generated) {
      const duplicate = existing.some(value => isDeepStrictEqual(value, element))
      if (!duplicate) elements.push(element)
    }
    if (!own(variables, slot)) textures[slot] = texture.resolved
    layers[slot] = texture.resolved
  }
  if (!elements.length) return { elements: [], textures: {}, reason: uiText("core.generatedItemModel.originalElementExistingOrPastedFullyTransparent") }
  const marker = { version: 1, layers, elements: elements.length }
  validateJavaModel({ ...raw, textures: { ...(raw.textures as JavaModelData | undefined), ...textures }, elements: [...existing, ...elements], [GENERATED_BASE_FIELD]: marker })
  return { elements, textures, marker, ...(raw.elements === undefined ? { inheritedElements: existing } : {}) }
}
