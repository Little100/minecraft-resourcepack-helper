import { uiText } from '../i18n/messages'
export const COLLABORATION_REQUEST_TIMEOUT_MS = 60_000
export const COLLABORATION_RECEIVE_IDLE_MS = 15_000
export const COLLABORATION_RESPONSE_IDLE_MS = COLLABORATION_REQUEST_TIMEOUT_MS + 5_000
export const COLLABORATION_SESSION_BODY_BYTES = 16 * 1024
export const COLLABORATION_MAX_ACTIVE_SUBMISSIONS = 2

const routes = new Set(['hello', 'session', 'me', 'packs', 'files', 'versions', 'proposals', 'members', 'settings', 'audit', 'discover'].map(name => '/v1/' + name))
const localRoutes = new Set(['rotate', 'stop', 'invitation', 'p2p'].map(name => '/v1/local/' + name))
export function collaborationRequestLabel(method: string, route: string): string {
  const pathname = route.split('?')[0]
  let safe = routes.has(pathname) || localRoutes.has(pathname) ? pathname : uiText("collaboration.httpPolicy.v1OtherInterfaces")
  if (/^\/v1\/packs\/[a-f0-9-]{8,64}\/manifest$/.test(pathname)) safe = '/v1/packs/:id/manifest'
  else if (/^\/v1\/proposals\/[a-f0-9-]{8,64}\/review$/.test(pathname)) safe = '/v1/proposals/:id/review'
  else if (/^\/v1\/members\/[1-9][0-9]{0,19}$/.test(pathname)) safe = '/v1/members/:id'
  return (['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'HEAD', 'OPTIONS'].includes(method) ? method : 'REQUEST') + ' ' + safe
}
