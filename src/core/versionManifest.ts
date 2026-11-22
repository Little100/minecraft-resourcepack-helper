import { uiText } from '../i18n/messages'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pipeline } from 'node:stream/promises'

export interface VersionEntry {
  id: string
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha'
  url: string
  releaseTime: string
}

export interface VersionManifest {
  latest: { release: string; snapshot: string }
  versions: VersionEntry[]
}

export interface VersionDetail {
  id: string
  downloads?: { client?: { url: string; size: number; sha1: string } }
  assetIndex?: { id: string; url: string; size: number; sha1: string; totalSize?: number }
  javaVersion?: { majorVersion: number }
}

const MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'

// 清单请求超时后可提示重试
const REQUEST_TIMEOUT_MS = 15 * 1000

// 只重试清单请求，不重试大文件下载
const RETRY_COUNT = 1
const RETRY_BACKOFF_MS = 500

function networkOptions(): { headers: Record<string, string> } {
  return { headers: { 'User-Agent': 'MCRH-VSCode-Extension' } }
}

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { ...networkOptions(), signal: withTimeout(signal) })
  if (!response.ok) throw new Error(uiText("core.versionManifest.requestFailed", response.status, url))
  return await response.json() as T
}

async function fetchJsonWithRetry<T>(url: string, signal?: AbortSignal): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
    try {
      return await fetchJson<T>(url, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error
      if (attempt < RETRY_COUNT) await delay(RETRY_BACKOFF_MS * (attempt + 1))
    }
  }
  throw lastError
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function fetchVersionManifest(): Promise<VersionManifest> {
  const manifest = await fetchJsonWithRetry<VersionManifest>(MANIFEST_URL)
  if (!manifest?.versions?.length) throw new Error(uiText("core.versionManifest.versionListIsEmptyCheckTheNetwork"))
  return manifest
}

export async function fetchVersionDetail(entry: VersionEntry): Promise<VersionDetail> {
  return await fetchJsonWithRetry<VersionDetail>(entry.url)
}

export class ClientJarIntegrityError extends Error {}

// 分块检查客户端文件，避免一次读进内存
export async function verifyClientJar(file: string, expected: { size?: number; sha1?: string }, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const stat = await fs.promises.stat(file)
  if (expected.size !== undefined && stat.size !== expected.size) throw new ClientJarIntegrityError(uiText("core.versionManifest.clientJarSizeVerificationFailed"))
  const digest = crypto.createHash('sha1')
  let received = 0
  for await (const chunk of fs.createReadStream(file, { signal })) {
    received += chunk.length
    digest.update(chunk)
  }
  signal?.throwIfAborted()
  if (expected.size !== undefined && received !== expected.size) throw new ClientJarIntegrityError(uiText("core.versionManifest.clientJarSizeVerificationFailed"))
  if (expected.sha1 && digest.digest('hex') !== expected.sha1.toLowerCase()) throw new ClientJarIntegrityError(uiText("core.versionManifest.clientJarSha1VerificationFailed"))
}

// 下载文件通过检查后才替换目标文件
export async function downloadClientJar(
  url: string,
  targetFile: string,
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal,
  expected?: { size?: number; sha1?: string }
): Promise<string> {
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10 * 60_000)])
  bounded.throwIfAborted()
  const temporary = targetFile + '.' + crypto.randomUUID() + '.part'
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let destination: fs.WriteStream | undefined
  try {
    const response = await fetch(url, { ...networkOptions(), signal: bounded })
    if (!response.ok) throw new Error(uiText("core.versionManifest.downloadFailed", response.status))
    if (!response.body) throw new Error(uiText("core.versionManifest.responseEmptyUnableToDownload"))
    const total = Number(response.headers.get('content-length') ?? 0)
    reader = response.body.getReader()
    let received = 0
    async function* chunks(): AsyncGenerator<Uint8Array> {
      for (;;) {
        bounded.throwIfAborted()
        const { done, value } = await reader!.read()
        if (done) return
        if (!value) continue
        received += value.byteLength
        if (expected?.size !== undefined && received > expected.size) throw new ClientJarIntegrityError(uiText("core.versionManifest.clientDownloadsBeyondDeclaredSize"))
        onProgress?.(received, total)
        bounded.throwIfAborted()
        yield value
      }
    }
    await fs.promises.mkdir(path.dirname(targetFile), { recursive: true })
    destination = fs.createWriteStream(temporary, { flags: 'wx' })
    await pipeline(chunks(), destination, { signal: bounded })
    if (expected) await verifyClientJar(temporary, expected, bounded)
    bounded.throwIfAborted()
    await fs.promises.rename(temporary, targetFile)
    return targetFile
  } finally {
    await reader?.cancel().catch(() => undefined)
    if (destination && !destination.closed) await new Promise<void>(resolve => { destination!.once('close', resolve); destination!.destroy() })
    await fs.promises.rm(temporary, { force: true })
  }
}

// 挑出版本列表, 默认只给稳定版, 避免用户误选快照导致资源不匹配
export function pickVersions(manifest: VersionManifest, includeSnapshots: boolean): VersionEntry[] {
  return manifest.versions.filter(entry => includeSnapshots || entry.type === 'release')
}
