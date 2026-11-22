import { uiText } from '../i18n/messages'
import * as https from 'node:https'
import { z } from 'zod'
import { CollaborationError, fail, type Identity, type ServerConfig } from './types'

export const identityPolicySchema = z.object({ queryMode: z.enum(['github', 'proxy', 'auto']), queryProxy: z.string().nullable() }).strict()
export type IdentityPolicy = z.infer<typeof identityPolicySchema>
export function identityPolicy(config: Pick<ServerConfig, 'queryMode'> & { queryProxy?: string }): IdentityPolicy { return { queryMode: config.queryMode, queryProxy: config.queryMode === 'github' ? null : config.queryProxy ?? null } }
export function sameIdentityPolicy(a: IdentityPolicy, b: IdentityPolicy): boolean { return a.queryMode === b.queryMode && a.queryProxy === b.queryProxy }
const identitySchema = z.object({ id: z.number().int().positive().safe(), login: z.string().regex(/^[a-zA-Z0-9-]{1,39}$/) })
async function query(url: string, token: string, label: string): Promise<Identity> {
  const target = new URL(url)
  if (target.protocol !== 'https:' || target.username || target.password || target.hash || target.search) fail(uiText("collaboration.identity.theIdentitySearchEndpointMustBeAn"), 503)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, identity?: Identity): void => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(identity!) }
    const request = https.request(target, { method: 'GET', headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'user-agent': 'MCRH-Collaboration', 'x-github-api-version': '2022-11-28' } }, response => {
      const chunks: Buffer[] = []; let length = 0
      response.on('data', (chunk: Buffer) => { length += chunk.length; if (length > 65536) { finish(new CollaborationError(label + uiText("collaboration.identity.identityResponseExceededLimit"), 502)); request.destroy() } else chunks.push(chunk) })
      response.on('error', () => finish(new CollaborationError(label + uiText("collaboration.identity.identityResponseAbortedPleaseCheckTheSearch"), 502)))
      response.on('aborted', () => finish(new CollaborationError(label + uiText("collaboration.identity.identityResponseAbortedPleaseCheckTheSearch"), 502)))
      response.on('end', () => {
        const status = response.statusCode ?? 502
        if (status !== 200) { finish(new CollaborationError(label + (status === 401 ? uiText("collaboration.identity.rejectThisGithubIdPleaseReEnter") : status === 403 || status === 429 ? uiText("collaboration.identity.denyAccessOrTriggerTheRestrictedStream") : uiText("collaboration.identity.identificationQueryNotAvailablePleaseCheckThe")) + ' (HTTP ' + status + ')', status === 401 ? 401 : 502)); return }
        try { const value = identitySchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))); finish(undefined, { id: String(value.id), login: value.login }) }
        catch { finish(new CollaborationError(label + uiText("collaboration.identity.noValidGithubUserIdentityDataReturned"), 502)) }
      })
    })
    const timer = setTimeout(() => { finish(new CollaborationError(label + uiText("collaboration.identity.identificationCheckTimeoutPleaseCheckTheSearch"), 503)); request.destroy() }, 12000)
    request.on('error', (error: NodeJS.ErrnoException) => { const code = error.code && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? ' [' + error.code + ']' : ''; finish(new CollaborationError(label + uiText("collaboration.identity.couldNotCloseTemporaryFolderS") + code, 502)) }); request.end()
  })
}
export async function githubIdentity(token: string, config: Pick<ServerConfig, 'queryMode'> & { queryProxy?: string }): Promise<Identity> {
  if (!/^[\x21-\x7e]{10,2048}$/.test(token)) fail(uiText("collaboration.identity.invalidGithubAccessTokenFormat"), 401)
  if (config.queryMode === 'github') return query('https://api.github.com/user', token, uiText("collaboration.identity.githubOfficial"))
  if (!config.queryProxy) fail(uiText("collaboration.identity.theServiceHasNotConfiguredTheIdentity"), 503)
  if (config.queryMode === 'proxy') return query(config.queryProxy, token, uiText("collaboration.identity.serviceEndMirror"))
  try { return await query('https://api.github.com/user', token, uiText("collaboration.identity.githubOfficial")) }
  catch (error) {
    if (error instanceof CollaborationError && error.statusCode === 401) throw error
    try { return await query(config.queryProxy, token, uiText("collaboration.identity.serviceEndMirror")) }
    catch (fallback) { fail(uiText("collaboration.identity.couldNotCloseTemporaryFolderS_47372b", (error instanceof CollaborationError ? error.message : uiText("collaboration.identity.officialPeerNotAvailable")), (fallback instanceof CollaborationError ? fallback.message : uiText("collaboration.identity.mirrorEndpointNotAvailable"))), fallback instanceof CollaborationError ? fallback.statusCode : 503) }
  }
}
export type IdentityVerifier = (accessToken: string, config: ServerConfig) => Promise<Identity>
