import { uiText } from '../i18n/messages'
import { inspectReferenceImage, isReferenceImageName } from './referenceImageFormats'
import * as fs from 'node:fs/promises'
import { constants, type Stats, type Dir } from 'node:fs'
import * as path from 'node:path'
import { REFERENCE_LIMITS, referenceAbort } from './referenceImages'

export interface ReferenceFile { path: string; stamp: Stats }
const samePath = (left: string, right: string): boolean => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
const identity = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino
const unchanged = (left: Stats, right: Stats): boolean => identity(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs

// 检查所有路径分量，拒绝符号链接和目录联接
async function pathChain(filename: string, signal: AbortSignal): Promise<Array<{ path: string; stat: Stats }>> {
  const absolute = path.resolve(filename), root = path.parse(absolute).root
  let current = root
  const chain: Array<{ path: string; stat: Stats }> = []
  for (const part of ['', ...absolute.slice(root.length).split(path.sep).filter(Boolean)]) {
    referenceAbort(signal)
    if (part) current = path.join(current, part)
    const stat = await fs.lstat(current)
    if (stat.isSymbolicLink()) throw new Error(uiText("core.referenceFiles.referenceDiagramsDoNotAllowForA"))
    if (current !== absolute && !stat.isDirectory()) throw new Error(uiText("core.referenceFiles.referenceDiagramFatherPathIsNotA"))
    chain.push({ path: current, stat })
  }
  if (!samePath(await fs.realpath(absolute), absolute)) throw new Error(uiText("core.referenceFiles.theReferenceMapDoesNotMatchThe"))
  referenceAbort(signal)
  return chain
}
async function verifyChain(chain: Array<{ path: string; stat: Stats }>, signal: AbortSignal): Promise<void> {
  const latest = await pathChain(chain[chain.length - 1].path, signal)
  if (latest.length !== chain.length || latest.some((entry, index) => !identity(entry.stat, chain[index].stat))) throw new Error(uiText("core.referenceFiles.theReferenceChartPathHasBeenChanged"))
}

export async function registerReferenceFile(filename: string, signal: AbortSignal): Promise<ReferenceFile> {
  if (!isReferenceImageName(filename)) throw new Error(uiText("core.referenceFiles.pleaseSelectASupportedPhotoFile"))
  const chain = await pathChain(filename, signal), last = chain[chain.length - 1]
  if (!last.stat.isFile() || last.stat.size < 8 || last.stat.size > REFERENCE_LIMITS.fileBytes) throw new Error(uiText("core.referenceFiles.photoFilesAreEmptyTooBigOr"))
  await verifyChain(chain, signal)
  return { path: last.path, stamp: last.stat }
}

export async function* walkReferenceFolder(folder: string, signal: AbortSignal): AsyncGenerator<string> {
  const pending = [path.resolve(folder)]
  while (pending.length) {
    referenceAbort(signal)
    const current = pending.pop()!
    let directory: Dir | undefined
    try {
      const chain = await pathChain(current, signal)
      if (!chain[chain.length - 1].stat.isDirectory()) continue
      directory = await fs.opendir(current)
      await verifyChain(chain, signal)
      for await (const entry of directory) {
        referenceAbort(signal)
        if (entry.isSymbolicLink()) continue
        const filename = path.join(current, entry.name)
        if (entry.isDirectory()) pending.push(filename)
        else if (entry.isFile() && isReferenceImageName(entry.name)) yield filename
      }
    } catch (error) {
      referenceAbort(signal)
      if (current === path.resolve(folder)) throw error
    } finally {
      if (directory) await directory.close().catch(() => undefined)
    }
  }
}

export async function readReferenceFile(file: ReferenceFile, signal: AbortSignal): Promise<Uint8Array> {
  const chain = await pathChain(file.path, signal)
  if (!unchanged(chain[chain.length - 1].stat, file.stamp)) throw new Error(uiText("core.referenceFiles.theReferenceDiagramFileHasBeenChanged"))
  const handle = await fs.open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const before = await handle.stat()
    if (!before.isFile() || !unchanged(before, file.stamp)) throw new Error(uiText("core.referenceFiles.referenceChartFileIdentityChanged"))
    await verifyChain(chain, signal)
    const bytes = new Uint8Array(before.size)
    let offset = 0
    while (offset < bytes.length) {
      referenceAbort(signal)
      const result = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset)
      if (!result.bytesRead) throw new Error(uiText("core.referenceFiles.referenceDiagramReadIncomplete"))
      offset += result.bytesRead
    }
    if (!unchanged(await handle.stat(), before)) throw new Error(uiText("core.referenceFiles.changesDuringReferenceChartReading"))
    await verifyChain(chain, signal)
    inspectReferenceImage(bytes)
    referenceAbort(signal)
    return bytes
  } finally { await handle.close() }
}
