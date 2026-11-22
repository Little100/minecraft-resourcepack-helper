import { uiText } from '../i18n/messages'
import { existsSync, promises as fs, type Dirent, type Stats } from 'node:fs'
import * as path from 'node:path'
import type { PackInfo } from './types'

const PACK_META = 'pack.mcmeta'
const NAMESPACE = /^[a-z0-9_.-]+$/
export const RESOURCE_DIRECTORIES = ['textures', 'font', 'models', 'blockstates', 'sounds', 'lang', 'shaders', 'atlases', 'particles', 'equipment', 'items', 'texts', 'optifine'] as const
const RESOURCE_MARKERS = new Set<string>(RESOURCE_DIRECTORIES)
const RESOURCE_FILE_MARKERS = new Set(['sounds.json'])
const DATAPACK_MARKERS = new Set(['tags', 'loot_tables', 'loot_table', 'advancements', 'advancement', 'recipes', 'recipe', 'structures', 'structure', 'predicates', 'predicate', 'item_modifiers', 'item_modifier', 'functions', 'function', 'worldgen'])
const MAX_DIRECTORY_ENTRIES = 4096
const MAX_METADATA_BYTES = 1024 * 1024

type WarningReporter = (message: string) => void

interface RawPackMeta {
  pack?: { pack_format?: unknown; min_format?: unknown; max_format?: unknown; description?: unknown; supported_formats?: unknown; version?: unknown }
  [key: string]: unknown
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNKNOWN'
}

// 只读取普通入口，符号链接和 Windows 联接均不会被跟随
export async function readPackEntry(target: string, onWarning?: WarningReporter): Promise<Stats | undefined> {
  try {
    const entry = await fs.lstat(target)
    if (entry.isSymbolicLink()) {
      onWarning?.(uiText("core.packDetector.skippedLink", target))
      return undefined
    }
    return entry
  } catch (error) {
    const code = errorCode(error)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') onWarning?.(uiText("core.packDetector.unableToReadEntry", code, target))
    return undefined
  }
}

// 检查整条根路径，避免从链接内部指定扫描根绕过层数限制
export async function isSafePackDirectory(target: string, onWarning?: WarningReporter): Promise<boolean> {
  const resolved = path.resolve(target)
  const volume = path.parse(resolved).root
  const parts = resolved.slice(volume.length).split(path.sep).filter(Boolean)
  let current = volume
  for (const part of ['', ...parts]) {
    if (part) current = path.join(current, part)
    const entry = await readPackEntry(current, onWarning)
    if (!entry?.isDirectory()) {
      onWarning?.(uiText("core.packDetector.scanDirectoryIsNotAvailable", current))
      return false
    }
  }
  return true
}

// 流式读取目录并限制入口数量，避免超大开发目录占用扫描内存
export async function readDiscoveryDirectory(target: string, onWarning?: WarningReporter): Promise<Dirent[] | undefined> {
  const entries: Dirent[] = []
  try {
    const directory = await fs.opendir(target)
    for await (const entry of directory) {
      if (entries.length >= MAX_DIRECTORY_ENTRIES) {
        onWarning?.(uiText("core.packDetector.theDirectoryEntranceExceededTheScanningLimit", target))
        break
      }
      entries.push(entry)
    }
    return entries
  } catch (error) {
    onWarning?.(uiText("core.packDetector.unableToReadDirectory", errorCode(error), target))
    return undefined
  }
}

async function hasNamespaceMarker(root: string, markers: ReadonlySet<string>, onWarning?: WarningReporter): Promise<boolean> {
  const namespaces = await readDiscoveryDirectory(root, onWarning)
  if (!namespaces) return false
  for (const namespace of namespaces) {
    if (!NAMESPACE.test(namespace.name) || namespace.name === '.' || namespace.name === '..' || namespace.name.startsWith('.')) continue
    const namespacePath = path.join(root, namespace.name)
    if (namespace.isSymbolicLink()) {
      onWarning?.(uiText("core.packDetector.skippedLink", namespacePath))
      continue
    }
    if (!namespace.isDirectory() || !(await readPackEntry(namespacePath, onWarning))?.isDirectory()) continue
    const entries = await readDiscoveryDirectory(namespacePath, onWarning)
    if (!entries) continue
    for (const entry of entries) {
      if (!markers.has(entry.name) && !(markers === RESOURCE_MARKERS && RESOURCE_FILE_MARKERS.has(entry.name))) continue
      const markerPath = path.join(namespacePath, entry.name)
      if (entry.isSymbolicLink()) {
        onWarning?.(uiText("core.packDetector.skippedLink", markerPath))
        continue
      }
      if (markers.has(entry.name) && entry.isDirectory() && (await readPackEntry(markerPath, onWarning))?.isDirectory()) return true
      if (markers === RESOURCE_MARKERS && RESOURCE_FILE_MARKERS.has(entry.name) && entry.isFile() && (await readPackEntry(markerPath, onWarning))?.isFile()) return true
    }
  }
  return false
}

// 新版格式保留主次版本，旧字段兼容现有读取行为
function readPackFormat(meta: RawPackMeta): { packFormat?: number; packFormatMinor?: number; packVersion?: string } {
  const minimum = meta.pack?.min_format
  if (Number.isInteger(minimum) && Number(minimum) >= 0) return { packFormat: Number(minimum), packFormatMinor: 0 }
  if (Array.isArray(minimum) && minimum.length === 2 && minimum.every(value => Number.isInteger(value) && value >= 0)) return { packFormat: minimum[0], packFormatMinor: minimum[1] }
  const fmt = meta.pack?.pack_format
  const ver = meta.pack?.version
  if (typeof fmt === 'number' && Number.isFinite(fmt)) return { packFormat: fmt }
  if (typeof fmt === 'string') {
    const num = Number(fmt)
    return Number.isFinite(num) ? { packFormat: num } : { packVersion: fmt }
  }
  if (Array.isArray(ver)) {
    const first = Number(ver[0])
    return { packFormat: Number.isFinite(first) ? first : undefined }
  }
  if (typeof ver === 'number' && Number.isFinite(ver)) return { packFormat: ver }
  return {}
}

// 扫描器可接收文件系统警告，直接检测仍保留现有单参数接口
export async function inspectPackDirectory(root: string, onWarning?: WarningReporter): Promise<PackInfo> {
  const info: PackInfo = { root, kind: 'unknown', hasAssets: false, hasMetadata: false, reasons: [] }
  const warn: WarningReporter = message => {
    info.reasons.push(message)
    onWarning?.(message)
  }
  if (!(await isSafePackDirectory(root, warn))) return info
  const assets = await readPackEntry(path.join(root, 'assets'), warn)
  info.hasAssets = assets?.isDirectory() ?? false
  const metadataWarnings: string[] = []
  const metaPath = path.join(root, PACK_META)
  const metadataEntry = await readPackEntry(metaPath, message => { metadataWarnings.push(message); warn(message) })
  info.hasMetadata = Boolean(metadataEntry)
  let meta: RawPackMeta | undefined
  if (!metadataEntry) {
    info.metadataIssue = metadataWarnings.length ? uiText("core.packDetector.packMcmetaCannotBeReadSafely") : uiText("core.packDetector.lackOfPackMcmetaResourcePackWork")
  } else if (!metadataEntry.isFile()) {
    info.metadataIssue = uiText("core.packDetector.packMcmetaIsNotANormalFile")
  } else if (metadataEntry.size > MAX_METADATA_BYTES) {
    info.metadataIssue = uiText("core.packDetector.packMcmetaExceedingMetadataReadingLimit")
  } else {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(metaPath, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('metadata')
      const holder = (parsed as RawPackMeta).pack
      if (typeof holder !== 'object' || holder === null || Array.isArray(holder)) throw new Error('pack')
      meta = parsed as RawPackMeta
    } catch (error) {
      info.metadataIssue = uiText("core.packDetector.packMcmetaParsingFailedOrLackedPack")
      const code = errorCode(error)
      if (code !== 'UNKNOWN') warn(uiText("core.packDetector.unableToReadMetadata", code, metaPath))
    }
  }
  if (info.metadataIssue) info.reasons.push(info.metadataIssue)
  if (!meta) {
    if (info.hasAssets && await hasNamespaceMarker(path.join(root, 'assets'), RESOURCE_MARKERS, warn)) {
      info.kind = 'resourcepack'
      info.reasons.push(uiText("core.packDetector.assetsNamedSpaceResourceDirectoryDetected"))
    }
    return info
  }
  Object.assign(info, readPackFormat(meta))
  info.name = typeof meta.pack?.description === 'string' ? meta.pack.description : undefined
  const data = await readPackEntry(path.join(root, 'data'), warn)
  if (data?.isDirectory() && (!info.hasAssets || await hasNamespaceMarker(path.join(root, 'data'), DATAPACK_MARKERS, warn))) {
    info.kind = 'datapack'
    info.reasons.push(uiText("core.packDetector.dataPacketEntitledDirectoryDetected"))
  } else if (info.hasAssets) {
    info.kind = 'resourcepack'
    info.reasons.push(uiText("core.packDetector.thereArePackMcmetaAndAssetsDirectories"))
  } else {
    info.reasons.push(uiText("core.packDetector.missingAsetsDirectory"))
  }
  return info
}

export async function detectPack(root: string): Promise<PackInfo> {
  return inspectPackDirectory(root)
}

// 仅工作区入口加载宿主模块，纯文件系统检测可在 Node 中运行
export function workspaceRoots(): string[] {
  const vscode = require('vscode') as typeof import('vscode')
  return (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath).filter(target => existsSync(target))
}
