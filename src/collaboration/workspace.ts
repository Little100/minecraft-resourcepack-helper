import { uiText } from '../i18n/messages'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import lockfile from 'proper-lockfile'
import { assertLayout, assertManifest, assertDiskLayout, rollbackResource, type WriteReceipt, atomic, exists, hash, Objects, resourcePath, scanFiles, writeResource } from './files'
import { History } from './history'
import { RemoteClient } from './client'
import { configSchema, fail, hashSchema, type FileEntry, type Manifest, type Proposal, type ServerConfig } from './types'

export type SyncOptions = { signal?: AbortSignal; onProgress?: (completed: number, total: number) => void }
type Conflict = { path: string; incoming: FileEntry | null; incomingPath?: string }
type WorkspaceState = { version: 1; lastSyncId?: string; serverId: string; packId: string; revision: string; files: Manifest; conflicts: Conflict[]; limits: ServerConfig['limits'] }
type Operation = { path: string; before: FileEntry | null; after: FileEntry | null; receipt?: WriteReceipt }
type Transaction = { id: string; operations: Operation[] }
const index = (files: Manifest): Map<string, { path: string; entry: FileEntry }> => new Map(Object.entries(files).map(([name, entry]) => [name.toLowerCase(), { path: name, entry }]))
function align(files: Manifest, reference: Manifest): Manifest { const names = index(reference), result: Manifest = Object.create(null); for (const [name, entry] of Object.entries(files)) result[names.get(name.toLowerCase())?.path ?? name] = entry; return result }
export class LocalWorkspace {
  readonly objects: Objects
  private state?: WorkspaceState
  constructor(readonly root: string, readonly directory: string, readonly client: RemoteClient) { this.objects = new Objects(path.join(directory, 'objects')) }
  async load(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true })
    await this.withWorkspaceLock(async () => this.history().initialize())
  }
  private async withWorkspaceLock<T>(operation: (lease: AbortSignal) => Promise<T>): Promise<T> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const lease = new AbortController()
    const release = await lockfile.lock(this.directory, {
      stale: 30000,
      update: 10000,
      onCompromised: () => lease.abort(new Error(uiText("collaboration.workspace.taskCopyLockIsDisabledPleaseReload")))
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ELOCKED') fail(uiText("collaboration.workspace.aCopyOfTheTaskIsBeing"), 409)
      throw error
    })
    try {
      await this.loadState(lease.signal)
      lease.signal.throwIfAborted()
      return await operation(lease.signal)
    } finally {
      if (!lease.signal.aborted) await release()
    }
  }
  private async loadState(lease: AbortSignal): Promise<void> {
    const metadata = path.join(this.directory, 'workspace.json')
    const state = await exists(metadata) ? JSON.parse(await fs.readFile(metadata, 'utf8')) as WorkspaceState : undefined
    if (state && state.serverId !== this.client.invitation.serverId) fail(uiText("collaboration.workspace.aCopyOfThisTaskBelongsTo"))
    this.state = state
    const journal = path.join(this.directory, 'sync-transaction.json')
    if (await exists(journal)) {
      const transaction = JSON.parse(await fs.readFile(journal, 'utf8')) as Transaction
      if (this.state?.lastSyncId !== transaction.id) {
        const errors: unknown[] = []
        for (const operation of transaction.operations.slice().reverse()) {
          lease.throwIfAborted()
          try { await rollbackResource(this.root, operation.path, operation.before ? await this.objects.get(operation.before.hash) : null, operation.after?.hash ?? null, operation.receipt, this.objects) }
          catch (error) { errors.push(error) }
        }
        if (errors.length) throw new AggregateError(errors, uiText("collaboration.service.partialPathRestorationFailedOriginalsRetainedIn"))
      }
      lease.throwIfAborted()
      await fs.rm(journal)
    }
  }
  private history(): History { return new History(path.join(this.directory, 'history.git'), this.objects, path.join(this.directory, 'manifests')) }
  private async save(next: WorkspaceState, lease: AbortSignal): Promise<void> {
    lease.throwIfAborted()
    await atomic(path.join(this.directory, 'workspace.json'), JSON.stringify(next))
    this.state = next
  }
  private operations(local: Manifest, currentPath: string | undefined, targetPath: string, result: FileEntry | null): Operation[] {
    const current = currentPath ? local[currentPath] : undefined
    if (currentPath && currentPath !== targetPath && process.platform !== 'win32') return [{ path: currentPath, before: current ?? null, after: null }, ...(result ? [{ path: targetPath, before: null, after: result }] : [])]
    if ((current?.hash ?? null) === (result?.hash ?? null) && (!currentPath || currentPath === targetPath)) return []
    return [{ path: targetPath, before: current ?? null, after: result }]
  }
  private async apply(local: Manifest, operations: Operation[], next: WorkspaceState, lease: AbortSignal): Promise<void> {
    const resulting = { ...local }
    for (const operation of operations) { for (const name of Object.keys(resulting)) if (name.toLowerCase() === operation.path.toLowerCase()) delete resulting[name]; if (operation.after) resulting[operation.path] = operation.after }
    assertManifest(resulting, next.limits); assertLayout(local, resulting); await assertDiskLayout(this.root, operations.map(operation => operation.path))
    lease.throwIfAborted()
    await this.history().commit(local, undefined, { id: 'local', login: 'local-backup' }, uiText("collaboration.workspace.restoreLocalSnapshotsBeforeWriting"), 'refs/heads/backups')
    const transaction: Transaction = { id: randomUUID(), operations }, journal = path.join(this.directory, 'sync-transaction.json')
    lease.throwIfAborted()
    await atomic(journal, JSON.stringify(transaction))
    try {
      for (const operation of operations) {
        const data = operation.after ? await this.objects.get(operation.after.hash) : null
        lease.throwIfAborted()
        await writeResource(this.root, operation.path, data, {
          expected: operation.before?.hash ?? null,
          objects: this.objects,
          record: async receipt => {
            lease.throwIfAborted()
            operation.receipt = receipt
            await atomic(journal, JSON.stringify(transaction))
          }
        })
      }
      await this.save({ ...next, lastSyncId: transaction.id }, lease)
      lease.throwIfAborted()
      await fs.rm(journal)
    } catch (error) {
      if (!lease.aborted) await this.loadState(lease)
      throw error
    }
  }
  async sync(packId: string, options: SyncOptions = {}): Promise<{ updated: number; conflicts: Conflict[]; revision: string }> {
    options.signal?.throwIfAborted()
    return this.withWorkspaceLock(lease => this.syncLocked(packId, options, lease))
  }
  private async syncLocked(packId: string, options: SyncOptions, lease: AbortSignal) {
    const signal = options.signal ? AbortSignal.any([options.signal, lease]) : lease
    signal.throwIfAborted()
    if (this.state && this.state.packId !== packId) fail(uiText("collaboration.workspace.aCopyOfTheWorkHasBeen"))
    const response = await this.client.request<{ revision: string; files: Manifest; limits: ServerConfig['limits'] }>('/v1/packs/' + packId + '/manifest', 'GET', undefined, { signal })
    if (!/^[a-f0-9]{40}$/.test(response.revision)) fail(uiText("collaboration.workspace.upstreamVersionInvalid"))
    const limits = configSchema.shape.limits.parse(response.limits), files = z.record(z.string(), z.object({ hash: hashSchema, size: z.number().int().min(0) })).parse(response.files)
    for (const name of Object.keys(files)) resourcePath(name); assertManifest(files, limits)
    const local = await scanFiles(this.root, this.objects, limits, signal), base = this.state?.files ?? {}, accepted: Manifest = { ...files }, conflicts: Conflict[] = [], operations: Operation[] = []
    const localIndex = index(local), oldIndex = index(base), remoteIndex = index(files)
    const ids = new Set([...localIndex.keys(), ...oldIndex.keys(), ...remoteIndex.keys()]); let completed = 0
    options.onProgress?.(completed, ids.size)
    for (const id of ids) {
      signal.throwIfAborted()
      options.onProgress?.(++completed, ids.size)
      const current = localIndex.get(id), previous = oldIndex.get(id), incoming = remoteIndex.get(id), currentHash = current?.entry.hash ?? null, previousHash = previous?.entry.hash ?? null, incomingHash = incoming?.entry.hash ?? null
      if (currentHash !== previousHash && incomingHash !== previousHash && currentHash !== incomingHash) {
        conflicts.push({ path: current?.path ?? previous?.path ?? incoming!.path, incoming: incoming?.entry ?? null, incomingPath: incoming?.path })
        if (incoming) delete accepted[incoming.path]; if (previous) accepted[previous.path] = previous.entry; continue
      }
      const targetPath = incoming?.path ?? current?.path ?? previous!.path
      const result = incomingHash === previousHash ? current?.entry ?? null : incoming?.entry ?? null
      if (result && result.hash !== currentHash) { const data = await this.client.file(packId, response.revision, targetPath, { signal }); if (hash(data) !== result.hash) fail(uiText("collaboration.workspace.upstreamDocumentsDoNotMatchTheList")); await this.objects.put(data) }
      operations.push(...this.operations(local, current?.path, targetPath, result))
    }
    const next: WorkspaceState = { version: 1, serverId: this.client.invitation.serverId, packId, revision: response.revision, files: accepted, conflicts, limits }
    signal.throwIfAborted()
    if (operations.length) await this.apply(local, operations, next, lease)
    else await this.save(next, lease)
    return { updated: operations.length, conflicts, revision: response.revision }
  }
  private difference(local: Manifest) {
    if (!this.state) fail(uiText("collaboration.workspace.pleasePullTheResourcePackFirst"))
    const files = this.state.files
    const paths = [...new Set([...Object.keys(local), ...Object.keys(files)])].filter(name => (local[name]?.hash ?? null) !== (files[name]?.hash ?? null)).sort().map(name => ({ path: name, kind: !local[name] ? 'deleted' as const : !files[name] ? 'added' as const : 'modified' as const, base: files[name]?.hash ?? null, next: local[name]?.hash ?? null }))
    const revision = hash(JSON.stringify({ server: this.state.serverId, pack: this.state.packId, base: this.state.revision, paths, conflicts: this.state.conflicts }))
    return { revision, paths, conflicts: this.state.conflicts }
  }
  private async readSubmission(signal: AbortSignal) {
    if (!this.state) fail(uiText("collaboration.workspace.pleasePullTheResourcePackFirst"))
    return this.difference(align(await scanFiles(this.root, this.objects, this.state.limits, signal), this.state.files))
  }
  async submission(signal?: AbortSignal) {
    return this.withWorkspaceLock(lease => this.readSubmission(signal ? AbortSignal.any([signal, lease]) : lease))
  }
  async changes(signal?: AbortSignal): Promise<{ paths: { path: string; kind: 'added' | 'modified' | 'deleted' }[]; conflicts: Conflict[] }> {
    return this.withWorkspaceLock(async lease => {
      if (!this.state) return { paths: [], conflicts: [] }
      const result = await this.readSubmission(signal ? AbortSignal.any([signal, lease]) : lease)
      return { paths: result.paths.map(({ path, kind }) => ({ path, kind })), conflicts: result.conflicts }
    })
  }
  async submit(title: string, paths: string[], expectedRevision?: string, beforeSend?: () => void | Promise<void>): Promise<Proposal> {
    return this.withWorkspaceLock(lease => this.submitLocked(title, paths, expectedRevision, beforeSend, lease))
  }
  private async submitLocked(title: string, paths: string[], expectedRevision: string | undefined, beforeSend: (() => void | Promise<void>) | undefined, lease: AbortSignal): Promise<Proposal> {
    if (!this.state) fail(uiText("collaboration.workspace.pleasePullTheResourcePackFirst"))
    if (this.state.conflicts.length) fail(uiText("collaboration.workspace.pleaseFirstAddressUpstreamConflictsAndAvoid"))
    const local = align(await scanFiles(this.root, this.objects, this.state.limits, lease), this.state.files), seen = new Set(paths), changed = this.difference(local)
    if (expectedRevision !== undefined && expectedRevision !== changed.revision) fail(uiText("collaboration.workspace.localChangeOrCollaborativeBaselineChangedPlease"))
    if (seen.size !== paths.length || !paths.length || paths.some(name => !changed.paths.some(entry => entry.path === name))) fail(uiText("collaboration.workspace.pleaseSelectTheFilesThatActuallyChange"))
    let total = 0
    const changes = await Promise.all(paths.map(async name => { const data = local[name] ? await this.objects.get(local[name].hash) : null; total += data?.length ?? 0; return { path: name, base: this.state!.files[name]?.hash ?? null, data: data?.toString('base64') ?? null } }))
    if (total > this.state.limits.submissionBytes) fail(uiText("collaboration.workspace.thisSubmissionExceedsTheServiceEndLimit"))
    await beforeSend?.()
    lease.throwIfAborted()
    const result = await this.client.request<Proposal>('/v1/proposals', 'POST', { packId: this.state.packId, baseRevision: this.state.revision, title, changes }, { signal: lease })
    lease.throwIfAborted()
    await this.history().commit(local, undefined, result.author, uiText("collaboration.workspace.proactiveSubmissionOf", title), 'refs/mcrh/submissions/' + result.id); return result
  }
  async resolve(relative: string, keep: 'local' | 'remote'): Promise<void> {
    return this.withWorkspaceLock(lease => this.resolveLocked(relative, keep, lease))
  }
  private async resolveLocked(relative: string, keep: 'local' | 'remote', lease: AbortSignal): Promise<void> {
    if (!this.state) fail(uiText("collaboration.workspace.aCopyOfTheTaskHasNot"))
    const conflict = this.state.conflicts.find(value => value.path === relative) ?? fail(uiText("collaboration.workspace.thereIsNoConflict")), files = { ...this.state.files }
    for (const name of Object.keys(files)) if (name.toLowerCase() === relative.toLowerCase()) delete files[name]
    if (conflict.incoming) files[conflict.incomingPath ?? relative] = conflict.incoming
    const next = { ...this.state, files, conflicts: this.state.conflicts.filter(value => value.path !== relative) }
    if (keep === 'local') { await this.save(next, lease); return }
    const local = await scanFiles(this.root, this.objects, this.state.limits, lease), current = index(local).get(relative.toLowerCase()), target = conflict.incomingPath ?? relative
    if (conflict.incoming) { const data = await this.client.file(this.state.packId, this.state.revision, target, { signal: lease }); if (hash(data) !== conflict.incoming.hash) fail(uiText("collaboration.workspace.conflictDocumentsDoNotMatchTheList")); await this.objects.put(data) }
    await this.apply(local, this.operations(local, current?.path, target, conflict.incoming), next, lease)
  }
  info(): Pick<WorkspaceState, 'packId' | 'revision' | 'conflicts'> | undefined { return this.state ? { packId: this.state.packId, revision: this.state.revision, conflicts: this.state.conflicts } : undefined }
  async incoming(relative: string): Promise<Buffer | null> { if (!this.state) fail(uiText("collaboration.workspace.aCopyOfTheTaskHasNot")); const conflict = this.state.conflicts.find(value => value.path === relative) ?? fail(uiText("collaboration.workspace.thereIsNoConflict")); return conflict.incoming ? this.client.file(this.state.packId, this.state.revision, conflict.incomingPath ?? relative) : null }
}