import { uiText } from '../i18n/messages'
import { REFERENCE_IMAGE_ACCEPT, inspectReferenceImage, isReferenceImageName } from '../core/referenceImageFormats'
import { REFERENCE_LIMITS, referenceAbort, type ReferenceEntry, type ReferenceKind, type ReferenceSource } from '../core/referenceImages'

export class BrowserReferenceSource implements ReferenceSource {
  private readonly files = new Map<string, File>()
  private readonly fileIds = new Map<File, string>()
  private disposed = false
  private generation = 0
  private serial = 0
  private readonly pickers = new Set<() => void>()
  async append(kind: ReferenceKind, signal: AbortSignal, receive: (entries: ReferenceEntry[]) => void): Promise<number> {
    const generation = this.generation
    const check = (): void => {
      referenceAbort(signal)
      if (this.disposed || generation !== this.generation) throw new DOMException(uiText("browser.referenceImages.referenceChartSessionIsClosed"), 'AbortError')
    }
    check()
    const selected = await this.pick(kind, signal)
    check()
    let skipped = 0, batch: Array<{ file: File; entry: ReferenceEntry }> = []
    const staged = new Set<File>()
    const publish = (): void => {
      check()
      if (!batch.length) return
      const current = batch
      batch = []; staged.clear()
      for (const { file, entry } of current) { this.files.set(entry.id, file); this.fileIds.set(file, entry.id) }
      try { receive(current.map(item => item.entry)) } catch (error) {
        for (const { file, entry } of current) {
          if (this.files.get(entry.id) === file) this.files.delete(entry.id)
          if (this.fileIds.get(file) === entry.id) this.fileIds.delete(file)
        }
        throw error
      }
    }
    for (const file of selected) {
      check()
      const name = file.webkitRelativePath || file.name, size = file.size
      if (kind === 'folder' && !file.type.startsWith('image/') && !isReferenceImageName(name)) continue
      if (size < 8 || size > REFERENCE_LIMITS.fileBytes) { skipped++; continue }
      // 文件名元信息不能证明来源，只对同一 File 对象去重
      if (this.fileIds.has(file) || staged.has(file)) continue
      const id = 'local-' + (++this.serial)
      staged.add(file); batch.push({ file, entry: { id, name, size } })
      if (batch.length >= REFERENCE_LIMITS.batchSize) {
        publish()
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
    }
    publish()
    return skipped
  }

  async read(id: string, signal: AbortSignal): Promise<Blob> {
    referenceAbort(signal)
    const file = this.files.get(id), generation = this.generation
    if (!file || this.disposed) throw new Error(uiText("browser.referenceImages.referenceDiagramRemoved"))
    const bytes = new Uint8Array(await file.arrayBuffer())
    referenceAbort(signal)
    if (this.disposed || generation !== this.generation || this.files.get(id) !== file) throw new DOMException(uiText("browser.referenceImages.referenceChartSessionIsClosed"), 'AbortError')
    const info = inspectReferenceImage(bytes)
    return new Blob([bytes], { type: info.mime })
  }
  remove(id: string): void {
    const file = this.files.get(id)
    this.files.delete(id)
    if (file && this.fileIds.get(file) === id) this.fileIds.delete(file)
  }
  clear(): void { this.generation++; for (const cancel of this.pickers) cancel(); this.files.clear(); this.fileIds.clear() }
  dispose(): void { this.disposed = true; this.clear() }
  private pick(kind: ReferenceKind, signal: AbortSignal): Promise<File[]> {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input')
      input.type = 'file'; input.accept = REFERENCE_IMAGE_ACCEPT; input.multiple = true; input.hidden = true
      if (kind === 'folder') input.setAttribute('webkitdirectory', '')
      let settled = false, focusTimer: ReturnType<typeof setTimeout> | undefined
      const finish = (files: File[], error?: unknown): void => {
        if (settled) return
        settled = true; if (focusTimer) clearTimeout(focusTimer)
        signal.removeEventListener('abort', abort); window.removeEventListener('focus', focus)
        this.pickers.delete(cancel); input.remove()
        if (error) reject(error); else resolve(files)
      }
      const abort = (): void => finish([], new DOMException(uiText("browser.referenceImages.referenceChartSelectionCancelled"), 'AbortError'))
      const cancel = (): void => finish([])
      const focus = (): void => { focusTimer = setTimeout(() => { if (!input.files?.length) finish([]) }, 500) }
      input.addEventListener('change', () => finish(Array.from(input.files ?? [])), { once: true })
      input.addEventListener('cancel', cancel, { once: true }); signal.addEventListener('abort', abort, { once: true }); if (!('oncancel' in input)) window.addEventListener('focus', focus)
      this.pickers.add(cancel); document.body.append(input)
      try { referenceAbort(signal); input.click() } catch (error) { finish([], error) }
    })
  }
}
