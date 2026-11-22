import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ScannedPack } from '../core/packScanner'

export type PackTreeEntry = PackFolderEntry | PackLeafEntry

export interface PackFolderEntry {
  kind: 'folder'
  label: string
  path: string
  packCount: number
  children: PackTreeEntry[]
}

export interface PackLeafEntry {
  kind: 'pack'
  pack: ScannedPack
}

interface FolderBuild {
  name: string
  path: string
  folders: Map<string, FolderBuild>
  packs: ScannedPack[]
}

function newFolder(name: string, folderPath: string): FolderBuild {
  return { name, path: folderPath, folders: new Map(), packs: [] }
}

function isSameOrInside(base: string, dir: string): boolean {
  const rel = path.relative(base, dir)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

function nearestRoot(roots: string[], dir: string): string | undefined {
  let best: string | undefined
  for (const root of roots) {
    if (!isSameOrInside(root, dir)) continue
    if (best === undefined || root.length > best.length) best = root
  }
  return best
}

export function buildPackTree(roots: string[], packs: ScannedPack[]): PackTreeEntry[] {
  const resolvedRoots = roots.map(root => path.resolve(root))
  const bases = new Map<string, FolderBuild>()
  const loose: ScannedPack[] = []
  for (const pack of packs) {
    const dir = path.dirname(path.resolve(pack.root))
    const base = nearestRoot(resolvedRoots, dir)
    const rel = base === undefined ? '' : path.relative(base, dir)
    if (base === undefined || rel === '') {
      loose.push(pack)
      continue
    }
    const top = bases.get(base) ?? newFolder('', base)
    bases.set(base, top)
    let node: FolderBuild = top
    for (const segment of rel.split(path.sep)) {
      const child = node.folders.get(segment) ?? newFolder(segment, path.join(node.path, segment))
      node.folders.set(segment, child)
      node = child
    }
    node.packs.push(pack)
  }
  const entries: PackTreeEntry[] = []
  for (const top of bases.values()) entries.push(...folderChildren(top))
  for (const pack of loose) entries.push({ kind: 'pack', pack })
  return sortEntries(entries)
}

function folderChildren(folder: FolderBuild): PackTreeEntry[] {
  const entries: PackTreeEntry[] = [...folder.folders.values()].map(compressFolder)
  for (const pack of folder.packs) entries.push({ kind: 'pack', pack })
  return sortEntries(entries)
}

function compressFolder(folder: FolderBuild): PackFolderEntry {
  let label = folder.name
  let current = folder
  while (current.packs.length === 0 && current.folders.size === 1) {
    current = [...current.folders.values()][0]
    label = `${label}/${current.name}`
  }
  return {
    kind: 'folder',
    label,
    path: current.path,
    packCount: countPacks(current),
    children: folderChildren(current)
  }
}

function countPacks(folder: FolderBuild): number {
  let total = folder.packs.length
  for (const child of folder.folders.values()) total += countPacks(child)
  return total
}

function sortEntries(entries: PackTreeEntry[]): PackTreeEntry[] {
  const nameOf = (entry: PackTreeEntry): string => (entry.kind === 'folder' ? entry.label : entry.pack.name)
  return entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    return nameOf(a).localeCompare(nameOf(b))
  })
}

// 显示图标时只用扫描记录，不重新读盘
export function packIconSource(pack: ScannedPack): { path: string; version?: number } | undefined {
  if (!pack.iconPath) return undefined
  return { path: pack.iconPath, version: pack.iconMtime }
}

export interface Debounced {
  trigger(): void
  dispose(): void
}

export function createDebounced(task: () => void, delayMs: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    trigger() {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        task()
      }, delayMs)
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    }
  }
}

export type StructurePresence = ReadonlyMap<string, ReadonlySet<string>>

export function collectStructurePresence(roots: string[], relatives: string[]): StructurePresence {
  const presence = new Map<string, ReadonlySet<string>>()
  for (const root of roots) {
    presence.set(root, new Set(relatives.filter(relative => fs.existsSync(path.join(root, relative)))))
  }
  return presence
}
