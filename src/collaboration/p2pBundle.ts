import { uiText } from '../i18n/messages'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { installOpenP2P, installedOpenP2PPath } from './p2pInstall'
import { verifyOpenP2PExecutable } from './openp2p'

const manifestSchema = z.object({ protocol: z.literal(1), files: z.array(z.object({ name: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive().max(64 * 1024 * 1024) })) })
const pending = new Map<string, Promise<string>>()

export function bundledOpenP2PName(platform: NodeJS.Platform = process.platform, arch = process.arch): string {
  if (!['win32', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error(uiText("collaboration.p2pBundle.inlineOpenp2pToSupportWindowsLinuxX64"))
  return 'openp2p-mcrh-' + (platform === 'win32' ? 'windows' : 'linux') + '-' + (arch === 'x64' ? 'amd64' : 'arm64') + (platform === 'win32' ? '.exe' : '')
}

async function installBundled(directory: string, bundleDirectory: string): Promise<string> {
  const name = bundledOpenP2PName(), manifestFile = path.join(bundleDirectory, 'manifest.json')
  const manifestStat = await fs.lstat(manifestFile)
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 65536) throw new Error(uiText("collaboration.p2pBundle.inlineEmbeddedOpenp2pChecklistInvalid"))
  const manifest = manifestSchema.parse(JSON.parse(await fs.readFile(manifestFile, 'utf8'))), entries = manifest.files.filter(file => file.name === name)
  if (entries.length !== 1) throw new Error(uiText("collaboration.p2pBundle.promulgationPackageMissingOpenp2pClientForThe"))
  const entry = entries[0], source = path.join(bundleDirectory, name), sourceStat = await fs.lstat(source)
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size !== entry.bytes) throw new Error(uiText("collaboration.p2pBundle.inlineOpenp2pClientSizeOrFileType"))
  if (createHash('sha256').update(await fs.readFile(source)).digest('hex') !== entry.sha256) throw new Error(uiText("collaboration.p2pBundle.inlineOpenp2pClientShaNotMatching"))
  const installed = installedOpenP2PPath(directory)
  try {
    const stat = await fs.lstat(installed)
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size === entry.bytes && createHash('sha256').update(await fs.readFile(installed)).digest('hex') === entry.sha256) {
      await verifyOpenP2PExecutable(installed)
      return installed
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return installOpenP2P(directory, source, entry.sha256)
}

export function ensureBundledOpenP2P(directory: string, bundleDirectory: string): Promise<string> {
  const key = path.resolve(directory), active = pending.get(key)
  if (active) return active
  const task = installBundled(directory, bundleDirectory).finally(() => { if (pending.get(key) === task) pending.delete(key) })
  pending.set(key, task)
  return task
}
