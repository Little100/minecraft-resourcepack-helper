import { uiText } from '../i18n/messages'
import * as https from 'node:https'
import * as tls from 'node:tls'
import { isIP } from 'node:net'
import { performance } from 'node:perf_hooks'
import { X509Certificate } from 'node:crypto'
import { hash } from './files'
import { collaborationLog, type CollaborationLog } from './diagnostics'
import { COLLABORATION_REQUEST_TIMEOUT_MS, collaborationRequestLabel } from './httpPolicy'
import { fail, invitationSchema, type Invitation } from './types'

export function encodeInvitation(invitation: Invitation): string { return (invitation.p2p ? 'mcrh://p2p/' + invitation.node + '/' : 'mcrh://connect/') + Buffer.from(JSON.stringify(invitation)).toString('base64url') }
export function decodeInvitation(value: string): Invitation {
  if (value.length > 24000) fail(uiText("collaboration.client.overlongConnectionInformation"))
  const p2p = /^mcrh:\/\/p2p\/([A-Za-z0-9_-]{8,31})\/([A-Za-z0-9_-]+)$/i.exec(value)
  const raw = p2p ? Buffer.from(p2p[2], 'base64url').toString('utf8') : value.startsWith('mcrh://connect/') ? Buffer.from(value.slice('mcrh://connect/'.length), 'base64url').toString('utf8') : value
  if (raw.length > 16384) fail(uiText("collaboration.client.overlongConnectionInformation"))
  let parsed: unknown; try { parsed = JSON.parse(raw) } catch { return fail(uiText("collaboration.client.pleasePasteTheFullMcrhConnectionInformation")) }
  const invitation = invitationSchema.parse(parsed), url = new URL(invitation.url)
  if (p2p && (!invitation.p2p || invitation.node !== p2p[1])) fail(uiText("collaboration.client.p2pInvitationUuidDoesNotMatchConnection"))
  if (invitation.p2p && (!invitation.node || url.hostname !== '127.0.0.1' || Number(url.port || 443) !== invitation.p2p.port)) fail(uiText("collaboration.client.p2pInvitationCanOnlyPointToThe"))
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail(uiText("collaboration.client.connectionAddressesMustBeANoPath"))
  return invitation
}
export class CollaborationConnectionError extends Error {
  constructor(message: string, readonly code: string, readonly retryable = false) { super(message); this.name = 'CollaborationConnectionError' }
}

type ConnectionOptions = { signal?: AbortSignal; timeoutMs?: number; onProgress?: (message: string) => void }

function connectionFailure(error: unknown): CollaborationConnectionError {
  if (error instanceof CollaborationConnectionError) return error
  const code = typeof (error as NodeJS.ErrnoException)?.code === 'string' ? (error as NodeJS.ErrnoException).code! : 'TLS_CONNECTION_FAILED'
  const reasons: Record<string, string> = {
    ECONNREFUSED: uiText("collaboration.client.collaborationPortIsNotYetListeningOr"),
    ECONNRESET: uiText("collaboration.client.theConnectionIsClosedByTheEnd"),
    ETIMEDOUT: uiText("collaboration.client.connectTimeoutCheckServiceSpecifiedPortAnd"),
    ENOTFOUND: uiText("collaboration.client.couldNotCloseTemporaryFolderS"),
    EAI_AGAIN: uiText("collaboration.client.couldNotParseTheCoWorkerAddress"),
    EHOSTUNREACH: uiText("collaboration.client.couldNotReachTheCollaborativeServerCheck"),
    ENETUNREACH: uiText("collaboration.client.theCurrentNetworkCannotReachTheCollaborating"),
    CERT_HAS_EXPIRED: uiText("collaboration.client.serviceEndCertificateExpiredPleaseUpdateThe"),
    CERT_NOT_YET_VALID: uiText("collaboration.client.theServiceEndCertificateIsNotYet"),
    ERR_SSL_WRONG_VERSION_NUMBER: uiText("collaboration.client.theTargetPortDoesNotProvideMcrh"),
    ERR_SSL_PACKET_LENGTH_TOO_LONG: uiText("collaboration.client.targetPortReturnsNonTlsContentPlease"),
    DEPTH_ZERO_SELF_SIGNED_CERT: uiText("collaboration.client.theServiceEndCertificateIsDifferentFrom"),
    SELF_SIGNED_CERT_IN_CHAIN: uiText("collaboration.client.theServiceCertificateChainIsNotConsistent"),
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: uiText("collaboration.client.theServiceCertificateChainCannotBeVerified")
  }
  const retryable = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)
  const safeCode = /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'TLS_CONNECTION_FAILED'
  return new CollaborationConnectionError((reasons[code] ?? uiText("collaboration.client.couldNotCreateFingerprintedTlsConnectionCheck")) + ' [' + safeCode + ']', safeCode, retryable)
}

export class RemoteClient {
  private certificate?: string
  token?: string
  localKey?: string
  private readonly log: CollaborationLog
  constructor(readonly invitation: Invitation, log?: CollaborationLog) { this.log = collaborationLog(log) }
  async connect(options: ConnectionOptions = {}): Promise<void> {
    this.certificate = undefined
    const url = new URL(this.invitation.url), hostname = url.hostname.replace(/^\[|\]$/g, '')
    const timeout = options.timeoutMs ?? 10000, deadline = performance.now() + timeout
    let phase = uiText("collaboration.client.certificateFingerprintDetection")
    try {
      options.onProgress?.(uiText("collaboration.client.useDirectLinkTlsDetectionServiceCertificate"))
      this.certificate = await new Promise<string>((resolve, reject) => {
        if (options.signal?.aborted) { reject(new CollaborationConnectionError(uiText("collaboration.client.connectionCancelled"), 'ABORT_ERR')); return }
        let settled = false
        const finish = (error?: unknown, certificate?: string): void => {
          if (settled) return
          settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); socket.destroy()
          if (error) reject(connectionFailure(error)); else resolve(certificate!)
        }
        const cancel = (): void => finish(new CollaborationConnectionError(uiText("collaboration.client.connectionCancelled"), 'ABORT_ERR'))
        const socket = tls.connect({ host: hostname, port: Number(url.port || 443), servername: isIP(hostname) ? undefined : hostname, rejectUnauthorized: false, ca: [] }, () => {
          try {
            const certificate = socket.getPeerCertificate(true)
            if (!certificate.raw || hash(certificate.raw) !== this.invitation.fingerprint) throw new CollaborationConnectionError(uiText("collaboration.client.serviceEndCertificateFingerprintsAreNotMatched"), 'MCRH_CERTIFICATE_MISMATCH')
            const parsed = new X509Certificate(certificate.raw), now = Date.now()
            if (now > Date.parse(parsed.validTo)) throw Object.assign(new Error(), { code: 'CERT_HAS_EXPIRED' })
            if (now < Date.parse(parsed.validFrom)) throw Object.assign(new Error(), { code: 'CERT_NOT_YET_VALID' })
            finish(undefined, parsed.toString())
          } catch (error) { finish(error) }
        })
        const timer = setTimeout(() => finish(Object.assign(new Error(), { code: 'ETIMEDOUT' })), timeout)
        socket.once('error', finish)
        socket.once('close', () => { if (!settled) finish(Object.assign(new Error(), { code: 'ECONNRESET' })) })
        options.signal?.addEventListener('abort', cancel, { once: true })
      })
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw Object.assign(new Error(), { code: 'ETIMEDOUT' })
      phase = uiText("collaboration.client.httpsServiceEndIdentificationValidation")
      options.onProgress?.(uiText("collaboration.client.certificateFingerprintAndValidityVerifiedServiceEnd"))
      const hello = await this.request<{ serverId: string }>('/v1/hello', 'GET', undefined, { ...options, public: true, timeoutMs: remaining })
      if (performance.now() >= deadline) throw Object.assign(new Error(), { code: 'ETIMEDOUT' })
      if (hello.serverId !== this.invitation.serverId) throw new CollaborationConnectionError(uiText("collaboration.client.theServiceEndIdentificationWasNotConsistent"), 'MCRH_SERVER_ID_MISMATCH')
      options.onProgress?.(uiText("collaboration.client.tlsCertificatesAndServiceEndIdentificationValidation"))
    } catch (error) { this.certificate = undefined; const failure = connectionFailure(error); throw new CollaborationConnectionError(phase + uiText("collaboration.client.failed") + failure.message, failure.code, failure.retryable) }
  }
  async request<T = unknown>(route: string, method = 'GET', body?: unknown, options: ConnectionOptions & { public?: boolean } = {}): Promise<T> {
    if (!this.certificate) fail(uiText("collaboration.client.createAFingerprintedTlsConnectionFirst"))
    if (!route.startsWith('/v1/') || route.includes('..')) fail(uiText("collaboration.client.collaborationRequestPathInvalid"))
    const url = new URL(this.invitation.url), data = body === undefined ? undefined : Buffer.from(JSON.stringify(body)), headers: Record<string, string | number> = { accept: 'application/json' }
    if (this.token && !options.public) headers.authorization = 'Bearer ' + this.token
    if (this.localKey && !options.public) headers['x-mcrh-local'] = this.localKey
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = data.length }
    const started = performance.now(), label = collaborationRequestLabel(method, route)
    return new Promise<T>((resolve, reject) => {
      if (options.signal?.aborted) { reject(new CollaborationConnectionError(uiText("collaboration.client.connectionCancelled"), 'ABORT_ERR')); return }
      const agent = new https.Agent({ keepAlive: false, maxCachedSessions: 0, ca: this.certificate })
      let settled = false
      const finish = (error?: unknown, value?: T): void => {
        if (settled) return
        settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); agent.destroy()
        const elapsed = Math.round(performance.now() - started)
        if (error) {
          const context = label + uiText("collaboration.client.requestFailedTimed") + elapsed + 'ms：'
          const failure = error instanceof CollaborationConnectionError ? new CollaborationConnectionError(context + error.message, error.code, error.retryable) : Object.assign(new Error(context + (error instanceof Error ? error.message : uiText("collaboration.client.collaborationRequestFailed"))), error && typeof error === 'object' && 'statusCode' in error ? { statusCode: error.statusCode } : {})
          this.log('warn', uiText("collaboration.client.coordinationRequest", failure.message)); reject(failure)
        } else { if (elapsed >= 1000) this.log('info', uiText("collaboration.client.coordinationRequestDoneTimedMs", label, elapsed)); resolve(value!) }
      }
      const cancel = (): void => { finish(new CollaborationConnectionError(uiText("collaboration.client.connectionCancelled"), 'ABORT_ERR')); request.destroy() }
      const request = https.request(url, { method, path: route, headers, ca: this.certificate, rejectUnauthorized: true, agent, checkServerIdentity: (_host, cert) => hash(cert.raw) === this.invitation.fingerprint ? undefined : new CollaborationConnectionError(uiText("collaboration.client.serviceCertificateFingerprintsWereNotMatchedAnd"), 'MCRH_CERTIFICATE_MISMATCH') }, response => {
        const chunks: Buffer[] = []; let length = 0
        response.on('data', (chunk: Buffer) => { length += chunk.length; if (length > 720 * 1024 ** 2) { finish(new Error(uiText("collaboration.client.overRespondingCollaboratively"))); request.destroy() } else chunks.push(chunk) })
        response.on('error', error => finish(connectionFailure(error)))
        response.on('end', () => {
          if (settled) return
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as T & { error?: string }
            if ((response.statusCode ?? 500) >= 400) finish(Object.assign(new Error(typeof value?.error === 'string' ? value.error : uiText("collaboration.client.serviceRefuseRequest")), { statusCode: response.statusCode }))
            else finish(undefined, value)
          } catch { finish(new Error(uiText("collaboration.client.collaborationResponseFormatIsInvalid"))) }
        })
      })
      const timer = setTimeout(() => { finish(connectionFailure(Object.assign(new Error(), { code: 'ETIMEDOUT' }))); request.destroy() }, options.timeoutMs ?? COLLABORATION_REQUEST_TIMEOUT_MS)
      request.on('error', error => finish(connectionFailure(error)))
      request.once('close', () => { if (!settled) finish(connectionFailure(Object.assign(new Error(), { code: 'ECONNRESET' }))) })
      options.signal?.addEventListener('abort', cancel, { once: true }); request.end(data)
    })
  }
  async login(accessToken: string, identityPolicy?: import('./identity').IdentityPolicy): Promise<{ token: string; status: string; role: string; identity: { id: string; login: string }; expires: number }> {
    const session = await this.request<{ token: string; status: string; role: string; identity: { id: string; login: string }; expires: number }>('/v1/session', 'POST', { accessToken, connectionKey: this.invitation.key, identityPolicy }); this.token = session.token; return session
  }
  async file(packId: string, revision: string, relative: string, options: ConnectionOptions = {}): Promise<Buffer> {
    const result = await this.request<{ data: string; hash: string }>('/v1/files', 'POST', { packId, revision, path: relative }, options), data = Buffer.from(result.data, 'base64')
    if (hash(data) !== result.hash) fail(uiText("collaboration.client.failedToVerifyTheIntegrityOfDownloaded")); return data
  }
}