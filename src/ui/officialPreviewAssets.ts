import { uiText } from '../i18n/messages'
import * as fs from 'node:fs'
import * as https from 'node:https'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { assertClientAssetsPath } from '../core/clientAssets'

const officialHosts = new Set(['launchermeta.mojang.com', 'piston-meta.mojang.com', 'piston-data.mojang.com', 'launcher.mojang.com', 'resources.download.minecraft.net'])
const maxMetadataBytes = 8 * 1024 * 1024
export interface OfficialAssetDigest { size: number; sha1: string }

export function validateOfficialAssetDigest(value: unknown, maximum = maxMetadataBytes): value is OfficialAssetDigest {
  if (!value || typeof value !== 'object') return false
  const digest = value as Partial<OfficialAssetDigest>
  return Number.isSafeInteger(digest.size) && digest.size! > 0 && digest.size! <= maximum && typeof digest.sha1 === 'string' && /^[a-f0-9]{40}$/i.test(digest.sha1)
}

function officialUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !officialHosts.has(url.hostname) || url.username || url.password || url.port) throw new Error(uiText("ui.officialPreviewAssets.clientResourcesMustBeDownloadedViaThe"))
  return url
}

// 原生 HTTPS 不读取代理配置，重定向仍限定为官方地址
async function directResponse(value: string, signal: AbortSignal, redirects = 0): Promise<import('node:http').IncomingMessage> {
  signal.throwIfAborted()
  if (redirects > 5) throw new Error(uiText("ui.officialPreviewAssets.officialDownloadsAreOverRedirected"))
  const url = officialUrl(value)
  const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const request = https.get(url, { agent: false, signal, headers: { 'User-Agent': 'MCRH-VSCode-Extension' } }, resolve)
    request.once('error', reject)
    request.setTimeout(30_000, () => request.destroy(new Error(uiText("ui.officialPreviewAssets.officialResourceRequestsTimedOut"))))
  })
  if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
    const next = new URL(response.headers.location, url).href
    response.destroy()
    return directResponse(next, signal, redirects + 1)
  }
  if (response.statusCode !== 200) { response.destroy(); throw new Error(uiText("ui.officialPreviewAssets.officialResourceRequestFailed", response.statusCode)) }
  return response
}

export async function readOfficialMetadata<T>(url: string, signal: AbortSignal, expected?: OfficialAssetDigest): Promise<T> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
  const response = await directResponse(url, bounded), chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of response) {
      bounded.throwIfAborted(); size += chunk.length
      if (size > (expected?.size ?? maxMetadataBytes)) throw new Error(uiText("ui.officialPreviewAssets.officialVersionOfMetadataOverAndAbove"))
      chunks.push(Buffer.from(chunk))
    }
    const data = Buffer.concat(chunks)
    if (expected && (data.length !== expected.size || createHash('sha1').update(data).digest('hex') !== expected.sha1.toLowerCase())) throw new Error(uiText("ui.officialPreviewAssets.officialResourceIndexSizeOrSha1Validation"))
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as T
  } finally { response.destroy() }
}

export async function downloadOfficialAsset(url: string, target: string, expected: OfficialAssetDigest, signal: AbortSignal, report: (bytes: number) => void = () => undefined): Promise<void> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)])
  const response = await directResponse(url, bounded), digest = createHash('sha1')
  let received = 0
  const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    received += chunk.length
    if (received > expected.size) { callback(new Error(uiText("ui.officialPreviewAssets.officialResourcesOverStatedSize"))); return }
    digest.update(chunk); report(received); callback(null, chunk)
  } })
  try {
    await assertClientAssetsPath(target)
    await pipeline(response, counter, fs.createWriteStream(target, { flags: 'wx' }), { signal: bounded })
    bounded.throwIfAborted()
    if (received !== expected.size || digest.digest('hex') !== expected.sha1.toLowerCase()) throw new Error(uiText("ui.officialPreviewAssets.officialResourceSizeOrSha1VerificationFailed"))
  } finally { response.destroy() }
}
