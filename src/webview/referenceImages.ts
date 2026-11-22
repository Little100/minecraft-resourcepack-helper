import { uiText } from '../i18n/messages'
import { inspectReferenceImage } from '../core/referenceImageFormats'
import { REFERENCE_LIMITS, referenceAbort, type ReferenceEntry, type ReferenceKind, type ReferenceLayout, type ReferenceReply, type ReferenceRequest, type ReferenceSource } from '../core/referenceImages'

interface Pending {
  receive?: (entries: ReferenceEntry[]) => void
  resolve(reply: ReferenceReply): void
  reject(error: unknown): void
  cleanup(): void
}
export class HostReferenceSource implements ReferenceSource {
  private token?: string
  private disposed = false
  private serial = 0
  private readonly prefix = 'reference-' + Math.random().toString(36).slice(2) + '-'
  private readonly pending = new Map<string, Pending>()
  private readonly listener = (event: MessageEvent): void => {
    const reply = event.data as ReferenceReply | undefined
    if (!reply || reply.command !== 'referenceImagesResult' || typeof reply.requestId !== 'string') return
    const pending = this.pending.get(reply.requestId)
    if (!pending) return
    if (reply.token) this.token = reply.token
    if (reply.entries?.length) pending.receive?.(reply.entries)
    if (reply.done) {
      this.pending.delete(reply.requestId); pending.cleanup()
      if (reply.error) pending.reject(new Error(reply.error)); else pending.resolve(reply)
    }
  }
  constructor(private readonly post: (request: ReferenceRequest) => void) { window.addEventListener('message', this.listener) }
  async restore(signal: AbortSignal, receive: (entries: ReferenceEntry[]) => void): Promise<void> { await this.request({ operation: 'restore' }, signal, receive) }
  saveLayout(id: string, layout: ReferenceLayout): void { if (this.token) this.send({ operation: 'layout', id, layout }) }
  async append(kind: ReferenceKind, signal: AbortSignal, receive: (entries: ReferenceEntry[]) => void): Promise<number> {
    const reply = await this.request({ operation: 'choose', kind }, signal, receive)
    return reply.skipped ?? 0
  }
  async read(id: string, signal: AbortSignal): Promise<Blob> {
    const reply = await this.request({ operation: 'read', id }, signal)
    referenceAbort(signal)
    if (typeof reply.base64 !== 'string' || reply.base64.length > Math.ceil(REFERENCE_LIMITS.fileBytes / 3) * 4) throw new Error(uiText("webview.referenceImages.invalidReadingResultForReferenceDiagrams"))
    const bytes = Uint8Array.from(atob(reply.base64), character => character.charCodeAt(0))
    const info = inspectReferenceImage(bytes)
    return new Blob([bytes], { type: info.mime })
  }
  remove(id: string): void { if (this.token) this.send({ operation: 'remove', id }) }
  clear(): void {
    for (const [requestId, pending] of this.pending) {
      this.send({ operation: 'cancel', target: requestId }); pending.cleanup(); pending.reject(new DOMException(uiText("core.referenceImages.referenceDiagramOperationCancelled"), 'AbortError'))
    }
    this.pending.clear()
    if (this.token) this.send({ operation: 'clear' })
    this.token = undefined
  }
  dispose(): void {
    if (this.disposed) return
    for (const [requestId, pending] of this.pending) { this.send({ operation: 'cancel', target: requestId }); pending.cleanup(); pending.reject(new DOMException(uiText("webview.referenceImages.referencePageClosed"), 'AbortError')) }
    this.pending.clear(); if (this.token) this.send({ operation: 'dispose' }); this.disposed = true; window.removeEventListener('message', this.listener)
  }
  private send(data: Omit<ReferenceRequest, 'command' | 'requestId'>): string {
    const requestId = this.prefix + (++this.serial)
    this.post({ command: 'referenceImages', requestId, token: this.token, ...data })
    return requestId
  }
  private request(data: Omit<ReferenceRequest, 'command' | 'requestId'>, signal: AbortSignal, receive?: (entries: ReferenceEntry[]) => void): Promise<ReferenceReply> {
    referenceAbort(signal)
    if (this.disposed) return Promise.reject(new Error(uiText("webview.referenceImages.referencePanelClosed")))
    return new Promise((resolve, reject) => {
      const requestId = this.prefix + (++this.serial)
      const abort = (): void => {
        this.pending.delete(requestId); this.send({ operation: 'cancel', target: requestId })
        signal.removeEventListener('abort', abort); reject(new DOMException(uiText("core.referenceImages.referenceDiagramOperationCancelled"), 'AbortError'))
      }
      this.pending.set(requestId, { receive, resolve, reject, cleanup: () => signal.removeEventListener('abort', abort) })
      signal.addEventListener('abort', abort, { once: true })
      this.post({ command: 'referenceImages', requestId, token: this.token, ...data })
    })
  }
}
