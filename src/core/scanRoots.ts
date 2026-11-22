import { uiText } from '../i18n/messages'
import * as path from 'node:path'

export interface ScanSettings { roots: string[]; depth: number; warnings: string[] }

// 相对路径保留原写法，绝对路径规范化且不依赖终端当前目录
export function mergeCustomScanPaths(currentPaths: unknown, addedPaths: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const existing = Array.isArray(currentPaths) ? currentPaths : []
  const merged: string[] = []
  const seen = new Set<string>()
  for (const entry of [...existing, ...addedPaths]) {
    if (typeof entry !== 'string' || !entry.trim() || /[\u0000-\u001f]/.test(entry)) continue
    const value = entry.trim()
    const absolute = pathApi.isAbsolute(value)
    const normalized = pathApi.normalize(value)
    const canonical = normalized.length > pathApi.parse(normalized).root.length && normalized.endsWith(pathApi.sep)
      ? normalized.slice(0, -1)
      : normalized
    // 分开去重以保留相对路径随工作区变化的语义
    const key = (absolute ? 'absolute:' : 'relative:') + (platform === 'win32' ? canonical.toLowerCase() : canonical)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(absolute ? canonical : entry)
  }
  return merged
}

export function resolveScanSettings(workspacePaths: readonly string[], extraPaths: unknown, depthValue: unknown): ScanSettings {
  const warnings: string[] = []
  const inputs: string[] = []
  const workspaces = workspacePaths.filter(value => typeof value === 'string' && path.isAbsolute(value)).map(value => path.resolve(value))
  inputs.push(...workspaces)
  const extras = Array.isArray(extraPaths) ? extraPaths : []
  if (!Array.isArray(extraPaths)) warnings.push(uiText("core.scanRoots.customScanDirectoriesMustBeArraysInvalid"))
  for (const entry of extras) {
    if (typeof entry !== 'string' || !entry.trim() || /[\u0000-\u001f]/.test(entry)) { warnings.push(uiText("core.scanRoots.ignoreInvalidCustomScanDirectories")); continue }
    const value = entry.trim()
    if (process.platform === 'win32' && /^[a-z]:(?![\\/])/i.test(value)) { warnings.push(uiText("core.scanRoots.customDirectoryCannotUseTheRelativeDrive", value)); continue }
    if (path.isAbsolute(value)) inputs.push(path.resolve(value))
    else if (workspaces.length) for (const workspace of workspaces) inputs.push(path.resolve(workspace, value))
    else warnings.push(uiText("core.scanRoots.theCustomRelativePathDoesNotHave", value))
  }
  const unique = new Map<string, string>()
  for (const root of inputs) unique.set(process.platform === 'win32' ? root.toLowerCase() : root, root)
  const requested = typeof depthValue === 'number' && Number.isFinite(depthValue) ? Math.trunc(depthValue) : 2
  const depth = Math.max(0, Math.min(8, requested))
  if (depthValue !== undefined && depthValue !== depth) warnings.push(uiText("core.scanRoots.scanDepthIsInvalidOrHyperdrivedIntegrated"))
  return { roots: [...unique.values()], depth, warnings }
}
