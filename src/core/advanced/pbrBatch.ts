import { uiText } from '../../i18n/messages'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { safeRelativePath } from './safeExport'

export interface PbrTextureEntry { path: string; source: string; size: number; animation?: string }
export interface PbrTextureScan { entries: PbrTextureEntry[]; skipped: string[] }
const MAX_TEXTURES = 1024
const MAX_INPUT_BYTES = 128 * 1024 * 1024

export function consumePbrBudget(total: number, bytes: number): number {
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(bytes) || total < 0 || bytes < 0 || total + bytes > MAX_INPUT_BYTES) throw new Error(uiText("core.advanced.pbrBatch.pbrStickersAndAnimationMetadataCumulativelyExceed"))
  return total + bytes
}

export async function scanPbrTextures(root: string, signal?: AbortSignal): Promise<PbrTextureScan> {
  if (!path.isAbsolute(root)) throw new Error(uiText("core.advanced.pbrBatch.theMaterialPackageCatalogueMustBeAbsolute"))
  const base = path.resolve(root), assets = path.join(base, 'assets')
  const baseStat = await fs.lstat(base)
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error(uiText("core.advanced.pbrBatch.pleaseSelectTheActualMaterialPackageRoot"))
  const metadataFile = path.join(base, 'pack.mcmeta')
  const metadataStat = await fs.lstat(metadataFile)
  if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.size > 256 * 1024) throw new Error(uiText("core.advanced.pbrBatch.sourcePackageLacksAReasonableNormalSize"))
  const metadata = JSON.parse(await fs.readFile(metadataFile, 'utf8')) as { pack?: unknown }
  if (!metadata.pack || typeof metadata.pack !== 'object' || Array.isArray(metadata.pack)) throw new Error(uiText("core.advanced.pbrBatch.sourcePackagePackMcmetaMissingAValid"))
  const rootReal = await fs.realpath(base)
  const entries: PbrTextureEntry[] = [], skipped: string[] = []
  let total = 0, visited = 0
  const check = () => { if (signal?.aborted) throw new Error(uiText("core.advanced.pbrBatch.pbrBatchOperationCancelledSourcePackageNot")) }
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    check()
    if (depth > 32) throw new Error(uiText("core.advanced.pbrBatch.pasteCatalogLevelOverlimit"))
    const actual = await fs.realpath(directory), relative = path.relative(rootReal, actual)
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error(uiText("core.advanced.pbrBatch.canNotGetFolderSS"))
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > 16384) throw new Error(uiText("core.advanced.pbrBatch.pasteScanEntryExcess"))
      const source = path.join(directory, entry.name), name = prefix + entry.name
      const stat = await fs.lstat(source)
      if (stat.isSymbolicLink()) throw new Error(uiText("core.advanced.pbrBatch.thePosterDirectoryCannotContainASymbol"))
      if (stat.isDirectory()) { await walk(source, name + '/', depth + 1); continue }
      if (!stat.isFile() || !/\.png$/i.test(entry.name)) continue
      if (/_(?:n|s|normal|mer)\.png$/i.test(entry.name)) { skipped.push(name); continue }
      safeRelativePath(name)
      total = consumePbrBudget(total, stat.size)
      if (entries.length >= MAX_TEXTURES || stat.size > 32 * 1024 * 1024 || total > MAX_INPUT_BYTES) throw new Error(uiText("core.advanced.pbrBatch.batchPbrLimitToPosterOrMib"))
      let animation: string | undefined
      try {
        const meta = await fs.lstat(source + '.mcmeta')
        if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 1024 * 1024) throw new Error(uiText("core.advanced.pbrBatch.animationMetadataInvalid"))
        consumePbrBudget(total, meta.size)
        animation = await fs.readFile(source + '.mcmeta', 'utf8')
        const actualBytes = Buffer.byteLength(animation)
        if (actualBytes > 1024 * 1024) throw new Error(uiText("core.advanced.pbrBatch.animatedMetadataExceedTheMaximumSizeDuring"))
        total = consumePbrBudget(total, actualBytes)
        JSON.parse(animation)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      entries.push({ path: name, source, size: stat.size, animation })
      check()
    }
  }
  const assetStat = await fs.lstat(assets)
  if (!assetStat.isDirectory() || assetStat.isSymbolicLink()) throw new Error(uiText("core.advanced.pbrBatch.sourceDirectoryMissingActualAsetsFolder"))
  for (const namespace of await fs.readdir(assets, { withFileTypes: true })) {
    check()
    if (++visited > 16384) throw new Error(uiText("core.advanced.pbrBatch.resourceNamingSpaceExcess"))
    const namespaceStat = await fs.lstat(path.join(assets, namespace.name))
    if (namespaceStat.isSymbolicLink()) throw new Error(uiText("core.advanced.pbrBatch.resourceNamingSpaceCannotBeASymbol"))
    if (!namespaceStat.isDirectory()) continue
    if (!/^[a-z0-9_.-]+$/.test(namespace.name)) { skipped.push(`assets/${namespace.name}/`); continue }
    const textures = path.join(assets, namespace.name, 'textures')
    try {
      const stat = await fs.lstat(textures)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(uiText("core.advanced.pbrBatch.texturesMustBeAPhysicalDirectory"))
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    await walk(textures, `assets/${namespace.name}/textures/`, 0)
  }
  if (!entries.length) throw new Error(uiText("core.advanced.pbrBatch.noUnderlyingPngDrawingFoundToGenerate"))
  return { entries, skipped }
}
