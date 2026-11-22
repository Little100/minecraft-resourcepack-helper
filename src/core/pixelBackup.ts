import { uiText } from '../i18n/messages'
import { PixelDocument } from './document'
import { decodeLayers, encodeLayer, type LayerRecord } from './pixelCodec'

export const BACKUP_VERSION = 4

interface BackupRecord {
  version: number
  kind: 'backup'
  frameHeight?: number
  width: number
  height: number
  activeLayerId?: string
  png: string
  layers: LayerRecord[]
}

export function buildBackupText(doc: PixelDocument): string {
  const record: BackupRecord = {
    version: BACKUP_VERSION,
    kind: 'backup',
    frameHeight: doc.frameHeight,
    width: doc.width,
    height: doc.height,
    activeLayerId: doc.activeLayerId,
    png: doc.toPng().toString('base64'),
    layers: doc.layers.map(layer => encodeLayer(layer, doc.width, doc.height))
  }
  return JSON.stringify(record)
}

// 合成结果与备份 PNG 不一致时，改用磁盘文件
export function parseBackupText(text: string): PixelDocument {
  const record = JSON.parse(text) as Partial<BackupRecord>
  if ((record.version !== BACKUP_VERSION && record.version !== 2 && record.version !== 3) || record.kind !== 'backup') throw new Error(uiText("core.pixelBackup.backupVersionIsNotCompatible"))
  if (!Number.isInteger(record.width) || !Number.isInteger(record.height)) throw new Error(uiText("core.pixelBackup.backupSizeInvalid"))
  const width = record.width as number
  const height = record.height as number
  const layers = decodeLayers(record.layers, width, height)
  const doc = PixelDocument.fromLayers(width, height, layers, record.activeLayerId)
  doc.frameHeight = record.frameHeight
  const png = Buffer.from(typeof record.png === 'string' ? record.png : '', 'base64')
  if (png.length === 0) throw new Error(uiText("core.pixelBackup.backupMissingSyntheticImages"))
  const composite = PixelDocument.fromPng(new Uint8Array(png))
  if (composite.width !== width || composite.height !== height) throw new Error(uiText("core.pixelBackup.backupCompositesDoNotMatchSize"))
  if (Buffer.compare(Buffer.from(composite.layers[0].pixels), Buffer.from(doc.flatten(record.version !== BACKUP_VERSION))) !== 0) {
    throw new Error(uiText("core.pixelBackup.backupLayerIsInconsistentWithSyntheticMap"))
  }
  return doc
}
