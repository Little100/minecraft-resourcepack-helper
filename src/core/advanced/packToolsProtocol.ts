import { uiText } from '../../i18n/messages'
import { zipSync } from 'fflate'
import { readBrowserPackArchive } from '../browserPackProject'
import { filterMcrhEditorData } from './editorDataExportPolicy'
import { z } from 'zod'

export const PACK_TOOLS_LIMITS = Object.freeze({ bytes: 256 * 1024 * 1024, fileBytes: 64 * 1024 * 1024, files: 16384, entries: 32768, packs: 128, depth: 64 })
const MAX_BASE64 = Math.ceil(PACK_TOOLS_LIMITS.fileBytes / 3) * 4
const base64 = (limit: number) => z.string().max(limit).refine(value => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), uiText("core.advanced.packToolsProtocol.invalidBase64FileData"))
export function assertPackToolsPath(path: string): void {
  if (!path || path.length > 4096 || /[\\\x00-\x1f\x7f<>:"|?*]/.test(path) || path.startsWith('/')) throw new Error(uiText("core.advanced.packToolsProtocol.insecureResourcePaths"))
  const parts = path.split('/')
  if (parts.length > PACK_TOOLS_LIMITS.depth || parts.some(part => !part || part === '.' || part === '..' || part.length > 255 || /[.\s]$/.test(part) || /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part.trimStart()))) throw new Error(uiText("core.advanced.packToolsProtocol.unsafeResourcePathOrDirectoryLevelExceeding"))
}
const file = z.object({ path: z.string().max(4096), base64: base64(MAX_BASE64), origin: z.enum(['user', 'vanilla', 'modified']).default('user'), modifiedAt: z.number().finite().nonnegative().max(8640000000000000).optional() }).strict()
export type PackToolsWireFile = z.infer<typeof file>
export interface PackToolsFile { path: string; content: Uint8Array; origin: 'user' | 'vanilla' | 'modified'; modifiedAt?: number }
const requestId = z.string().min(1).max(128)
export const PackToolsRequestSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('packToolsImport'), requestId }).strict(),
  z.object({ command: z.literal('packToolsProject'), requestId, projectToken: z.string().min(1).max(128).optional() }).strict(),
  z.object({ command: z.literal('packToolsImages'), requestId }).strict(),
  z.object({ command: z.literal('packToolsCancel'), requestId }).strict(),
  z.object({ command: z.literal('packToolsBaseline'), requestId, paths: z.array(z.string().max(4096)).max(PACK_TOOLS_LIMITS.files) }).strict(),
  z.object({ command: z.literal('packToolsSave'), requestId, name: z.string().min(1).max(256), includeMcrhEditorData: z.boolean().optional(), base64: base64(Math.ceil(PACK_TOOLS_LIMITS.bytes / 3) * 4) }).strict()
])
export const PackToolsResponseSchema = z.object({ type: z.literal('packToolsResponse'), requestId, ok: z.boolean(), error: z.string().max(4096).optional(), canceled: z.boolean().optional(), saved: z.boolean().optional(), name: z.string().max(256).optional(), warnings: z.array(z.string()).optional(), archives: z.array(z.object({ name: z.string().max(256), base64: base64(Math.ceil(PACK_TOOLS_LIMITS.bytes / 3) * 4) }).strict()).max(PACK_TOOLS_LIMITS.packs).optional(), files: z.array(file).max(PACK_TOOLS_LIMITS.entries).optional() }).strict()
export type PackToolsResponse = z.infer<typeof PackToolsResponseSchema>
export function encodePackToolsBytes(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)))
  return btoa(parts.join(''))
}
export function decodePackToolsBytes(value: string, limit = PACK_TOOLS_LIMITS.fileBytes): Uint8Array {
  if (value.length > Math.ceil(limit / 3) * 4) throw new Error(uiText("core.advanced.packToolsProtocol.documentDataExceededBudget"))
  const decoded = atob(value)
  if (decoded.length > limit) throw new Error(uiText("core.advanced.packToolsProtocol.documentDataExceededBudget"))
  return Uint8Array.from(decoded, char => char.charCodeAt(0))
}
export function validatePackToolsFiles(files: readonly PackToolsFile[]): void {
  if (files.length > PACK_TOOLS_LIMITS.entries) throw new Error(uiText("core.advanced.packToolsProtocol.numberOfDocumentsExceededBudget"))
  const nodes = new Map<string, { path: string; directory: boolean }>()
  let total = 0
  for (const file of files) {
    assertPackToolsPath(file.path)
    if (!(file.content instanceof Uint8Array) || file.content.length > PACK_TOOLS_LIMITS.fileBytes) throw new Error(uiText("core.advanced.packToolsProtocol.singleDocumentExceedingMibBudget"))
    total += file.content.length
    if (total > PACK_TOOLS_LIMITS.bytes) throw new Error(uiText("core.advanced.packToolsProtocol.theTotalNumberOfDocumentsExceededThe"))
    const parts = file.path.split('/')
    for (let index = 0; index < parts.length; index++) {
      const path = parts.slice(0, index + 1).join('/'), directory = index < parts.length - 1, key = path.normalize('NFC').toLowerCase(), previous = nodes.get(key)
      if (previous && (previous.path !== path || previous.directory !== directory || !directory)) throw new Error(uiText("core.advanced.packToolsProtocol.resourcePathDuplicatesAliasesOrFileDirectory"))
      nodes.set(key, { path, directory })
    }
  }
}
export function decodePackToolsFiles(files: readonly PackToolsWireFile[]): PackToolsFile[] {
  let total = 0
  for (const file of files) {
    total += file.base64.length / 4 * 3 - (file.base64.endsWith('==') ? 2 : file.base64.endsWith('=') ? 1 : 0)
    if (total > PACK_TOOLS_LIMITS.bytes) throw new Error(uiText("core.advanced.packToolsProtocol.theTotalNumberOfDocumentsExceededThe"))
  }
  const decoded = files.map(file => ({ path: file.path, content: decodePackToolsBytes(file.base64), origin: file.origin, modifiedAt: file.modifiedAt }))
  validatePackToolsFiles(decoded)
  return decoded
}
export function sanitizePackToolsArchive(bytes: Uint8Array, includeMcrhEditorData = false): Uint8Array {
  const files = readBrowserPackArchive(bytes).map(file => ({ path: file.path, content: file.data }))
  const policy = filterMcrhEditorData(files, { includeMcrhEditorData })
  if (!policy.omitted.length) return bytes
  const entries: Record<string, Uint8Array> = Object.create(null)
  for (const file of policy.files) entries[file.path] = file.content
  const output = zipSync(entries, { level: 6 })
  if (output.length > PACK_TOOLS_LIMITS.bytes) throw new Error(uiText("core.advanced.packToolsProtocol.siftScreenedResourcePacksExceedExportBudget"))
  return output
}

export function filterPackToolsSources(files: readonly PackToolsFile[], includeVanillaTextures = false, includeMcrhEditorData = false): PackToolsFile[] {
  validatePackToolsFiles(files)
  files = filterMcrhEditorData(files, { includeMcrhEditorData }).files
  if (includeVanillaTextures) return [...files]
  const byPath = new Map(files.map(file => [file.path, file])), omitted = new Set<string>()
  for (const file of files) {
    if ((!file.path.startsWith('assets/') && file.path !== 'pack.png') || file.origin !== 'vanilla') continue
    if (/\.png\.mcmeta$/i.test(file.path)) { const image = byPath.get(file.path.slice(0, -7)); if (image && image.origin !== 'vanilla') continue }
    const metadata = byPath.get(file.path + '.mcmeta')
    if (metadata && metadata.origin !== 'vanilla') continue
    omitted.add(file.path)
    if (metadata) omitted.add(metadata.path)
  }
  return files.filter(file => !omitted.has(file.path))
}
