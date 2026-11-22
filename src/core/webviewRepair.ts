import { uiText } from '../i18n/messages'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import lockfile from 'proper-lockfile'
import { desktopLaunchEnvironment } from './desktopProcess'
export { desktopLaunchEnvironment as repairLaunchEnvironment } from './desktopProcess'

export const WEBVIEW_REPAIR_LIFETIME_MS = 90000
const absolutePath = z.string().min(1).max(32768).refine(value => path.isAbsolute(value), uiText("core.webviewRepair.needAbsolutePath"))
export const webviewRepairSchema = z.object({
  id: z.string().uuid(), mainPid: z.number().int().positive(), expiresAt: z.number().int().positive(),
  executable: absolutePath, userDataDir: absolutePath, extensionsDir: absolutePath,
  workspaces: z.array(absolutePath).max(128), resetCache: z.boolean()
}).strict()
export type WebviewRepairPlan = z.infer<typeof webviewRepairSchema>
export interface WebviewRepairState {
  id: string
  phase: 'waiting' | 'cancelled' | 'expired' | 'started' | 'failed'
  backup?: string
  cacheError?: string
  error?: string
  pid?: number
}

export function profileRootFromGlobalStorage(storage: string): string {
  const global = path.dirname(path.resolve(storage))
  if (path.basename(global).toLowerCase() !== 'globalstorage') throw new Error(uiText("core.webviewRepair.vsCodeUserDirectoryNotRecognized"))
  let user = path.dirname(global)
  if (path.basename(path.dirname(user)).toLowerCase() === 'profiles') user = path.dirname(path.dirname(user))
  if (path.basename(user).toLowerCase() !== 'user') throw new Error(uiText("core.webviewRepair.vsCodeUserProfileNotRecognized"))
  return path.dirname(user)
}

export function repairLaunchArgs(plan: WebviewRepairPlan): string[] {
  return ['--user-data-dir=' + plan.userDataDir, '--extensions-dir=' + plan.extensionsDir, ...plan.workspaces]
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

export async function backupWebviewServiceWorker(userDataDir: string): Promise<string | undefined> {
  const root = path.resolve(userDataDir)
  if (!samePath(await fs.realpath(root), root) || !(await fs.stat(path.join(root, 'User'))).isDirectory()) throw new Error(uiText("core.webviewRepair.userDataPathNotChecked"))
  const cache = path.join(root, 'Service Worker')
  let item
  try { item = await fs.lstat(cache) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  if (!item.isDirectory() || item.isSymbolicLink() || !samePath(await fs.realpath(cache), cache)) throw new Error(uiText("core.webviewRepair.cachePathContainsLinksOrIsNot"))
  const backup = path.join(root, 'Service Worker.mcrh-backup-' + randomUUID())
  if (!samePath(path.dirname(cache), root) || !samePath(path.dirname(backup), root)) throw new Error(uiText("core.webviewRepair.cachePathExceedingUserDataDirectories"))
  await fs.rename(cache, backup)
  return backup
}

export async function writeRepairState(job: string, state: WebviewRepairState): Promise<void> {
  const target = job + '.state.json', temporary = target + '.' + randomUUID() + '.tmp'
  await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' })
  await fs.rename(temporary, target)
}

async function cancelled(job: string): Promise<boolean> {
  try { await fs.access(job + '.cancel'); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; return true }
}

async function launch(plan: WebviewRepairPlan): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.executable, repairLaunchArgs(plan), { detached: true, stdio: 'ignore', env: desktopLaunchEnvironment(process.env) })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve(child.pid) })
  })
}

export interface RepairHooks {
  isAlive(pid: number): boolean
  now(): number
  sleep(ms: number): Promise<void>
  launch(plan: WebviewRepairPlan): Promise<number | undefined>
}

export async function runWebviewRepair(job: string, overrides: Partial<RepairHooks> = {}): Promise<WebviewRepairState> {
  const input = await fs.readFile(job)
  if (input.length > 65536) throw new Error(uiText("core.webviewRepair.rehabilitationRequestIsTooLarge"))
  const plan = webviewRepairSchema.parse(JSON.parse(input.toString('utf8')))
  const hooks: RepairHooks = { isAlive, now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), launch, ...overrides }
  if (plan.mainPid === process.pid || plan.expiresAt > hooks.now() + WEBVIEW_REPAIR_LIFETIME_MS) throw new Error(uiText("core.webviewRepair.theProcessOrValidityOfTheRequest"))
  const state: WebviewRepairState = { id: plan.id, phase: 'waiting' }
  const finish = async (phase: WebviewRepairState['phase']) => { state.phase = phase; await writeRepairState(job, state); return state }
  const interrupted = async () => {
    if (await cancelled(job)) return 'cancelled' as const
    if (hooks.now() >= plan.expiresAt) return 'expired' as const
    return undefined
  }
  const initialStop = await interrupted()
  if (initialStop) return finish(initialStop)
  if (!hooks.isAlive(plan.mainPid)) { state.error = uiText("core.webviewRepair.formerVsCodeHasWithdrawnAndDenied"); return finish('cancelled') }
  const userDataDir = await fs.realpath(plan.userDataDir)
  let compromised = false
  let release: (() => Promise<void>) | undefined
  try {
    release = await lockfile.lock(userDataDir, { lockfilePath: path.join(userDataDir, 'mcrh-webview-repair.lock'), retries: 0, stale: WEBVIEW_REPAIR_LIFETIME_MS * 2, onCompromised: () => { compromised = true } })
  } catch (error) {
    state.error = (error as NodeJS.ErrnoException).code === 'ELOCKED' ? uiText("core.webviewRepair.otherWindowsAreBeingRepairedPleaseWait") : uiText("core.webviewRepair.cannotGetFixLocks")
    return finish('failed')
  }
  try {
    if (!hooks.isAlive(plan.mainPid)) return finish('cancelled')
    await writeRepairState(job, state)
    while (hooks.isAlive(plan.mainPid)) {
      const stop = await interrupted()
      if (stop || compromised) return finish(stop ?? 'cancelled')
      await hooks.sleep(250)
    }
    await hooks.sleep(500)
    const stop = await interrupted()
    if (stop || compromised) return finish(stop ?? 'cancelled')
    if (plan.resetCache) {
      try { state.backup = await backupWebviewServiceWorker(plan.userDataDir) }
      catch (error) { state.cacheError = (error as NodeJS.ErrnoException).code || uiText("core.webviewRepair.cacheBackupIncompleteOriginalCacheMaintained") }
    }
    const beforeLaunch = await interrupted()
    if (beforeLaunch || compromised) return finish(beforeLaunch ?? 'cancelled')
    try { state.pid = await hooks.launch(plan); return finish('started') }
    catch (error) { state.error = (error as NodeJS.ErrnoException).code || uiText("core.webviewRepair.renewalNotCompleted"); return finish('failed') }
  } finally { await release().catch(() => undefined) }

}
