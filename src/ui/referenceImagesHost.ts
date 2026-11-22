import { uiText } from '../i18n/messages'
import { REFERENCE_IMAGE_EXTENSIONS } from '../core/referenceImageFormats'
import * as vscode from 'vscode'
import * as path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import { REFERENCE_LIMITS, referenceAbort, type ReferenceEntry, type ReferenceLayout, type ReferenceReply, type ReferenceRequest } from '../core/referenceImages'
import { readReferenceFile, registerReferenceFile, walkReferenceFolder, type ReferenceFile } from '../core/referenceFiles'

const layoutSchema = z.object({ x: z.number().finite().min(0).max(1000000), y: z.number().finite().min(0).max(1000000), width: z.number().finite().min(8).max(262144), hidden: z.boolean(), locked: z.boolean(), pinned: z.boolean() }).strict()
const savedReference = z.object({ id: z.string().uuid(), name: z.string().min(1).max(8192), size: z.number().int().min(0), path: z.string().min(1).max(32768), layout: layoutSchema.optional() }).strict()
interface ReferencePersistence { state: Pick<vscode.Memento, 'get' | 'update'>; key: string }
export const referenceStorageKey = (uri: vscode.Uri): string => 'mcrh.references.' + createHash('sha256').update(uri.toString()).digest('hex')
interface ReferenceWebview { postMessage(message: unknown): PromiseLike<boolean> }
export class ReferenceImagesHost {
  private token?: string
  private disposed = false
  private generation = 0
  private choosing = false
  private readTail = Promise.resolve()
  private readonly files = new Map<string, ReferenceFile>()
  private readonly paths = new Map<string, string>()
  private readonly operations = new Map<string, AbortController>()
  private readonly entries = new Map<string, ReferenceEntry>()
  private readonly savedPaths = new Map<string, string>()
  private initialized?: Promise<void>
  private saving = Promise.resolve()
  constructor(private readonly webview: ReferenceWebview, private readonly persistence?: ReferencePersistence) {}

  private initialize(): Promise<void> {
    this.initialized ??= (async () => {
      const stored = this.persistence?.state.get<unknown>(this.persistence.key)
      if (!Array.isArray(stored)) return
      for (const item of stored) {
        const parsed = savedReference.safeParse(item)
        if (!parsed.success || this.disposed) continue
        const { path: filename, ...entry } = parsed.data
        this.savedPaths.set(entry.id, filename)
        try {
          const file = await registerReferenceFile(filename, new AbortController().signal)
          if (this.disposed) return
          this.files.set(entry.id, file); this.paths.set(process.platform === 'win32' ? file.path.toLowerCase() : file.path, entry.id)
          this.entries.set(entry.id, { ...entry, size: file.stamp.size })
        } catch { if (!this.disposed) this.entries.set(entry.id, entry) }
      }
      if (this.entries.size) this.token ??= randomUUID()
    })()
    return this.initialized
  }
  private persist(): Promise<void> {
    if (!this.persistence) return Promise.resolve()
    const records = [...this.entries.values()].map(entry => {
      const file = this.files.get(entry.id)
      return { ...entry, layout: entry.layout ? { ...entry.layout } : undefined, path: file?.path ?? this.savedPaths.get(entry.id) }
    }).filter(entry => entry.path)
    this.saving = this.saving.catch(() => undefined).then(async () => { await this.persistence!.state.update(this.persistence!.key, records) })
    return this.saving
  }
  async catalog(): Promise<ReferenceEntry[]> { await this.initialize(); return [...this.entries.values()].map(entry => ({ ...entry })) }
  async readApproved(id: string): Promise<Uint8Array> {
    await this.initialize()
    const file = this.files.get(id)
    if (!file || this.disposed) throw new Error(uiText("ui.referenceImagesHost.theReferenceChartDoesNotExistIs"))
    return readReferenceFile(file, new AbortController().signal)
  }


  async handle(raw: unknown): Promise<boolean> {
    if (!raw || typeof raw !== 'object' || (raw as { command?: unknown }).command !== 'referenceImages') return false
    const request = raw as ReferenceRequest
    if (this.disposed || typeof request.requestId !== 'string' || !/^[\w-]{1,100}$/.test(request.requestId)) return true
    const reply = async (data: Omit<ReferenceReply, 'command' | 'requestId'>): Promise<void> => {
      if (!this.disposed) await this.webview.postMessage({ command: 'referenceImagesResult', requestId: request.requestId, ...data })
    }
    if (request.operation === 'cancel') {
      if (typeof request.target === 'string') this.operations.get(request.target)?.abort()
      return true
    }
    const controller = new AbortController(), generation = this.generation
    if (this.operations.has(request.requestId)) return true
    if (this.operations.size >= 16) { await reply({ done: true, error: uiText("ui.referenceImagesHost.tooManyRequestsForReferenceDiagramsPlease") }); return true }
    this.operations.set(request.requestId, controller)
    const check = (): void => {
      referenceAbort(controller.signal)
      if (this.disposed || generation !== this.generation) throw new DOMException(uiText("browser.referenceImages.referenceChartSessionIsClosed"), 'AbortError')
    }
    try {
      await this.initialize(); check()
      if (request.operation === 'restore') {
        if (this.entries.size) this.token ??= randomUUID()
        const entries = [...this.entries.values()]
        for (let offset = 0; offset < entries.length; offset += REFERENCE_LIMITS.batchSize) { check(); await reply({ done: false, token: this.token, entries: entries.slice(offset, offset + REFERENCE_LIMITS.batchSize) }) }
        await reply({ done: true, token: this.token })
      } else if (request.operation === 'choose') {
        if (this.choosing) throw new Error(uiText("ui.referenceImagesHost.theReferenceChartSelectionIsInProgress"))
        if (request.kind !== 'files' && request.kind !== 'folder') throw new Error(uiText("ui.referenceImagesHost.invalidDiagramSelection"))
        this.choosing = true
        const unpublished = new Set<string>()
        try {
          const folder = request.kind === 'folder'
          const selected = await vscode.window.showOpenDialog({ title: folder ? uiText("ui.referenceImagesHost.appendReferenceFolders") : uiText("ui.referenceImagesHost.additionalReferencePictures"), canSelectFiles: !folder, canSelectFolders: folder, canSelectMany: !folder, filters: folder ? undefined : { [uiText("ui.referenceImagesHost.picture")]: REFERENCE_IMAGE_EXTENSIONS, [uiText("ui.referenceImagesHost.allFiles")]: ['*'] }, openLabel: uiText("ui.referenceImagesHost.additionalReferenceDiagram") })
          check()
          if (!selected?.length) { await reply({ done: true, skipped: 0 }); return true }
          if (selected.some(uri => uri.scheme !== 'file')) throw new Error(uiText("ui.referenceImagesHost.referenceDiagramOnlySupportsLocalFiles"))
          this.token ??= randomUUID()
          await reply({ done: false, token: this.token })
          check()
          const base = folder ? selected[0].fsPath : commonParent(selected.map(uri => uri.fsPath))
          const iterable = folder ? walkReferenceFolder(base, controller.signal) : selected.map(uri => uri.fsPath)
          let batch: ReferenceEntry[] = [], skipped = 0
          for await (const filename of iterable) {
            check()
            const key = process.platform === 'win32' ? path.resolve(filename).toLowerCase() : path.resolve(filename)
            if (this.paths.has(key)) continue
            try {
              const file = await registerReferenceFile(filename, controller.signal)
              check()
              const id = randomUUID(), local = path.relative(base, file.path)
              const relative = (path.isAbsolute(local) ? path.basename(file.path) : local).split(path.sep).join('/')
              this.files.set(id, file); this.paths.set(key, id); unpublished.add(id)
              const entry = { id, name: folder ? path.basename(base) + '/' + relative : relative, size: file.stamp.size }
              this.entries.set(id, entry); this.savedPaths.set(id, file.path); batch.push(entry)
              if (batch.length >= REFERENCE_LIMITS.batchSize) { await this.persist(); check(); await reply({ done: false, token: this.token, entries: batch }); unpublished.clear(); batch = []; check() }
            } catch { check(); skipped++ }
          }
          check()
          await this.persist(); check()
          await reply({ done: true, token: this.token, entries: batch, skipped })
          unpublished.clear()
        } finally {
          for (const id of unpublished) {
            const file = this.files.get(id)
            if (!file) continue
            this.files.delete(id); this.entries.delete(id); this.savedPaths.delete(id)
            const key = process.platform === 'win32' ? file.path.toLowerCase() : file.path
            if (this.paths.get(key) === id) this.paths.delete(key)
          }
          if (!this.disposed && generation === this.generation && unpublished.size) await this.persist()
          this.choosing = false
        }
      } else {
        if (!this.token || request.token !== this.token) throw new Error(uiText("ui.referenceImagesHost.referenceSessionIsNotAuthorizedUseThe"))
        if (request.operation === 'read') {
          const file = typeof request.id === 'string' ? this.files.get(request.id) : undefined
          if (!file) throw new Error(uiText("ui.referenceImagesHost.referenceDiagramDoesNotExistOrHas"))
          const previous = this.readTail
          let release!: () => void
          this.readTail = new Promise<void>(resolve => { release = resolve })
          try {
            await previous
            check()
            const bytes = await readReferenceFile(file, controller.signal)
            check()
            if (this.files.get(request.id!) !== file) throw new Error(uiText("browser.referenceImages.referenceDiagramRemoved"))
            await reply({ done: true, base64: Buffer.from(bytes).toString('base64') })
          } finally { release() }
        } else if (request.operation === 'remove') {
          const file = typeof request.id === 'string' ? this.files.get(request.id) : undefined
          if (file) { this.files.delete(request.id!); this.paths.delete(process.platform === 'win32' ? file.path.toLowerCase() : file.path) }
          if (typeof request.id === 'string') { this.entries.delete(request.id); this.savedPaths.delete(request.id) }
          await this.persist(); await reply({ done: true })
        } else if (request.operation === 'layout') {
          const entry = typeof request.id === 'string' ? this.entries.get(request.id) : undefined
          if (!entry) throw new Error(uiText("ui.referenceImagesHost.referenceDiagramDoesNotExistOrHas"))
          entry.layout = layoutSchema.parse(request.layout) as ReferenceLayout
          await this.persist(); await reply({ done: true })
        } else if (request.operation === 'clear') {
          this.reset(); await this.persist(); await reply({ done: true })
        } else if (request.operation === 'dispose') {
          await this.saving; await reply({ done: true }); this.dispose()
        } else throw new Error(uiText("ui.referenceImagesHost.theReferenceDiagramOperationIsInvalid"))
      }
    } catch (error) {
      await reply({ done: true, error: error instanceof Error ? error.message : uiText("ui.referenceImagesHost.referenceChartOperationFailed") })
    } finally { this.operations.delete(request.requestId) }
    return true
  }
  private reset(): void {
    this.generation++; this.token = undefined
    for (const operation of this.operations.values()) operation.abort()
    this.files.clear(); this.paths.clear(); this.entries.clear(); this.savedPaths.clear()
  }
  dispose(): void { this.disposed = true; this.reset() }
}
function commonParent(filenames: string[]): string {
  let base = path.dirname(filenames[0])
  for (const filename of filenames) {
    while (path.relative(base, filename).startsWith('..' + path.sep) || path.isAbsolute(path.relative(base, filename))) {
      const parent = path.dirname(base)
      if (parent === base) return path.dirname(filenames[0])
      base = parent
    }
  }
  return base
}
