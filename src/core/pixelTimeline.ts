import { uiText } from '../i18n/messages'
import { deflateSync, inflateSync } from 'node:zlib'
import { decodeLayers, encodeLayer } from './pixelCodec'
import { assertEditSize } from './pixelTransforms'
import type { DocumentSnapshot } from './document'
export interface TimelineEntry { id: number; label: string; at: string; data: string }
export class PixelTimeline {
  entries: TimelineEntry[] = []
  current = -1
  private sequence = 0
  constructor(initial: DocumentSnapshot) { this.add(uiText("core.pixelTimeline.openPaste"), initial) }
  reset(initial: DocumentSnapshot, history?: string): void {
    this.entries = []; this.current = -1; this.sequence = 0
    this.add(uiText("core.pixelTimeline.openPaste"), initial)
    if (history) { try { this.restore(history) } catch {} }
  }
  add(label: string, snapshot: DocumentSnapshot): number {
    const data = deflateSync(Buffer.from(JSON.stringify({ ...snapshot, layers: snapshot.layers.map(layer => encodeLayer(layer, snapshot.width, snapshot.height)) }))).toString('base64')
    const id = ++this.sequence
    this.entries = this.entries.slice(0, this.current + 1)
    this.entries.push({ id, label, at: new Date().toISOString(), data })
    while (this.entries.length > 1 && (this.entries.length > 100 || this.entries.reduce((sum, value) => sum + value.data.length, 0) > 32 * 1024 * 1024)) this.entries.shift()
    this.current = this.entries.length - 1
    return id
  }
  point(id: number): void { this.current = this.entries.findIndex(entry => entry.id === id) }
  read(id: number): DocumentSnapshot {
    const entry = this.entries.find(value => value.id === id)
    if (!entry) throw new Error(uiText("core.pixelTimeline.theHistoryOfPaintingHasExpired"))
    const value = JSON.parse(inflateSync(Buffer.from(entry.data, 'base64'), { maxOutputLength: 128 * 1024 * 1024 }).toString('utf8'))
    assertEditSize(value.width, value.height, value.layers?.length)
    if (value.frameHeight !== undefined && (!Number.isSafeInteger(value.frameHeight) || value.frameHeight < 1 || value.height % value.frameHeight)) throw new Error(uiText("core.pixelTimeline.historicFrameIsInvalid"))
    return { width: value.width, height: value.height, frameHeight: value.frameHeight, activeLayerId: value.activeLayerId, layers: decodeLayers(value.layers, value.width, value.height) }
  }
  serialize(): string { return JSON.stringify({ version: 1, entries: this.entries, current: this.current }) }
  restore(text: string): void {
    if (text.length > 34 * 1024 * 1024) throw new Error(uiText("core.pixelTimeline.historyRecordExceededBudget"))
    const value = JSON.parse(text)
    if (value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 100 || !Number.isInteger(value.current) || value.current < -1 || value.current >= value.entries.length) throw new Error(uiText("core.pixelTimeline.theHistoricalRecordFormatIsInvalid"))
    const entries = value.entries as TimelineEntry[]
    if (entries.some(entry => !Number.isSafeInteger(entry.id) || typeof entry.label !== 'string' || entry.label.length > 120 || typeof entry.at !== 'string' || typeof entry.data !== 'string') || new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error(uiText("core.pixelTimeline.historyRecordEntryInvalid"))
    const old = this.entries; this.entries = entries
    try { for (const entry of entries) this.read(entry.id) } catch (error) { this.entries = old; throw error }
    this.current = value.current; this.sequence = Math.max(...entries.map(entry => entry.id))
  }
}
