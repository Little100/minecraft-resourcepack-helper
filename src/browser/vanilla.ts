import { uiText } from '../i18n/messages'
import { ARCHIVE_LIMIT, errorText, textDecoder } from './files'

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
export interface VanillaVersion { id: string; type: string; url: string; releaseTime: string; sha1: string }
export interface VanillaManifest { latest: { release: string; snapshot: string }; versions: VanillaVersion[] }
export interface VanillaDownload { id: string; url: string; size: number; sha1: string }
export type DownloadProgress = (received: number, total: number, label: string) => void

function officialUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error(uiText("browser.vanilla.mojangResponseMissingDownloadAddress"))
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !['piston-meta.mojang.com', 'piston-data.mojang.com', 'launcher.mojang.com', 'launchermeta.mojang.com'].includes(url.hostname)) throw new Error(uiText("browser.vanilla.rejectsNonMojangOfficialDownloadAddress"))
  return url.href
}

async function fetchBytes(url: string, limit: number, signal: AbortSignal, onProgress?: DownloadProgress, label = ''): Promise<Uint8Array> {
  let response: Response
  try { response = await fetch(officialUrl(url), { signal, credentials: 'omit', redirect: 'error' }) }
  catch (error) { if (signal.aborted) throw new Error(uiText("browser.packToolsBridge.operationCanceled")); throw new Error(uiText("browser.vanilla.mojangRequestFailedAndMayBeRestricted", errorText(error))) }
  if (!response.ok || !response.body) throw new Error(uiText("browser.vanilla.mojangDownloadFailedHttpEnableToImport", response.status))
  const total = Number(response.headers.get('content-length') || 0)
  if (total > limit) { await response.body.cancel(); throw new Error(uiText("browser.vanilla.downloadsExceedingBrowserSizeLimits")) }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let received = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      received += chunk.value.length
      if (received > limit) throw new Error(uiText("browser.vanilla.downloadsExceedingBrowserSizeLimits"))
      chunks.push(chunk.value); onProgress?.(received, total, label)
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  const bytes = new Uint8Array(received); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

async function sha1(bytes: Uint8Array): Promise<string> { const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', Uint8Array.from(bytes))); return Array.from(digest, value => value.toString(16).padStart(2, '0')).join('') }

export async function fetchManifest(signal: AbortSignal): Promise<VanillaManifest> {
  const raw: unknown = JSON.parse(textDecoder.decode(await fetchBytes(MANIFEST_URL, 8 * 1024 * 1024, signal)))
  const value = raw as Partial<VanillaManifest>
  if (!value.latest || typeof value.latest.release !== 'string' || !Array.isArray(value.versions) || !value.versions.some(entry => entry.id === value.latest!.release)) throw new Error(uiText("browser.vanilla.mojangVersionListFormatInvalid"))
  const versions = value.versions.filter(entry => entry && typeof entry.id === 'string' && typeof entry.type === 'string' && typeof entry.url === 'string' && typeof entry.sha1 === 'string' && /^[a-f0-9]{40}$/i.test(entry.sha1)).map(entry => ({ ...entry, url: officialUrl(entry.url) }))
  return { latest: value.latest, versions }
}

export async function resolveClient(version: VanillaVersion, signal: AbortSignal): Promise<VanillaDownload> {
  const bytes = await fetchBytes(version.url, 8 * 1024 * 1024, signal)
  if (await sha1(bytes) !== version.sha1.toLowerCase()) throw new Error(uiText("browser.vanilla.versionMetadataShaVerificationFailedClientNot"))
  signal.throwIfAborted()
  const metadata = JSON.parse(textDecoder.decode(bytes)) as { id?: unknown; downloads?: { client?: { url?: unknown; size?: unknown; sha1?: unknown } } }
  if (metadata.id !== version.id) throw new Error(uiText("browser.vanilla.versionMetadataIdDoesNotMatchThe"))
  const client = metadata.downloads?.client
  if (!client || typeof client.size !== 'number' || !Number.isSafeInteger(client.size) || client.size < 1 || client.size > ARCHIVE_LIMIT || typeof client.sha1 !== 'string' || !/^[a-f0-9]{40}$/i.test(client.sha1)) throw new Error(uiText("browser.vanilla.thereAreNoVerifiedJavaClientDownloads"))
  return { id: version.id, url: officialUrl(client.url), size: client.size, sha1: client.sha1 }
}

export async function downloadClient(client: VanillaDownload, signal: AbortSignal, onProgress: DownloadProgress): Promise<Uint8Array> {
  const bytes = await fetchBytes(client.url, Math.min(client.size, ARCHIVE_LIMIT), signal, onProgress, client.id)
  signal.throwIfAborted()
  if (bytes.length !== client.size) throw new Error(uiText("browser.vanilla.clientSizeDoesNotMatchMojangMetadata"))
  if (await sha1(bytes) !== client.sha1.toLowerCase()) throw new Error(uiText("browser.vanilla.clientShaVerificationFailedNoProjectImported"))
  return bytes
}
