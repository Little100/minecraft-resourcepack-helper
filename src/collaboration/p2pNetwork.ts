import { uiText } from '../i18n/messages'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { findNodeAtLocation, getNodeValue, parseTree, type ParseError } from 'jsonc-parser'
import { z } from 'zod'
import { atomic } from './files'
import { fail, p2pNetworkSchema, type ServerConfig } from './types'

export const OPL_PRESET_URL = 'https://file.gldhn.top/file/json/preset.json'
const MAX_PRESET_BYTES = 256 * 1024
const CACHE_FRESH_MS = 24 * 60 * 60 * 1000
const CACHE_FALLBACK_MS = 30 * CACHE_FRESH_MS
const networkSchema = p2pNetworkSchema.extend({ name: z.string().trim().min(1).max(120), serverHost: p2pNetworkSchema.shape.serverHost.unwrap(), serverPort: p2pNetworkSchema.shape.serverPort.unwrap() })
export type P2PNetwork = z.infer<typeof networkSchema>
const cacheSchema = z.object({ version: z.literal(1), source: z.string(), fetchedAt: z.number().int().positive(), network: networkSchema }).strict()
const pending = new Map<string, Promise<P2PNetwork>>()

export function presetSource(input = OPL_PRESET_URL): string {
  if (input.length > 2048) fail(uiText("collaboration.p2pNetwork.openp2pPresetAddressTooLong"))
  let url: URL
  try { url = new URL(input) } catch { return fail(uiText("collaboration.p2pNetwork.openp2pNodePresetMustUseAValid")) }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) fail(uiText("collaboration.p2pNetwork.openp2pNodePresetsMustUseHttpsAddresses"))
  return url.href
}

export function parseOPLNetworks(text: string): P2PNetwork[] {
  if (Buffer.byteLength(text) > MAX_PRESET_BYTES) fail(uiText("collaboration.p2pNetwork.openp2pNodePresetsMoreThanSizeLimit"))
  const errors: ParseError[] = [], tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false })
  if (!tree || errors.length) fail(uiText("collaboration.p2pNetwork.openp2pNodePresetIsNotValidJson"))
  const servers = findNodeAtLocation(tree, ['servers'])
  if (servers?.type !== 'array' || !servers.children?.length || servers.children.length > 64) fail(uiText("collaboration.p2pNetwork.openp2pNodePresetsNoValidServerList"))
  const networks: P2PNetwork[] = []
  for (const server of servers.children) {
    if (server.type !== 'object') continue
    const value = getNodeValue(server), token = findNodeAtLocation(server, ['Token'])
    if (!token || !['number', 'string'].includes(token.type)) continue
    const result = networkSchema.safeParse({ name: value.ServerName, serverHost: value.ServerHost, serverPort: value.ServerPort ?? 27183, token: token.type === 'string' ? token.value : text.slice(token.offset, token.offset + token.length) })
    if (result.success) networks.push(result.data)
  }
  if (!networks.length) fail(uiText("collaboration.p2pNetwork.openp2pNodePresetsDoNotContainAvailable"))
  return networks
}

async function fetchPreset(source: string): Promise<P2PNetwork> {
  const response = await fetch(source, { redirect: 'error', signal: AbortSignal.timeout(12000), headers: { Accept: 'application/json' } })
  if (!response.ok || !response.body || Number(response.headers.get('content-length') ?? 0) > MAX_PRESET_BYTES) {
    await response.body?.cancel()
    fail(uiText("collaboration.p2pNetwork.openp2pPresetAcquisitionFailed"))
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > MAX_PRESET_BYTES) fail(uiText("collaboration.p2pNetwork.openp2pNodePresetsMoreThanSizeLimit"))
    chunks.push(chunk)
  }
  return parseOPLNetworks(Buffer.concat(chunks).toString('utf8'))[0]
}

async function acquire(directory: string, source: string): Promise<P2PNetwork> {
  const file = path.join(directory, 'openp2p-network.json'), now = Date.now()
  let cached: z.infer<typeof cacheSchema> | undefined
  const stat = await fs.lstat(file).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
  if (stat && stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_PRESET_BYTES) {
    try {
      const result = cacheSchema.safeParse(JSON.parse(await fs.readFile(file, 'utf8')))
      if (result.success && result.data.source === source && result.data.fetchedAt <= now) cached = result.data
    } catch { cached = undefined }
  }
  if (cached && now - cached.fetchedAt < CACHE_FRESH_MS) return cached.network
  let network: P2PNetwork
  try { network = await fetchPreset(source) } catch {
    if (cached && now - cached.fetchedAt < CACHE_FALLBACK_MS) return cached.network
    return fail(uiText("collaboration.p2pNetwork.unableToAutomaticallyRetrieveOpenp2pNodeConfiguration"))
  }
  await atomic(file, JSON.stringify({ version: 1, source, fetchedAt: now, network }))
  return network
}

export async function acquireP2PNetwork(directory: string, input = OPL_PRESET_URL): Promise<P2PNetwork> {
  const source = presetSource(input), key = path.resolve(directory) + '\0' + source
  const existing = pending.get(key)
  if (existing) return existing
  const operation = acquire(directory, source)
  pending.set(key, operation)
  try { return await operation } finally { if (pending.get(key) === operation) pending.delete(key) }
}

export async function automaticP2PNetwork(directory: string, input = OPL_PRESET_URL) {
  const source = presetSource(input), network = p2pNetworkSchema.parse(await acquireP2PNetwork(directory, source))
  return { ...network, presetUrl: source }
}

export async function refreshAutomaticP2P(directory: string, config: NonNullable<ServerConfig['p2p']>): Promise<NonNullable<ServerConfig['p2p']>> {
  if (!config.presetUrl) return config
  return { ...config, ...await automaticP2PNetwork(directory, config.presetUrl) }
}
