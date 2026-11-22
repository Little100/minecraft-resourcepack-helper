import { uiText } from '../i18n/messages'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import git from 'isomorphic-git'
import { atomic, exists, type Objects } from './files'
import { fail, type Identity, type Manifest } from './types'

export async function requireGit(): Promise<string> {
  try { return (await promisify(execFile)('git', ['--version'], { windowsHide: true, timeout: 10000 })).stdout.trim() } catch { return fail(uiText("collaboration.history.collaborationRequiresTheInstallationOfGitHttps")) }
}
export class History {
  private readonly blobs = new Map<string, string>()
  constructor(readonly gitdir: string, private readonly objects: Objects, private readonly manifests: string) {}
  async initialize(): Promise<void> { await requireGit(); await fsp.mkdir(this.gitdir, { recursive: true, mode: 0o700 }); if (!await exists(path.join(this.gitdir, 'HEAD'))) await git.init({ fs, gitdir: this.gitdir, bare: true, defaultBranch: 'official' }) }
  async commit(files: Manifest, parent: string | undefined, actor: Identity, message: string, ref = 'refs/heads/official'): Promise<string> {
    const root = new Map<string, unknown>()
    for (const [name, entry] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
      let oid = this.blobs.get(entry.hash)
      if (!oid) { oid = await git.writeBlob({ fs, gitdir: this.gitdir, blob: await this.objects.get(entry.hash) }); this.blobs.set(entry.hash, oid) }
      let branch = root; const parts = name.split('/')
      for (const part of parts.slice(0, -1)) { if (!branch.has(part)) branch.set(part, new Map()); const nested = branch.get(part); if (!(nested instanceof Map)) fail(uiText("collaboration.history.fileConflictWithDirectoryPath")); branch = nested }
      if (branch.has(parts.at(-1)!)) fail(uiText("collaboration.history.fileConflictWithDirectoryPath")); branch.set(parts.at(-1)!, oid)
    }
    const tree = async (branch: Map<string, unknown>): Promise<string> => git.writeTree({ fs, gitdir: this.gitdir, tree: await Promise.all([...branch].map(async ([name, item]) => item instanceof Map ? { path: name, oid: await tree(item), mode: '040000', type: 'tree' as const } : { path: name, oid: item as string, mode: '100644', type: 'blob' as const })) })
    if (!parent) { try { parent = await git.resolveRef({ fs, gitdir: this.gitdir, ref }) } catch {} }
    const author = { name: actor.login.replace(/[\n\r<>]/g, ''), email: actor.id + '@mcrh.invalid', timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 }
    const revision = await git.writeCommit({ fs, gitdir: this.gitdir, commit: { tree: await tree(root), parent: parent ? [parent] : [], author, committer: author, message: message + '\n' } })
    await atomic(path.join(this.manifests, revision + '.json'), JSON.stringify(files)); await git.writeRef({ fs, gitdir: this.gitdir, ref, value: revision, force: true }); return revision
  }
  async isAncestor(official: string, revision: string): Promise<boolean> { try { return official === revision || await git.isDescendent({ fs, gitdir: this.gitdir, oid: official, ancestor: revision }) } catch { return false } }
  async promote(revision: string): Promise<void> { await git.writeRef({ fs, gitdir: this.gitdir, ref: 'refs/heads/official', value: revision, force: true }) }
  async manifest(revision: string): Promise<Manifest> {
    if (!/^[a-f0-9]{40}$/.test(revision)) fail(uiText("collaboration.history.versionNumberInvalid"))
    try { return JSON.parse(await fsp.readFile(path.join(this.manifests, revision + '.json'), 'utf8')) as Manifest } catch { return fail(uiText("collaboration.history.versionDoesNotExistOrIsBroken"), 404) }
  }
}