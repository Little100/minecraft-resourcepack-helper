import { uiText } from '../i18n/messages'
import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'
import type { PixelDocument } from '../core/document'
import { updateAnimationMetadata } from '../core/pixelAnimation'
import { buildProjectText, encodeProjectText, sidecarUriFor } from '../core/project'

async function readOptional(uri: vscode.Uri): Promise<Uint8Array | undefined> {
  try { return await vscode.workspace.fs.readFile(uri) }
  catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') return undefined
    throw error
  }
}

async function removeOptional(uri: vscode.Uri): Promise<void> {
  try { await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false }) }
  catch (error) {
    if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) throw error
  }
}

// 动画序列与时长沿用源图，目标旧元数据不能混入新的导出
async function animationBytes(source: vscode.Uri, doc: PixelDocument): Promise<Uint8Array | undefined> {
  const bytes = await readOptional(source.with({ path: source.path + '.mcmeta' }))
  let original: unknown
  if (bytes) {
    try { original = JSON.parse(Buffer.from(bytes).toString('utf8')) }
    catch { throw new Error(uiText("ui.pixelLayerExport.animatedMetadataSyntaxOfSourcePicturesIs")) }
  }
  const hasAnimationMetadata = Boolean(original && typeof original === 'object' && !Array.isArray(original) && 'animation' in original)
  if (hasAnimationMetadata) {
    const animation = (original as { animation?: unknown }).animation
    if (!animation || typeof animation !== 'object' || Array.isArray(animation)) throw new Error(uiText("ui.pixelLayerExport.animatedMetadataStructureOfSourcePicturesIs"))
    return Buffer.from(JSON.stringify(original, null, 2) + '\n')
  }
  if (doc.frameHeight === undefined && !hasAnimationMetadata) {
    return original === undefined ? undefined : Buffer.from(JSON.stringify(original, null, 2) + '\n')
  }
  const frameHeight = doc.frameHeight ?? doc.height
  const metadata = updateAnimationMetadata(original, doc.width, frameHeight, doc.frameCount)
  return metadata === undefined ? undefined : Buffer.from(JSON.stringify(metadata, null, 2) + '\n')
}

// 所有新文件与旧文件副本先写入同目录临时文件，任一步失败都能回滚
export async function writeLayerExport(source: vscode.Uri, target: vscode.Uri, doc: PixelDocument, png: Uint8Array): Promise<void> {
  const sidecar = sidecarUriFor(target)
  const metadata = sidecar ? await animationBytes(source, doc) : undefined
  const metadataUri = target.with({ path: target.path + '.mcmeta' })
  const outputs: Array<{ uri: vscode.Uri; bytes?: Uint8Array }> = [{ uri: target, bytes: png }]
  if (sidecar && (metadata !== undefined || await readOptional(metadataUri) !== undefined)) outputs.push({ uri: metadataUri, bytes: metadata })
  if (sidecar) {
    const bytes = encodeProjectText(buildProjectText(doc, png, new Date(), vscode.workspace.asRelativePath(target, false).replace(/\\/g, '/')))
    outputs.push({ uri: sidecar, bytes })
  }
  const previous = await Promise.all(outputs.map(output => readOptional(output.uri)))
  const nonce = randomUUID()
  const staged = outputs.map(output => ({ ...output, temporary: output.uri.with({ path: output.uri.path + '.' + nonce + '.mcrh-export.tmp' }) }))
  const backups = outputs.map((output, index) => previous[index] === undefined ? undefined : output.uri.with({ path: output.uri.path + '.' + nonce + '.mcrh-export.bak' }))
  const committed: number[] = []
  let preserveBackups = false
  try {
    for (let index = 0; index < staged.length; index++) {
      const item = staged[index]
      if (item.uri.toString() === sidecar?.toString()) await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(item.uri, '..'))
      if (item.bytes !== undefined) await vscode.workspace.fs.writeFile(item.temporary, item.bytes)
      if (backups[index] && previous[index]) await vscode.workspace.fs.writeFile(backups[index]!, previous[index]!)
    }
    for (let index = 0; index < staged.length; index++) {
      const item = staged[index]
      if (item.bytes === undefined && previous[index] === undefined) continue
      committed.push(index)
      if (item.bytes === undefined) await removeOptional(item.uri)
      else await vscode.workspace.fs.rename(item.temporary, item.uri, { overwrite: true })
    }
  } catch (error) {
    const failures: string[] = []
    for (const index of committed.reverse()) {
      try {
        if (backups[index]) await vscode.workspace.fs.rename(backups[index]!, outputs[index].uri, { overwrite: true })
        else await removeOptional(outputs[index].uri)
      } catch { failures.push(backups[index]?.fsPath ?? outputs[index].uri.fsPath) }
    }
    preserveBackups = failures.length > 0
    if (failures.length) throw new Error(uiText("ui.pixelLayerExport.exportFailedOriginalFileFailedBackupIs", failures.join(', '), String(error)))
    throw error
  } finally {
    for (const item of staged) await removeOptional(item.temporary).catch(() => undefined)
    if (!preserveBackups) for (const backup of backups) if (backup) await removeOptional(backup).catch(() => undefined)
  }
}
