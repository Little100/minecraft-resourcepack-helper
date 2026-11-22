import { uiText } from '../i18n/messages'
import { canExportPackFile, isMcrhEditorDataPath, shouldExportPackPath, validateMcrhEditorDataExportOptions, type McrhEditorDataExportOptions } from '../core/advanced/editorDataExportPolicy'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { zipSync, type Zippable } from 'fflate'
import { safeRelativePath, type GeneratedFile } from '../core/advanced/safeExport'
import { processExportTextures } from '../core/advanced/exportTextureProcessing'
import { applyVanillaExportPolicy, assertExportPathWithoutLinks, isInsideExportDirectory, PACK_EXPORT_LIMITS, readSafeExportFile, readVanillaExportBase } from '../core/advanced/exportPolicy'

export type ExportPackCommandSource = vscode.Uri | { resourceUri?: vscode.Uri }
export interface ExportPackCommandSettings extends McrhEditorDataExportOptions { includeVanillaTextures?: boolean; watermark?: unknown }
export interface ExportPackZipRequest extends ExportPackCommandSettings { inputDirectory: string; outputFile: string; vanillaBasePath?: string; editorDataWorkspaceRoot?: string }
export interface ExportPackZipResult { outputFile: string; fileCount: number; inputBytes: number; outputBytes: number; omitted: string[]; skipped: string[]; warnings: string[] }
interface TextureChoice extends vscode.QuickPickItem { includeVanillaTextures: boolean }

const TOOLING_DIRECTORIES = new Set(['.git', '.svn', '.hg', '.vscode', '.idea', '.mcrh', '.mcrh-backups', 'node_modules', '__pycache__', '.cache'])
const TOOLING_FILES = /^(?:package(?:-lock)?|tsconfig(?:\.[^.]+)?|jsconfig|composer(?:\.lock)?|eslint(?:\.config)?|biome)\.json$/i
const EXECUTABLE_EXTENSIONS = new Set(['.exe', '.dll', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.sh', '.bash', '.zsh', '.py', '.pyc', '.js', '.mjs', '.cjs', '.ts', '.jar', '.class', '.msi', '.msp', '.vbs', '.vbe', '.hta', '.wsf', '.wsh', '.scr', '.lnk', '.so', '.dylib', '.wasm'])
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.py', '.pyc', '.class'])
const RESOURCE_EXTENSIONS = new Set(['.png', '.json', '.jsonc', '.mcmeta', '.ogg', '.wav', '.mp3', '.flac', '.properties', '.lang', '.txt', '.md', '.jem', '.jpm', '.bbmodel', '.glsl', '.vsh', '.fsh', '.gsh', '.csh', '.inc', '.ttf', '.otf', '.hex', '.bin', '.dat', '.yaml', '.yml', '.toml', '.cfg', '.conf'])

function isToolingDirectory(name: string): boolean { return TOOLING_DIRECTORIES.has(name.toLowerCase()) || /^\.mcrh-/i.test(name) }
function isRootResource(relative: string): boolean {
  if (relative.includes('/') || TOOLING_FILES.test(relative)) return false
  return ['pack.mcmeta', 'pack.png'].includes(relative) || /^(?:licen[cs]e|copying|notice|credits|authors)(?:\.[^.]+)?$/i.test(relative) || /\.(?:json|jsonc|mcmeta|txt|md)$/i.test(relative)
}

function resourceDirectories(metadata: Uint8Array): string[] {
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadata)) }
  catch { throw new Error(uiText("ui.exportPackCommand.rootDirectoryPackMcmetaIsNotA")) }
  const meta = value as { pack?: { description?: unknown; pack_format?: unknown; min_format?: unknown; max_format?: unknown }; overlays?: { entries?: Array<{ directory?: unknown }> } } | null
  if (!meta || !meta.pack || meta.pack.description === undefined || (!Number.isInteger(meta.pack.pack_format) && (meta.pack.min_format === undefined || meta.pack.max_format === undefined))) throw new Error(uiText("ui.exportPackCommand.packMcmetaLacksEffectiveResourcePackFormat"))
  const directories = ['assets']
  if (meta.overlays?.entries !== undefined) {
    if (!Array.isArray(meta.overlays.entries) || meta.overlays.entries.length > PACK_EXPORT_LIMITS.files) throw new Error(uiText("ui.exportPackCommand.theResourcePackOverlayConfigurationIsInvalid"))
    for (const entry of meta.overlays.entries) {
      if (!entry || typeof entry.directory !== 'string') throw new Error(uiText("ui.exportPackCommand.resourcePackOverlayDirectoryInvalid"))
      const directory = safeRelativePath(entry.directory)
      if (directory.split('/').some(isToolingDirectory)) throw new Error(uiText("ui.exportPackCommand.resourcePackOverlayCannotPointToA"))
      directories.push(directory + '/assets')
    }
  }
  return [...new Set(directories)]
}

async function validateDestination(input: string, output: string): Promise<void> {
  if (!path.isAbsolute(input) || !path.isAbsolute(output) || path.extname(output).toLowerCase() !== '.zip') throw new Error(uiText("ui.exportPackCommand.theSourcePackageMustBeAnAbsolute"))
  safeRelativePath(path.basename(output))
  if (isInsideExportDirectory(input, output)) throw new Error(uiText("ui.exportPackCommand.outputZipMustBeLocatedOutsideThe"))
  await assertExportPathWithoutLinks(input)
  if (!(await fs.lstat(input)).isDirectory()) throw new Error(uiText("ui.exportPackCommand.sourcePackageMustBeARealFolder"))
  await assertExportPathWithoutLinks(path.dirname(output))
  if (!(await fs.lstat(path.dirname(output))).isDirectory()) throw new Error(uiText("ui.exportPackCommand.zipOutputParentPathMustBeA"))
  if (await assertExportPathWithoutLinks(output, true)) throw new Error(uiText("ui.exportPackCommand.outputFileAlreadyExistsDoesNotOverwrite"))
  const actualInput = await fs.realpath(input), actualParent = await fs.realpath(path.dirname(output))
  if (isInsideExportDirectory(actualInput, path.join(actualParent, path.basename(output)))) throw new Error(uiText("ui.exportPackCommand.outputZipMustBeOutsideTheSource"))
}

// 只读取当前包里各 PNG 对应的编辑数据
async function appendWorkspacePixelSidecars(input: string, workspaceRoot: string, files: GeneratedFile[], inputBytes: number): Promise<number> {
  if (!path.isAbsolute(workspaceRoot) || !isInsideExportDirectory(workspaceRoot, input)) throw new Error(uiText("ui.exportPackCommand.theEditingOfTheDataWorkspaceMust"))
  await assertExportPathWithoutLinks(workspaceRoot)
  const indexed = new Map(files.map((file, index) => [file.path.toLowerCase(), index]))
  for (const texture of files.filter(file => /\.png$/i.test(file.path) && !isMcrhEditorDataPath(file.path))) {
    const sourceRelative = path.relative(workspaceRoot, path.join(input, ...texture.path.split('/'))).split(path.sep).join('/')
    safeRelativePath(sourceRelative)
    const sourceSidecar = '.mcrh/resources/' + sourceRelative + '.mcrh'
    const exportedPath = '.mcrh/resources/' + texture.path + '.mcrh'
    const previousIndex = indexed.get(exportedPath.toLowerCase())
    if (path.resolve(workspaceRoot) === input && previousIndex !== undefined) continue
    let content: Uint8Array
    try { content = await readSafeExportFile(workspaceRoot, sourceSidecar) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    const sidecar = { path: exportedPath, content }
    if (!canExportPackFile(sidecar, { includeMcrhEditorData: true })) continue
    const previous = previousIndex === undefined ? undefined : files[previousIndex]!.content
    const previousBytes = previous === undefined ? 0 : typeof previous === 'string' ? new TextEncoder().encode(previous).length : previous.byteLength
    const nextBytes = inputBytes - previousBytes + content.byteLength
    if ((previousIndex === undefined && files.length >= PACK_EXPORT_LIMITS.files) || nextBytes > PACK_EXPORT_LIMITS.bytes) throw new Error(uiText("ui.exportPackCommand.includeWorkspaceEditingDataExceedingResourcePack"))
    inputBytes = nextBytes
    if (previousIndex === undefined) { indexed.set(exportedPath.toLowerCase(), files.length); files.push(sidecar) }
    else files[previousIndex] = sidecar
  }
  return inputBytes
}

export async function writeResourcePackZip(request: ExportPackZipRequest): Promise<ExportPackZipResult> {
  if (request.includeVanillaTextures !== undefined && typeof request.includeVanillaTextures !== 'boolean') throw new Error(uiText("core.advanced.exportPolicy.theOriginalPosterExportOptionMustBe"))
  validateMcrhEditorDataExportOptions(request)
  await validateDestination(request.inputDirectory, request.outputFile)
  const input = path.resolve(request.inputDirectory), output = path.resolve(request.outputFile)
  const metaStat = await fs.lstat(path.join(input, 'pack.mcmeta'))
  if (metaStat.size > 1024 * 1024) throw new Error(uiText("ui.exportPackCommand.rootDirectoryPackMcmetaExceedingMibSecurity"))
  const metadata = await readSafeExportFile(input, 'pack.mcmeta')
  const resourceRoots = resourceDirectories(metadata)
  const files: GeneratedFile[] = [{ path: 'pack.mcmeta', content: metadata }]
  const skipped: string[] = []
  let inputBytes = metadata.byteLength, visited = 0
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > PACK_EXPORT_LIMITS.depth) throw new Error(uiText("ui.exportPackCommand.resourcePackDirectoryDepthExceededSecurityLimit"))
    for await (const entry of await fs.opendir(directory)) {
      if (++visited > PACK_EXPORT_LIMITS.entries) throw new Error(uiText("ui.exportPackCommand.theNumberOfResourcePackEntriesExceeded"))
      const relative = prefix + entry.name, target = path.join(directory, entry.name)
      safeRelativePath(relative)
      const stat = await fs.lstat(target)
      const editorData = isMcrhEditorDataPath(relative)
      if (!shouldExportPackPath(relative, request)) { skipped.push(relative + (stat.isDirectory() ? '/' : '')); continue }
      if (stat.isSymbolicLink()) throw new Error(uiText("core.advanced.portableOptimizer.resourcePacksCannotContainSymbolicLinksOr"))
      if (stat.isDirectory()) {
        const relevant = resourceRoots.some(root => relative === root || relative.startsWith(root + '/') || root.startsWith(relative + '/'))
        if ((isToolingDirectory(entry.name) && !editorData) || (!relevant && !editorData)) { skipped.push(relative + '/'); continue }
        await assertExportPathWithoutLinks(target)
        await walk(target, relative + '/', depth + 1)
        continue
      }
      if (!stat.isFile()) throw new Error(uiText("ui.exportPackCommand.resourcePacksCannotContainEquipmentConduitsOr"))
      if (relative === 'pack.mcmeta') continue
      const resource = resourceRoots.some(root => relative.startsWith(root + '/'))
      const extension = path.extname(entry.name).toLowerCase()
      if (EXECUTABLE_EXTENSIONS.has(extension)) {
        if (resource || !SOURCE_EXTENSIONS.has(extension)) throw new Error(uiText("ui.exportPackCommand.resourcePackContainsHazardExecutionDocumentsNot", relative))
        skipped.push(relative)
        continue
      }
      if (!editorData && (!resource || !RESOURCE_EXTENSIONS.has(extension)) && !isRootResource(relative)) { skipped.push(relative); continue }
      if (files.length >= PACK_EXPORT_LIMITS.files || stat.size > PACK_EXPORT_LIMITS.fileBytes || inputBytes + stat.size > PACK_EXPORT_LIMITS.bytes) throw new Error(uiText("ui.exportPackCommand.resourcePacksExceedingMibTotalMibSingle"))
      const content = await readSafeExportFile(input, relative)
      inputBytes += content.byteLength
      if (inputBytes > PACK_EXPORT_LIMITS.bytes) throw new Error(uiText("ui.exportPackCommand.resourcePackReadingBeyondMibLimit"))
      files.push({ path: relative, content })
    }
  }
  await walk(input, '', 0)
  if (request.includeMcrhEditorData && request.editorDataWorkspaceRoot) inputBytes = await appendWorkspacePixelSidecars(input, request.editorDataWorkspaceRoot, files, inputBytes)
  files.sort((left, right) => left.path.localeCompare(right.path))
  const vanilla = request.includeVanillaTextures ? new Map<string, Uint8Array>() : await readVanillaExportBase(request.vanillaBasePath, files, { scope: 'resources' })
  const policy = applyVanillaExportPolicy(files, vanilla, { includeVanillaTextures: request.includeVanillaTextures, scope: 'resources' })
  const processed = await processExportTextures(policy.files, undefined, { includeVanillaTextures: true, includeMcrhEditorData: request.includeMcrhEditorData, watermark: request.watermark }, policy.omitted)
  skipped.push(...processed.omittedEditorData)
  const warnings = [...(policy.omitted.length ? [uiText("ui.exportPackCommand.ignoreConfirmedUnmodifiedOriginalResourceAndAssociated", policy.omitted.length)] : []), ...processed.warnings]
  const entries: Zippable = Object.create(null) as Zippable
  let processedBytes = 0
  for (const file of processed.files) {
    const content = typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content
    processedBytes += content.byteLength
    if (content.byteLength > PACK_EXPORT_LIMITS.fileBytes || processedBytes > PACK_EXPORT_LIMITS.bytes) throw new Error(uiText("ui.exportPackCommand.theProcessedResourcePackExceedsTheIndividual"))
    entries[file.path] = [content, { level: /\.(?:png|ogg|mp3|flac)$/i.test(file.path) ? 0 : 6 }]
  }
  const bytes = zipSync(entries, { level: 6 })
  if (bytes.byteLength > PACK_EXPORT_LIMITS.bytes) throw new Error(uiText("ui.exportPackCommand.generateZipBeyondMibLimitUnwrittenOutput"))
  await validateDestination(input, output)
  const handle = await fs.open(output, 'wx')
  const owned = await handle.stat()
  let completed = false
  try {
    await handle.writeFile(bytes)
    await handle.sync()
    completed = true
  } finally {
    await handle.close()
    if (!completed) {
      const current = await fs.lstat(output).catch(() => undefined)
      if (current?.isFile() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) await fs.unlink(output)
    }
  }
  return { outputFile: output, fileCount: processed.files.length, inputBytes, outputBytes: bytes.byteLength, omitted: policy.omitted, skipped, warnings }
}

export async function exportPackZip(argument?: ExportPackCommandSource, settings: ExportPackCommandSettings = {}): Promise<ExportPackZipResult | undefined> {
  try {
    validateMcrhEditorDataExportOptions(settings)
    if (settings.includeVanillaTextures !== undefined && typeof settings.includeVanillaTextures !== 'boolean') throw new Error(uiText("core.advanced.exportPolicy.theOriginalPosterExportOptionMustBe"))
    const uri = argument && 'scheme' in argument ? argument : argument?.resourceUri
    const source = uri ?? (await vscode.window.showOpenDialog({ title: uiText("ui.exportPackCommand.selectTheResourcePackDirectoryToExport"), canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: uiText("ui.exportPackCommand.selectResourcePack") }))?.[0]
    if (!source) return undefined
    if (source.scheme !== 'file') throw new Error(uiText("ui.exportPackCommand.zipExportOnlyLocalResourcePackFolders"))
    let includeVanillaTextures = settings.includeVanillaTextures
    if (includeVanillaTextures === undefined) {
      const choices: TextureChoice[] = [
        { label: uiText("ui.exportPackCommand.customModifiedContentOnly"), description: uiText("ui.exportPackCommand.defaultNoConfirmedUnmodifiedOriginalResourceIs"), picked: true, includeVanillaTextures: false },
        { label: uiText("ui.exportPackCommand.includeUnmodifiedOriginalResources"), description: uiText("ui.exportPackCommand.retainAllResourcesInTheResourcePack"), includeVanillaTextures: true }
      ]
      const choice = await vscode.window.showQuickPick(choices, { title: uiText("ui.exportPackCommand.resourcePackZipExport"), placeHolder: uiText("ui.exportPackCommand.selectWhetherOrNotToKeepUnmodified"), canPickMany: false, ignoreFocusOut: true })
      if (!choice) return undefined
      includeVanillaTextures = choice.includeVanillaTextures
    }
    let includeMcrhEditorData = settings.includeMcrhEditorData
    if (includeMcrhEditorData === undefined) {
      const choice = await vscode.window.showQuickPick([
        { label: uiText("ui.exportPackCommand.doNotContainMrchEditData"), description: uiText("ui.exportPackCommand.defaultExportOnlyGameResources"), includeMcrhEditorData: false, picked: true },
        { label: uiText("ui.exportPackCommand.includeMcrhEditData"), description: uiText("ui.exportPackCommand.retainExistingEditingFilesOfTheSource"), includeMcrhEditorData: true }
      ], { title: uiText("ui.exportPackCommand.mcrhEditData"), placeHolder: uiText("ui.exportPackCommand.selectWhetherToIncludeMcrhEditData"), ignoreFocusOut: true })
      if (!choice) return undefined
      includeMcrhEditorData = choice.includeMcrhEditorData
    }
    const output = await vscode.window.showSaveDialog({ title: uiText("ui.exportPackCommand.saveIndependentResourcePackZipMustBe"), defaultUri: vscode.Uri.file(path.join(path.dirname(source.fsPath), `${path.basename(source.fsPath)}.zip`)), filters: { ZIP: ['zip'] }, saveLabel: uiText("shell.exportZip") })
    if (!output) return undefined
    if (output.scheme !== 'file') throw new Error(uiText("ui.exportPackCommand.zipOutputMustBeLocalFiles"))
    const base = vscode.workspace.getConfiguration('mcrh', source).get<string>('previewBaseAssetsPath', '').trim()
    const workspaceFolder = includeMcrhEditorData ? vscode.workspace.getWorkspaceFolder?.(source) : undefined
    const editorDataWorkspaceRoot = workspaceFolder?.uri.scheme === 'file' ? workspaceFolder.uri.fsPath : undefined
    const result = await writeResourcePackZip({ editorDataWorkspaceRoot, inputDirectory: source.fsPath, outputFile: output.fsPath, vanillaBasePath: base, includeVanillaTextures, includeMcrhEditorData, watermark: settings.watermark })
    void vscode.window.showInformationMessage(uiText("ui.exportPackCommand.exportedResourcePackZipFileOmittedUnmodified", result.fileCount, result.omitted.length, result.warnings.length ? ' ' + result.warnings.join(' ') : ''))
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    void vscode.window.showErrorMessage(uiText("ui.exportPackCommand.resourcePackZipExportFailed", message))
    return undefined
  }
}

export function registerExportPackCommand(): vscode.Disposable {
  return vscode.commands.registerCommand('mcrh.exportPackZip', (source?: ExportPackCommandSource, settings?: ExportPackCommandSettings) => exportPackZip(source, settings))
}
