import { deflateSync, inflateSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import * as vscode from 'vscode'
import { DEFAULT_LAYER_NAME, type Layer, type PixelDocument } from './document'
import { decodeLayers, encodeLayer, sha256Hex, type LayerRecord } from './pixelCodec'

// 旧版不支持随机图层时仍可读取 PNG
export const PROJECT_VERSION = 5
export const PROJECT_HEADER = 'MCRH' + PROJECT_VERSION + '\n'

export function encodeProjectText(text: string): Buffer {
  return Buffer.concat([Buffer.from(PROJECT_HEADER), deflateSync(Buffer.from(text, 'utf8'))])
}

// 记录与 PNG 哈希绑定，未知版本整体忽略
export interface ProjectRecord {
  version: number
  frameHeight?: number
  history?: string
  width: number
  height: number
  pngSha256: string
  sourcePath: string
  activeLayerId?: string
  savedAt: string
  layers: LayerRecord[]
}

export interface RestoredLayers {
  frameHeight?: number
  history?: string
  layers: Layer[]
  activeLayerId?: string
}

export function isDefaultState(doc: PixelDocument): boolean {
  const only = doc.layers[0]
  return doc.layers.length === 1 && !only.randomVariant && only.visible && only.opacity === 1 && only.name === DEFAULT_LAYER_NAME
}

// pngBytes 必须是刚写入磁盘的同一份字节, 打开时哈希才能对上
export function buildProjectText(doc: PixelDocument, pngBytes: Uint8Array, savedAt: Date = new Date(), sourcePath = '', history?: string): string {
  const record: ProjectRecord = {
    version: PROJECT_VERSION,
    frameHeight: doc.frameHeight,
    history,
    width: doc.width,
    height: doc.height,
    pngSha256: sha256Hex(pngBytes),
    sourcePath,
    activeLayerId: doc.activeLayerId,
    savedAt: savedAt.toISOString(),
    layers: doc.layers.map(layer => encodeLayer(layer, doc.width, doc.height))
  }
  return JSON.stringify(record)
}

export function parseProjectText(text: string, pngBytes: Uint8Array, width: number, height: number): RestoredLayers | undefined {
  try {
    const record = JSON.parse(text) as Partial<ProjectRecord>
    if (record.version !== PROJECT_VERSION && record.version !== 4 && record.version !== 3) return undefined
    if (record.frameHeight !== undefined && (!Number.isSafeInteger(record.frameHeight) || record.frameHeight < 1 || height % record.frameHeight)) return undefined
    if (record.width !== width || record.height !== height) return undefined
    if (record.pngSha256 !== sha256Hex(pngBytes)) return undefined
    const layers = decodeLayers(record.layers, width, height)
    const activeLayerId = typeof record.activeLayerId === 'string' ? record.activeLayerId : undefined
    return { layers, activeLayerId, frameHeight: record.frameHeight, history: typeof record.history === 'string' ? record.history : undefined }
  } catch {
    return undefined
  }
}

function relativePathFor(uri: vscode.Uri): string | undefined {
  if (!vscode.workspace.getWorkspaceFolder(uri)) return undefined
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/')
}

// 按路径区分同名文件，编辑数据放在工作区的 .mcrh 里
export function sidecarUriFor(uri: vscode.Uri): vscode.Uri | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri)
  if (!folder) return undefined
  const relative = relativePathFor(uri)
  if (relative === undefined) return undefined
  return vscode.Uri.joinPath(folder.uri, '.mcrh', 'resources', ...relative.split('/').slice(0, -1), relative.split('/').at(-1)! + '.mcrh')
}

// 在异步写入前记下本次编辑内容
export function prepareProjectWrite(target: vscode.Uri, doc: PixelDocument, pngBytes: Uint8Array, history?: string): (() => Promise<void>) | undefined {
  const sidecar = sidecarUriFor(target)
  if (!sidecar) return
  if (isDefaultState(doc) && !history && doc.frameHeight === undefined) return () => removeIfExists(sidecar)
  const sourcePath = relativePathFor(target) ?? ''
  const bytes = encodeProjectText(buildProjectText(doc, pngBytes, new Date(), sourcePath, history))
  return async () => {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(sidecar, '..'))
    const temporary = sidecar.with({ path: sidecar.path + '.' + randomUUID() + '.tmp' })
    try {
      await vscode.workspace.fs.writeFile(temporary, bytes)
      await vscode.workspace.fs.rename(temporary, sidecar, { overwrite: true })
    } finally { await removeIfExists(temporary) }
  }
}

export async function writeProject(target: vscode.Uri, doc: PixelDocument, pngBytes: Uint8Array, history?: string): Promise<void> {
  await prepareProjectWrite(target, doc, pngBytes, history)?.()
}

export async function readProject(target: vscode.Uri, pngBytes: Uint8Array, width: number, height: number): Promise<RestoredLayers | undefined> {
  const sidecar = sidecarUriFor(target)
  if (!sidecar) return undefined
  try {
    let bytes: Uint8Array
    try { bytes = await vscode.workspace.fs.readFile(sidecar) } catch {
      const folder = vscode.workspace.getWorkspaceFolder(target)
      if (!folder) return undefined
      bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, '.mcrh', encodeURIComponent(relativePathFor(target)!) + '.mcrh'))
    }
    if (bytes.length > 64 * 1024 * 1024) return undefined
    const buffer = Buffer.from(bytes)
    const text = /^MCRH[45]\n$/.test(buffer.subarray(0, 6).toString()) ? inflateSync(buffer.subarray(6), { maxOutputLength: 128 * 1024 * 1024 }).toString('utf8') : buffer.toString('utf8')
    return parseProjectText(text, pngBytes, width, height)
  } catch {
    return undefined
  }
}

async function removeIfExists(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.stat(uri)
  } catch {
    return
  }
  try {
    await vscode.workspace.fs.delete(uri)
  } catch {
    // 删除失败不影响写入结果
  }
}
