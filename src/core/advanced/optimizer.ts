import { uiText } from '../../i18n/messages'
import { canExportPackFile, isMcrhEditorDataPath, shouldExportPackPath, validateMcrhEditorDataExportOptions, type McrhEditorDataExportOptions } from './editorDataExportPolicy'
import { spawn, ChildProcess } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { constants, createWriteStream, Stats } from 'node:fs'
import * as path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { StringDecoder } from 'node:string_decoder'
import { z } from 'zod'

export interface PackSquashOptions {
  zipCompressionIterations?: number
  recompressCompressedFiles?: boolean
  threads?: number
  allowMods?: Array<'OptiFine' | 'Minecraft Transit Railway 3'>
  pngQuantization?: 'none' | 'auto' | 'eight_bit_depth'
  transcodeOgg?: boolean
  minifyJson?: boolean
  shaderSourceTransformation?: 'keep_as_is' | 'minify'
}
export interface PackSquashRequest extends McrhEditorDataExportOptions {
  binaryPath: string
  inputDirectory: string
  outputFile: string
  options?: PackSquashOptions
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}
export interface PackSquashValidation {
  valid: boolean
  errors: string[]
  warnings: string[]
  config: string | null
}
export interface PackSquashResult {
  status: 'completed' | 'cancelled' | 'failed'
  exitCode: number | null
  stdout: string
  stderr: string
  outputFile: string
  error?: string
  logsTruncated: boolean
  temporaryDirectory?: string
}

const optionSchema = z.strictObject({
  zipCompressionIterations: z.number().int().min(0).max(255).optional(),
  recompressCompressedFiles: z.boolean().optional(),
  threads: z.number().int().positive().max(65535).optional(),
  allowMods: z.array(z.enum(['OptiFine', 'Minecraft Transit Railway 3'])).max(2).refine(v => new Set(v).size === v.length).optional(),
  pngQuantization: z.enum(['none', 'auto', 'eight_bit_depth']).optional(),
  transcodeOgg: z.boolean().optional(),
  minifyJson: z.boolean().optional(),
  shaderSourceTransformation: z.enum(['keep_as_is', 'minify']).optional()
})
const MAX_FILES = 32768
const MAX_BYTES = 2 * 1024 * 1024 * 1024
const MAX_METADATA_BYTES = 256 * 1024
const MAX_LOG_BYTES = 1024 * 1024
interface InputFile { relative: string; stat: Stats }
interface CheckedRequest { files: InputFile[]; input: string; output: string; binary: string }

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw new Error(uiText("core.advanced.optimizer.operationCancelled")) }
function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}
function absolutePath(value: string, label: string): string {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value) || /[\ud800-\udfff]/u.test(value.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ''))) throw new Error(uiText("core.advanced.optimizer.itHasToBeAnAbsolutePath", label))
  if (process.platform === 'win32') {
    if (/^[\\/]{2}/.test(value)) throw new Error(uiText("core.advanced.optimizer.networkPathOrDevicePathIsNot", label))
    const parts = value.slice(path.parse(value).root.length).split(/[\\/]/).filter(Boolean)
    if (parts.some(p => /[<>:"|?*]|[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) throw new Error(uiText("core.advanced.optimizer.includingWindowsUnsafeNames", label))
  }
  return path.resolve(value)
}
async function noLinks(value: string): Promise<void> {
  let current = path.parse(value).root
  for (const part of ['', ...value.slice(current.length).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part)
    const stat = await fs.lstat(current)
    if (stat.isSymbolicLink()) throw new Error(uiText("core.advanced.optimizer.aPathMayNotPassThroughA"))
  }
}
function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\u007f/g, '\\u007f')
}

export function generatePackSquashConfig(inputDirectory: string, outputFile: string, options: PackSquashOptions = {}, includeMcrhEditorData = false): string {
  const input = absolutePath(inputDirectory, uiText("core.advanced.optimizer.inputDirectory"))
  const output = absolutePath(outputFile, uiText("core.advanced.optimizer.outputFile"))
  if (inside(input, output) || path.extname(output).toLowerCase() !== '.zip') throw new Error(uiText("core.advanced.optimizer.outputMustBeASeparateZipFile"))
  validateMcrhEditorDataExportOptions({ includeMcrhEditorData })
  const opts = optionSchema.parse(options)
  const lines = [
    `pack_directory = ${tomlString(input)}`,
    `output_file_path = ${tomlString(output)}`,
    'validate_pack_metadata_file = true',
    'automatic_minecraft_quirks_detection = true',
    'automatic_asset_types_mask_detection = true',
    "zip_spec_conformance_level = 'pedantic'",
    'skip_pack_icon = false',
    `allow_mods = [${(opts.allowMods ?? []).map(tomlString).join(', ')}]`
  ]
  if (opts.zipCompressionIterations !== undefined) lines.push(`zip_compression_iterations = ${opts.zipCompressionIterations}`)
  if (opts.recompressCompressedFiles !== undefined) lines.push(`recompress_compressed_files = ${opts.recompressCompressedFiles}`)
  if (opts.threads !== undefined) lines.push(`threads = ${opts.threads}`)
  lines.push('', "['**/*?.png']", `color_quantization_target = ${tomlString(opts.pngQuantization ?? 'none')}`, 'downsize_if_single_color = false', 'skip_alpha_optimizations = true', 'png_obfuscation = false',
    '', "['**/*?.ogg']", `transcode_ogg = ${opts.transcodeOgg ?? false}`, 'ogg_obfuscation = false',
    '', "['**/*?.{json,jsonc,mcmeta,mcmetac,jem,jemc,jpm,jpmc,bbmodel,bbmodelc}']", `minify_json = ${opts.minifyJson ?? true}`, 'delete_bloat_keys = false',
    '', "['**/*?.{vsh,fsh,glsl}']", `shader_source_transformation_strategy = ${tomlString(opts.shaderSourceTransformation ?? 'keep_as_is')}`,
    '', "['**/{LICENSE,LICENSE.*,COPYING,COPYING.*,AUTHORS,AUTHORS.*,NOTICE,NOTICE.*}']", 'force_include = true', '')
  if (includeMcrhEditorData) lines.push("['**/{.mcrh,.mcrh-*,.history,.image-editor-history}/**']", 'force_include = true', '', "['**/*.mcrh']", 'force_include = true', '', "['**/*.mcrh.json']", 'force_include = true', '')
  return lines.join('\n')
}

async function scanInput(root: string, signal?: AbortSignal, options: McrhEditorDataExportOptions = {}): Promise<InputFile[]> {
  const files: InputFile[] = []
  let bytes = 0
  async function visit(directory: string, depth: number): Promise<void> {
    checkAbort(signal)
    if (depth > 64) throw new Error(uiText("core.advanced.optimizer.inputDirectoryLevelExceedingSecurityLimit"))
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      checkAbort(signal)
      const full = path.join(directory, entry.name)
      const stat = await fs.lstat(full)
      if (stat.isSymbolicLink()) throw new Error(uiText("core.advanced.optimizer.sourcePackageCannotContainASymbolLink"))
      const relative = path.relative(root, full).split(path.sep).join('/')
      if (!shouldExportPackPath(relative, options)) continue
      if (stat.isDirectory()) await visit(full, depth + 1)
      else if (stat.isFile()) {
        if (files.length >= MAX_FILES || stat.size > MAX_BYTES || bytes + stat.size > MAX_BYTES) throw new Error(uiText("core.advanced.optimizer.sourcePackageExceedingFileNumberOrTotal"))
        if (isMcrhEditorDataPath(relative) && !canExportPackFile({ path: relative, content: await fs.readFile(full) }, options)) continue
        bytes += stat.size
        if (files.length >= MAX_FILES || bytes > MAX_BYTES) throw new Error(uiText("core.advanced.optimizer.sourcePackageExceedingFileNumberOrTotal"))
        files.push({ relative: path.relative(root, full), stat })
      } else throw new Error(uiText("core.advanced.optimizer.sourcePackageCannotContainSpecialFiles"))
    }
  }
  await visit(root, 0)
  return files
}
const formatValue = z.union([z.number().int().nonnegative(), z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])])
const packMetadata = z.object({ pack: z.object({ pack_format: z.number().int().nonnegative().optional(), min_format: formatValue.optional(), max_format: formatValue.optional(), description: z.unknown() }).passthrough() }).passthrough()

async function checkRequest(request: PackSquashRequest): Promise<CheckedRequest> {
  checkAbort(request.signal)
  generatePackSquashConfig(request.inputDirectory, request.outputFile, request.options, request.includeMcrhEditorData)
  const binary = absolutePath(request.binaryPath, uiText("core.advanced.optimizer.executable"))
  const input = absolutePath(request.inputDirectory, uiText("core.advanced.optimizer.inputDirectory"))
  const output = absolutePath(request.outputFile, uiText("core.advanced.optimizer.outputFile"))
  await noLinks(binary)
  const binaryStat = await fs.lstat(binary)
  if (!binaryStat.isFile()) throw new Error(uiText("core.advanced.optimizer.enforceableDocumentsMustBeOrdinary"))
  if (process.platform === 'win32' && path.extname(binary).toLowerCase() !== '.exe') throw new Error(uiText("core.advanced.optimizer.windowsAllowsOnlyVisibleSelectionOfInstalled"))
  await fs.access(binary, process.platform === 'win32' ? constants.R_OK : constants.X_OK)
  await noLinks(input)
  if (!(await fs.lstat(input)).isDirectory()) throw new Error(uiText("core.advanced.optimizer.inputMustBeAResourcePackDirectory"))
  await noLinks(path.dirname(output))
  if (!(await fs.lstat(path.dirname(output))).isDirectory()) throw new Error(uiText("core.advanced.optimizer.outputParentDirectoryMustAlreadyExist"))
  const realInput = await fs.realpath(input)
  const realOutput = path.join(await fs.realpath(path.dirname(output)), path.basename(output))
  if (inside(realInput, realOutput) || inside(realInput, binary) || realOutput === binary) throw new Error(uiText("core.advanced.optimizer.executableFilesAndOutputZipMustBe"))
  try { await fs.lstat(output); throw new Error(uiText("core.advanced.optimizer.theSameNameHasBeenExportedFile")) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const files = await scanInput(input, request.signal, request)
  const metadata = files.find(f => f.relative === 'pack.mcmeta')
  if (!metadata || metadata.stat.size > MAX_METADATA_BYTES) throw new Error(uiText("core.advanced.optimizer.requiresASaneRootDirectory"))
  const parsed = packMetadata.parse(JSON.parse(await fs.readFile(path.join(input, 'pack.mcmeta'), 'utf8')))
  if (parsed.pack.description === undefined || (parsed.pack.pack_format === undefined && (parsed.pack.min_format === undefined || parsed.pack.max_format === undefined))) throw new Error(uiText("core.advanced.optimizer.packMcmetaMissingDescriptionOrLegitimateFormat"))
  return { files, input, output, binary }
}

export async function validatePackSquashRequest(request: PackSquashRequest): Promise<PackSquashValidation> {
  const warnings = [uiText("core.advanced.optimizer.packsquashIsNotExecutedForLocalPath"), uiText("core.advanced.optimizer.onlyRunYourTrustedInstalledProgramThis"), uiText("core.advanced.optimizer.packsquashMaySkipUnrecognizedFilesPleaseCheck"), uiText("core.advanced.optimizer.successfulSubmissionOfRequestOutputFileSystem")]
  try {
    await checkRequest(request)
    return { valid: true, errors: [], warnings, config: generatePackSquashConfig(request.inputDirectory, request.outputFile, request.options, request.includeMcrhEditorData) }
  } catch (error) { return { valid: false, errors: [message(error)], warnings, config: null } }
}
export const dryRunPackSquash = validatePackSquashRequest

async function snapshotInput(checked: CheckedRequest, destination: string, signal?: AbortSignal): Promise<void> {
  await fs.mkdir(destination, { mode: 0o700 })
  for (const file of checked.files) {
    checkAbort(signal)
    const source = path.join(checked.input, file.relative)
    await noLinks(source)
    const handle = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.ino !== file.stat.ino || before.dev !== file.stat.dev || before.size !== file.stat.size || before.mtimeMs !== file.stat.mtimeMs) throw new Error(uiText("core.advanced.optimizer.changeBeforeThePackageIsImplementedPlease"))
      const target = path.join(destination, file.relative)
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      await pipeline(handle.createReadStream({ autoClose: false }), createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal })
      const after = await handle.stat()
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error(uiText("core.advanced.optimizer.changesInSourceFilesDuringCopyingPlease"))
    } finally { await handle.close() }
  }
}

function execute(binary: string, config: string, cwd: string, request: PackSquashRequest, spawnProcess: typeof spawn, result: PackSquashResult): Promise<void> {
  return new Promise((resolve, reject) => {
    checkAbort(request.signal)
    let child: ChildProcess
    let timer: NodeJS.Timeout | undefined
    let processError: Error | undefined
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
    const retained = { stdout: 0, stderr: 0 }
    let stopping = false
    const stop = (): void => {
      if (stopping) return
      stopping = true
      child.kill('SIGTERM')
      timer = setTimeout(() => child.kill('SIGKILL'), 1000)
      timer.unref()
    }
    const accept = (kind: 'stdout' | 'stderr', text: string): void => {
      if (!text) return
      const remaining = MAX_LOG_BYTES - retained[kind]
      const data = Buffer.from(text)
      if (data.length > remaining) result.logsTruncated = true
      result[kind] += data.subarray(0, Math.max(0, remaining)).toString('utf8')
      retained[kind] += Math.min(data.length, remaining)
      try { (kind === 'stdout' ? request.onStdout : request.onStderr)?.(text) }
      catch (error) { processError = new Error(uiText("core.advanced.optimizer.journalEchoesFailed", message(error))); stop() }
    }
    try { child = spawnProcess(binary, [config], { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (error) { reject(error); return }
    child.stdout?.on('data', (chunk: Buffer) => accept('stdout', decoders.stdout.write(chunk)))
    child.stderr?.on('data', (chunk: Buffer) => accept('stderr', decoders.stderr.write(chunk)))
    child.on('error', error => { processError = error })
    child.once('close', (code: number | null) => {
      request.signal?.removeEventListener('abort', stop)
      if (timer) clearTimeout(timer)
      accept('stdout', decoders.stdout.end())
      accept('stderr', decoders.stderr.end())
      result.exitCode = code
      if (request.signal?.aborted) reject(new Error(uiText("core.advanced.optimizer.operationCancelled")))
      else if (processError) reject(processError)
      else if (code !== 0) reject(new Error(uiText("core.advanced.optimizer.packsquashExitFailedExitCode", String(code))))
      else resolve()
    })
    request.signal?.addEventListener('abort', stop, { once: true })
    if (request.signal?.aborted) stop()
  })
}

// 注入启动器用于测试，GUI 使用默认 runner
export function createPackSquashRunner(spawnProcess: typeof spawn = spawn): (request: PackSquashRequest) => Promise<PackSquashResult> {
  return async request => {
    const result: PackSquashResult = { status: 'failed', exitCode: null, stdout: '', stderr: '', outputFile: request.outputFile, logsTruncated: false }
    try {
      const checked = await checkRequest(request)
      checkAbort(request.signal)
      const cleanupParent = path.dirname(checked.output)
      const staging = await fs.mkdtemp(path.join(cleanupParent, '.mcrh-packsquash-'))
      result.temporaryDirectory = staging
      await fs.chmod(staging, 0o700)
      const input = path.join(staging, 'input')
      const output = path.join(staging, 'output.zip')
      const config = path.join(staging, 'options.toml')
      await snapshotInput(checked, input, request.signal)
      await fs.writeFile(config, generatePackSquashConfig(input, output, request.options, request.includeMcrhEditorData), { flag: 'wx', mode: 0o600 })
      await execute(checked.binary, config, staging, request, spawnProcess, result)
      checkAbort(request.signal)
      const stat = await fs.lstat(output)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 4) throw new Error(uiText("core.advanced.optimizer.packsquashDoesNotGenerateAValidZip"))
      const handle = await fs.open(output, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const header = Buffer.alloc(4)
        await handle.read(header, 0, 4, 0)
        if (header[0] !== 0x50 || header[1] !== 0x4b || !((header[2] === 3 && header[3] === 4) || (header[2] === 5 && header[3] === 6))) throw new Error(uiText("core.advanced.optimizer.generatingFileWithoutValidZipIdentifier"))
      } finally { await handle.close() }
      await noLinks(path.dirname(checked.output))
      checkAbort(request.signal)
      await fs.link(output, checked.output)
      result.status = 'completed'
    } catch (error) {
      result.status = request.signal?.aborted ? 'cancelled' : 'failed'
      result.error = message(error)
    }
    return result
  }
}
export const runPackSquash = createPackSquashRunner()


