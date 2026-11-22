import { uiText } from '../../i18n/messages'
import { parsePackFormat, comparePackFormats } from '../packFormatValue'
import { Buffer } from 'buffer'
import { PNG } from 'pngjs'
import { z } from 'zod'
import rules from '../data/conversion/kyanite-rules.json'
import compatibility from '../data/conversion/compatibility.json'
import { getVersionCapabilities, type PackFormat } from './versionCapabilities'

export interface PackConversionFile { path: string; content: Uint8Array | string }
export interface PackConversionOptions {
  sourceVersion: string
  targetVersion: string
  maxImagePixels?: number
}
export interface PackConversionTarget {
  id: string
  format: PackFormat
  label: string
  supported: boolean
  limitations: string[]
}
export interface PackConversionChange {
  kind: 'rename' | 'rewrite' | 'generate' | 'remove'
  path: string
  sourcePath?: string
  detail: string
}
export interface PackConversionResult {
  files: PackConversionFile[]
  warnings: string[]
  changes: PackConversionChange[]
  unsupported: string[]
}

type Json = Record<string, unknown>
type Version = { id: string; major: number; minor: number }
type Model = { path: string; json: Json; namespace: string; name: string }
const boundaries = compatibility.boundaries
const specialItems = compatibility.specialItemPatterns.map(pattern => new RegExp(pattern))
const specialBlocks = compatibility.unsupportedBlockPatterns.map(pattern => new RegExp(pattern))
const blockNames: Readonly<Record<string, string>> = rules.blocks
const itemNames: Readonly<Record<string, string>> = rules.items
const DEFAULT_MAX_IMAGE_PIXELS = 16_777_216

const number = z.number().finite()
const vector = z.tuple([number, number, number])
const angles = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
const faceSchema = z.object({ texture: z.string(), uv: z.tuple([number, number, number, number]).optional(), cullface: z.enum(['down', 'up', 'north', 'south', 'east', 'west']).optional(), rotation: angles.optional(), tintindex: z.number().int().min(-1).optional() }).strict()
const transformSchema = z.object({ rotation: vector.optional(), translation: vector.optional(), scale: vector.optional() }).strict()
const modelSchema = z.object({
  parent: z.string().optional(), textures: z.record(z.string(), z.string()).optional(),
  elements: z.array(z.object({
    from: vector, to: vector, shade: z.boolean().optional(),
    rotation: z.object({ origin: vector, axis: z.enum(['x', 'y', 'z']), angle: z.union([z.literal(-45), z.literal(-22.5), z.literal(0), z.literal(22.5), z.literal(45)]), rescale: z.boolean().optional() }).strict().optional(),
    faces: z.object({ down: faceSchema.optional(), up: faceSchema.optional(), north: faceSchema.optional(), south: faceSchema.optional(), east: faceSchema.optional(), west: faceSchema.optional() }).strict()
  }).strict()).optional(),
  display: z.object({ gui: transformSchema.optional(), ground: transformSchema.optional(), fixed: transformSchema.optional(), head: transformSchema.optional(), thirdperson_righthand: transformSchema.optional(), thirdperson_lefthand: transformSchema.optional(), firstperson_righthand: transformSchema.optional(), firstperson_lefthand: transformSchema.optional() }).strict().optional(),
  ambientocclusion: z.boolean().optional(), gui_light: z.enum(['front', 'side']).optional(), overrides: z.array(z.unknown()).optional()
}).strict()

function object(value: unknown): value is Json { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function fail(message: string): never { throw new Error('(' + message + ')') }
function text(file: PackConversionFile): string { return typeof file.content === 'string' ? file.content : new TextDecoder('utf-8', { fatal: true }).decode(file.content) }
function json(file: PackConversionFile): Json {
  let value: unknown
  try { value = JSON.parse(text(file).replace(/^\uFEFF/, '')) } catch { return fail(file.path + uiText("core.advanced.packConversion.invalidJsonOrUtf")) }
  if (!object(value)) return fail(file.path + uiText("core.advanced.packConversion.jsonRootMustBeAnObject"))
  return value
}
function serialized(value: Json): string { return JSON.stringify(value, null, 2) + '\n' }
function copy(file: PackConversionFile): PackConversionFile { return { path: file.path, content: typeof file.content === 'string' ? file.content : new Uint8Array(file.content) } }
function getVersion(id: string): Version | undefined { return compatibility.versions.find(version => version.id === id) }
function packFormat(version: Version): PackFormat {
  return getVersionCapabilities(version.id)?.resourcePackFormat ?? { major: version.major, minor: version.minor }
}
function crossing(source: Version, target: Version, boundary: number): boolean { return (source.major < boundary) !== (target.major < boundary) }

export function listPackConversionTargets(): PackConversionTarget[] {
  return compatibility.versions.map(version => ({
    id: version.id, format: { ...packFormat(version) }, label: version.id + uiText("core.advanced.packConversion.validatedSubsetOfContents"), supported: !compatibility.unverifiedVersions.includes(version.id),
    limitations: [...compatibility.limitations]
  }))
}

function validPath(value: string): void {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\\:\x00-\x1f\x7f\ud800-\udfff]/u.test(value) || value.startsWith('/') || value.endsWith('/')) fail(uiText("core.advanced.packConversion.invalidPathInPackage", String(value)))
  for (const part of value.split('/')) {
    if (!part || part === '.' || part === '..' || part.length > 255 || /[.\s]$/.test(part) || /[<>"|?*]/.test(part) || /^\s*(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\s*\.|\s*$)/i.test(part)) fail(uiText("core.advanced.packConversion.thePathInsideThePackageContainsUnsafe", value))
  }
}
function addPath(nodes: Map<string, { path: string; directory: boolean }>, filename: string): void {
  validPath(filename)
  const parts = filename.split('/')
  for (let index = 0; index < parts.length; index++) {
    const entry = parts.slice(0, index + 1).join('/')
    const directory = index < parts.length - 1
    const key = entry.normalize('NFC').toLowerCase()
    const previous = nodes.get(key)
    if (previous && (previous.path !== entry || previous.directory !== directory || !directory)) fail(uiText("core.advanced.packConversion.pathsRepeatUnicodeCaseAliasesOrFile", filename))
    nodes.set(key, { path: entry, directory })
  }
}
function staticVariant(file: PackConversionFile, source: Version, target: Version): Json {
  if (Math.min(source.major, target.major) < boundaries.flattening) return fail(file.path + uiText("core.advanced.packConversion.andEarlierStateKeysAreNotIndependently"))
  const blockstate = json(file)
  if (Object.keys(blockstate).length !== 1 || !object(blockstate.variants) || Object.keys(blockstate.variants).length !== 1 || !object(blockstate.variants[''])) return fail(file.path + uiText("core.advanced.packConversion.onlySupportSingleEmptyStatusVariantsAttribute"))
  const variant = blockstate.variants['']
  if (Object.keys(variant).some(key => !['model', 'x', 'y', 'uvlock'].includes(key))) return fail(file.path + uiText("core.advanced.packConversion.variantContainsUnadaptedFields"))
  modelReference(variant.model, file.path)
  for (const axis of ['x', 'y']) if (variant[axis] !== undefined && ![0, 90, 180, 270].includes(Number(variant[axis]))) return fail(file.path + uiText("core.advanced.packConversion.variantRotationMustHaveAStraightAngle"))
  if (['x', 'y'].some(axis => variant[axis] !== undefined && typeof variant[axis] !== 'number') || (variant.uvlock !== undefined && typeof variant.uvlock !== 'boolean')) return fail(file.path + uiText("core.advanced.packConversion.invalidParameterTypeVariant"))
  const match = /^assets\/minecraft\/blockstates\/([^/]+)\.json$/.exec(file.path)
  if (match && !compatibility.stableBlockIds.includes(match[1])) return fail(file.path + uiText("core.advanced.packConversion.theOriginalBlockIdentityIsNotIn"))
  return blockstate
}

function renamedName(name: string, table: Readonly<Record<string, string | undefined>>, forward: boolean): string {
  if (forward) return table[name] ?? name
  const originals = Object.keys(table).filter(key => table[key] === name)
  if (originals.length > 1) return fail(uiText("core.advanced.packConversion.thereIsAAmbiguityInTheReverse", name, originals.join(', ')))
  return originals[0] ?? name
}
function resourceId(value: string, forward: boolean, texture: boolean): string {
  if (value.startsWith('#')) return value
  const colon = value.indexOf(':')
  const namespace = colon >= 0 ? value.slice(0, colon) : 'minecraft'
  let relative = colon >= 0 ? value.slice(colon + 1) : value
  const match = /^(blocks?|items?)\/(.+)$/.exec(relative)
  if (!match) return value
  const block = match[1].startsWith('block')
  if (!texture) return value
  const directory = texture ? (forward ? (block ? 'block' : 'item') : (block ? 'blocks' : 'items')) : (block ? 'block' : 'item')
  const mapped = namespace === 'minecraft' ? renamedName(match[2] + '.png', block ? blockNames : itemNames, forward).slice(0, -4) : match[2]
  relative = directory + '/' + mapped
  return (colon >= 0 ? namespace + ':' : '') + relative
}
function flattenedPath(value: string, forward: boolean): string {
  const match = /^assets\/([^/]+)\/(textures|models)\/(blocks?|items?)\/(.+?)(\.png(?:\.mcmeta)?|\.json)$/.exec(value)
  if (!match) return value
  const [, namespace, kind, directory, name, suffix] = match
  if (kind === 'models') return value
  if (kind === 'textures' && directory !== (forward ? (directory.startsWith('block') ? 'blocks' : 'items') : (directory.startsWith('block') ? 'block' : 'item'))) return value
  const converted = resourceId(namespace + ':' + directory + '/' + name, forward, kind === 'textures').split(':')[1]
  return 'assets/' + namespace + '/' + kind + '/' + converted + suffix
}
function textureSteps(source: Version, target: Version): typeof compatibility.textureRenames {
  const rank = (id: string) => compatibility.versions.findIndex(version => version.id === id)
  const selected = compatibility.textureRenames.filter(step => (rank(source.id) < rank(step.since)) !== (rank(target.id) < rank(step.since)))
  return rank(source.id) < rank(target.id) ? selected : selected.reverse()
}
function versionedTexturePath(filename: string, source: Version, target: Version): string {
  const match = /^(assets\/minecraft\/textures\/(block|item)\/)([^/]+)(\.png(?:\.mcmeta)?|\.json)$/.exec(filename)
  if (!match) return filename
  let name = match[3] + '.png'
  for (const step of textureSteps(source, target)) if (step.kind === match[2]) name = renamedName(name, step.names, compatibility.versions.indexOf(source) < compatibility.versions.indexOf(target))
  return match[1] + name.slice(0, -4) + match[4]
}
function versionedModelId(value: string, source: Version, target: Version): string {
  const explicit = value.includes(':')
  if (explicit && !value.startsWith('minecraft:')) return value
  let relative = explicit ? value.slice('minecraft:'.length) : value
  const legacyIdentity = relative
  const rank = (id: string) => compatibility.versions.findIndex(version => version.id === id)
  const forward = rank(source.id) < rank(target.id)
  const steps = compatibility.modelRenames.filter(step => (rank(source.id) < rank(step.since)) !== (rank(target.id) < rank(step.since)))
  for (const step of forward ? steps : steps.reverse()) relative = renamedName(relative, step.names, forward)
  if (crossing(source, target, boundaries.flattening) && compatibility.unverifiedLegacyItemModels.includes(source.major < boundaries.flattening ? legacyIdentity : relative)) fail(uiText("core.advanced.packConversion.thereAreNoIndependentAndVerifiableMigration", (source.major < boundaries.flattening ? legacyIdentity : relative)))
  return (explicit ? 'minecraft:' : '') + relative
}
function versionedModelPath(filename: string, source: Version, target: Version): string {
  const match = /^assets\/minecraft\/models\/(.+)\.json$/.exec(filename)
  return match ? 'assets/minecraft/models/' + versionedModelId(match[1], source, target) + '.json' : filename
}
function versionedReferences(model: Json, source: Version, target: Version): void {
  const convertTexture = (value: string): string => {
    const explicit = value.includes(':')
    const match = /^(?:minecraft:)?(block|item)\/([^/]+)$/.exec(value)
    if (!match) return value
    const filename = versionedTexturePath('assets/minecraft/textures/' + match[1] + '/' + match[2] + '.png', source, target)
    return (explicit ? 'minecraft:' : '') + filename.slice('assets/minecraft/textures/'.length, -4)
  }
  if (typeof model.parent === 'string') model.parent = versionedModelId(model.parent, source, target)
  if (object(model.textures)) for (const [key, value] of Object.entries(model.textures)) if (typeof value === 'string') model.textures[key] = convertTexture(value)
  if (Array.isArray(model.overrides)) for (const override of model.overrides) if (object(override) && typeof override.model === 'string') override.model = versionedModelId(override.model, source, target)
  if (Array.isArray(model.elements)) for (const element of model.elements) if (object(element) && object(element.faces)) for (const face of Object.values(element.faces)) if (object(face) && typeof face.texture === 'string') face.texture = convertTexture(face.texture)
}

function rewriteModelReferences(model: Json, forward: boolean, filename: string): void {
  if (model.parent !== undefined) {
    if (typeof model.parent !== 'string') fail(filename + uiText("core.advanced.packConversion.parentMustBeAResourceIdentifier"))
    model.parent = resourceId(model.parent as string, forward, false)
  }
  if (model.textures !== undefined) {
    if (!object(model.textures)) fail(filename + uiText("core.advanced.packConversion.texturesMustBeAnObject"))
    model.textures = Object.fromEntries(Object.entries(model.textures as Json).map(([key, value]) => {
      if (typeof value !== 'string') fail(filename + uiText("core.advanced.packConversion.textureReferencesMustBeString"))
      return [key, resourceId(value as string, forward, true)]
    }))
  }
  if (Array.isArray(model.overrides)) for (const override of model.overrides) {
    if (!object(override) || typeof override.model !== 'string') fail(filename + uiText("core.advanced.packConversion.overrideInvalid"))
    override.model = resourceId(override.model as string, forward, false)
  }
  if (Array.isArray(model.elements)) for (const element of model.elements) {
    if (!object(element) || !object(element.faces)) continue
    for (const face of Object.values(element.faces)) if (object(face) && typeof face.texture === 'string') face.texture = resourceId(face.texture, forward, true)
  }
}

function plainModel(id: string): Json { return { type: 'minecraft:model', model: id } }
function modelReference(value: unknown, filename: string): string {
  if (typeof value !== 'string' || !/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(value) || value.split(/[/:]/).some(part => !part || part === '..' || part === '.')) return fail(filename + uiText("core.advanced.packConversion.invalidModelResourceIdentifier"))
  return value.includes(':') ? value : 'minecraft:' + value
}
function modernItem(model: Model): Json {
  const base = plainModel(model.namespace + ':item/' + model.name)
  if (model.json.overrides === undefined) return { model: base }
  if (!Array.isArray(model.json.overrides)) return fail(model.path + uiText("core.advanced.packConversion.overridesMustBeAnArray"))
  let property: string | undefined
  const overrides = model.json.overrides.map(value => {
    if (!object(value) || !object(value.predicate) || typeof value.model !== 'string' || Object.keys(value).some(key => !['predicate', 'model'].includes(key))) return fail(model.path + uiText("core.advanced.packConversion.overrideStructureNotSupported"))
    const entries = Object.entries(value.predicate)
    if (entries.length !== 1 || !['custom_model_data', 'damage'].includes(entries[0][0])) return fail(model.path + uiText("core.advanced.packConversion.onlySingleCustomModelDataOrDamage"))
    const [key, threshold] = entries[0]
    if (property && property !== key) return fail(model.path + uiText("core.advanced.packConversion.mixedPredicateRequiresManualMigration"))
    property = key
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || (key === 'damage' && threshold > 1)) return fail(model.path + uiText("core.advanced.packConversion.predicateThresholdInvalid"))
    return { threshold, model: modelReference(value.model, model.path) }
  })
  if (!overrides.length) return { model: base }
  const thresholds = [...new Set(overrides.map(value => value.threshold))].sort((a, b) => a - b)
  const entries = thresholds.map(threshold => {
    const selected = overrides.filter(value => value.threshold <= threshold).at(-1)!
    return { threshold, model: plainModel(selected.model) }
  })
  const dispatch: Json = { type: 'minecraft:range_dispatch', property: 'minecraft:' + property, entries, fallback: base }
  if (property === 'custom_model_data') dispatch.index = 0
  else dispatch.normalize = true
  return { model: dispatch }
}
function legacyItem(definition: Json, baseId: string, filename: string): unknown[] {
  if (Object.keys(definition).some(key => key !== 'model')) return fail(filename + uiText("core.advanced.packConversion.fieldWithUnsuitableItemDefinition"))
  const rootModel = definition.model
  const checkModel = (value: unknown): string => {
    if (!object(value) || value.type !== 'minecraft:model' || Object.keys(value).some(key => !['type', 'model'].includes(key))) return fail(filename + uiText("core.advanced.packConversion.baseModelReferencesOnlySupportedWithoutTint"))
    return modelReference(value.model, filename)
  }
  if (object(rootModel) && rootModel.type === 'minecraft:model') {
    if (checkModel(rootModel) !== baseId) return fail(filename + uiText("core.advanced.packConversion.defaultModelDoesNotCorrespondToA"))
    return []
  }
  if (!object(rootModel) || rootModel.type !== 'minecraft:range_dispatch' || !['minecraft:custom_model_data', 'minecraft:damage'].includes(String(rootModel.property))) return fail(filename + uiText("core.advanced.packConversion.unadaptedItemModelType"))
  const property = String(rootModel.property).slice('minecraft:'.length)
  if (Object.keys(rootModel).some(key => !['type', 'property', 'entries', 'fallback', 'index', 'normalize', 'scale'].includes(key)) || (rootModel.scale !== undefined && rootModel.scale !== 1) || (property === 'custom_model_data' && rootModel.index !== undefined && rootModel.index !== 0) || (property === 'damage' && rootModel.normalize !== undefined && rootModel.normalize !== true)) return fail(filename + uiText("core.advanced.packConversion.rangeDispatchParameterCannotBeConvertedWithout"))
  if (checkModel(rootModel.fallback) !== baseId || !Array.isArray(rootModel.entries)) return fail(filename + uiText("core.advanced.packConversion.lackOfDefaultModelForTheSame"))
  const thresholds = new Set<number>()
  return rootModel.entries.map(entry => {
    if (!object(entry) || Object.keys(entry).some(key => !['threshold', 'model'].includes(key)) || typeof entry.threshold !== 'number' || !Number.isFinite(entry.threshold) || entry.threshold < 0 || (property === 'damage' && entry.threshold > 1) || thresholds.has(entry.threshold)) return fail(filename + uiText("core.advanced.packConversion.thresholdInvalidOrDuplicate"))
    thresholds.add(entry.threshold)
    return { predicate: { [property]: entry.threshold }, model: checkModel(entry.model) }
  }).sort((a, b) => Object.values(a.predicate)[0] - Object.values(b.predicate)[0])
}

function migrateMetadata(file: PackConversionFile, source: Version, target: Version): string {
  const metadata = json(file)
  if (!object(metadata.pack)) return fail(uiText("core.advanced.packConversion.packMcmetaMissingPackObject"))
  if (metadata.overlays !== undefined || metadata.filter !== undefined) return fail(uiText("core.advanced.packConversion.packMcmetaWithOverplaysFilterNeedTo"))
  const pack = metadata.pack
  const expected = packFormat(source)
  if (source.major < boundaries.rangeMetadata) {
    if (pack.pack_format !== expected.major) return fail(uiText("core.advanced.packConversion.packMcendaDoesNotMatchTheSource"))
    if (pack.supported_formats !== undefined) return fail(uiText("core.advanced.packConversion.sourcePackageStatementSupportedFormatsFirstTo"))
  } else {
    const minimum = parsePackFormat(pack.min_format), maximum = parsePackFormat(pack.max_format, true)
    if (!minimum || !maximum || comparePackFormats(minimum, expected) > 0 || comparePackFormats(maximum, expected) < 0) return fail(uiText("core.advanced.packConversion.minFormatMaxFormatMustContainThe"))
  }
  if (pack.description === undefined || !(typeof pack.description === 'string' || object(pack.description) || Array.isArray(pack.description))) return fail(uiText("core.advanced.packConversion.packMcmetaLacksEffectiveDescription"))
  delete pack.pack_format
  delete pack.supported_formats
  delete pack.min_format
  delete pack.max_format
  const format = packFormat(target)
  if (target.major >= boundaries.rangeMetadata) {
    pack.min_format = [format.major, format.minor]
    pack.max_format = [format.major, format.minor]
  } else pack.pack_format = format.major
  return serialized(metadata)
}
function equipmentPath(value: string, forward: boolean): string {
  if (forward) {
    const match = /^(assets\/[^/]+\/textures\/)models\/armor\/([a-z]+)_layer_([12])(_overlay)?(\.png(?:\.mcmeta)?)$/.exec(value)
    if (!match || !rules.equipment.materials.includes(match[2])) return value
    if (match[4] && match[2] !== 'leather') return value
    return match[1] + 'entity/equipment/' + (match[3] === '1' ? 'humanoid' : 'humanoid_leggings') + '/' + match[2] + (match[4] ?? '') + match[5]
  }
  const match = /^(assets\/[^/]+\/textures\/)entity\/equipment\/(humanoid|humanoid_leggings)\/([a-z]+)(_overlay)?(\.png(?:\.mcmeta)?)$/.exec(value)
  if (!match || !rules.equipment.materials.includes(match[3]) || (match[4] && match[3] !== 'leather')) return value
  return match[1] + 'models/armor/' + match[3] + '_layer_' + (match[2] === 'humanoid' ? '1' : '2') + (match[4] ?? '') + match[5]
}
function pngImage(file: PackConversionFile, maxPixels: number): PNG {
  if (typeof file.content === 'string' || file.content.length < 24) return fail(file.path + uiText("core.advanced.packConversion.validPngBinaryDataRequired"))
  const bytes = Buffer.from(file.content)
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return fail(file.path + uiText("core.advanced.packConversion.invalidSignaturePng"))
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  if (!width || !height || width * height > maxPixels) return fail(file.path + uiText("core.advanced.packConversion.pngPixelsExceedingLimit"))
  try { return PNG.sync.read(bytes, { checkCRC: true }) } catch { return fail(file.path + uiText("core.advanced.packConversion.pngDecodeFailed")) }
}
function splitIcons(file: PackConversionFile, maxPixels: number): PackConversionFile[] {
  const image = pngImage(file, maxPixels)
  const scale = image.width / rules.icons.baseSize
  if (image.width !== image.height || !rules.icons.scales.includes(scale)) return fail(file.path + uiText("core.advanced.packConversion.iconsAtlasOnlySupportsSquareDimensions"))
  const prefix = file.path.slice(0, -'icons.png'.length) + 'sprites/'
  return rules.icons.crops.map(crop => {
    const [x, y, width, height] = crop.rect.map(value => value * scale)
    const output = new PNG({ width, height })
    for (let row = 0; row < height; row++) image.data.copy(output.data, row * width * 4, ((y + row) * image.width + x) * 4, ((y + row) * image.width + x + width) * 4)
    return { path: prefix + crop.path, content: new Uint8Array(PNG.sync.write(output)) }
  })
}

function inheritedTint(filename: string, files: Map<string, PackConversionFile>, seen: Set<string>): boolean {
  if (seen.has(filename)) return fail(filename + uiText("core.advanced.packConversion.modelParentExistsLoop"))
  const file = files.get(filename)
  if (!file) return false
  seen.add(filename)
  const model = json(file)
  if (/"tintindex"\s*:/.test(JSON.stringify(model))) return true
  if (typeof model.parent !== 'string') return false
  const [namespace, relative] = modelReference(model.parent, filename).split(':')
  return inheritedTint('assets/' + namespace + '/models/' + relative + '.json', files, seen)
}

function inspectScope(file: PackConversionFile, source: Version, target: Version, allPaths: Set<string>): void {
  const filename = file.path
  if (filename === 'pack.mcmeta' || filename === 'pack.png' || !filename.startsWith('assets/')) {
    if (/^(?:data|shaders)\//.test(filename) || /(?:^|\/)shaders\//.test(filename)) fail(filename + uiText("core.advanced.packConversion.doNotSupportConversionOfDataPackages"))
    if (filename !== 'pack.mcmeta' && filename !== 'pack.png' && !/^(?:[^/]+\.(?:txt|md)|LICENSE(?:\.[^/]+)?|COPYING)$/i.test(filename)) fail(filename + uiText("core.advanced.packConversion.notPartOfTheMatchableResourcePack"))
    return
  }
  if (!/^assets\/[a-z0-9_.-]+\/[a-z0-9_./-]+$/.test(filename)) fail(filename + uiText("core.advanced.packConversion.resourcePathContainsInvalidNamespaceOrResource"))
  if (/(?:^|\/)(?:shaders|post_effect|optifine|mcpatcher|ctm|cit|cem|font|atlases|particles)\//i.test(filename) || /_[ns]\.png(?:\.mcmeta)?$/i.test(filename)) fail(filename + uiText("core.advanced.packConversion.shaderModelTexturePbrFontsAtlasOr"))
  if (/^assets\/[^/]+\/textures\/(?:block|blocks|item|items)\/.+\.png(?:\.mcmeta)?$/.test(filename)) {
    if (crossing(source, target, boundaries.flattening) && /\/textures\/blocks?\//.test(filename) && compatibility.unsupportedLegacyTexturePatterns.some(pattern => new RegExp(pattern).test(filename.split('/').at(-1)!))) fail(filename + uiText("core.advanced.packConversion.theOldTextureRequiresAdditionalPixelsOr"))
    if (filename.endsWith('.mcmeta')) {
      const metadata = json(file)
      if (Object.keys(metadata).some(key => key !== 'animation')) fail(filename + uiText("core.advanced.packConversion.onlyAnimationTextureFilesSupported"))
    }
    return
  }
  if (/^assets\/[^/]+\/models\/(?:block|item)\/.+\.json$/.test(filename)) {
    const model = json(file)
    if (!modelSchema.safeParse(model).success) fail(filename + uiText("core.advanced.packConversion.theModelContainsAnUnsuitedFieldOr"))
    if (source.major < 3 || target.major < 3) fail(filename + uiText("core.advanced.packConversion.modelsAndDisplaySyntaxDifferencesAreNot"))
    if (source.major >= boundaries.itemDefinitions && model.overrides !== undefined) fail(filename + uiText("core.advanced.packConversion.modernSourcePackageResidualOverridesNotSure"))
    const checkTexture = (value: string) => {
      if (value.startsWith('#')) { if (!/^#[a-z0-9_.-]+$/.test(value)) fail(filename + uiText("core.advanced.packConversion.textureVariableReferencesInvalid")) }
      else modelReference(value, filename)
    }
    for (const value of Object.values((model.textures ?? {}) as Json)) if (typeof value === 'string') checkTexture(value)
    if (Array.isArray(model.elements)) for (const element of model.elements) if (object(element) && object(element.faces)) for (const face of Object.values(element.faces)) if (object(face) && typeof face.texture === 'string') checkTexture(face.texture)
    if (model.gui_light !== undefined && Math.min(source.major, target.major) < 5) fail(filename + uiText("core.advanced.packConversion.guiLightDoesNotHaveTheSame"))
    if (model.overrides !== undefined) {
      const match = /^assets\/([^/]+)\/models\/item\/(.+)\.json$/.exec(filename)
      if (!match) fail(filename + uiText("core.advanced.packConversion.restrictedToSupportingOnlyTheItemModel"))
      const converted = modernItem({ path: filename, json: model, namespace: match![1], name: match![2] })
      if (object(converted.model) && converted.model.property === 'minecraft:custom_model_data' && Math.min(source.major, target.major) < 4) fail(filename + uiText("core.advanced.packConversion.theSourceOrTargetDoesNotSupport"))
    }
    const root = /^assets\/minecraft\/models\/block\/([^/]+)\.json$/.exec(filename)
    if (root && specialBlocks.some(pattern => pattern.test(root[1]))) fail(filename + uiText("core.advanced.packConversion.blockModelOrUvWithSpecialChanges"))
    if (model.parent !== undefined) {
      const parent = modelReference(model.parent, filename)
      const [namespace, relative] = parent.split(':')
      if (!allPaths.has('assets/' + namespace + '/models/' + relative + '.json') && !/^minecraft:(?:item\/(?:generated|handheld|handheld_rod)|block\/(?:block|cube|cube_all|cube_bottom_top|cube_column|cube_column_horizontal|cube_top|orientable|orientable_with_bottom|cross|air))$/.test(parent)) fail(filename + uiText("core.advanced.packConversion.theExternalParentModelIsNotIn") + parent)
    }
    return
  }
  if (/^assets\/[^/]+\/items\/.+\.json$/.test(filename)) {
    const definition = json(file)
    if (target.major < 4 && object(definition.model) && definition.model.property === 'minecraft:custom_model_data') fail(filename + uiText("core.advanced.packConversion.targetVersionNotSupported"))
    if (source.major < boundaries.itemDefinitions) fail(filename + uiText("core.advanced.packConversion.sourceVersionsDoNotSupport"))
    return
  }
  if (/^assets\/[^/]+\/textures\/gui\/icons\.png$/.test(filename)) {
    if (target.major >= boundaries.guiSprites && source.major < boundaries.guiSprites) {
      if (source.major < 3) fail(filename + uiText("core.advanced.packConversion.earlySemanticChangesOfIconsNotRealized"))
      if (allPaths.has(filename + '.mcmeta')) fail(filename + uiText("core.advanced.packConversion.animatedAtlasNeedsToFitIndependently"))
      return
    }
    if (source.major < boundaries.guiSprites && target.major < boundaries.guiSprites && source.major >= 3 && target.major >= 3) return
    fail(filename + uiText("core.advanced.packConversion.oldGuiCollectionsFromModernSourcePackages"))
  }
  if (/^assets\/[^/]+\/textures\/(?:models\/armor|entity\/equipment)\//.test(filename) && equipmentPath(filename, source.major < target.major) !== filename && crossing(source, target, boundaries.equipment)) return
  if (/^assets\/[^/]+\/blockstates\/.+\.json$/.test(filename)) { staticVariant(file, source, target); return }
  fail(filename + uiText("core.advanced.packConversion.thereAreNoVerifiableCrossVersionAdaptation"))
}

export function convertResourcePack(files: readonly PackConversionFile[], options: PackConversionOptions): PackConversionResult {
  const result: PackConversionResult = { files: [], warnings: [], changes: [], unsupported: [] }
  try {
    const source = getVersion(options.sourceVersion), target = getVersion(options.targetVersion)
    if (!source || !target) return fail(uiText("core.advanced.packConversion.versionUnknownOrNotSuitable", (!source ? options.sourceVersion : options.targetVersion)))
    if (compatibility.unverifiedVersions.includes(source.id) || compatibility.unverifiedVersions.includes(target.id)) return fail(uiText("core.advanced.packConversion.theListOfNamesHasNotBeen"))
    const maxPixels = options.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS
    if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0) return fail(uiText("core.advanced.packConversion.maximagepixelsMustBePositiveInteger"))
    const input = new Map<string, PackConversionFile>()
    const inputNodes = new Map<string, { path: string; directory: boolean }>()
    for (const file of files) {
      validPath(file.path)
      if (!(typeof file.content === 'string' || file.content instanceof Uint8Array)) return fail(file.path + uiText("core.advanced.packConversion.contentTypeInvalid"))
      addPath(inputNodes, file.path)
      input.set(file.path, copy(file))
    }
    const metadata = input.get('pack.mcmeta')
    if (!metadata) return fail(uiText("core.advanced.packConversion.packageDirectoryMissingPackMcenda"))
    const newMetadata = migrateMetadata(metadata, source, target)
    if (source.id === target.id) {
      result.files = [...input.values()]
      result.warnings.push(uiText("core.advanced.packConversion.sameSourceAndTargetVersionsVerifiedPaths"))
      return result
    }
    const allPaths = new Set(input.keys())
    for (const file of input.values()) {
      try { inspectScope(file, source, target, allPaths) } catch (error) { result.unsupported.push(error instanceof Error ? error.message : String(error)) }
    }
    if (result.unsupported.length) return result
    const output = new Map<string, PackConversionFile>()
    const outputNodes = new Map<string, { path: string; directory: boolean }>()
    const put = (file: PackConversionFile) => {
      addPath(outputNodes, file.path)
      output.set(file.path, file)
    }
    const change = (kind: PackConversionChange['kind'], filename: string, detail: string, sourcePath?: string) => result.changes.push({ kind, path: filename, detail: '(' + detail + ')', ...(sourcePath ? { sourcePath } : {}) })
    const flatten = crossing(source, target, boundaries.flattening)
    const forward = target.major > source.major
    const modernize = source.major < boundaries.itemDefinitions && target.major >= boundaries.itemDefinitions
    const downgrade = source.major >= boundaries.itemDefinitions && target.major < boundaries.itemDefinitions
    const models: Model[] = []
    for (const original of input.values()) {
      let filename = forward && flatten ? flattenedPath(original.path, true) : original.path
      filename = versionedModelPath(versionedTexturePath(filename, source, target), source, target)
      if (!forward && flatten) filename = flattenedPath(filename, false)
      if (crossing(source, target, boundaries.equipment)) filename = equipmentPath(filename, forward)
      let content = original.content
      if (filename === 'pack.mcmeta') content = newMetadata
      const modelMatch = /^assets\/([^/]+)\/models\/item\/([^/]+)\.json$/.exec(filename)
      if (/^assets\/[^/]+\/models\/(?:block|item)\/.+\.json$/.test(filename)) {
        const parsed = json(original)
        if (forward && flatten) rewriteModelReferences(parsed, true, original.path)
        versionedReferences(parsed, source, target)
        if (!forward && flatten) rewriteModelReferences(parsed, false, original.path)
        if (modernize && !modelMatch && parsed.overrides !== undefined) return fail(original.path + uiText("core.advanced.packConversion.embeddedArticlesModelOverridesNotYetFit"))
        if (modelMatch) models.push({ path: filename, json: parsed, namespace: modelMatch[1], name: modelMatch[2] })
        content = serialized(parsed)
      }
      if (/^assets\/[^/]+\/blockstates\/.+\.json$/.test(filename)) {
        const parsed = staticVariant(original, source, target)
        const variant = (parsed.variants as Json)[''] as Json
        const reference: Json = { parent: variant.model }
        if (forward && flatten) rewriteModelReferences(reference, true, original.path)
        versionedReferences(reference, source, target)
        if (!forward && flatten) rewriteModelReferences(reference, false, original.path)
        variant.model = reference.parent
        content = serialized(parsed)
      }
      if (downgrade && /^assets\/[^/]+\/items\/.+\.json$/.test(filename)) continue
      put({ path: filename, content })
      if (filename !== original.path) change('rename', filename, uiText("core.advanced.packConversion.migrationResourcePathAndAnimatedSideFiles"), original.path)
      if (typeof content === 'string' && content !== (typeof original.content === 'string' ? original.content : text(original))) change('rewrite', filename, filename === 'pack.mcmeta' ? uiText("core.advanced.packConversion.keepPackageDescriptionAndExtensionMetadataWith") : uiText("core.advanced.packConversion.updateTextureAndModelReferencesInModels"))
      if (source.major < boundaries.guiSprites && target.major >= boundaries.guiSprites && /\/textures\/gui\/icons\.png$/.test(filename)) {
        for (const sprite of splitIcons(original, maxPixels)) {
          put(sprite)
          change('generate', sprite.path, uiText("core.advanced.packConversion.splitGuiAtlasByUpstreamPixelsKeep"), original.path)
        }
        result.warnings.push(uiText("core.advanced.packConversion.reserveOldIconsPngToSaveThe"))
      }
    }
    if (modernize) for (const model of models) {
      if (model.namespace === 'minecraft' && specialItems.some(pattern => pattern.test(model.name))) return fail(model.path + uiText("core.advanced.packConversion.dynamicRenderingOrDyeingItemsRequireA"))
      if (inheritedTint(model.path, output, new Set())) return fail(model.path + uiText("core.advanced.packConversion.dyeModelNeedsAVisibleTintSource"))
      const filename = 'assets/' + model.namespace + '/items/' + model.name + '.json'
      put({ path: filename, content: serialized(modernItem(model)) })
      change('generate', filename, uiText("core.advanced.packConversion.generateModernItemDefinitionAndMaintainThe"), model.path)
      if (model.json.overrides !== undefined) {
        delete model.json.overrides
        output.set(model.path, { path: model.path, content: serialized(model.json) })
        change('rewrite', model.path, uiText("core.advanced.packConversion.oldOverridesMovedToItsDefinition"))
      }
    }
    if (downgrade) for (const definition of input.values()) {
      const match = /^assets\/([^/]+)\/items\/(.+)\.json$/.exec(definition.path)
      if (!match) continue
      const [, namespace, name] = match
      const originalId = namespace + ':item/' + name
      const versionedId = versionedModelId(originalId, source, target)
      const id = flatten ? resourceId(versionedId, false, false) : versionedId
      const [modelNamespace, relative] = id.split(':')
      const filename = 'assets/' + modelNamespace + '/models/' + relative + '.json'
      const file = output.get(filename)
      if (!file) return fail(definition.path + uiText("core.advanced.packConversion.lackOfReversibleBaseModelForThe"))
      const model = json(file)
      if (model.overrides !== undefined) return fail(filename + uiText("core.advanced.packConversion.existingOverridesConflictWithItemDefinition"))
      const overrides = legacyItem(json(definition), originalId, definition.path)
      if (overrides.length) model.overrides = overrides
      for (const override of overrides) if (object(override) && typeof override.model === 'string') {
        override.model = versionedModelId(override.model, source, target)
        if (flatten) override.model = resourceId(override.model as string, false, false)
      }
      output.set(filename, { path: filename, content: serialized(model) })
      change('rewrite', filename, uiText("core.advanced.packConversion.revertBaseItsemDefinitionAndRangeThreshold"), definition.path)
      change('remove', definition.path, uiText("core.advanced.packConversion.contentRevertedToOldModelTargetDoes"))
    }
    if (source.major >= boundaries.itemDefinitions && target.major >= boundaries.itemDefinitions) {
      for (const file of input.values()) if (/^assets\/[^/]+\/items\/.+\.json$/.test(file.path)) {
        const match = /^assets\/([^/]+)\/items\/(.+)\.json$/.exec(file.path)!
        legacyItem(json(file), match[1] + ':item/' + match[2], file.path)
      }
    }
    result.files = [...output.values()]
    result.warnings.push(...compatibility.limitations)
    if (!result.changes.some(entry => entry.path !== 'pack.mcmeta')) result.warnings.push(uiText("core.advanced.packConversion.noSupportedContentToBeRewrittenOnly"))
    return result
  } catch (error) {
    result.files = []
    result.changes = []
    result.unsupported.push(error instanceof Error ? error.message : '(' + String(error) + ')')
    return result
  }
}
