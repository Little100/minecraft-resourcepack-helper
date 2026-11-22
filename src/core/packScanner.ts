import { uiText } from '../i18n/messages'
import * as path from 'node:path'
import type * as vscode from 'vscode'
import { inspectPackDirectory, isSafePackDirectory, readDiscoveryDirectory, readPackEntry } from './packDetector'
import type { PackKind } from './types'

export interface ScannedPack {
  root: string
  name: string
  kind: PackKind
  packFormat?: number
  hasMetadata?: boolean
  metadataIssue?: string
  reasons?: string[]
  // 包图标路径与修改时间供侧栏刷新使用
  iconPath?: string
  iconMtime?: number
}

export interface ScanOptions {
  roots: string[]
  // 深度相对于各自扫描根计算，根目录为零
  depth: number
  // 所有扫描根共享候选数量限制
  limit?: number
}

export interface ScanResult {
  packs: ScannedPack[]
  scannedRoots: number
  warnings?: string[]
}

const DEFAULT_LIMIT = 64
const MAX_DEPTH = 8
const MAX_LIMIT = 4096
const MAX_DIRECTORIES = 10000
const MAX_WARNINGS = 64
const SKIP_DIRS = new Set(['node_modules', '.git', '.vscode', 'out', 'dist', 'build', '.vscode-test', 'target', '__pycache__', 'coverage', 'venv', 'bower_components', 'assets', 'data'])

// Windows 路径大小写统一，重叠扫描根共享同一个候选
export function pathKey(target: string): string {
  const resolved = path.resolve(target)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

async function readIcon(root: string, onWarning: (message: string) => void): Promise<Pick<ScannedPack, 'iconPath' | 'iconMtime'>> {
  const iconPath = path.join(root, 'pack.png')
  const entry = await readPackEntry(iconPath, onWarning)
  return entry?.isFile() ? { iconPath, iconMtime: entry.mtimeMs } : {}
}

// 有界扫描保留元数据候选，同时发现尚未补齐元数据的资源包工程
export async function scanForPacks(options: ScanOptions): Promise<ScanResult> {
  const limit = options.limit ?? DEFAULT_LIMIT
  if (!Number.isInteger(options.depth) || options.depth < 0 || options.depth > MAX_DEPTH) throw new RangeError(uiText("core.packScanner.scanDepthMustBeToIntegerNumber", MAX_DEPTH))
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_LIMIT) throw new RangeError(uiText("core.packScanner.scanNumberLimitMustBeToInteger", MAX_LIMIT))
  if (!Array.isArray(options.roots) || options.roots.some(root => typeof root !== 'string' || root.trim().length === 0)) throw new TypeError(uiText("core.packScanner.scanRootMustBeANonEmpty"))
  const hits = new Map<string, ScannedPack>()
  const visitedDepth = new Map<string, number>()
  const warnings: string[] = []
  const warn = (message: string): void => {
    if (warnings.includes(message)) return
    if (warnings.length < MAX_WARNINGS) warnings.push(message)
    else warnings[MAX_WARNINGS - 1] = uiText("core.packScanner.scanWarningExceededTheNumberLimitAnd")
  }

  const walk = async (dir: string, remainingDepth: number): Promise<void> => {
    if (hits.size >= limit) return
    const key = pathKey(dir)
    const previousDepth = visitedDepth.get(key)
    if (previousDepth !== undefined && previousDepth >= remainingDepth) return
    if (previousDepth === undefined && visitedDepth.size >= MAX_DIRECTORIES) {
      warn(uiText("core.packScanner.scanDirectoryExceededTheNumberLimitAnd"))
      return
    }
    visitedDepth.set(key, remainingDepth)
    if (!(await readPackEntry(dir, warn))?.isDirectory()) return
    const entries = await readDiscoveryDirectory(dir, warn)
    if (!entries) return
    const hasMeta = entries.some(entry => entry.name === 'pack.mcmeta' && !entry.isSymbolicLink())
    const hasAssets = entries.some(entry => entry.name === 'assets' && entry.isDirectory())
    if (!hits.has(key) && (hasMeta || hasAssets)) {
      const info = await inspectPackDirectory(dir, warn)
      if (hasMeta || info.kind === 'resourcepack') {
        hits.set(key, {
          root: dir,
          name: path.basename(dir),
          kind: info.kind,
          packFormat: info.packFormat,
          hasMetadata: info.hasMetadata,
          metadataIssue: info.metadataIssue,
          reasons: info.reasons,
          ...await readIcon(dir, warn)
        })
      }
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) warn(uiText("core.packDetector.skippedLink", path.join(dir, entry.name)))
    }
    if (remainingDepth === 0 || hits.size >= limit || visitedDepth.size >= MAX_DIRECTORIES) return
    const children = entries
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      if (hits.size >= limit) return
      await walk(path.join(dir, child.name), remainingDepth - 1)
    }
  }

  for (const root of options.roots) {
    if (hits.size >= limit) break
    const resolved = path.resolve(root)
    if (await isSafePackDirectory(resolved, warn)) await walk(resolved, options.depth)
  }
  return { packs: [...hits.values()].sort((a, b) => a.root.localeCompare(b.root)), scannedRoots: options.roots.length, warnings }
}

const STORAGE_KEY = 'mcrh.scannedPacks'

export function saveScan(context: vscode.ExtensionContext, packs: ScannedPack[]): void {
  void context.workspaceState.update(STORAGE_KEY, packs)
}

// 旧缓存的诊断和图标字段保持可选，不需要迁移
export function loadScan(context: vscode.ExtensionContext): ScannedPack[] {
  return context.workspaceState.get<ScannedPack[]>(STORAGE_KEY) ?? []
}
