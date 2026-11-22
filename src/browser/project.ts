import { activeLanguage } from '../i18n/messages'
import { uiText } from '../i18n/messages'
import { filterMcrhEditorData } from '../core/advanced/editorDataExportPolicy'
import type { BrowserPackEntry, BrowserPackMetadata, BrowserPackFormat } from '../core/browserPackProject'
import { textEncoder, type BrowserFile } from './files'
import type { ProjectInfo, ProjectPort } from './projectPort'
import type { ProjectWorkerRequest, ProjectWorkerResponse } from './projectProtocol'

class ProjectWorkerClient {
  private readonly worker = new Worker(new URL('./project-worker.js', location.href))
  private serial = 0
  private readonly pending = new Map<number, { resolve(value: ProjectWorkerResponse): void; reject(error: Error): void }>()
  constructor() {
    this.worker.postMessage(activeLanguage())
    this.worker.addEventListener('message', (event: MessageEvent<ProjectWorkerResponse>) => { const response = event.data, pending = this.pending.get(response.id); if (!pending) return; this.pending.delete(response.id); if (response.ok) pending.resolve(response); else pending.reject(new Error(response.error || uiText("browser.project.projectProcessingFailed"))) })
    this.worker.addEventListener('error', () => this.dispose(uiText("browser.project.projectWorkFailedReImportLocalZip")))
  }
  request(input: Omit<ProjectWorkerRequest, 'id'>, signal?: AbortSignal): Promise<ProjectWorkerResponse> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error(uiText("browser.packToolsBridge.operationCanceled"))); return }
      const id = ++this.serial
      const abort = () => this.dispose(uiText("browser.project.operationCancelledCurrentItemNotReplaced"))
      this.pending.set(id, { resolve: value => { signal?.removeEventListener('abort', abort); resolve(value) }, reject: error => { signal?.removeEventListener('abort', abort); reject(error) } })
      signal?.addEventListener('abort', abort, { once: true })
      const transfers: ArrayBuffer[] = []
      if (input.bytes) transfers.push(input.bytes.buffer as ArrayBuffer)
      for (const file of input.files ?? []) transfers.push(file.data.buffer as ArrayBuffer)
      this.worker.postMessage({ ...input, id }, transfers)
    })
  }
  dispose(reason = uiText("browser.project.itemReplaced")): void { this.worker.terminate(); for (const pending of this.pending.values()) pending.reject(new Error(reason)); this.pending.clear() }
}
function formatText(format?: BrowserPackFormat): string | undefined { if (format === undefined) return undefined; if (typeof format === 'number') return String(format); if ('major' in format) return format.major + '.' + format.minor; return format.join('.') }

export class BrowserProjectStore implements ProjectPort {
  private client = new ProjectWorkerClient()
  private readonly entries = new Map<string, BrowserPackEntry>()
  private metadata: BrowserPackMetadata = { name: uiText("browser.project.untitledResourcePack") }
  private names: string[] = []
  private totalBytes = 0
  private dirty = false
  private busy = false
  private revisionValue = 0
  get revision(): number { return this.revisionValue }
  private assertRevision(expected: number): void { if (expected !== this.revision) throw new Error(uiText("browser.project.projectHasChangedPleaseRestart")) }
  info(): ProjectInfo { return { name: this.metadata.name, version: this.metadata.version, fileCount: this.names.length, bytes: this.totalBytes, resourceFormat: formatText(this.metadata.packFormat), dirty: this.dirty } }
  paths(): readonly string[] { return this.names }
  read(path: string): Uint8Array | undefined { return this.entries.get(path)?.data.slice() }
  private accept(response: ProjectWorkerResponse, replace = false): void {
    if (replace) this.entries.clear()
    for (const entry of response.entries ?? response.changed ?? []) this.entries.set(entry.path, entry)
    if (response.metadata) this.metadata = response.metadata
    this.revisionValue++
    this.names = [...this.entries.keys()].sort(); this.totalBytes = [...this.entries.values()].reduce((size, entry) => size + entry.data.length, 0)
  }
  private assertIdle(): void { if (this.busy) throw new Error(uiText("browser.project.processingPleaseWaitForCompletionOrCancellation")) }
  async initialize(): Promise<void> { this.accept(await this.client.request({ operation: 'initialize' }), true) }
  async apply(files: readonly BrowserFile[], expectedRevision = this.revision): Promise<void> {
    this.assertRevision(expectedRevision); this.assertIdle(); this.busy = true
    try {
      const staged = files.map(file => ({ path: file.path, data: typeof file.content === 'string' ? textEncoder.encode(file.content) : file.content }))
        .filter(file => { const current = this.entries.get(file.path)?.data; return !current || current.length !== file.data.length || !current.every((byte, index) => byte === file.data[index]) })
        .map(file => ({ path: file.path, data: file.data.slice() }))
      if (!staged.length) return
      const response = await this.client.request({ operation: 'apply', files: staged }); this.assertRevision(expectedRevision); this.accept(response); this.dirty = true
    }
    finally { this.busy = false }
  }
  async startBlank(version: string, name?: string): Promise<void> { this.assertIdle(); this.busy = true; try { this.accept(await this.client.request({ operation: 'blank', version, name }), true); this.dirty = true } finally { this.busy = false } }
  async importArchive(bytes: Uint8Array, name: string, vanilla: boolean, version?: string, signal?: AbortSignal): Promise<void> {
    this.assertIdle(); this.busy = true
    const candidate = new ProjectWorkerClient()
    try { const response = await candidate.request({ operation: 'import', bytes: bytes.slice(), name, vanilla, version }, signal); signal?.throwIfAborted(); const previous = this.client; this.client = candidate; this.accept(response, true); this.dirty = true; previous.dispose() }
    catch (error) { candidate.dispose(); throw error }
    finally { this.busy = false }
  }
  packToolsEntries(): BrowserPackEntry[] {
    this.assertIdle()
    return [...this.entries.values()].map(entry => ({ ...entry, data: entry.data.slice() }))
  }
  exportFiles(): readonly BrowserFile[] {
    this.assertIdle()
    const include = document.querySelector<HTMLInputElement>('#export-include-vanilla')?.checked ?? false
    const files = new Map([...this.entries.values()].filter(entry => include || entry.origin !== 'vanilla' || entry.modified || entry.path === 'pack.mcmeta').map(entry => [entry.path, entry]))
    for (const path of [...files.keys()]) { const paired = /\.png$/i.test(path) ? this.entries.get(path + '.mcmeta') : /\.png\.mcmeta$/i.test(path) ? this.entries.get(path.slice(0, -7)) : undefined; if (/\.png\.mcmeta$/i.test(path) && !paired) throw new Error(uiText("browser.project.pngAnimatedMetadataMissingMatchingPaste")); if (paired) files.set(paired.path, paired) }
    return filterMcrhEditorData([...files.values()].map(entry => ({ path: entry.path, content: entry.data.slice() })), { includeMcrhEditorData: document.querySelector<HTMLInputElement>('#export-include-mcrh')?.checked ?? false }).files
  }
  async exportZip(signal?: AbortSignal, expectedRevision = this.revision): Promise<Uint8Array> { this.assertRevision(expectedRevision); this.assertIdle(); this.busy = true; try { const response = await this.client.request({ operation: 'export', includeMcrhEditorData: document.querySelector<HTMLInputElement>('#export-include-mcrh')?.checked ?? false, includeVanillaTextures: document.querySelector<HTMLInputElement>('#export-include-vanilla')?.checked ?? false }, signal); this.assertRevision(expectedRevision); return response.bytes! } finally { this.busy = false } }
  markExported(expectedRevision: number): void { this.assertRevision(expectedRevision); this.dirty = false }
}
