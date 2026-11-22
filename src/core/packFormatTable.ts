import { uiText } from '../i18n/messages'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type * as vscode from 'vscode'

export interface PackFormatEntry {
  id: string
  name: string
  type: string
  stable: boolean
  rpk: number
  rpkMinor: number
  dpk: number
  dpkMinor?: number
}

export interface PackFormatTable {
  source: string
  generated: string
  count: number
  versions: PackFormatEntry[]
}

const REMOTE_URL = 'https://raw.githubusercontent.com/misode/mcmeta/summary/versions/data.json'
const CACHE_FILE = 'packFormats.cache.json'
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

// 网络不稳时限制等待时间和重试次数
const REQUEST_TIMEOUT_MS = 15 * 1000
const RETRY_COUNT = 1
const RETRY_BACKOFF_MS = 500

// 缓存缺太多条目时使用内置表
const CACHE_TRUST_RATIO = 0.5

// 避免定时和手动刷新同时写缓存
let refreshInFlight: Promise<RefreshResult> | undefined

function bundledTable(context: vscode.ExtensionContext): PackFormatTable | undefined {
  const file = path.join(context.extensionPath, 'src', 'core', 'data', 'packFormats.json')
  const fallback = path.join(context.extensionPath, 'out', 'data', 'packFormats.json')
  for (const candidate of [fallback, file]) {
    try {
      if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, 'utf8')) as PackFormatTable
    } catch {
      // 换一个路径试试
    }
  }
  return undefined
}

function cacheFile(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, CACHE_FILE)
}

export function readCache(context: vscode.ExtensionContext): PackFormatTable | undefined {
  try {
    const file = cacheFile(context)
    if (!fs.existsSync(file)) return undefined
    return JSON.parse(fs.readFileSync(file, 'utf8')) as PackFormatTable
  } catch {
    return undefined
  }
}

function cacheAge(context: vscode.ExtensionContext): number {
  try {
    return Date.now() - fs.statSync(cacheFile(context)).mtimeMs
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export function loadTable(context: vscode.ExtensionContext): PackFormatTable {
  const cached = readCache(context)
  const bundled = bundledTable(context)
  if (cached && bundled && cached.versions.length < bundled.versions.length * CACHE_TRUST_RATIO) return bundled
  return cached ?? bundled ?? { source: 'none', generated: '', count: 0, versions: [] }
}

function compact(raw: Array<Record<string, unknown>>): PackFormatTable {
  const versions: PackFormatEntry[] = raw.map(item => ({
    id: String(item.id ?? ''),
    name: String(item.name ?? item.id ?? ''),
    type: String(item.type ?? 'release'),
    stable: Boolean(item.stable),
    rpk: Number(item.resource_pack_version ?? 0),
    rpkMinor: Number(item.resource_pack_version_minor ?? 0),
    dpk: Number(item.data_pack_version ?? 0),
    dpkMinor: Number(item.data_pack_version_minor ?? 0)
  }))
  return {
    source: 'https://github.com/misode/mcmeta/tree/summary/versions',
    generated: new Date().toISOString().slice(0, 10),
    count: versions.length,
    versions
  }
}

export interface RefreshResult {
  ok: boolean
  count?: number
  message: string
}

// 刷新仍在进行时共用同一次请求
export async function refreshTable(context: vscode.ExtensionContext): Promise<RefreshResult> {
  if (refreshInFlight) return await refreshInFlight
  refreshInFlight = doRefreshTable(context).finally(() => { refreshInFlight = undefined })
  return await refreshInFlight
}

async function doRefreshTable(context: vscode.ExtensionContext): Promise<RefreshResult> {
  let table: PackFormatTable
  try {
    const raw = await fetchRemoteTable()
    table = compact(raw)
    const bundled = bundledTable(context), cached = readCache(context)
    const knownCount = Math.max(bundled?.versions?.length ?? 0, cached?.versions?.length ?? 0)
    if (table.count < knownCount * CACHE_TRUST_RATIO) throw new Error(uiText("core.packFormatTable.remoteVersionTableMissingTooManyVersions"))
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
  return saveTable(cacheFile(context), table)
}

// 请求失败时稍等再重试
async function fetchRemoteTable(): Promise<Array<Record<string, unknown>>> {
  let lastError: unknown
  for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
    try {
      const response = await fetch(REMOTE_URL, {
        headers: { 'User-Agent': 'MCRH-VSCode-Extension' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      if (!response.ok) {
        const error = new Error(uiText("core.packFormatTable.failedToDownloadVersionTableHttp", response.status))
        if (response.status === 429 || response.status >= 500) throw error
        lastError = error
        break
      }
      const raw = await response.json() as unknown
      if (!Array.isArray(raw) || !raw.length || !raw.every(validRemoteEntry)) throw new Error(uiText("core.packFormatTable.remoteVersionTableIsEmptyOrContains"))
      return raw
    } catch (error) {
      lastError = error
      if (attempt < RETRY_COUNT) await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS * (attempt + 1)))
    }
  }
  throw lastError
}

function validRemoteEntry(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string' && !!entry.id.trim() &&
    ['resource_pack_version', 'resource_pack_version_minor', 'data_pack_version', 'data_pack_version_minor'].every(key =>
      entry[key] == null || typeof entry[key] === 'number' && Number.isSafeInteger(entry[key]) && entry[key] >= 0)
}

// 临时文件写好后才替换原缓存
export async function saveTable(file: string, table: PackFormatTable): Promise<RefreshResult> {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    await fs.promises.writeFile(temp, JSON.stringify(table), 'utf8')
    await fs.promises.rename(temp, file)
  } catch (error) {
    await fs.promises.rm(temp, { force: true }).catch(() => undefined)
    return { ok: false, message: uiText("core.packFormatTable.writingToVersionTableCacheFailed", errorMessage(error)) }
  }
  return { ok: true, count: table.count, message: uiText("core.packFormatTable.updatedVersions", table.count) }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function needsRefresh(context: vscode.ExtensionContext): boolean {
  return cacheAge(context) > CACHE_MAX_AGE_MS
}

export function formatForVersion(table: PackFormatTable, version: string): PackFormatEntry | undefined {
  const target = version.trim().toLowerCase()
  return table.versions.find(entry => entry.id.toLowerCase() === target)
}

// 资源包格式反查最小兼容版本, 用于提示用户该填哪个 pack_format
export function versionsForFormat(table: PackFormatTable, format: number): PackFormatEntry[] {
  return table.versions.filter(entry => entry.rpk === format && entry.stable)
}

export interface VersionSuggestion {
  label: string
  detail: string
  version: string
  format: string
}

export function suggestions(table: PackFormatTable, limit = 60): VersionSuggestion[] {
  const stable = table.versions.filter(entry => entry.stable && entry.type === 'release')
  const snapshots = table.versions.filter(entry => !entry.stable)
  return [...stable, ...snapshots].slice(0, limit).map(entry => ({
    label: entry.id,
    detail: uiText("core.packFormatTable.resourcePackFormat", entry.type === 'release' ? uiText("browser.workbenchBridge.release") : uiText("browser.workbenchBridge.quickshot"), entry.rpk, entry.rpkMinor ? `.${entry.rpkMinor}` : ''),
    version: entry.id,
    format: entry.rpkMinor ? `${entry.rpk}.${entry.rpkMinor}` : String(entry.rpk)
  }))
}
