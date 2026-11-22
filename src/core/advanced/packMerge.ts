import { uiText } from '../../i18n/messages'
import { z } from 'zod'
import type { BrowserPackOrigin } from '../browserPackProject'
import type { PACK_EXPORT_LIMITS } from './exportPolicy'
import type { GeneratedFile } from './safeExport'

export type PackMergeOrigin = BrowserPackOrigin | 'modified'
export interface PackMergeInputFile {
  readonly path: string
  readonly bytes: Uint8Array
  readonly modifiedAt?: number
  readonly origin?: PackMergeOrigin
}
export interface PackMergeInput {
  readonly id: string
  readonly name: string
  readonly files: readonly PackMergeInputFile[]
}
export interface PackMergeSelection {
  readonly include?: readonly string[]
  readonly exclude?: readonly string[]
}
export type PackMergeSelections = Readonly<Record<string, PackMergeSelection>>
export type PackMergeLimits = { readonly [Key in keyof typeof PACK_EXPORT_LIMITS]: number } & { readonly packs: number }
export const DEFAULT_PACK_MERGE_LIMITS: Readonly<PackMergeLimits> = Object.freeze({
  bytes: 256 * 1024 * 1024,
  fileBytes: 64 * 1024 * 1024,
  files: 16384,
  entries: 32768,
  depth: 64,
  packs: 128
})
export interface PackMergeOptions { readonly limits?: Partial<PackMergeLimits> }
export interface PackMergeCandidate {
  readonly packId: string
  readonly packName: string
  readonly path: string
  readonly byteLength: number
  readonly modifiedAt?: number
  readonly origin: PackMergeOrigin
}
export interface PackMergeEntry {
  readonly path: string
  readonly kind: 'file' | 'pack-metadata'
  readonly candidates: readonly PackMergeCandidate[]
}
export type PackMergeWarningCode = 'missing-timestamp' | 'latest-tie' | 'preferred-pack-missing' | 'missing-pack-metadata'
export interface PackMergeWarning {
  readonly code: PackMergeWarningCode
  readonly path?: string
  readonly packId?: string
  readonly message: string
}
export interface PackMergePlan {
  readonly entries: readonly PackMergeEntry[]
  readonly conflicts: readonly PackMergeEntry[]
  readonly warnings: readonly PackMergeWarning[]
  readonly limits: Readonly<PackMergeLimits>
}
export type PackMergeChoice = 'exclude' | { readonly packId: string }
export type PackMergeStrategy = 'manual' | 'latest' | PackMergeChoice
export interface PackMergeResolveOptions {
  readonly strategy?: PackMergeStrategy
  readonly resolutions?: Readonly<Record<string, PackMergeChoice>>
}
export interface PackMergeProvenance {
  readonly packId: string
  readonly packName: string
  readonly path: string
  readonly origin: PackMergeOrigin
  readonly modifiedAt?: number
}
export interface PackMergeFile extends GeneratedFile {
  content: Uint8Array
  readonly provenance: PackMergeProvenance
}
export interface PackMergeResult {
  files: PackMergeFile[]
  unresolved: readonly PackMergeEntry[]
  warnings: PackMergeWarning[]
  provenance: ReadonlyMap<string, PackMergeProvenance>
}

const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const limitsSchema = z.object({ bytes: positiveInteger, fileBytes: positiveInteger, files: positiveInteger, entries: positiveInteger, depth: positiveInteger, packs: positiveInteger }).strict()
const packSchema = z.object({ id: z.string().trim().min(1).max(256), name: z.string().trim().min(1).max(256) })
const fileSchema = z.object({
  path: z.string(),
  bytes: z.instanceof(Uint8Array),
  modifiedAt: z.number().finite().nonnegative().max(8_640_000_000_000_000).optional(),
  origin: z.enum(['vanilla', 'user', 'modified']).optional()
})
const choiceSchema = z.union([z.literal('exclude'), z.object({ packId: z.string().min(1) }).strict()])
const strategySchema = z.union([z.literal('manual'), z.literal('latest'), choiceSchema])
interface ValidatedFile extends PackMergeInputFile { readonly byteLength: number }
interface SourceFile { readonly candidate: PackMergeCandidate; readonly bytes: Uint8Array }
interface PlannedEntry { readonly entry: PackMergeEntry; readonly sources: readonly SourceFile[] }
interface PlanState { readonly entries: readonly PlannedEntry[]; readonly packIds: ReadonlySet<string> }
interface TreeNode { readonly path: string; readonly directory: boolean }
const plans = new WeakMap<PackMergePlan, PlanState>()
const typedArrayByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get! as (this: Uint8Array) => number

function fail(message: string): never { throw new Error('(' + message + ')') }
function byteLengthOf(bytes: Uint8Array): number {
  try { return typedArrayByteLength.call(bytes) }
  catch { return fail(uiText("core.advanced.packMerge.enterTheFileToBeATrue")) }
}
function copyBytes(bytes: Uint8Array, expectedLength: number): Uint8Array {
  if (byteLengthOf(bytes) !== expectedLength) fail(uiText("core.advanced.packMerge.enterAByteChangeInTheLength"))
  return new Uint8Array(bytes)
}
function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value)
  if (!result.success) fail(message)
  return result.data
}
function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(message)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail(message)
  return value as Record<string, unknown>
}
function checkedPath(value: unknown, depth: number): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.startsWith('/') || /[\\\x00-\x1f\x7f<>:"|?*]/.test(value)) fail(uiText("core.advanced.packMerge.mergeFilePathsMustBeASecure"))
  const parts = value.split('/')
  if (parts.length > depth) fail(uiText("core.advanced.packMerge.mergeFilePathExceedingDepthDepthBudget"))
  if (parts.some(part => !part || part === '.' || part === '..' || part.length > 255 || /[.\s]$/.test(part) || /^\s*(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\s*\.|\s*$)/i.test(part))) fail(uiText("core.advanced.packMerge.mergeFilePathContainsAnUnsafeName"))
  return value
}
function registerPath(tree: Map<string, TreeNode>, path: string): void {
  const parts = path.split('/')
  let prefix = ''
  for (let index = 0; index < parts.length; index++) {
    prefix += (index ? '/' : '') + parts[index]
    const key = prefix.normalize('NFC').toLowerCase()
    const directory = index < parts.length - 1
    const previous = tree.get(key)
    if (previous && (previous.path !== prefix || previous.directory !== directory)) fail(uiText("core.advanced.packMerge.mergeFileWithACaseUnicodeAlias", path))
    if (!previous) tree.set(key, { path: prefix, directory })
  }
}
function selectedPaths(value: unknown, known: ReadonlySet<string>, depth: number): Set<string> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > known.size) fail(uiText("core.advanced.packMerge.fileByFileSelectionMustBeThe"))
  const paths = new Set<string>()
  for (const item of value) {
    const path = checkedPath(item, depth)
    if (!known.has(path)) fail(uiText("core.advanced.packMerge.fileByFileSelectionOfNonExistent", path))
    if (paths.has(path)) fail(uiText("core.advanced.packMerge.fileByFilePathRepeated", path))
    paths.add(path)
  }
  return paths
}
function missingMetadata(): PackMergeWarning {
  return { code: 'missing-pack-metadata', path: 'pack.mcmeta', message: uiText("core.advanced.packMerge.theMergerResultsAreMissingPackMcmeta") }
}

export function planPackMerge(inputs: readonly PackMergeInput[], selections: PackMergeSelections = {}, options: PackMergeOptions = {}): PackMergePlan {
  const settings = record(options, uiText("core.advanced.packMerge.mergeOptionsMustBeObjects"))
  if (Object.keys(settings).some(key => key !== 'limits')) fail(uiText("core.advanced.packMerge.unknownMergeOptionExists"))
  const overrides = settings.limits === undefined ? {} : record(settings.limits, uiText("core.advanced.packMerge.theConsolidatedBudgetMustBeTargeted"))
  const limits = Object.freeze(parse(limitsSchema, { ...DEFAULT_PACK_MERGE_LIMITS, ...overrides }, uiText("core.advanced.packMerge.theConsolidatedBudgetMustContainAValid")))
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > limits.packs) fail(uiText("core.advanced.packMerge.inputPackagesAreEmptyOrMoreThan"))
  const choices = record(selections, uiText("core.advanced.packMerge.thePackageByPackSelectionMustBe"))
  const packIds = new Set<string>()
  const validated: Array<{ id: string; name: string; files: ValidatedFile[] }> = []
  let entries = 0
  let bytes = 0
  for (const input of inputs) {
    if (!input || typeof input !== 'object') fail(uiText("core.advanced.packMerge.theInputPackageIsInvalid"))
    const metadata = parse(packSchema, input, uiText("core.advanced.packMerge.theInputPackageMustBeNonEmpty"))
    if (metadata.id !== input.id || metadata.name !== input.name) fail(uiText("core.advanced.packMerge.inputPackageIdAndNameCannotLeave"))
    if (packIds.has(metadata.id)) fail(uiText("core.advanced.packMerge.inputPackageIdRepeat", metadata.id))
    packIds.add(metadata.id)
    if (!Array.isArray(input.files)) fail(uiText("core.advanced.packMerge.inputPackageFilesMustBeArrays"))
    entries += input.files.length
    if (entries > limits.entries) fail(uiText("core.advanced.packMerge.mergeTheNumberOfCandidatesThatExceed"))
    const paths = new Set<string>()
    const tree = new Map<string, TreeNode>()
    const files: ValidatedFile[] = []
    for (const rawFile of input.files) {
      const file = parse(fileSchema, rawFile, uiText("core.advanced.packMerge.theInputFileMustHaveAPath"))
      const path = checkedPath(file.path, limits.depth)
      if (paths.has(path)) fail(uiText("core.advanced.packMerge.repeatThePathToTheSameFile", path))
      paths.add(path)
      registerPath(tree, path)
      const byteLength = byteLengthOf(file.bytes)
      if (byteLength > limits.fileBytes) fail(uiText("core.advanced.packMerge.mergedFilesExceedFilebytesSingleFileVolume", path))
      bytes += byteLength
      if (!Number.isSafeInteger(bytes) || bytes > limits.bytes) fail(uiText("core.advanced.packMerge.mergeInputExceedingBytesCumulativeVolumeBudget"))
      files.push({ ...file, byteLength })
    }
    validated.push({ ...metadata, files })
  }
  for (const packId of Object.keys(choices)) if (!packIds.has(packId)) fail(uiText("core.advanced.packMerge.packageByPackSelectionRefersToNon", packId))
  const grouped = new Map<string, SourceFile[]>()
  const tree = new Map<string, TreeNode>()
  // 校验全部输入后才复制入选字节
  const pending: Array<{ candidate: PackMergeCandidate; bytes: Uint8Array }> = []
  for (const input of validated) {
    const choice = Object.hasOwn(choices, input.id) ? record(choices[input.id], uiText("core.advanced.packMerge.packageByPackageSelectionMustContainInclode")) : {}
    if (Object.keys(choice).some(key => key !== 'include' && key !== 'exclude')) fail(uiText("core.advanced.packMerge.unknownPackageToPackOptionsExist"))
    const known = new Set(input.files.map(file => file.path))
    const include = selectedPaths(choice.include, known, limits.depth)
    const exclude = selectedPaths(choice.exclude, known, limits.depth)
    for (const file of input.files) {
      if ((include && !include.has(file.path)) || exclude?.has(file.path)) continue
      registerPath(tree, file.path)
      if (!grouped.has(file.path)) grouped.set(file.path, [])
      if (grouped.size > limits.files) fail(uiText("core.advanced.packMerge.mergeTheSelectedPathWithMoreThan"))
      const candidate = Object.freeze({ packId: input.id, packName: input.name, path: file.path, byteLength: file.byteLength, modifiedAt: file.modifiedAt, origin: file.origin ?? 'user' })
      pending.push({ candidate, bytes: file.bytes })
    }
  }
  for (const source of pending) grouped.get(source.candidate.path)!.push({ candidate: source.candidate, bytes: copyBytes(source.bytes, source.candidate.byteLength) })
  const planned: PlannedEntry[] = [...grouped].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([path, sources]) => ({
    entry: Object.freeze({ path, kind: path === 'pack.mcmeta' ? 'pack-metadata' : 'file', candidates: Object.freeze(sources.map(source => source.candidate)) }), sources
  }))
  const warnings = grouped.has('pack.mcmeta') ? [] : [Object.freeze(missingMetadata())]
  const plan: PackMergePlan = Object.freeze({ entries: Object.freeze(planned.map(item => item.entry)), conflicts: Object.freeze(planned.filter(item => item.sources.length > 1).map(item => item.entry)), warnings: Object.freeze(warnings), limits })
  plans.set(plan, { entries: planned, packIds })
  return plan
}

export function resolvePackMerge(plan: PackMergePlan, options: PackMergeResolveOptions = {}): PackMergeResult {
  const state = plans.get(plan)
  if (!state) fail(uiText("core.advanced.packMerge.theMergerPlanIsInvalidOrHas"))
  const settings = record(options, uiText("core.advanced.packMerge.conflictResolutionOptionsMustBeTargeted"))
  if (Object.keys(settings).some(key => key !== 'strategy' && key !== 'resolutions')) fail(uiText("core.advanced.packMerge.unknownConflictResolutionOption"))
  const strategy = parse(strategySchema, settings.strategy === undefined ? 'manual' : settings.strategy, uiText("core.advanced.packMerge.unknownBatchMergePolicy"))
  if (typeof strategy === 'object' && !state.packIds.has(strategy.packId)) fail(uiText("core.advanced.packMerge.batchPolicyRefersToNonExistentPackid", strategy.packId))
  const resolutions = settings.resolutions === undefined ? {} : record(settings.resolutions, uiText("core.advanced.packMerge.fileByFileResolutionMustBeIndexed"))
  const indexed = new Map(state.entries.map(item => [item.entry.path, item]))
  const decisions = new Map<string, PackMergeChoice>()
  for (const [path, rawChoice] of Object.entries(resolutions)) {
    const item = indexed.get(path)
    if (!item) fail(uiText("core.advanced.packMerge.theConflictResolutionCitesTheUnselectedPath", path))
    const choice = parse(choiceSchema, rawChoice, uiText("core.advanced.packMerge.documentByDocumentResolutionMustBeExclude"))
    if (typeof choice === 'object' && !item.sources.some(source => source.candidate.packId === choice.packId)) fail(uiText("core.advanced.packMerge.thePackageSpecifiedByTheDocumentBy", path))
    decisions.set(path, choice)
  }
  const files: PackMergeFile[] = []
  const unresolved: PackMergeEntry[] = []
  const warnings: PackMergeWarning[] = [...plan.warnings]
  const provenance = new Map<string, PackMergeProvenance>()
  for (const { entry, sources } of state.entries) {
    const explicit = decisions.get(entry.path)
    const choice = explicit ?? (sources.length > 1 ? strategy : undefined)
    if (choice === 'exclude') continue
    let source: SourceFile | undefined
    if (typeof choice === 'object') {
      source = sources.find(item => item.candidate.packId === choice.packId)
      if (!source) warnings.push({ code: 'preferred-pack-missing', path: entry.path, packId: choice.packId, message: uiText("core.advanced.packMerge.specifyAPackageWithoutThisConflictFile", entry.path) })
    } else if (sources.length === 1) source = sources[0]
    else if (choice === 'latest') {
      if (sources.some(item => item.candidate.modifiedAt === undefined)) {
        warnings.push({ code: 'missing-timestamp', path: entry.path, message: uiText("core.advanced.packMerge.theCandidateFileIsMissingATime", entry.path) })
      } else {
        let newest = sources[0]!
        let tied = false
        for (const item of sources.slice(1)) {
          if (item.candidate.modifiedAt! > newest.candidate.modifiedAt!) { newest = item; tied = false }
          else if (item.candidate.modifiedAt === newest.candidate.modifiedAt) tied = true
        }
        if (tied) warnings.push({ code: 'latest-tie', path: entry.path, message: uiText("core.advanced.packMerge.recentTimeStampParallelLatestBackTo", entry.path) })
        else source = newest
      }
    }
    if (!source) { unresolved.push(entry); continue }
    const candidate = source.candidate
    const origin: PackMergeProvenance = Object.freeze({ packId: candidate.packId, packName: candidate.packName, path: candidate.path, origin: candidate.origin, modifiedAt: candidate.modifiedAt })
    files.push({ path: entry.path, content: copyBytes(source.bytes, candidate.byteLength), provenance: origin })
    provenance.set(entry.path, origin)
  }
  if (!files.some(file => file.path === 'pack.mcmeta') && !warnings.some(warning => warning.code === 'missing-pack-metadata')) warnings.push(missingMetadata())
  return { files, unresolved, warnings, provenance }
}
