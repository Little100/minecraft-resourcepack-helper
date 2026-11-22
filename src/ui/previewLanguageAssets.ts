import { uiText } from '../i18n/messages'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import * as vscode from 'vscode'
import { assertClientAssetsPath, validateClientVersion } from '../core/clientAssets'
import { previewClientStoragePath } from '../core/previewClientStorage'
import type { VersionDetail, VersionManifest } from '../core/versionManifest'
import { downloadOfficialAsset, readOfficialMetadata, validateOfficialAssetDigest, type OfficialAssetDigest } from './officialPreviewAssets'

const markerName = '.mcrh-languages.json'
const languageRelativePath = 'assets/minecraft/lang/zh_cn.json'
const maxLanguageBytes = 4 * 1024 * 1024
const pending = new Map<string, Promise<string>>()
interface LanguageMarker { schema: number; version: string; assetIndex: OfficialAssetDigest & { id: string }; language: OfficialAssetDigest; complete: boolean }
interface AssetIndex { objects?: Record<string, { hash: string; size: number }> }
interface LanguageCacheOptions { throwOnError?: boolean; signal?: AbortSignal; detail?: VersionDetail }

function cacheRoot(context: vscode.ExtensionContext, version: string): string {
  validateClientVersion(version)
  return path.join(previewClientStoragePath(context), 'preview-languages', 'minecraft-' + version)
}

function parseLanguage(bytes: Uint8Array): void {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''))
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length || !Object.values(value).every(entry => typeof entry === 'string')) throw new Error(uiText("ui.previewLanguageAssets.invalidFormatForOfficialChineseLanguageFiles"))
}

// 语言包独立于客户端资源缓存，补齐旧缓存时不改写用户材质包
export async function findPreviewLanguageAssets(context: vscode.ExtensionContext, version: string): Promise<string | undefined> {
  try {
    const root = cacheRoot(context, version), markerPath = path.join(root, markerName), languagePath = path.join(root, languageRelativePath)
    await assertClientAssetsPath(markerPath); await assertClientAssetsPath(languagePath)
    const stat = await fs.lstat(markerPath)
    if (!stat.isFile() || stat.size > 8192) return undefined
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as LanguageMarker
    if (marker.schema !== 1 || marker.version !== version || !marker.complete || !validateOfficialAssetDigest(marker.assetIndex) || typeof marker.assetIndex.id !== 'string' || !validateOfficialAssetDigest(marker.language, maxLanguageBytes)) return undefined
    const languageStat = await fs.lstat(languagePath)
    if (!languageStat.isFile() || languageStat.size !== marker.language.size) return undefined
    const bytes = await fs.readFile(languagePath)
    if (createHash('sha1').update(bytes).digest('hex') !== marker.language.sha1.toLowerCase()) return undefined
    parseLanguage(bytes)
    return root
  } catch { return undefined }
}

export async function ensurePreviewLanguageAssets(context: vscode.ExtensionContext, version: string, options: LanguageCacheOptions = {}): Promise<string | undefined> {
  try {
    const target = cacheRoot(context, version), existing = await findPreviewLanguageAssets(context, version)
    if (existing) return existing
    let work = pending.get(target)
    if (!work) {
      work = buildLanguageCache(version, target, options).finally(() => pending.delete(target))
      pending.set(target, work)
    }
    return await work
  } catch (error) {
    if (options.throwOnError) throw error
    if (options.signal?.aborted) return undefined
    void vscode.window.showWarningMessage(uiText("ui.previewLanguageAssets.theChineseLanguageCacheHasNotBeen", (error instanceof Error ? error.message : String(error))))
    return undefined
  }
}

async function buildLanguageCache(version: string, target: string, options: LanguageCacheOptions): Promise<string> {
  const signal = options.signal ?? new AbortController().signal
  let detail = options.detail
  if (!detail) {
    const manifest = await readOfficialMetadata<VersionManifest>('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json', signal)
    const entry = manifest.versions?.find(value => value.id === version)
    if (!entry) throw new Error(uiText("ui.previewLanguageAssets.itSNotOnTheOfficialList", version))
    detail = await readOfficialMetadata<VersionDetail>(entry.url, signal)
  }
  if (detail.id !== version || !detail.assetIndex || typeof detail.assetIndex.id !== 'string' || !validateOfficialAssetDigest(detail.assetIndex)) throw new Error(uiText("ui.previewLanguageAssets.theVersionLacksAValidIndexOf"))
  const index = await readOfficialMetadata<AssetIndex>(detail.assetIndex.url, signal, detail.assetIndex)
  const asset = index.objects?.['minecraft/lang/zh_cn.json']
  const digest = asset && { sha1: asset.hash, size: asset.size }
  if (!validateOfficialAssetDigest(digest, maxLanguageBytes)) throw new Error(version + uiText("ui.previewLanguageAssets.noValidZhCnJsonInOfficial"))
  const parent = path.dirname(target)
  await assertClientAssetsPath(target); await fs.mkdir(parent, { recursive: true })
  const staging = await fs.mkdtemp(path.join(parent, '.languages-')), stale = path.join(parent, '.languages-' + randomUUID())
  let moved = false, published = false
  try {
    const language = path.join(staging, languageRelativePath)
    await fs.mkdir(path.dirname(language), { recursive: true })
    await downloadOfficialAsset('https://resources.download.minecraft.net/' + digest.sha1.slice(0, 2) + '/' + digest.sha1, language, digest, signal)
    parseLanguage(await fs.readFile(language))
    const marker: LanguageMarker = { schema: 1, version, assetIndex: { id: detail.assetIndex.id, size: detail.assetIndex.size, sha1: detail.assetIndex.sha1 }, language: digest, complete: true }
    await fs.writeFile(path.join(staging, markerName), JSON.stringify(marker, null, 2), { flag: 'wx' })
    signal.throwIfAborted(); await assertClientAssetsPath(target)
    try { await fs.lstat(target); await fs.rename(target, stale); moved = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    try { signal.throwIfAborted(); await fs.rename(staging, target); published = true }
    catch (error) { if (moved) { await fs.rename(stale, target); moved = false }; throw error }
    return target
  } finally {
    if (!published) await removeOwnedDirectory(parent, staging)
    if (moved) await removeOwnedDirectory(parent, stale)
  }
}

async function removeOwnedDirectory(parent: string, target: string): Promise<void> {
  if (path.dirname(target) !== parent || !/^\.languages-[a-zA-Z0-9-]+$/.test(path.basename(target))) throw new Error(uiText("ui.previewLanguageAssets.languageCacheCleanupPathBeyondSpecialTemporary"))
  await assertClientAssetsPath(target)
  await fs.rm(target, { recursive: true, force: true })
}
