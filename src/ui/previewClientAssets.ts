import { uiText } from '../i18n/messages'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as vscode from 'vscode'
import { previewClientStoragePath } from '../core/previewClientStorage'
import {
  assertClientAssetsPath, CLIENT_ASSETS_EXTRACTION_SCHEMA, CLIENT_ASSETS_LIMITS, CLIENT_ASSETS_MANIFEST,
  CLIENT_ASSETS_POLICY, extractClientReleaseAsync, cacheDir, validateClientVersion
} from '../core/clientAssets'
import { ensureCachedClientJar } from '../core/clientJarCache'
import type { VersionDetail, VersionManifest } from '../core/versionManifest'
import { readOfficialMetadata as metadata, downloadOfficialAsset as download } from './officialPreviewAssets'
import { ensurePreviewLanguageAssets } from './previewLanguageAssets'

const MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'
const pending = new Map<string, Promise<string | undefined>>()
const MAX_MARKER_BYTES = 64 * 1024

function cacheRoot(context: vscode.ExtensionContext, version: string): string {
  validateClientVersion(version)
  return path.resolve(previewClientStoragePath(context), 'preview-assets', `minecraft-${version}`)
}

interface CompleteMarker {
  version: string
  sourceManifest: { version: string; sha1: string; size: number }
  extractionSchema: number
  assetPolicy: string
  assetsRoot: string
  complete: boolean
  versionConfirmed: boolean
  failedCount: number
  fileCount: number
  totalBytes: number
  includedCategories: string[]
  includedNamespaces: string[]
}

const REGISTERED_CLIENTS = 'mcrh.previewClientAssets'

export async function registerPreviewClientAssets(context: vscode.ExtensionContext, version: string, root: string): Promise<void> {
  if (!await readCompleteCache(root, version)) return
  const registered = context.globalState.get<Record<string, string>>(REGISTERED_CLIENTS, {})
  await context.globalState.update(REGISTERED_CLIENTS, { ...registered, [version]: path.resolve(root) })
}

// 下载目录与独立缓存都按完整清单验证，当前资源包仍处于最高优先级
export async function findPreviewClientAssets(context: vscode.ExtensionContext, version: string, nearbyRoots: readonly string[] = []): Promise<string | undefined> {
  validateClientVersion(version)
  const roots: string[] = []
  try { roots.push(cacheRoot(context, version)) } catch {}
  const registered = context.globalState?.get<Record<string, string>>(REGISTERED_CLIENTS, {})?.[version]
  if (typeof registered === 'string' && path.isAbsolute(registered)) roots.push(registered)
  for (const root of nearbyRoots) {
    roots.push(root, path.join(root, 'minecraft-' + version))
  }
  for (const root of new Set(roots)) {
    const complete = await readCompleteCache(root, version)
    if (complete) return complete
  }
  return undefined
}

async function readCompleteCache(root: string, version: string): Promise<string | undefined> {
  try {
    const markerFile = path.join(root, CLIENT_ASSETS_MANIFEST)
    await assertClientAssetsPath(markerFile)
    const stat = await fs.lstat(markerFile)
    if (!stat.isFile() || stat.size > MAX_MARKER_BYTES) return undefined
    const marker = JSON.parse(await fs.readFile(markerFile, 'utf8')) as CompleteMarker
    if (marker.version !== version || marker.extractionSchema !== CLIENT_ASSETS_EXTRACTION_SCHEMA || marker.assetPolicy !== CLIENT_ASSETS_POLICY || marker.assetsRoot !== 'assets' || marker.complete !== true || marker.versionConfirmed !== true || marker.failedCount !== 0) return undefined
    const source = marker.sourceManifest
    if (!source || source.version !== version || typeof source.sha1 !== 'string' || !/^[a-f0-9]{40}$/i.test(source.sha1) || !Number.isSafeInteger(source.size) || source.size <= 0 || source.size > CLIENT_ASSETS_LIMITS.maxArchiveBytes) return undefined
    if (!Number.isSafeInteger(marker.fileCount) || marker.fileCount < 1 || marker.fileCount > CLIENT_ASSETS_LIMITS.maxEntries || !Number.isSafeInteger(marker.totalBytes) || marker.totalBytes < 0 || marker.totalBytes > CLIENT_ASSETS_LIMITS.maxTotalBytes) return undefined
    if (!Array.isArray(marker.includedNamespaces) || !marker.includedNamespaces.length || marker.includedNamespaces.length > 256 || !Array.isArray(marker.includedCategories) || marker.includedCategories.length > 256) return undefined
    const namespaces = new Set<string>()
    for (const namespace of marker.includedNamespaces) {
      if (typeof namespace !== 'string' || !/^[a-z0-9_.-]+$/.test(namespace) || namespace === '.' || namespace === '..' || namespaces.has(namespace)) return undefined
      validateClientVersion(namespace)
      namespaces.add(namespace)
    }
    const categories = new Set<string>()
    for (const category of marker.includedCategories) {
      if (typeof category !== 'string' || category === '.' || category === '..' || categories.has(category)) return undefined
      validateClientVersion(category)
      categories.add(category)
    }
    const assets = path.join(root, 'assets')
    if (!(await fs.lstat(assets)).isDirectory()) return undefined
    for (const namespace of namespaces) {
      const directory = path.join(assets, namespace)
      if (!(await fs.lstat(directory)).isDirectory()) return undefined
    }
    return root
  } catch { return undefined }
}

export async function ensurePreviewClientAssets(context: vscode.ExtensionContext, version: string, options: { throwOnError?: boolean; includeLanguages?: boolean; nearbyRoots?: readonly string[] } = {}): Promise<string | undefined> {
  try {
    const key = cacheRoot(context, version)
    let work = pending.get(key)
    if (!work) {
      work = buildPreviewClientAssets(context, version, key, options.nearbyRoots).finally(() => pending.delete(key))
      pending.set(key, work)
    }
    const root = await work
    if (root && options.includeLanguages !== false) await ensurePreviewLanguageAssets(context, version)
    return root
  } catch (error) {
    if (options.throwOnError) throw error
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
    return undefined
  }
}

async function buildPreviewClientAssets(context: vscode.ExtensionContext, version: string, target: string, nearbyRoots: readonly string[] = []): Promise<string | undefined> {
  const cached = await findPreviewClientAssets(context, version, nearbyRoots)
  if (cached) return cached
  try {
    return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: uiText("ui.previewClientAssets.mcrhReadyOriginalPreviewResource", version), cancellable: true }, async (progress, token) => {
      const controller = new AbortController()
      const subscription = token.onCancellationRequested(() => controller.abort())
      if (token.isCancellationRequested) controller.abort()
      const signal = controller.signal
      let staging: string | undefined
      try {
        signal.throwIfAborted()
        await assertClientAssetsPath(target)
        const parent = path.dirname(target)
        await fs.mkdir(parent, { recursive: true })
        staging = await fs.mkdtemp(path.join(parent, '.build-'))
        progress.report({ message: uiText("ui.previewClientAssets.accessToOfficialVersionOfTheList") })
        const manifest = await metadata<VersionManifest>(MANIFEST_URL, signal)
        const entry = manifest.versions?.find(item => item.id === version)
        if (!entry) throw new Error(uiText("ui.previewClientAssets.thereSNoClearVersionOfThe", version))
        const detail = await metadata<VersionDetail>(entry.url, signal)
        const client = detail.downloads?.client
        if (detail.id !== version || !client || !Number.isSafeInteger(client.size) || client.size <= 0 || client.size > CLIENT_ASSETS_LIMITS.maxArchiveBytes || !/^[a-f0-9]{40}$/i.test(client.sha1)) throw new Error(uiText("ui.previewClientAssets.invalidOfficialClientVersionShaOrSize"))
        const jar = await ensureCachedClientJar(cacheDir(context), version, client, (file, downloadSignal) => download(client.url, file, client, downloadSignal, bytes => progress.report({ message: uiText("ui.previewClientAssets.downloadClientMb", (bytes / 1024 / 1024).toFixed(1)) })), signal, status => progress.report({ message: status === 'cached' ? uiText("ui.clientAssetsCommand.reuseVerifiedClientCache") : status === 'checking' ? uiText("ui.clientAssetsCommand.verifyLocalClientCaches") : uiText("ui.clientAssetsCommand.downloadClient_2e1d36") }))
        signal.throwIfAborted()
        const result = await extractClientReleaseAsync(jar.file, staging, version, info => progress.report(info), { version, sha1: client.sha1, size: client.size }, signal)
        signal.throwIfAborted()
        if (await readCompleteCache(result.targetDir, version) !== result.targetDir) throw new Error(uiText("ui.previewClientAssets.failedToVerifyThePreviewFullResource"))
        signal.throwIfAborted()
        await assertClientAssetsPath(target)
        const stale = path.join(parent, `.stale-${randomUUID()}`)
        let moved = false
        try {
          signal.throwIfAborted()
          try { await fs.lstat(target); await fs.rename(target, stale); moved = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          signal.throwIfAborted()
          await fs.rename(result.targetDir, target)
        } catch (error) {
          if (moved) await fs.rename(stale, target)
          throw error
        }
        if (moved) await removeOwnedDirectory(parent, stale)
        return target
      } finally {
        subscription.dispose()
        if (staging) await removeOwnedDirectory(path.dirname(target), staging)
      }
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return undefined
    throw new Error(uiText("ui.previewClientAssets.couldNotCloseTemporaryFolderS", (error instanceof Error ? error.message : String(error))), { cause: error })
  }
}

async function removeOwnedDirectory(parent: string, target: string): Promise<void> {
  if (path.dirname(target) !== parent || !/^\.(?:build|stale)-[a-zA-Z0-9-]+$/.test(path.basename(target))) throw new Error(uiText("ui.previewClientAssets.cacheCleanupPathExceedingTheDedicatedTemporary"))
  await assertClientAssetsPath(target)
  await fs.rm(target, { recursive: true, force: true })
}
