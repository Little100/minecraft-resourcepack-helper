import { uiText } from '../i18n/messages'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { verifyOpenP2PExecutable } from './openp2p'
import { fail, hashSchema } from './types'
async function assertPrivateDirectory(directory: string): Promise<void> {
  const absolute = path.resolve(directory), volume = path.parse(absolute).root
  let cursor = volume
  for (const part of absolute.slice(volume.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    const stat = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined })
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail(uiText("collaboration.p2pInstall.assignDirectoryCannotContainLinksOrNormal"))
    if (!stat) await fs.mkdir(cursor, { mode: 0o700 })
  }
}

export function installedOpenP2PPath(directory: string): string { return path.join(directory, 'p2p-bin', process.platform === 'win32' ? 'openp2p-mcrh.exe' : 'openp2p-mcrh') }

export async function installOpenP2P(directory: string, source: string, sha256?: string): Promise<string> {
  let bytes: Buffer
  if (/^https:/i.test(source)) {
    if (!sha256 || !hashSchema.safeParse(sha256).success) fail(uiText("collaboration.p2pInstall.networkInstallationMustProvideDistributionDocumentsSha"))
    let url = new URL(source)
    for (let redirect = 0; ; redirect++) {
      if (url.protocol !== 'https:' || url.username || url.password || redirect > 5) fail(uiText("collaboration.p2pInstall.establishingOrReDirectionMustBeAn"))
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60000) })
      if ([301, 302, 303, 307, 308].includes(response.status)) { await response.body?.cancel(); const next = response.headers.get('location'); if (!next) fail(uiText("collaboration.p2pInstall.equipDownloadReDirectionMissingTarget")); url = new URL(next, url); continue }
      if (!response.ok || !response.body || Number(response.headers.get('content-length') ?? 0) > 64 * 1024 * 1024) { await response.body?.cancel(); fail(uiText("collaboration.p2pInstall.openp2pDownloadFailedOrExceededMib")) }
      const parts: Uint8Array[] = []; let size = 0
      for await (const part of response.body) { size += part.byteLength; if (size > 64 * 1024 * 1024) fail(uiText("collaboration.p2pInstall.openp2pDownloadsMoreThanMib")); parts.push(part) }
      bytes = Buffer.concat(parts); break
    }
  } else {
    if (!path.isAbsolute(source)) fail(uiText("collaboration.p2pInstall.accessablePathMustBeUsedForThe"))
    const stat = await fs.lstat(source)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) fail(uiText("collaboration.p2pInstall.theSourceOfTheInstallationMustBe"))
    bytes = await fs.readFile(source)
  }
  if (sha256 && createHash('sha256').update(bytes).digest('hex') !== sha256) fail(uiText("collaboration.p2pInstall.openp2pInstallationFileShaDoesNotMatch"))
  const destination = installedOpenP2PPath(directory), bin = path.dirname(destination)
  await assertPrivateDirectory(directory); await assertPrivateDirectory(bin)
  const temporary = path.join(bin, '.install-' + randomUUID() + (process.platform === 'win32' ? '.exe' : ''))
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o700 })
    await verifyOpenP2PExecutable(temporary)
    const previous = await fs.lstat(destination).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined })
    if (previous?.isSymbolicLink() || previous && !previous.isFile()) fail(uiText("collaboration.p2pInstall.stepTargetIsNotANormalFile"))
    await fs.rename(temporary, destination)
  } finally { await fs.rm(temporary, { force: true }) }
  return destination
}
