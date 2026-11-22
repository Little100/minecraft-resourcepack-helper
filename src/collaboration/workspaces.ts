import { uiText } from '../i18n/messages'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { z } from 'zod'
import { atomic, exists, hash } from './files'
import { RemoteClient } from './client'
import { CollaborationError, fail, idSchema } from './types'
import { LocalWorkspace } from './workspace'

const registrySchema = z.object({ version: z.literal(1), parent: z.string().optional(), roots: z.array(z.object({ packId: idSchema, root: z.string() }).strict()).max(256) }).strict()
export type RemotePack = { id: string; name: string; revision: string }
const contains = (parent: string, target: string): boolean => { const relative = path.relative(parent, target); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) }
export class WorkspaceCollection {
  private readonly workspaces = new Map<string, LocalWorkspace>()
  private roots: { packId: string; root: string }[] = []
  parent?: string
  constructor(private readonly storage: string, readonly client: RemoteClient) {}
  private registry(): string { return path.join(this.storage, 'connections', this.client.invitation.serverId + '.json') }
  private workspace(root: string): LocalWorkspace { return new LocalWorkspace(root, path.join(this.storage, 'workspaces', hash(root)), this.client) }
  get(packId: string | undefined): LocalWorkspace | undefined { return packId ? this.workspaces.get(packId) : undefined }
  entries(): { packId: string; root: string }[] { return [...this.workspaces].map(([packId, workspace]) => ({ packId, root: workspace.root })) }
  async load(): Promise<string[]> {
    if (!await exists(this.registry())) return []
    const stored = registrySchema.parse(JSON.parse(await fs.readFile(this.registry(), 'utf8'))), warnings: string[] = []
    this.parent = stored.parent; this.roots = stored.roots
    for (const entry of this.roots) {
      try {
        if (!path.isAbsolute(entry.root) || this.workspaces.has(entry.packId)) fail(uiText("collaboration.workspaces.canNotGetMessageSS"))
        this.assertSeparate(entry.packId, entry.root)
        if ((await fs.lstat(entry.root)).isSymbolicLink() || await fs.realpath(entry.root) !== entry.root) fail(uiText("collaboration.workspaces.taskCopyPathChanged"))
        const workspace = this.workspace(entry.root); await workspace.load()
        if (workspace.info()?.packId !== entry.packId) fail(uiText("collaboration.workspaces.copyOfWorkIsNotBaselineOr"))
        this.workspaces.set(entry.packId, workspace)
      } catch (error) {
        warnings.push(uiText("collaboration.workspaces.resourcePack", entry.packId, (error instanceof CollaborationError && error.statusCode === 409 ? error.message : uiText("collaboration.workspaces.localWorkingCopyIsNotAvailableRe"))))
      }
    }
    return warnings
  }
  private assertSeparate(packId: string, root: string): void {
    if (this.roots.some(entry => entry.packId !== packId && (contains(entry.root, root) || contains(root, entry.root)))) fail(uiText("collaboration.workspaces.theDirectoryOfWorkingCopiesOfDifferent"))
  }
  async selectParent(root: string): Promise<void> {
    if ((await fs.lstat(root)).isSymbolicLink()) fail(uiText("collaboration.workspaces.localParentDirectoryCannotBeALink"))
    this.parent = await fs.realpath(root)
  }
  async prepare(pack: RemotePack, existingRoot?: string): Promise<LocalWorkspace> {
    idSchema.parse(pack.id)
    const current = this.get(pack.id); if (current) return current
    let root: string
    if (existingRoot) root = path.resolve(existingRoot)
    else {
      if (!this.parent) fail(uiText("collaboration.workspaces.pleaseSelectTheParentDirectoryForA"))
      if (await fs.realpath(this.parent) !== this.parent || (await fs.lstat(this.parent)).isSymbolicLink()) fail(uiText("collaboration.workspaces.localParentDirectoryPathChangedReSelect"))
      const name = pack.name.normalize('NFKC').replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').slice(0, 64).replace(/[. ]+$/g, '') || 'pack'
      root = path.join(this.parent, name + '-' + pack.id)
      if (!await exists(root)) await fs.mkdir(root)
    }
    if ((await fs.lstat(root)).isSymbolicLink()) fail(uiText("collaboration.files.resourcePackDirectoryCannotBeALink"))
    root = await fs.realpath(root); this.assertSeparate(pack.id, root)
    const workspace = this.workspace(root); await workspace.load()
    if (workspace.info() && workspace.info()!.packId !== pack.id) fail(uiText("collaboration.workspaces.thisDirectoryHasBeenBoundToOther"))
    return workspace
  }
  async register(packId: string, workspace: LocalWorkspace): Promise<void> {
    if (workspace.client !== this.client || workspace.info()?.packId !== packId) fail(uiText("collaboration.workspaces.aCopyOfTheWorkHasNot"))
    this.assertSeparate(packId, workspace.root)
    this.workspaces.set(packId, workspace)
    this.roots = [...this.roots.filter(entry => entry.packId !== packId), { packId, root: workspace.root }]
    await atomic(this.registry(), JSON.stringify({ version: 1, parent: this.parent, roots: this.roots }))
  }
}
