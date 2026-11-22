import { uiText } from '../../i18n/messages'
import { validatePngInflation } from '../pngInflation'
import { PNG } from 'pngjs'
import { Buffer } from 'buffer'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'
import { openBrowserArchive, type BrowserArchiveReader } from '../browserPackProject'

export const MOD_TEXTURE_LIMITS = Object.freeze({ archiveBytes: 256 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, fileBytes: 16 * 1024 * 1024, pixels: 4 * 1024 * 1024, files: 4096, metadataBytes: 1024 * 1024 })
export const ModTextureRequest = z.discriminatedUnion('command', [
  z.object({ command: z.literal('modTexturesImport'), requestId: z.string().min(1).max(128) }).strict(),
  z.object({ command: z.literal('modTexturesCancel') }).strict()
])
export interface ModTextureFile { path: string; content: Uint8Array }
export interface ModTextureGroup { path: string; source: string; files: ModTextureFile[] }
export interface ModTexturePack { ids: string[]; namespaces: string[]; groups: ModTextureGroup[]; warnings: string[] }
export type ModConflictChoice = 'replace' | 'keep' | 'cancel'
const decoder = new TextDecoder('utf-8', { fatal: true })
const id = z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/)
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((value, index) => value === b[index])

function metadata(archive: BrowserArchiveReader): string[] {
  const ids = new Set<string>(), errors: string[] = []
  const add = (value: unknown) => { const result = id.safeParse(value); if (!result.success) throw new Error(uiText("core.advanced.modTextures.modularIdInvalid")); ids.add(result.data) }
  for (const path of ['fabric.mod.json', 'quilt.mod.json', 'META-INF/mods.toml', 'META-INF/neoforge.mods.toml', 'mcmod.info']) {
    if (!archive.files.some(entry => entry.path === path)) continue
    try {
      const text = decoder.decode(archive.read(path, MOD_TEXTURE_LIMITS.metadataBytes)!).replace(/^\uFEFF/, '')
      const document = path.endsWith('.toml') ? parseToml(text) : JSON.parse(text)
      if (path === 'fabric.mod.json') { if (!Number.isInteger(document.schemaVersion) || document.schemaVersion < 0) throw new Error(uiText("core.advanced.modTextures.missingSchemaversion")); add(document.id) }
      else if (path === 'quilt.mod.json') { if (!Number.isInteger(document.schema_version) || document.schema_version < 1) throw new Error(uiText("core.advanced.modTextures.missingSchemaVersion")); add(document.quilt_loader?.id) }
      else {
        const mods = path === 'mcmod.info' ? (Array.isArray(document) ? document : document.modList) : document.mods
        if (!Array.isArray(mods) || !mods.length) throw new Error(uiText("core.advanced.modTextures.synchronisingFolder"))
        for (const mod of mods) add(path === 'mcmod.info' ? mod.modid : mod.modId)
      }
    } catch (error) { errors.push(path + ': ' + String(error)) }
  }
  if (errors.length) throw new Error(uiText("core.advanced.modTextures.modularDeclarationInvalid", errors.join('; ')))
  if (!ids.size) throw new Error(uiText("core.advanced.modTextures.noValidModuleStatementsFoundForFabric"))
  return [...ids].sort()
}

export function validateModPng(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 33 || bytes.length > MOD_TEXTURE_LIMITS.fileBytes || !Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error(uiText("core.advanced.modTextures.notAValidPngOrSingleGraph"))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), width = view.getUint32(16), height = view.getUint32(20)
  if (!width || !height || width > 16384 || height > 16384 || width * height > MOD_TEXTURE_LIMITS.pixels) throw new Error(uiText("core.advanced.modTextures.pngSizesExceedingMPixelBudget"))
  validatePngInflation(bytes)
  const decoded = PNG.sync.read(Buffer.from(bytes), { checkCRC: true })
  if (decoded.width !== width || decoded.height !== height) throw new Error(uiText("core.advanced.modTextures.pngDecodeSizeInconsistentWithDeclaration"))
  return { width, height }
}

function validMcmeta(bytes: Uint8Array): void {
  const document = JSON.parse(decoder.decode(bytes).replace(/^\uFEFF/, ''))
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error(uiText("core.advanced.modTextures.pasteMetadataMustBeAJsonObject"))
}

export async function readModTextures(bytes: Uint8Array, name: string, check: () => void = () => {}): Promise<ModTexturePack> {
  const archive = openBrowserArchive(bytes, { maxArchiveBytes: MOD_TEXTURE_LIMITS.archiveBytes, maxCompressedBytes: MOD_TEXTURE_LIMITS.archiveBytes, maxUncompressedBytes: 512 * 1024 * 1024 })
  const ids = metadata(archive), groups: ModTextureGroup[] = [], warnings: string[] = [], namespaces = new Set<string>()
  const candidates = archive.files.filter(entry => /^assets\/[a-z0-9_.-]+\/textures\/[a-z0-9_./-]+\.png$/.test(entry.path))
  const allPaths = new Set(archive.files.map(entry => entry.path))
  let size = 0, count = 0, visited = 0
  for (const entry of candidates) {
    check()
    if (++visited % 8 === 0) await tick()
    let group: ModTextureGroup
    try {
      const content = archive.read(entry.path, MOD_TEXTURE_LIMITS.fileBytes)!
      validateModPng(content)
      group = { path: entry.path, source: name, files: [{ path: entry.path, content }] }
    } catch (error) { warnings.push(entry.path + uiText("core.advanced.modTextures.skipped") + String(error) + ')'); continue }
    const metaPath = entry.path + '.mcmeta'
    if (allPaths.has(metaPath)) {
      try { const content = archive.read(metaPath, MOD_TEXTURE_LIMITS.metadataBytes)!; validMcmeta(content); group.files.push({ path: metaPath, content }) }
      catch (error) { warnings.push(metaPath + uiText("core.advanced.modTextures.metadataInvalidSkipped") + String(error) + ')') }
    }
    size += group.files.reduce((total, file) => total + file.content.length, 0); count += group.files.length
    if (size > MOD_TEXTURE_LIMITS.totalBytes || count > MOD_TEXTURE_LIMITS.files) throw new Error(uiText("core.advanced.modTextures.modelPasteExceedingMibOrResourceFiles"))
    namespaces.add(entry.path.split('/')[1]!); groups.push(group)

  }
  for (const entry of archive.files) if (/^assets\/.*\/textures\/.*\.png\.mcmeta$/.test(entry.path) && !allPaths.has(entry.path.slice(0, -7))) warnings.push(entry.path + uiText("core.advanced.modTextures.missingPngSkipped"))
  if (!groups.length) throw new Error(uiText("core.advanced.modTextures.modelsDoNotHaveAValidPng"))
  check()
  return { ids, namespaces: [...namespaces].sort(), groups, warnings }
}

export function modFiles(groups: readonly ModTextureGroup[]): ModTextureFile[] {
  const files = groups.flatMap(group => group.files)
  if (files.length > MOD_TEXTURE_LIMITS.files || files.reduce((size, file) => size + file.content.length, 0) > MOD_TEXTURE_LIMITS.totalBytes) throw new Error(uiText("core.advanced.modTextures.theSelectedStickersTotalMoreThanMib"))
  return files
}

export async function resolveModDuplicates(packs: readonly ModTexturePack[], choose: (paths: string[]) => Promise<ModConflictChoice>): Promise<ModTextureGroup[] | undefined> {
  const groups = new Map<string, ModTextureGroup>(), collisions = new Set<string>()
  for (const pack of packs) for (const group of pack.groups) {
    const previous = groups.get(group.path)
    if (previous && (previous.files.length !== group.files.length || previous.files.some((file, index) => file.path !== group.files[index]?.path || !same(file.content, group.files[index]!.content)))) collisions.add(group.path)
    groups.set(group.path, group)
  }
  if (!collisions.size) return [...groups.values()]
  const choice = await choose([...collisions])
  if (choice === 'cancel') return undefined
  if (choice === 'keep') for (const pack of [...packs].reverse()) for (const group of pack.groups) if (collisions.has(group.path)) groups.set(group.path, group)
  return [...groups.values()]
}

export async function planModTextures(groups: readonly ModTextureGroup[], read: (path: string) => Promise<Uint8Array | undefined>): Promise<{ additions: ModTextureGroup[]; conflicts: ModTextureGroup[]; unchanged: number; warnings: string[] }> {
  const additions: ModTextureGroup[] = [], conflicts: ModTextureGroup[] = [], warnings: string[] = []
  let unchanged = 0
  for (const group of groups) {
    const existing = await Promise.all(group.files.map(file => read(file.path)))
    if (existing.every((value, index) => value && same(value, group.files[index]!.content))) { unchanged++; continue }
    if (existing.some(Boolean)) conflicts.push(group); else additions.push(group)
    if (group.files.length === 1 && await read(group.path + '.mcmeta')) warnings.push(group.path + uiText("core.advanced.modTextures.importWithoutMcmetaKeepExistingMetadataOn"))
  }
  return { additions, conflicts, unchanged, warnings }
}
