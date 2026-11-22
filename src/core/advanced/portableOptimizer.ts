import { uiText } from '../../i18n/messages'
import { canExportPackFile, isMcrhEditorDataPath, shouldExportPackPath, validateMcrhEditorDataExportOptions } from './editorDataExportPolicy'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { zip, type Zippable } from 'fflate'
import { safeRelativePath } from './safeExport'
import { processExportTextures, type ExportTextureProcessingOptions } from './exportTextureProcessing'
import { createScanner, parse, SyntaxKind, type ParseError } from 'jsonc-parser'

export interface PortableOptimizeRequest {
  inputDirectory: string
  outputFile: string
  minifyJson?: boolean
  vanillaBasePath?: string
  exportTextures?: ExportTextureProcessingOptions
  signal?: AbortSignal
  onLog?: (text: string) => void
}
export interface PortableOptimizeResult {
  outputFile: string
  fileCount: number
  inputBytes: number
  outputBytes: number
  minifiedFiles: number
  skipped: string[]
  temporaryDirectory: string
}
const MAX_BYTES = 128 * 1024 * 1024
const MAX_FILES = 16384
export const isToolingDirectory = (name: string): boolean => ['.git', '.mcrh', '.mcrh-backups', 'node_modules'].includes(name) || name.startsWith('.mcrh-export-') || name.startsWith('.mcrh-packsquash-') || name.startsWith('.mcrh-zip-')

export function minifyResourceJson(input: string, comments = false): string {
  const errors: ParseError[] = []
  parse(input, errors, { allowTrailingComma: comments, disallowComments: !comments })
  if (errors.length) throw new Error(uiText("core.advanced.portableOptimizer.jsonHasASyntaxErrorAndDoes"))
  const scanner = createScanner(input, false)
  const tokens: Array<{ kind: SyntaxKind; value: string }> = []
  while (true) {
    const kind = scanner.scan()
    if (kind === SyntaxKind.EOF) break
    if (![SyntaxKind.Trivia, SyntaxKind.LineBreakTrivia, SyntaxKind.LineCommentTrivia, SyntaxKind.BlockCommentTrivia].includes(kind)) tokens.push({ kind, value: input.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength()) })
  }
  return tokens.filter((token, index) => !(token.kind === SyntaxKind.CommaToken && [SyntaxKind.CloseBraceToken, SyntaxKind.CloseBracketToken].includes(tokens[index + 1]?.kind))).map(token => token.value).join('')
}

async function noLinks(target: string): Promise<void> {
  const volume = path.parse(target).root
  let cursor = volume
  for (const part of target.slice(volume.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    const stat = await fs.lstat(cursor)
    if (stat.isSymbolicLink()) throw new Error(uiText("core.advanced.portableOptimizer.optimizingPathCannotPassThroughASymbolic"))
  }
}

export async function optimizePortablePack(request: PortableOptimizeRequest): Promise<PortableOptimizeResult> {
  validateMcrhEditorDataExportOptions(request.exportTextures ?? {})
  const checkAbort = () => { if (request.signal?.aborted) throw new Error(uiText("core.advanced.portableOptimizer.optimizationCancelledTemporaryFileRetainedAndSource")) }
  checkAbort()
  if (!path.isAbsolute(request.inputDirectory) || !path.isAbsolute(request.outputFile) || path.extname(request.outputFile).toLowerCase() !== '.zip') throw new Error(uiText("core.advanced.portableOptimizer.inputsMustBeAbsoluteDirectoriesAndOutputs"))
  const input = path.resolve(request.inputDirectory), output = path.resolve(request.outputFile)
  const relative = path.relative(input, output)
  if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) throw new Error(uiText("core.advanced.portableOptimizer.outputMustBeOutsideTheSourcePackage"))
  await noLinks(input); await noLinks(path.dirname(output))
  try { await fs.lstat(output); throw new Error(uiText("core.advanced.portableOptimizer.outputFileAlreadyExistsOverwriteIsDisabled")) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const metadata = await fs.lstat(path.join(input, 'pack.mcmeta'))
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 256 * 1024) throw new Error(uiText("core.advanced.portableOptimizer.rootDirectoryIsInvalidOrBeyond"))
  const meta = JSON.parse(await fs.readFile(path.join(input, 'pack.mcmeta'), 'utf8')) as { pack?: Record<string, unknown> }
  if (!meta.pack || meta.pack.description === undefined || (!Number.isInteger(meta.pack.pack_format) && (meta.pack.min_format === undefined || meta.pack.max_format === undefined))) throw new Error(uiText("core.advanced.portableOptimizer.packMcmetaLacksAValidPackageFormat"))
  const entries: Zippable = Object.create(null) as Zippable
  const skipped: string[] = []
  let total = 0, count = 0, minified = 0, visited = 0
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    checkAbort()
    if (depth > 64) throw new Error(uiText("core.advanced.portableOptimizer.resourcePackDirectoryLevelExceedingLimit"))
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > MAX_FILES * 2) throw new Error(uiText("core.advanced.portableOptimizer.theTotalNumberOfResourcePackEntries"))
      const relative = `${prefix}${entry.name}`, file = path.join(directory, entry.name)
      const stat = await fs.lstat(file)
      if (stat.isSymbolicLink()) throw new Error(uiText("core.advanced.portableOptimizer.resourcePacksCannotContainSymbolicLinksOr"))
      if (!shouldExportPackPath(relative, request.exportTextures)) { skipped.push(relative + (stat.isDirectory() ? '/' : '')); continue }
      if (stat.isDirectory()) {
        if (isToolingDirectory(entry.name) && !isMcrhEditorDataPath(relative)) { skipped.push(relative + '/'); continue }
        await walk(file, relative + '/', depth + 1); continue
      }
      if (!stat.isFile()) throw new Error(uiText("core.advanced.portableOptimizer.resourcePackCannotContainSpecialFiles"))
      if (++count > MAX_FILES || stat.size > MAX_BYTES || total + stat.size > MAX_BYTES) throw new Error(uiText("core.advanced.portableOptimizer.internalOptimizationLimitMibOrFilesLarger"))
      let content: Uint8Array = await fs.readFile(file)
      total += content.byteLength
      if (total > MAX_BYTES) throw new Error(uiText("core.advanced.portableOptimizer.enterTheReadTimeToExceedThe"))
      if (!canExportPackFile({ path: relative, content }, request.exportTextures)) { skipped.push(relative); count--; continue }
      if (!isMcrhEditorDataPath(relative) && request.minifyJson && /\.(json|mcmeta|jem|jpm|bbmodel)$/i.test(entry.name)) {
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(content)
          const compact = Buffer.from(minifyResourceJson(text))
          if (compact.byteLength < content.byteLength) { content = compact; minified++ }
        } catch { request.onLog?.(uiText("core.advanced.portableOptimizer.keepUnverifiedJson", relative)) }
      }
      safeRelativePath(relative)
      if (relative === '__proto__') throw new Error(uiText("core.advanced.portableOptimizer.theBuiltInZipLibraryDoesNot"))
      entries[relative] = [content, { level: 9, mtime: new Date(1980, 0, 1) }]
      checkAbort()
    }
  }
  await walk(input, '', 0)
  if (request.exportTextures) {
    const files = Object.entries(entries).map(([relative, entry]) => ({ path: relative, content: (Array.isArray(entry) ? entry[0] : entry) as Uint8Array }))
    const processed = await processExportTextures(files, request.vanillaBasePath, request.exportTextures)
    const kept = new Set(processed.files.map(file => file.path))
    for (const relative of Object.keys(entries)) if (!kept.has(relative)) { delete entries[relative]; skipped.push(relative) }
    for (const file of processed.files) entries[file.path] = [typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content, { level: 9, mtime: new Date(1980, 0, 1) }]
    count = processed.files.length
    for (const warning of processed.warnings) request.onLog?.(warning + '\n')
    checkAbort()
  }
  request.onLog?.(uiText("core.advanced.portableOptimizer.readFilesStickersProcessedByExportOptions", count, minified))
  checkAbort()
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    const terminate = zip(entries, { level: 9 }, (error, result) => { request.signal?.removeEventListener('abort', abort); if (error) reject(error); else resolve(result) })
    const abort = () => { terminate(); reject(new Error(uiText("core.advanced.portableOptimizer.zipCompressionCancelledSourcePackageNotModified"))) }
    request.signal?.addEventListener('abort', abort, { once: true })
    if (request.signal?.aborted) abort()
  })
  checkAbort()
  const staging = await fs.mkdtemp(path.join(path.dirname(output), '.mcrh-zip-'))
  const stagedZip = path.join(staging, `${randomUUID()}.zip`)
  await fs.writeFile(stagedZip, bytes, { flag: 'wx' })
  checkAbort()
  await noLinks(path.dirname(output))
  checkAbort()
  await fs.link(stagedZip, output)
  return { outputFile: output, fileCount: count, inputBytes: total, outputBytes: bytes.byteLength, minifiedFiles: minified, skipped, temporaryDirectory: staging }
}
