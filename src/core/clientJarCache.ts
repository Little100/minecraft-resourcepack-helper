import { uiText } from '../i18n/messages'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertClientAssetsPath, CLIENT_ASSETS_LIMITS, validateClientVersion } from './clientAssets'
import { ClientJarIntegrityError, verifyClientJar } from './versionManifest'

export interface ClientJarDigest { size: number; sha1: string }
export interface CachedClientJar { file: string; cached: boolean }
export type ClientJarDownloader = (target: string, signal: AbortSignal) => Promise<unknown>
const pending = new Map<string, Promise<void>>()

function waitFor<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = (): void => { signal.removeEventListener('abort', aborted); reject(signal.reason) }
    signal.addEventListener('abort', aborted, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
    if (signal.aborted) aborted()
  })
}

async function matches(file: string, expected: ClientJarDigest, signal: AbortSignal): Promise<boolean> {
  try {
    await assertClientAssetsPath(file)
    await verifyClientJar(file, expected, signal)
    return true
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof ClientJarIntegrityError || (error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

// 同版本与摘要共用持久缓存，并发操作等待现有下载完成
export async function ensureCachedClientJar(
  directory: string,
  version: string,
  expected: ClientJarDigest,
  download: ClientJarDownloader,
  signal: AbortSignal = new AbortController().signal,
  report: (status: 'checking' | 'cached' | 'downloading') => void = () => undefined
): Promise<CachedClientJar> {
  signal.throwIfAborted()
  validateClientVersion(version)
  if (!Number.isSafeInteger(expected.size) || expected.size <= 0 || expected.size > CLIENT_ASSETS_LIMITS.maxArchiveBytes || !/^[a-f0-9]{40}$/i.test(expected.sha1)) throw new Error(uiText("core.clientJarCache.invalidClientCacheSizeOrSha1Metadata"))
  if (!path.isAbsolute(directory)) throw new Error(uiText("core.clientJarCache.clientCacheMustUseAbsolutePath"))
  const file = path.resolve(directory, 'client-' + version + '-' + expected.sha1.toLowerCase() + '.jar')
  const previous = pending.get(file) ?? Promise.resolve()
  const work = previous.then(async (): Promise<CachedClientJar> => {
    signal.throwIfAborted()
    report('checking')
    if (await matches(file, expected, signal)) {
      report('cached')
      return { file, cached: true }
    }
    await assertClientAssetsPath(directory)
    await fs.mkdir(directory, { recursive: true })
    const temporary = path.join(directory, '.client-' + randomUUID() + '.part')
    try {
      signal.throwIfAborted()
      report('downloading')
      await download(temporary, signal)
      signal.throwIfAborted()
      await verifyClientJar(temporary, expected, signal)
      await assertClientAssetsPath(file)
      signal.throwIfAborted()
      await fs.rename(temporary, file)
      return { file, cached: false }
    } finally {
      await fs.rm(temporary, { force: true })
    }
  })
  const completed = work.then(() => undefined, () => undefined)
  pending.set(file, completed)
  void completed.then(() => { if (pending.get(file) === completed) pending.delete(file) })
  return waitFor(work, signal)
}
