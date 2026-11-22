import { uiText } from '../../i18n/messages'
import { inspectPackJson, type JsonIssueLocation } from './packJsonDiagnostics'
import { parsePackFormat as format, comparePackFormats as compare } from '../packFormatValue'
import { listPackConversionTargets } from './packConversion'
import packFormatTable from '../data/packFormats.json'
import { detectPackRequirements } from './packRequirements'
import { getVersionCapabilities, metadataSchemaForFormat, type PackFormat } from './versionCapabilities'
import { inspectResourcePng } from '../pngInspection'
import { PngInspectionLimitError } from '../pngInflation'

export interface DiagnosticFile { path: string; content: Uint8Array | string }
export interface PackDiagnosticIssue { severity: 'error' | 'warning' | 'info'; code: string; path: string; message: string; suggestion: string; line?: number; column?: number; excerpt?: string; source?: 'pack' | 'base' }
export interface PackDiagnosticReport { targetVersion?: string; files: number; issues: PackDiagnosticIssue[]; errors: number; warnings: number; truncated: boolean }
export interface PackDiagnosticOptions { targetVersion?: string; baseFiles?: readonly DiagnosticFile[]; maxIssues?: number; canceled?: () => boolean }
type Json = Record<string, unknown>
const object = (value: unknown): value is Json => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
function bounds(pack: Json, modern: boolean): [PackFormat, PackFormat] | undefined {
  if (modern) { const min = format(pack.min_format), max = format(pack.max_format, true); return min && max ? [min, max] : undefined }
  const supported = pack.supported_formats
  if (Number.isSafeInteger(supported) && Number(supported) >= 0) return [format(supported)!, format(supported, true)!]
  if (Array.isArray(supported) && supported.length === 2) { const min = format(supported[0]), max = format(supported[1], true); return min && max ? [min, max] : undefined }
  if (object(supported)) { const min = format(supported.min_inclusive), max = format(supported.max_inclusive, true); return min && max ? [min, max] : undefined }
  const own = format(pack.pack_format); return own ? [own, format(pack.pack_format, true)!] : undefined
}
export function inferPackVersion(value: unknown): string | undefined {
  if (!object(value) || !object(value.pack)) return undefined
  const pack = value.pack, current = format(pack.min_format) ?? format(pack.pack_format)
  if (!current) return undefined
  const targets = packFormatTable.versions.filter(target => target.type === 'release' && target.stable && /^\d+(?:\.\d+){1,2}$/.test(target.id))
    .filter(target => compare(getVersionCapabilities(target.id)?.resourcePackFormat ?? { major: target.rpk, minor: target.rpkMinor }, current) === 0)
  return targets.length === 1 ? targets[0]!.id : undefined
}
function reference(value: string, category: 'models' | 'textures'): string | undefined {
  if (!/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(value) || value.split(/[/:]/).some(part => !part || part === '.' || part === '..')) return undefined
  const [namespace, id] = value.includes(':') ? value.split(':') : ['minecraft', value]
  return 'assets/' + namespace + '/' + category + '/' + id + (category === 'models' ? '.json' : '.png')
}



// 诊断只读取资源，原版依赖未提供时保留为待核验警告
export async function diagnoseResourcePack(input: readonly DiagnosticFile[], options: PackDiagnosticOptions = {}): Promise<PackDiagnosticReport> {
  const issues: PackDiagnosticIssue[] = [], seen = new Set<string>(), max = options.maxIssues ?? 1000
  if (!Number.isSafeInteger(max) || max < 1 || max > 10000 || input.length > 100000 || (options.baseFiles?.length ?? 0) > 100000) throw new Error(uiText("core.advanced.packDiagnostics.ineffectiveDiagnosticBudgetOrExcessiveNumberOf"))
  let truncated = false, errors = 0, warnings = 0
  const priority = { error: 3, warning: 2, info: 1 }
  const add = (severity: PackDiagnosticIssue['severity'], code: string, path: string, message: string, suggestion: string, location?: JsonIssueLocation): void => {
    const key = [code, path, message, location?.line, location?.column].join('\0'); if (seen.has(key)) return; seen.add(key)
    if (severity === 'error') errors++; else if (severity === 'warning') warnings++
    const source: PackDiagnosticIssue['source'] = own.has(path) ? 'pack' : files.has(path) ? 'base' : undefined
    const issue = { severity, code, path, message, suggestion, source, ...(location ? { line: location.line, column: location.column, excerpt: location.excerpt } : {}) }
    if (issues.length >= max) {
      truncated = true
      const replace = issues.findIndex(value => priority[value.severity] < priority[severity])
      if (replace >= 0) issues.splice(replace, 1, issue)
      return
    }
    issues.push(issue)
  }
  const own = new Map<string, DiagnosticFile>(), files = new Map<string, DiagnosticFile>(), folded = new Map<string, string>()
  for (const file of options.baseFiles ?? []) files.set(file.path, file)
  for (const file of input) {
    if (own.has(file.path)) add('error', 'duplicate', file.path, uiText("core.advanced.packDiagnostics.repeatThePathInThePackageThe"), uiText("core.advanced.packDiagnostics.removeRepeatEntriesFromTheSamePath"))
    own.set(file.path, file); files.set(file.path, file)
    const key = file.path.toLowerCase(), previous = folded.get(key)
    if (previous && previous !== file.path) add('error', 'case-collision', file.path, uiText("core.advanced.packDiagnostics.withCaseOnlyDifferent", previous), uiText("core.advanced.packDiagnostics.harmonizeResourcePathsToLowercaseAndRemove"))
    folded.set(key, file.path)
    if (/^assets\//i.test(file.path) && (!/^assets\/[a-z0-9_.-]+\/[a-z0-9_./-]+$/.test(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..'))) add('error', 'resource-path', file.path, uiText("core.advanced.packDiagnostics.resourcePathContainsInvalidCharactersCaseOr"), uiText("core.advanced.packDiagnostics.nameSpaceAndResourcePathsOnlyLowercase"))
    if (/^assets\/[^/]+\/textures\/(?:blocks|items)\//.test(file.path)) add('warning', 'legacy-path', file.path, uiText("core.advanced.packDiagnostics.useOldBlocksItemsTextureDirectories"), uiText("core.advanced.packDiagnostics.ifTargetAndAboveUseVersionTo"))
  }
  const parsed = new Map<string, Json | undefined>()
  const json = (path: string): Json | undefined => {
    if (parsed.has(path)) return parsed.get(path)
    const file = files.get(path); if (!file) return undefined
    try {
      const bytes = typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content
      if (bytes.length > 4 * 1024 * 1024) { add('warning', 'json-budget', path, uiText("core.advanced.packDiagnostics.jsonExceededMibCheckBudgetNotYet"), uiText("core.advanced.packDiagnostics.verifyThisFileWithTheEditorOr")); parsed.set(path, undefined); return undefined }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
      const findings = inspectPackJson(text)
      for (const finding of findings) add(finding.severity, finding.code, path, finding.message, finding.suggestion, finding)
      if (findings.some(finding => finding.severity === 'error')) { parsed.set(path, undefined); return undefined }
      const value: unknown = JSON.parse(text)
      if (!object(value)) {
        if (/\.mcmeta$/.test(path) || /^assets\/[^/]+\/(?:models|items|blockstates|atlases|font|lang|particles|equipment)\/.+\.json$/.test(path)) throw new Error(uiText("core.advanced.packDiagnostics.jsonRootNodeForSuchResourcesMust"))
        parsed.set(path, undefined); return undefined
      }
      parsed.set(path, value); return value
    } catch (error) { parsed.set(path, undefined); add('error', 'json', path, error instanceof Error ? error.message : String(error), uiText("core.advanced.packDiagnostics.rediagnosedAfterRecodingJsonSyntaxAndFile")); return undefined }
  }
  const metadata = json('pack.mcmeta'), targetVersion = options.targetVersion || inferPackVersion(metadata)
  const targetFormat = targetVersion ? getVersionCapabilities(targetVersion)?.resourcePackFormat ?? listPackConversionTargets().find(target => target.id === targetVersion)?.format : undefined
  if (!own.has('pack.mcmeta')) {
    const nested = input.find(file => /(?:^|\/)pack\.mcmeta$/.test(file.path))
    add('error', 'pack-root', 'pack.mcmeta', nested ? uiText("core.advanced.packDiagnostics.thereAreMultipleLayersOfThePackage", nested.path) : uiText("core.advanced.packDiagnostics.packMcmetaIsMissingInTheBox"), uiText("core.advanced.packDiagnostics.zipShouldSeePackMcmetaAndAssets"))
  } else if (metadata) {
    if (!object(metadata.pack)) add('error', 'metadata-pack', 'pack.mcmeta', uiText("core.advanced.packDiagnostics.noValidPackObjectAvailable"), uiText("core.advanced.packDiagnostics.supplementaryPackageDescriptionAndCorrectVersionFormat"))
    else {
      const pack = metadata.pack
      if (pack.description === undefined || pack.description === null || !['string', 'object'].includes(typeof pack.description)) add('error', 'description', 'pack.mcmeta', uiText("core.advanced.packDiagnostics.missingOrNotATextComponent"), uiText("core.advanced.packDiagnostics.fillInTextComponentsSupportedByString"))
      const modern = targetFormat ? metadataSchemaForFormat('resource', targetFormat) === 'range' : pack.min_format !== undefined || pack.max_format !== undefined
      if (!modern && !format(pack.pack_format)) add('error', 'pack-format-required', 'pack.mcmeta', uiText("core.advanced.packDiagnostics.theOldMetadataLackAValidPack"), uiText("core.advanced.packDiagnostics.supplementToPackFormatConsistentWithThe"))
      if (modern && format(pack.min_format) && format(pack.min_format)!.major >= 65 && pack.supported_formats !== undefined) add('error', 'obsolete-supported-formats', 'pack.mcmeta', uiText("core.advanced.packDiagnostics.packagesThatOnlySupportTheNewFormat"), uiText("core.advanced.packDiagnostics.removeSupportedFormatsAndDeclareCompatibilityBy"))
      const range = bounds(pack, modern)
      if (!range || compare(range[0], range[1]) > 0) add('error', 'format-schema', 'pack.mcmeta', modern ? uiText("core.advanced.packDiagnostics.targetVersionRequiresEffectiveAndOrderlyMin") : uiText("core.advanced.packDiagnostics.invalidPackFormatOrSupportedFormats"), uiText("core.advanced.packDiagnostics.generateTargetFormatUsingVersionConversionChanges"))
      else if (targetFormat && (compare(targetFormat, range[0]) < 0 || compare(targetFormat, range[1]) > 0)) add('warning', 'version-incompatible', 'pack.mcmeta', uiText("core.advanced.packDiagnostics.theDeclaredPackageFormatRangeDoesNot", targetVersion, targetFormat.major, targetFormat.minor), uiText("core.advanced.packDiagnostics.selectTheActualSourceAndTargetVersions"))
      if (modern && targetFormat && targetFormat.major > 64 && (pack.pack_format !== undefined || pack.supported_formats !== undefined) && pack.min_format === undefined) add('error', 'legacy-metadata', 'pack.mcmeta', uiText("core.advanced.packDiagnostics.theMetadataStillUsesOldPackFormat"), uiText("core.advanced.packDiagnostics.convertToTheCurrentVersionSRange"))
    }
    if (metadata.filter !== undefined) add('info', 'filter', 'pack.mcmeta', uiText("core.advanced.packDiagnostics.resourceFilteringRulesMayHideLowPriority"), uiText("core.advanced.packDiagnostics.checkTheNamespaceAndPathRegularExpression"))
    if (metadata.overlays !== undefined) add('warning', 'overlays', 'pack.mcmeta', uiText("core.advanced.packDiagnostics.resourcePackContainsOverlaysAndBaseDirectory"), uiText("core.advanced.packDiagnostics.checkTheEffectiveDirectoryAndOverlayResources"))
  }
  if (!targetVersion || !targetFormat) add('warning', 'target-unknown', 'pack.mcmeta', uiText("core.advanced.packDiagnostics.noClearTargetVersionSupportedWasIdentified"), uiText("core.advanced.packDiagnostics.selectTheJavaVersionOfYourActual"))
  if (input.some(file => file.path.startsWith('data/')) && !input.some(file => file.path.startsWith('assets/'))) add('error', 'datapack', 'pack.mcmeta', uiText("core.advanced.packDiagnostics.onlyDataDirectoryFoundThisIsA"), uiText("core.advanced.packDiagnostics.putItInWorldDatapacksClientPaste"))
  const missing = (path: string, from: string): void => {
    if (files.has(path)) return
    const vanilla = path.startsWith('assets/minecraft/'), supplied = options.baseFiles?.length
    add(vanilla && supplied ? 'error' : 'warning', 'missing-reference', from, uiText("core.advanced.packDiagnostics.quoteNotFound", path, (vanilla && !supplied ? uiText("core.advanced.packDiagnostics.possiblyProvidedByOriginalClient") : '')), vanilla && !supplied ? uiText("core.advanced.packDiagnostics.reTestTheSameVersionOfBasic") : uiText("core.advanced.packDiagnostics.checkPathSpellingParentModelResourcePack"))
  }
  const merged = new Map<string, Json | undefined>(), visiting = new Set<string>()
  const merge = (path: string, depth = 0): Json | undefined => {
    if (merged.has(path)) return merged.get(path)
    if (visiting.has(path)) { add('error', 'model-cycle', path, uiText("core.advanced.packDiagnostics.theParentInheritanceChainExistsInA"), uiText("core.advanced.packDiagnostics.removeTheLoopReferencesForModelParent")); return undefined }
    if (depth > 64) { add('error', 'model-depth', path, uiText("core.advanced.packDiagnostics.theModelInheritsMoreThanTheInspection"), uiText("core.advanced.packDiagnostics.shortenParentInheritanceChain")); return undefined }
    const raw = json(path); if (!raw) return undefined
    visiting.add(path)
    let parent: Json | undefined
    if (raw.parent !== undefined) {
      const parentPath = typeof raw.parent === 'string' ? reference(raw.parent, 'models') : undefined
      if (!parentPath) add('error', 'parent-id', path, uiText("core.advanced.packDiagnostics.parentIsNotAValidResourceIdentifier"), uiText("core.advanced.packDiagnostics.useNamespaceBlockNameOrNamespaceItem"))
      else if (!parentPath.startsWith('assets/minecraft/models/builtin/')) { missing(parentPath, path); parent = merge(parentPath, depth + 1) }
    }
    visiting.delete(path)
    const result: Json = { ...parent, ...raw, textures: { ...(object(parent?.textures) ? parent.textures : {}), ...(object(raw.textures) ? raw.textures : {}) } }
    merged.set(path, result); return result
  }
  const checkModel = async (path: string): Promise<void> => {
    const model = merge(path); if (!model) return
    const textures = object(model.textures) ? model.textures : {}
    const resolved = new Map<string, string | undefined>()
    const checkTexture = (value: unknown, chain = new Set<string>()): void => {
      if (typeof value !== 'string') { add('error', 'texture-id', path, uiText("core.advanced.packDiagnostics.modelTextureReferencesMustBeString"), uiText("core.advanced.packDiagnostics.checkTextureFieldsInTexturesAndFaces")); return }
      if (chain.size > 64) { add('error', 'texture-depth', path, uiText("core.advanced.packDiagnostics.textureVariableReferenceBeyondCheckDepth"), uiText("core.advanced.packDiagnostics.shortenTextureVariableReferenceChain")); return }
      if (value.startsWith('#')) {
        const key = value.slice(1)
        if (resolved.has(key)) return
        if (chain.has(key)) { add('error', 'texture-cycle', path, uiText("core.advanced.packDiagnostics.textureVariableLoopReferences", value), uiText("core.advanced.packDiagnostics.fixVariableReferencesInTextures")); return }
        if (textures[key] === undefined) { add('warning', 'texture-variable', path, uiText("core.advanced.packDiagnostics.textureVariablesAreNotAvailable", value), uiText("core.advanced.packDiagnostics.checkForParentModelsToReadAnd")); return }
        checkTexture(textures[key], new Set([...chain, key])); resolved.set(key, undefined); return
      }
      const texture = reference(value, 'textures')
      if (!texture) add('error', 'texture-id', path, uiText("core.advanced.packDiagnostics.textureResourceIdentifierInvalid", value), uiText("core.advanced.packDiagnostics.useNamespaceBlockNameWithoutPngSuffix"))
      else missing(texture, path)
    }
    let textureCount = 0
    for (const [key, value] of Object.entries(textures)) {
      if (++textureCount % 128 === 0) { await new Promise<void>(resolve => setTimeout(resolve, 0)); if (options.canceled?.()) throw new Error(uiText("core.advanced.packDiagnostics.diagnosisCancelled")) }
      if (key !== 'particle') checkTexture(object(value) ? value.sprite : value)
    }
    if (Array.isArray(model.overrides)) for (const override of model.overrides) if (object(override) && typeof override.model === 'string') { const target = reference(override.model, 'models'); if (target) missing(target, path); else add('error', 'override-model', path, uiText("core.advanced.packDiagnostics.overrideModelResourceIdentifierInvalid"), uiText("core.advanced.packDiagnostics.amendTheNamespaceAndPathOfOverrides")) }
    if (Array.isArray(model.elements)) for (const element of model.elements) if (object(element) && object(element.faces)) for (const face of Object.values(element.faces)) if (object(face)) checkTexture(face.texture)
  }
  const walkModels = (value: unknown, path: string, depth = 0): void => {
    if (depth > 64) { add('warning', 'json-depth', path, uiText("core.advanced.packDiagnostics.itSTooDeepPartOfThe"), uiText("core.advanced.packDiagnostics.simplifyNestedStructures")); return }
    if (Array.isArray(value)) { for (const entry of value) walkModels(entry, path, depth + 1); return }
    if (!object(value)) return
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'model' || key === 'base') && typeof child === 'string') { const model = reference(child, 'models'); if (model) missing(model, path); else add('error', 'model-id', path, uiText("core.advanced.packDiagnostics.modelResourceIdentifierInvalid", child), uiText("core.advanced.packDiagnostics.checkModelReference")) }
      else if (typeof child === 'object') walkModels(child, path, depth + 1)
    }
  }
  let count = 0
  for (const file of input) {
    if (options.canceled?.()) throw new Error(uiText("core.advanced.packDiagnostics.diagnosisCancelled"))
    if (++count % 64 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0))
    if (/\.(?:json|mcmeta)$/.test(file.path)) json(file.path)
    if (/^assets\/[^/]+\/models\/.+\.json$/.test(file.path)) await checkModel(file.path)
    if (/^assets\/[^/]+\/(?:items|blockstates)\/.+\.json$/.test(file.path)) walkModels(json(file.path), file.path)
    if (/\.png$/i.test(file.path)) {
      try { inspectResourcePng(typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content) }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const budget = error instanceof PngInspectionLimitError
        add(budget ? 'info' : 'error', budget ? 'png-inspection-limited' : 'png', file.path, (budget ? uiText("core.advanced.packDiagnostics.pngStructureVerifiedPixelScannerNotFully") : uiText("core.advanced.packDiagnostics.pngInvalid")) + message, budget ? uiText("core.advanced.packDiagnostics.thisIsTheProcessingBudgetForThe") : uiText("core.advanced.packDiagnostics.resaveAsValidPngAndTryAgain"))
      }
    }
    if (/\.png\.mcmeta$/.test(file.path)) {
      const image = file.path.slice(0, -7); if (!files.has(image)) add('warning', 'orphan-animation', file.path, uiText("core.advanced.packDiagnostics.animatedMetadataDoesNotCorrespondToPng"), uiText("core.advanced.packDiagnostics.keepPngWithPngMcmetaAndIn"))
    }
    const texture = /^assets\/([^/]+)\/textures\/(block|item)\/(.+)\.png$/.exec(file.path)
    if (texture && !/_(?:n|s|normal)$/.test(texture[3]!)) {
      const base = 'assets/' + texture[1] + '/', id = texture[3]!
      if (!files.has(base + 'models/' + texture[2] + '/' + id + '.json') && !files.has(base + 'items/' + id + '.json') && !files.has(base + 'blockstates/' + id + '.json')) add('info', 'texture-binding', file.path, texture[1] === 'minecraft' ? uiText("core.advanced.packDiagnostics.theSameNameModelIsNotCovered") : uiText("core.advanced.packDiagnostics.noModelOrBindOfSameName"), texture[1] === 'minecraft' ? uiText("core.advanced.packDiagnostics.ifTheGameIsNotShownCheck") : uiText("core.advanced.packDiagnostics.confirmThatTheModuleHasRegisteredIts"))
    }
  }
  for (const requirement of detectPackRequirements(input)) add('warning', 'runtime-' + requirement.id, requirement.files[0]!, requirement.feature + uiText("core.advanced.packDiagnostics.additionalOperatingEnvironmentRequired"), requirement.runtime)
  add('info', 'runtime-check', '', uiText("core.advanced.packDiagnostics.offlineDiagnosisDoesNotConfirmThatThe"), uiText("core.advanced.packDiagnostics.reloadTheResourceInTheGameCheck"))
  return { targetVersion, files: input.length, issues, errors, warnings, truncated }
}
