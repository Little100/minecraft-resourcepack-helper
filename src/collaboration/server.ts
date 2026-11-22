import { uiText } from '../i18n/messages'
import { refreshAutomaticP2P } from './p2pNetwork'
import { collaborationLog, type CollaborationLog } from './diagnostics'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { X509Certificate, randomBytes } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import selfsigned from 'selfsigned'
import { z, ZodError } from 'zod'
import { atomic, exists, hash, secureEqual } from './files'
import { githubIdentity, identityPolicy, identityPolicySchema, sameIdentityPolicy, type IdentityVerifier } from './identity'
import { OpenP2P, verifyOpenP2PExecutable } from './openp2p'
import { CollaborationService } from './service'
import { COLLABORATION_MAX_ACTIVE_SUBMISSIONS, COLLABORATION_REQUEST_TIMEOUT_MS, COLLABORATION_RECEIVE_IDLE_MS, COLLABORATION_RESPONSE_IDLE_MS, COLLABORATION_SESSION_BODY_BYTES, collaborationRequestLabel } from './httpPolicy'
import { CollaborationError, fail, githubIdSchema, idSchema, p2pSchema, type Actor, type Invitation, type ServerConfig } from './types'

type Session = { actor: Actor; epoch: number; expires: number }
export class CollaborationServer {
  app?: FastifyInstance
  onStop?: () => void
  readonly p2p: OpenP2P
  private readonly sessions = new Map<string, Session>()
  private certificate = ''
  private controlOnly = false
  private stopping = false
  private stopTask?: Promise<void>
  private p2pTail: Promise<void> = Promise.resolve()
  port = 0
  private readonly log: CollaborationLog
  constructor(readonly service: CollaborationService, private readonly verify: IdentityVerifier = githubIdentity, log?: CollaborationLog) { this.log = collaborationLog(log); this.p2p = new OpenP2P(path.join(service.directory, 'openp2p-server'), log) }
  async start(options?: { localControlOnly?: boolean }): Promise<void> {
    this.log('info', uiText("collaboration.server.collaborativeServiceEndPrepareHttpsServicesListening", this.service.config.host, this.service.config.port))
    if (this.stopping) fail(uiText("collaboration.server.serviceStoppedPleaseCreateNewServiceInstance"), 503)
    this.controlOnly = options?.localControlOnly === true
    await this.prepareP2P()
    if (this.stopping) fail(uiText("collaboration.server.serviceStartupCancelled"), 503)
    const certPath = path.join(this.service.directory, 'certificate.pem'), keyPath = path.join(this.service.directory, 'private-key.pem')
    if (!await exists(certPath) || !await exists(keyPath)) {
      const pair = await selfsigned.generate([{ name: 'commonName', value: 'MCRH Collaboration' }], { keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true }, { name: 'extKeyUsage', serverAuth: true }, { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, { type: 7, ip: '::1' }] }], notAfterDate: new Date(Date.now() + 5 * 365 * 86400000) })
      await atomic(certPath, pair.cert); await atomic(keyPath, pair.private)
    }
    this.certificate = await fs.readFile(certPath, 'utf8')
    const config = this.controlOnly ? { ...this.service.config, host: '127.0.0.1', port: 0 } : this.service.config
    const submissionBodyLimit = Math.ceil(config.limits.submissionBytes * 1.4) + 8 * 1024 ** 2
    const app = Fastify({ https: { cert: this.certificate, key: await fs.readFile(keyPath) }, logger: false, trustProxy: false, requestTimeout: COLLABORATION_REQUEST_TIMEOUT_MS, connectionTimeout: COLLABORATION_RECEIVE_IDLE_MS, keepAliveTimeout: 10000, maxRequestsPerSocket: 100 })
    if (this.stopping) { await app.close(); fail(uiText("collaboration.server.serviceStartupCancelled"), 503) }
    this.app = app
    const started = new WeakMap<FastifyRequest, number>()
    const submissions = new WeakMap<FastifyRequest, { processing: boolean; release(): void }>()
    let activeSubmissions = 0
    const tracked = new Set(['/v1/me', '/v1/packs', '/v1/proposals', '/v1/members'])
    app.addHook('onRequest', async (request, reply) => {
      started.set(request, Date.now())
      const label = collaborationRequestLabel(request.method, request.url)
      if (tracked.has(request.routeOptions.url ?? '')) this.log('info', uiText("collaboration.server.collaborationServiceEndRequestAction", label))
      reply.raw.once('close', () => { if (!reply.raw.writableFinished) this.log('warn', uiText("collaboration.server.collaborationServiceEndRequestConnectionClosedBefore", label, (Date.now() - (started.get(request) ?? Date.now())))) })
    })
    app.addHook('preParsing', async (request, reply, payload) => {
      const route = request.routeOptions.url
      if (!route || route === '/v1/session' || (request.method !== 'POST' && request.method !== 'PATCH')) return payload
      const role = this.service.role(this.actor(request))
      if (route === '/v1/proposals/:id/review' && role === 'member') fail(uiText("collaboration.server.noAuthorityToReview"), 403)
      if (route === '/v1/proposals') {
        if (role === 'reviewer') fail(uiText("collaboration.server.managerRoleOnlyAllowedReviewNotSubmitted"), 403)
        if (activeSubmissions >= COLLABORATION_MAX_ACTIVE_SUBMISSIONS) fail(uiText("collaboration.server.tooManySubmissionsToReceiveOrProcess"), 429)
        const slot = { processing: false, release: () => { if (submissions.delete(request)) activeSubmissions-- } }
        submissions.set(request, slot)
        activeSubmissions++
        reply.raw.once('close', () => { if (!slot.processing) slot.release() })
      }
      return payload
    })
    app.addHook('preHandler', async request => {
      // 收到完整请求后按响应时限等待扫描
      request.raw.setTimeout(COLLABORATION_RESPONSE_IDLE_MS)
    })
    app.addHook('onResponse', async (request, reply) => {
      submissions.get(request)?.release()
      const elapsed = Date.now() - (started.get(request) ?? Date.now())
      if (tracked.has(request.routeOptions.url ?? '') || elapsed >= 1000 || reply.statusCode >= 400) this.log(reply.statusCode >= 400 ? 'warn' : 'info', uiText("collaboration.server.collaborationServiceEndRequestDoneHttpTime", collaborationRequestLabel(request.method, request.url), reply.statusCode, elapsed))
    })
    app.addHook('onTimeout', async request => { this.log('warn', uiText("collaboration.server.collaborationServiceEndRequestSocketFreeTime", collaborationRequestLabel(request.method, request.url), (Date.now() - (started.get(request) ?? Date.now())))) })
    await app.register(rateLimit, { max: config.limits.requestsPerMinute, timeWindow: 60000 })
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof CollaborationError) void reply.code(error.statusCode).send({ error: error.message })
      else if (error instanceof ZodError) void reply.code(400).send({ error: uiText("collaboration.server.requestFieldIsInvalid", error.issues.map(issue => issue.path.join('.')).slice(0, 8).join('、')) })
      else { const status = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500; void reply.code(status).send({ error: status === 413 ? uiText("collaboration.server.requestExceedingServiceEndLimit") : status === 429 ? uiText("collaboration.server.requestsAreTooFrequentPleaseTryAgain") : uiText("collaboration.server.serviceEndOperationFailedCheckYourCurrent") }) }
    })
    app.addHook('onSend', async (_request, reply) => { reply.header('cache-control', 'no-store'); reply.header('x-content-type-options', 'nosniff') })
    app.get('/v1/hello', async () => ({ protocol: 1, serverId: config.serverId, authentication: 'github', ...identityPolicy(this.service.config), serverControlledIdentity: true }))
    app.post('/v1/session', { bodyLimit: COLLABORATION_SESSION_BODY_BYTES, config: { rateLimit: { max: config.limits.loginRequestsPerMinute, timeWindow: 60000 } } }, async request => {
      const body = z.object({ connectionKey: z.string().max(200), accessToken: z.string().max(2048), queryMode: z.enum(['github', 'proxy', 'auto']).optional(), identityPolicy: identityPolicySchema.optional() }).strict().parse(request.body)
      if (!this.service.connectionKeyValid(body.connectionKey)) fail(uiText("collaboration.server.incorrectOrResetConnection"), 401)
      const epoch = this.service.config.epoch
      const queryConfig = { ...this.service.config }, policy = identityPolicy(queryConfig)
      if (body.identityPolicy && !sameIdentityPolicy(body.identityPolicy, policy)) fail(uiText("collaboration.server.serviceEndIdentityQuerySettingsChangedReconnect"), 409)
      if (!body.identityPolicy && policy.queryMode !== 'github') fail(uiText("collaboration.server.useMirrorIdentityCheckForThisService"), 409)
      const identity = await this.verify(body.accessToken, queryConfig)
      return this.service.exclusive(async () => { if (request.routeOptions.url !== '/v1/session') this.actor(request);
        if (!sameIdentityPolicy(policy, identityPolicy(this.service.config))) fail(uiText("collaboration.server.serviceEndIdentityQuerySettingsChangedReconnect"), 409)
        if (epoch !== this.service.config.epoch || !this.service.connectionKeyValid(body.connectionKey)) fail(uiText("collaboration.server.connectionCertificateChangedPleaseReconnect"), 401)
        for (const [key, session] of this.sessions) if (session.expires < Date.now()) this.sessions.delete(key)
        if (this.sessions.size >= 4096) fail(uiText("collaboration.server.theNumberOfSessionsReachedTheMaximum"), 503)
        const membership = await this.service.join(identity), token = randomBytes(32).toString('hex'), expires = Date.now() + this.service.config.sessionMinutes * 60000
        this.sessions.set(hash(token), { actor: identity, epoch, expires }); return { token, expires, identity, ...membership }
      })
    })
    app.get('/v1/me', async request => { const actor = this.actor(request, true); return { identity: { id: actor.id, login: actor.login }, role: actor.id === this.service.config.ownerId ? 'owner' : this.service.state.members.find(member => member.id === actor.id)?.role ?? 'member', status: actor.id === this.service.config.ownerId ? 'active' : this.service.state.members.find(member => member.id === actor.id)?.status ?? 'removed', pollSeconds: this.service.config.pollSeconds } })
    // 列表用已提交的版本，读取清单或同步时才扫描文件
    app.get('/v1/packs', async request => { this.actor(request); return this.service.state.packs.map(({ files: _files, relative: _relative, ...pack }) => pack) })
    app.get('/v1/packs/:id/manifest', async request => { this.actor(request); const id = idSchema.parse((request.params as { id: string }).id); return this.service.exclusive(async () => { if (request.routeOptions.url !== '/v1/session') this.actor(request); const pack = this.service.pack(id); await this.service.refresh(pack); return { id, revision: pack.revision, files: pack.files, limits: this.service.config.limits } }) })
    app.post('/v1/files', async (request, reply) => { const actor = this.actor(request), body = z.object({ packId: idSchema, revision: z.string().regex(/^[a-f0-9]{40}$/), path: z.string().max(1024) }).strict().parse(request.body); return this.service.exclusive(async () => { if (request.routeOptions.url !== '/v1/session') this.actor(request); const data = await this.service.file(actor, body.packId, body.revision, body.path); if (!data) return reply.code(404).send({ error: uiText("collaboration.server.noSuchDocumentExistsInThisVersion") }); return { data: data.toString('base64'), hash: hash(data) } }) })
    app.post('/v1/versions', async request => { this.actor(request); const body = z.object({ packId: idSchema, revision: z.string().regex(/^[a-f0-9]{40}$/) }).strict().parse(request.body); return this.service.exclusive(() => this.service.version(this.actor(request), body.packId, body.revision)) })
    app.get('/v1/proposals', async request => { const actor = this.actor(request), role = this.service.role(actor); return this.service.state.proposals.filter(proposal => role !== 'member' || proposal.author.id === actor.id) })
    app.post('/v1/proposals', { bodyLimit: submissionBodyLimit }, async request => {
      const slot = submissions.get(request) ?? fail(uiText("collaboration.server.submitConnectionClosedPleaseTryAgain"), 409)
      slot.processing = true
      try { return await this.service.exclusive(() => this.service.submit(this.actor(request), request.body)) }
      finally { slot.release() }
    })
    app.post('/v1/proposals/:id/review', { bodyLimit: submissionBodyLimit }, async request => { const actor = this.actor(request), id = idSchema.parse((request.params as { id: string }).id); return this.service.exclusive(async () => { if (request.routeOptions.url !== '/v1/session') this.actor(request); await this.service.review(actor, id, request.body); return { ok: true } }) })
    app.get('/v1/members', async request => { this.owner(request); return this.service.state.members })
    app.patch('/v1/members/:id', async request => { const actor = this.owner(request), id = githubIdSchema.parse((request.params as { id: string }).id), body = z.object({ status: z.enum(['pending', 'active', 'removed', 'banned']).optional(), role: z.enum(['member', 'reviewer']).optional(), review: z.boolean().nullable().optional() }).strict().parse(request.body); return this.service.exclusive(async () => { if (request.routeOptions.url !== '/v1/session') this.actor(request); await this.service.member(actor, id, body); if (body.status === 'banned' || body.status === 'removed') for (const [key, session] of this.sessions) if (session.actor.id === id) this.sessions.delete(key); return { ok: true } }) })
    app.get('/v1/settings', async request => { this.owner(request); return this.publicSettings() })
    app.patch('/v1/settings', async request => { const actor = this.owner(request); return this.service.exclusive(async () => { if (request.routeOptions.url !== '/v1/session') this.actor(request); if (request.body && typeof request.body === 'object' && 'p2p' in request.body) fail(uiText("collaboration.server.p2pProgramConfigurationPleaseUseServerHome"), 403); await this.service.settings(actor, request.body); return { ok: true } }) })
    app.get('/v1/audit', async request => { this.owner(request); return this.service.state.audit })
    app.post('/v1/discover', async request => { this.owner(request); return this.service.exclusive(async () => { if (request.routeOptions.url !== '/v1/session') this.actor(request); await this.service.discover(); return { ok: true } }) })
    app.post('/v1/local/rotate', async request => { this.local(request); return this.service.exclusive(async () => { if (request.routeOptions.url !== '/v1/session') this.actor(request); await this.rotateConnection(); return { ok: true } }) })
    app.post('/v1/local/stop', async (request, reply) => { this.local(request); if (!this.onStop) fail(uiText("collaboration.server.thisIsNotAnIndependentFrontOffice")); reply.raw.once('finish', () => this.onStop?.()); return { ok: true } })
    app.get('/v1/local/invitation', async request => { this.local(request); return this.invitation(undefined, true) })
    app.post('/v1/local/invitation', async request => {
      this.local(request)
      const body = z.object({ url: z.url().max(2048).refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' }, uiText("collaboration.client.connectionAddressesMustBeANoPath")) }).strict().parse(request.body)
      return this.invitation(body.url, true)
    })
    app.post('/v1/local/p2p', async request => { this.local(request); const body = z.object({ p2p: p2pSchema.nullable() }).strict().parse(request.body); if (body.p2p) await verifyOpenP2PExecutable(body.p2p.executable); return this.service.exclusive(async () => { if (request.routeOptions.url !== '/v1/session') this.actor(request); await this.service.settings(this.service.owner(), body); await this.restartP2P(); return { ok: true } }) })
    if (this.stopping) fail(uiText("collaboration.server.serviceStartupCancelled"), 503)
    await app.listen({ port: config.port, host: config.host }); const address = app.server.address(); this.port = typeof address === 'object' && address ? address.port : config.port
    await atomic(path.join(this.service.directory, 'runtime.json'), JSON.stringify({ port: this.port, url: this.localUrl(), fingerprint: this.fingerprint(), serverId: config.serverId }))
    if (this.stopping) { await fs.rm(path.join(this.service.directory, 'runtime.json'), { force: true }); fail(uiText("collaboration.server.serviceStartupCancelled"), 503) }
    try { await this.restartP2P(false); this.log('info', uiText("collaboration.server.coordinationServiceEndHttpsIsListeningPort", this.port, this.service.state.packs.length)) } catch (error) { this.log('error', uiText("collaboration.server.coordinationServiceEndP2pStartupFailed", (error instanceof Error ? error.message : uiText("collaboration.server.unknownError")))); await this.stop(); throw error }
  }
  private actor(request: FastifyRequest, pending = false): Actor {
    const local = request.headers['x-mcrh-local']
    if (typeof local === 'string' && secureEqual(local, this.service.config.localControlKey) && ['127.0.0.1', '::1', '::ffff:127.0.0.1', ...Object.values(os.networkInterfaces()).flatMap(items => (items ?? []).flatMap(item => [item.address, '::ffff:' + item.address]))].includes(request.ip)) return this.service.owner()
    const authorization = request.headers.authorization
    if (!authorization?.startsWith('Bearer ')) fail(uiText("collaboration.server.createACollaborationSessionFirst"), 401)
    const session = this.sessions.get(hash(authorization.slice(7)))
    if (!session || session.epoch !== this.service.config.epoch || session.expires < Date.now()) fail(uiText("collaboration.server.sessionIsInvalidPleaseReconnect"), 401)
    const member = this.service.state.members.find(value => value.id === session.actor.id)
    if (session.actor.id !== this.service.config.ownerId && (!member || member.status === 'banned' || member.status === 'removed')) fail(uiText("collaboration.server.membersRemovedOrBanned"), 403)
    if (!pending) this.service.role(session.actor)
    return session.actor
  }
  private owner(request: FastifyRequest): Actor { const actor = this.actor(request); if (this.service.role(actor) !== 'owner') fail(uiText("collaboration.server.onlySuperadministersCanPerformThisOperation"), 403); return actor }
  private local(request: FastifyRequest): void { const actor = this.actor(request); if (!actor.local) fail(uiText("collaboration.server.thisOperationRequiresTheServerSOwn"), 403) }
  publicSettings(): Omit<ServerConfig, 'connectionKey' | 'localControlKey' | 'root' | 'p2p'> { const { connectionKey: _a, localControlKey: _b, root: _c, p2p: _d, ...settings } = this.service.config; return settings }
  fingerprint(): string { return hash(new X509Certificate(this.certificate).raw) }
  localUrl(): string { const host = this.controlOnly ? '127.0.0.1' : this.service.config.host === '0.0.0.0' ? '127.0.0.1' : this.service.config.host === '::' ? '::1' : this.service.config.host; return 'https://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + this.port }
  invitation(url?: string, sharing = false): Invitation { const p2p = url ? undefined : this.service.config.p2p; const port = p2p && sharing && this.controlOnly ? this.service.config.port : this.port; if (p2p && sharing && !this.p2p.node) fail(uiText("collaboration.server.pleaseStartTheP2pServerBeforeSharing")); if (p2p && !port) fail(uiText("collaboration.server.p2pInvitationRequiresAFixedCollaborationPort")); return { version: 1, serverId: this.service.config.serverId, url: url ?? (p2p ? 'https://127.0.0.1:' + port : this.localUrl()), fingerprint: this.fingerprint(), key: this.service.config.connectionKey, node: p2p ? this.p2p.node ?? p2p.node : undefined, p2p: p2p ? { token: p2p.token, port, ...(p2p.serverHost ? { serverHost: p2p.serverHost } : {}), ...(p2p.serverPort ? { serverPort: p2p.serverPort } : {}) } : undefined } }
  private async prepareP2P(): Promise<void> {
    const config = this.service.config.p2p
    if (this.stopping || this.controlOnly || !config?.presetUrl) return
    this.log('info', uiText("collaboration.server.coordinationP2pCheckAutomaticCoordinationNodesConfiguration"))
    const next = await refreshAutomaticP2P(this.service.directory, config)
    if (this.stopping) return
    if (JSON.stringify(next) !== JSON.stringify(config)) await this.service.settings(this.service.owner(), { p2p: next })
    this.log('info', uiText("collaboration.server.coordinationP2pCoordinateNodeConfigurationAvailable"))
  }
  private async rotateConnection(): Promise<void> {
    await this.prepareP2P()
    if (this.stopping) fail(uiText("collaboration.server.serviceIsBeingStoppedNoRotationOf"), 503)
    try { await this.service.rotate(this.service.owner()); this.sessions.clear(); await this.restartP2P(false) }
    catch (error) { await this.p2pTail; await this.p2p.stop(); throw error }
  }
  restartP2P(refresh = true): Promise<void> {
    const operation = this.p2pTail.then(async () => {
      if (this.stopping) return
      if (refresh) await this.prepareP2P()
      if (this.stopping) return
      await this.p2p.stop()
      if (this.stopping) return
      if (!this.controlOnly && this.service.config.p2p) await this.p2p.start(this.service.config.p2p, this.port)
      if (this.stopping) await this.p2p.stop()
    })
    this.p2pTail = operation.catch(() => {})
    return operation
  }
  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask
    this.stopping = true
    this.stopTask = this.stopResources()
    return this.stopTask
  }
  private async stopResources(): Promise<void> {
    const app = this.app
    this.app = undefined
    const results = await Promise.allSettled([app?.close(), this.p2pTail])
    try { await this.p2p.stop() }
    finally { this.sessions.clear(); await fs.rm(path.join(this.service.directory, 'runtime.json'), { force: true }) }
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
}
