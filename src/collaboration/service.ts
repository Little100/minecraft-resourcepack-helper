import { uiText } from '../i18n/messages'
import { TODO_RESOURCE, parseTodoBytes } from '../core/todos'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import lockfile from 'proper-lockfile'
import { z } from 'zod'
import { scanForPacks } from '../core/packScanner'
import { assertLayout, assertManifest, assertDiskLayout, rollbackResource, type WriteReceipt, atomic, exists, hash, now, Objects, sameFiles, scanFiles, secret, secureEqual, writeResource } from './files'
import { History } from './history'
import { configSchema, fail, reviewSchema, submitSchema, type Actor, type Identity, type Manifest, type Member, type Pack, type Proposal, type ServerConfig, type ServerState } from './types'

type Journal = { packId: string; afterRevision: string; before: Manifest; after: Manifest; paths: string[]; receipts?: Record<string, WriteReceipt> }
export class CollaborationService {
  readonly objects: Objects
  config!: ServerConfig
  state!: ServerState
  private unlock?: () => Promise<void>
  private tail = Promise.resolve()
  private stopped = false
  constructor(readonly directory: string) { this.objects = new Objects(path.join(directory, 'objects')) }
  static async initialize(directory: string, input: { root: string; ownerId: string; ownerLogin?: string; host?: string; port?: number; queryMode?: ServerConfig['queryMode']; queryProxy?: string }): Promise<void> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    if (await exists(path.join(directory, 'config.json'))) fail(uiText("collaboration.service.serviceHasBeenInitialisedAndOverwriteConfiguration"))
    const root = await fs.realpath(input.root), relativeState = path.relative(root, path.resolve(directory))
    if (!relativeState.startsWith('..') && !path.isAbsolute(relativeState)) fail(uiText("collaboration.service.serviceLevelPrivateStatusDirectoriesMustBe"))
    const config = configSchema.parse({ ...input, root, version: 1, serverId: randomUUID(), connectionKey: secret(), localControlKey: randomBytes(32).toString('hex'), epoch: 1, limits: {} })
    await atomic(path.join(directory, 'config.json'), JSON.stringify(config, null, 2))
  }
  async open(): Promise<void> {
    this.config = configSchema.parse(JSON.parse(await fs.readFile(path.join(this.directory, 'config.json'), 'utf8')))
    this.unlock = await lockfile.lock(this.directory, { realpath: true, stale: 30000, update: 10000, onCompromised: () => { this.stopped = true } })
    try {
      const file = path.join(this.directory, 'state.json')
      this.state = await exists(file) ? JSON.parse(await fs.readFile(file, 'utf8')) as ServerState : { version: 1, packs: [], members: [], proposals: [], audit: [] }
      if (this.state.version !== 1 || !Array.isArray(this.state.packs) || !Array.isArray(this.state.members) || !Array.isArray(this.state.proposals)) fail(uiText("collaboration.service.serviceStateFileInvalid"), 500)
      for (const pack of this.state.packs) await this.history(pack.id).initialize()
      await this.recover(); await this.discover()
    } catch (error) { await this.close(); throw error }
  }
  async close(): Promise<void> { this.stopped = true; await this.tail; const unlock = this.unlock; this.unlock = undefined; if (unlock) await unlock() }
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    const work = this.tail.then(() => { if (this.stopped) fail(uiText("collaboration.service.serviceEndStoppedOrStatusLockFailed"), 503); return task() })
    this.tail = work.then(() => {}, () => {}); return work
  }
  owner(): Actor { return { id: this.config.ownerId, login: this.config.ownerLogin, local: true } }
  role(actor: Identity): 'owner' | 'reviewer' | 'member' {
    if (actor.id === this.config.ownerId) return 'owner'
    const member = this.state.members.find(value => value.id === actor.id)
    if (!member || member.status !== 'active') fail(uiText("collaboration.service.memberHasNotYetRatifiedRemovedOr"), 403)
    return member.role
  }
  private requireOwner(actor: Identity): void { if (this.role(actor) !== 'owner') fail(uiText("collaboration.server.onlySuperadministersCanPerformThisOperation"), 403) }
  private audit(actor: Identity, action: string, subject: string): void { this.state.audit.push({ at: now(), actor: { id: actor.id, login: actor.login }, action, subject }) }
  private async save(): Promise<void> { try { await atomic(path.join(this.directory, 'state.json'), JSON.stringify(this.state)) } catch (error) { this.stopped = true; throw error } }
  private async saveConfig(): Promise<void> { await atomic(path.join(this.directory, 'config.json'), JSON.stringify(this.config, null, 2)) }
  history(packId: string): History { return new History(path.join(this.directory, 'history', packId + '.git'), this.objects, path.join(this.directory, 'manifests', packId)) }
  pack(id: string): Pack { return this.state.packs.find(value => value.id === id) ?? fail(uiText("collaboration.service.resourcePackDoesNotExist"), 404) }
  packRoot(pack: Pack): string {
    const target = path.resolve(this.config.root, pack.relative), relative = path.relative(this.config.root, target)
    if (relative.startsWith('..') || path.isAbsolute(relative)) fail(uiText("collaboration.service.theResourcePackCatalogueIsBeyondThe"), 500)
    return target
  }
  async discover(): Promise<void> {
    const result = await scanForPacks({ roots: [this.config.root], depth: this.config.scanDepth, limit: 256 })
    for (const candidate of result.packs) {
      const relative = path.relative(this.config.root, candidate.root), id = hash(relative || '.').slice(0, 24)
      if (this.state.packs.some(pack => pack.id === id)) continue
      const history = this.history(id); await history.initialize()
      const files = await scanFiles(candidate.root, this.objects, this.config.limits)
      const revision = await history.commit(files, undefined, this.owner(), uiText("collaboration.service.identificationResourceKit", candidate.name))
      this.state.packs.push({ id, relative, name: candidate.name, revision, files }); this.audit(this.owner(), 'discover', id)
    }
    await this.save()
  }
  async refresh(pack: Pack): Promise<void> {
    const files = await scanFiles(this.packRoot(pack), this.objects, this.config.limits)
    if (sameFiles(files, pack.files)) return
    pack.revision = await this.history(pack.id).commit(files, pack.revision, this.owner(), uiText("collaboration.service.serviceLocalDirectoryUpdate"))
    pack.files = files; this.audit(this.owner(), 'upstream-local-update', pack.id); await this.save()
  }
  async join(identity: Identity): Promise<{ status: string; role: string }> {
    if (identity.id === this.config.ownerId) return { status: 'active', role: 'owner' }
    let member = this.state.members.find(value => value.id === identity.id)
    if (member?.status === 'banned') fail(uiText("collaboration.service.thisAccountNumberHasBeenBannedFrom"), 403)
    if (!member || member.status === 'removed') {
      if (!member) { member = { ...identity, role: 'member', status: 'pending', joinedAt: now() }; this.state.members.push(member) }
      member.status = this.config.autoJoin ? 'active' : 'pending'; member.role = 'member'; delete member.review
      this.audit(identity, 'join-request', identity.id)
    }
    member.login = identity.login; await this.save(); return { status: member.status, role: member.role }
  }
  async member(actor: Identity, id: string, update: { status?: Member['status']; role?: Member['role']; review?: boolean | null }): Promise<void> {
    this.requireOwner(actor); if (id === this.config.ownerId) fail(uiText("collaboration.service.theOnlySupermanCanTChangeThrough"))
    const target = this.state.members.find(value => value.id === id) ?? fail(uiText("collaboration.service.memberDoesNotExist"), 404)
    if (update.status) target.status = update.status
    if (update.role) target.role = update.role
    if (update.review === null) delete target.review; else if (update.review !== undefined) target.review = update.review
    this.audit(actor, 'member-update', id + ':' + JSON.stringify(update)); await this.save()
  }
  async settings(actor: Identity, input: unknown): Promise<void> {
    this.requireOwner(actor)
    const update = z.object({ autoJoin: z.boolean().optional(), reviewDefault: z.boolean().optional(), queryMode: z.enum(['github', 'proxy', 'auto']).optional(), queryProxy: z.url().nullable().optional(), pollSeconds: z.number().int().min(5).max(3600).optional(), limits: configSchema.shape.limits.optional(), p2p: configSchema.shape.p2p.nullable().optional() }).strict().parse(input)
    const next = { ...this.config, ...update, queryProxy: update.queryProxy === null ? undefined : update.queryProxy ?? this.config.queryProxy, p2p: update.p2p === null ? undefined : update.p2p ?? this.config.p2p }
    if (next.queryProxy) { const url = new URL(next.queryProxy); if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) fail(uiText("collaboration.service.fullHttpsEndpointForSearchAgentsWithout")) }
    if (next.queryMode !== 'github' && !next.queryProxy) fail(uiText("collaboration.service.cannotInitialiseEvolutionSMailComponent"))
    this.config = configSchema.parse(next); this.audit(actor, 'settings-update', Object.keys(update).join(',')); await this.saveConfig(); await this.save()
  }
  async rotate(actor: Identity): Promise<void> {
    this.requireOwner(actor); this.config.connectionKey = secret(); this.config.epoch++
    if (this.config.p2p) this.config.p2p.node = 'mcrh-' + randomBytes(16).toString('base64url')
    await this.saveConfig(); this.audit(actor, 'rotate-connection', String(this.config.epoch)); await this.save()
  }
  connectionKeyValid(key: string): boolean { return secureEqual(key, this.config.connectionKey) }
  async submit(actor: Identity, input: unknown): Promise<Proposal> {
    if (this.role(actor) === 'reviewer') fail(uiText("collaboration.server.managerRoleOnlyAllowedReviewNotSubmitted"), 403)
    const request = submitSchema.parse(input), pack = this.pack(request.packId)
    await this.refresh(pack)
    if (this.state.proposals.filter(value => value.author.id === actor.id && value.changes.some(change => change.decision === 'pending')).length >= 100) fail(uiText("collaboration.service.tooManyPendingSubmissionsPleaseTryAgain"), 429)
    const base = await this.version(actor, pack.id, request.baseRevision), next: Manifest = { ...base }, seen = new Set<string>(); let bytes = 0
    const changes: Proposal['changes'] = []
    for (const change of request.changes) {
      const { resourcePath } = await import('./files'); resourcePath(change.path)
      const folded = change.path.toLowerCase(); if (seen.has(folded)) fail(uiText("collaboration.service.submitAPathThatContainsRepetitionOr")); seen.add(folded)
      if ((base[change.path]?.hash ?? null) !== change.base) fail(uiText("collaboration.service.theSubmittedBaselineDoesNotMatchThe"), 409)
      let entry = null
      if (change.data !== null) {
        if (change.data.length > Math.ceil(this.config.limits.fileBytes / 3) * 4) fail(uiText("collaboration.service.submissionOfFilesExceedingTheLimit"), 413)
        const data = Buffer.from(change.data, 'base64')
        if (data.toString('base64') !== change.data) fail(uiText("collaboration.service.fileEncodingInvalid"))
        bytes += data.length; if (data.length > this.config.limits.fileBytes || bytes > this.config.limits.submissionBytes) fail(uiText("collaboration.service.submitExceedingTheConfiguredSizeLimit"), 413)
        if (change.path === TODO_RESOURCE) parseTodoBytes(data)
        entry = { hash: await this.objects.put(data), size: data.length }; next[change.path] = entry
      } else delete next[change.path]
      if ((entry?.hash ?? null) === change.base) fail(uiText("collaboration.service.submissionOfDocumentContainingNoChange"))
      changes.push({ path: change.path, base: change.base, next: entry, decision: 'pending' })
    }
    if (Object.keys(next).length > this.config.limits.files || Object.values(next).reduce((sum, file) => sum + file.size, 0) > this.config.limits.packBytes) fail(uiText("collaboration.service.resourcePacksAfterSubmissionExceededTheLimit"), 413)
    const keys = Object.keys(next).map(name => name.toLowerCase()); if (new Set(keys).size !== keys.length) fail(uiText("collaboration.service.thereIsACasePathConflictIn"))
    const id = randomUUID(), commit = await this.history(pack.id).commit(next, request.baseRevision, actor, request.title, 'refs/mcrh/proposals/' + id)
    const proposal: Proposal = { id, packId: pack.id, author: { id: actor.id, login: actor.login }, title: request.title, createdAt: now(), baseRevision: request.baseRevision, commit, changes }
    this.state.proposals.push(proposal); this.audit(actor, 'submit', id); await this.save()
    const member = this.state.members.find(value => value.id === actor.id), review = member?.review ?? this.config.reviewDefault
    if (!review) { try { await this.review(actor, id, { paths: changes.map(change => change.path), decision: 'approved', comment: uiText("collaboration.service.superadministratorSSetUpWaiverRule") }, true) } catch (error) { if (!(error instanceof Error && 'statusCode' in error && error.statusCode === 409)) throw error; this.audit(actor, 'exemption-conflict-pending', id); await this.save() } }
    return proposal
  }
  async review(actor: Identity, id: string, input: unknown, exemption = false): Promise<void> {
    const role = this.role(actor), request = reviewSchema.parse(input), proposal = this.proposal(actor, id)
    if (!exemption && role !== 'owner' && role !== 'reviewer') fail(uiText("collaboration.server.noAuthorityToReview"), 403)
    if (!exemption && proposal.author.id === actor.id) fail(uiText("collaboration.service.canTReviewYourOwnSubmissionPlease"), 403)
    const unique = new Set(request.paths); if (unique.size !== request.paths.length) fail(uiText("collaboration.service.reviewPathDuplicated"))
    const selected = request.paths.map(name => proposal.changes.find(change => change.path === name && change.decision === 'pending') ?? fail(uiText("collaboration.service.documentsNotPending")))
    const pack = this.pack(proposal.packId); await this.refresh(pack)
    if (request.decision === 'approved') {
      const conflicts = selected.filter(change => (pack.files[change.path]?.hash ?? null) !== change.base)
      if (conflicts.length) fail(uiText("collaboration.service.theOfficialVersionHasBeenChangedAnd", conflicts.map(change => change.path).join('、')), 409)
      const after = { ...pack.files }
      for (const change of selected) { if (change.next) after[change.path] = change.next; else delete after[change.path] }
      const folded = Object.keys(after).map(name => name.toLowerCase()); if (new Set(folded).size !== folded.length) fail(uiText("collaboration.service.thereIsACasePathConflictAfter"), 409)
      assertManifest(after, this.config.limits); assertLayout(pack.files, after); await assertDiskLayout(this.packRoot(pack), selected.map(change => change.path))
      const history = this.history(pack.id), revision = await history.commit(after, pack.revision, proposal.author, uiText("collaboration.service.ratificationReviewer", proposal.title, actor.login), 'refs/mcrh/staging')
      const journal: Journal = { packId: pack.id, before: pack.files, after, afterRevision: revision, paths: selected.map(change => change.path), receipts: {} }
      await atomic(path.join(this.directory, 'transaction.json'), JSON.stringify(journal))
      try {
        for (const change of selected) await writeResource(this.packRoot(pack), change.path, change.next ? await this.objects.get(change.next.hash) : null, { expected: journal.before[change.path]?.hash ?? null, objects: this.objects, record: async receipt => { journal.receipts![change.path] = receipt; await atomic(path.join(this.directory, 'transaction.json'), JSON.stringify(journal)) } })
        const actual = await scanFiles(this.packRoot(pack), this.objects, this.config.limits)
        if (!sameFiles(actual, after)) fail(uiText("collaboration.service.externalChangesInDirectoriesDuringApplicationSuspended"), 409)
        pack.files = after; pack.revision = revision
      } catch (error) { await this.recover(); throw error }
    }
    for (const change of selected) { change.decision = request.decision; change.reviewer = { id: actor.id, login: actor.login }; change.decidedAt = now(); change.comment = request.comment }
    this.audit(actor, 'review-' + request.decision, id + ':' + selected.length); await this.save()
    if (request.decision === 'approved') {
      try {
        await this.history(pack.id).promote(pack.revision)
        await fs.rm(path.join(this.directory, 'transaction.json'), { force: true })
      } catch (error) { this.stopped = true; throw error }
    }
  }
  proposal(actor: Identity, id: string): Proposal {
    const role = this.role(actor), proposal = this.state.proposals.find(value => value.id === id) ?? fail(uiText("cli.collaboration.submissionDoesNotExist"), 404)
    if (role === 'member' && proposal.author.id !== actor.id) fail(uiText("collaboration.service.onlySeeYourOwnSubmission"), 403)
    return proposal
  }
  async version(actor: Identity, packId: string, revision: string): Promise<Manifest> {
    const role = this.role(actor), pack = this.pack(packId), history = this.history(packId)
    const allowed = revision === pack.revision || this.state.proposals.some(proposal => proposal.packId === packId && (proposal.baseRevision === revision || proposal.commit === revision) && (role !== 'member' || proposal.author.id === actor.id))
    if (!allowed && !await history.isAncestor(pack.revision, revision)) fail(uiText("collaboration.service.noAccessRightsForThisVersion"), 403)
    return history.manifest(revision)
  }
  async file(actor: Identity, packId: string, revision: string, relative: string): Promise<Buffer | null> {
    const { resourcePath } = await import('./files'); resourcePath(relative)
    const files = await this.version(actor, packId, revision), entry = files[relative]
    return entry ? this.objects.get(entry.hash) : null
  }
  async recover(): Promise<void> {
    const file = path.join(this.directory, 'transaction.json'); if (!await exists(file)) return
    const journal = JSON.parse(await fs.readFile(file, 'utf8')) as Journal, pack = this.pack(journal.packId)
    if (pack.revision === journal.afterRevision) {
      await this.history(pack.id).promote(journal.afterRevision)
    } else {
      const errors: unknown[] = []
      for (const name of journal.paths.slice().reverse()) { try { const restored = await rollbackResource(this.packRoot(pack), name, journal.before[name] ? await this.objects.get(journal.before[name].hash) : null, journal.after[name]?.hash ?? null, journal.receipts?.[name], this.objects); if (!restored) this.audit(this.owner(), 'recovery-kept-external-change', name) } catch (error) { errors.push(error) } }
      if (errors.length) throw new AggregateError(errors, uiText("collaboration.service.partialPathRestorationFailedOriginalsRetainedIn"))
    }
    await fs.rm(file)
  }
}
