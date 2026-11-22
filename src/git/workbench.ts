import { uiText } from '../i18n/messages'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID, createHash } from 'node:crypto'
export interface GitChange { path: string; status: string; previous?: string }
export interface GitCommit { hash: string; author: string; date: string; subject: string }
export class UserGit {
  constructor(readonly root: string) {}
  async run(args: string[], binary = false): Promise<Buffer> {
    const { stdout } = await promisify(execFile)('git', ['--literal-pathspecs', '-c', 'core.quotepath=false', '-C', this.root, ...args], { encoding: 'buffer', windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } })
    return binary ? stdout : stdout
  }
  async text(args: string[]): Promise<string> { return (await this.run(args)).toString('utf8').trim() }
  static async detect(directory: string): Promise<UserGit | undefined> {
    const git = new UserGit(directory)
    await git.run(['--version'])
    try { return new UserGit(await git.text(['rev-parse', '--show-toplevel'])) } catch { return undefined }
  }
  relative(absolute: string): string { const relative = path.relative(this.root, absolute).replace(/\\/g, '/'); return this.path(relative) }
  path(relative: string): string {
    if (!relative || relative.length > 4096 || /[\\\x00]/.test(relative) || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '..' || part === '.' || part.toLowerCase() === '.git')) throw new Error(uiText("git.workbench.gitFilePathInvalid"))
    return relative
  }
  revision(value: string): string { if (!/^[0-9a-f]{40,64}$/.test(value)) throw new Error(uiText("git.workbench.gitSubmissionNumberInvalid")); return value }
  async changes(): Promise<GitChange[]> {
    const fields = (await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).toString('utf8').split('\0'), output: GitChange[] = []
    for (let index = 0; index < fields.length; index++) {
      const field = fields[index]; if (!field) continue
      const status = field.slice(0, 2), name = field.slice(3), previous = /[RC]/.test(status) ? fields[++index] : undefined
      output.push({ path: name, status, previous })
    }
    return output
  }
  async log(file?: string): Promise<GitCommit[]> {
    try {
      const output = await this.text(['log', '-100', '-z', '--format=%H%x1f%an%x1f%aI%x1f%s', ...(file ? ['--follow', '--', this.path(file)] : [])])
      return output.split('\0').filter(Boolean).map(record => { const [hash, author, date, ...subject] = record.split('\x1f'); return { hash, author, date, subject: subject.join(' ') } })
    } catch (error) { try { await this.run(['rev-parse', '--verify', 'HEAD']) } catch { return [] }; throw error }
  }
  async commitFiles(hash: string): Promise<GitChange[]> {
    const fields = (await this.run(['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', this.revision(hash)])).toString('utf8').split('\0'), result: GitChange[] = []
    for (let index = 0; index < fields.length - 1; index += 2) result.push({ status: fields[index], path: fields[index + 1] })
    return result
  }
  async read(hash: string, file: string): Promise<Buffer> { return this.run(['show', this.revision(hash) + ':' + this.path(file)], true) }
  async stage(files: string[], unstage = false): Promise<void> {
    if (!files.length) return
    const paths = files.map(file => this.path(file))
    await this.run(unstage ? ['restore', '--staged', '--', ...paths] : ['add', '--', ...paths])
  }
  async commit(message: string): Promise<void> {
    if (!message.trim() || message.length > 4096) throw new Error(uiText("git.workbench.pleaseFillInAValidStatement"))
    await this.run(['commit', '-m', message.trim()])
  }
  async restore(hash: string, file: string): Promise<string> {
    this.path(file)
    const data = await this.read(hash, file), target = path.join(this.root, file)
    let parent = this.root
    for (const part of file.split('/')) {
      parent = path.join(parent, part)
      try { const stat = await fs.lstat(parent); if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1) throw new Error(uiText("git.workbench.rejectionToRestoreLinksOrHardLink")) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    let previous: Buffer | undefined
    try { previous = await fs.readFile(target) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const directory = path.join(this.root, '.mcrh', 'git-backups', randomUUID())
    await fs.mkdir(directory, { recursive: true })
    if (previous) await fs.writeFile(path.join(directory, 'original'), previous, { flag: 'wx' })
    await fs.writeFile(path.join(directory, 'record.json'), JSON.stringify({ path: file, source: hash, existed: previous !== undefined, sha256: previous ? createHash('sha256').update(previous).digest('hex') : null }))
    await fs.mkdir(path.dirname(target), { recursive: true })
    const current = await fs.readFile(target).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined })
    if (!((previous === undefined && current === undefined) || previous && current && previous.equals(current))) throw new Error(uiText("git.workbench.documentsModifiedByOtherProceduresDuringRecovery"))
    const temporary = target + '.' + randomUUID() + '.tmp'
    try { await fs.writeFile(temporary, data, { flag: 'wx' }); await fs.rename(temporary, target) } finally { await fs.rm(temporary, { force: true }) }
    return directory
  }
  async revert(hash: string): Promise<void> {
    if ((await this.changes()).length) throw new Error(uiText("git.workbench.pleaseSubmitOrProcessTheCurrentGit"))
    const parents = await this.text(['rev-list', '--parents', '-n', '1', this.revision(hash)])
    if (parents.split(' ').length > 2) throw new Error(uiText("git.workbench.consolidationRequiresTheSelectionOfMainLines"))
    await this.run(['revert', '--no-commit', this.revision(hash)])
  }
}
