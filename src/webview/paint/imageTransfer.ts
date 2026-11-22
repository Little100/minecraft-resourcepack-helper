import { uiText } from '../../i18n/messages'
import { imageUrisFromPayload, MAX_IMAGE_IMPORT_FILES } from '../../core/imageImportUris'

export interface ImageTransferActions {
  root: HTMLElement
  importFiles(files: File[]): void
  importUris(uris: string[]): void
  copyPixels(): void
  pastePixels(): void
  preferPixelPaste?(): boolean
  cancelTransform(): boolean
  notify(message: string): void
}

const uriTypes = new Set(['text/uri-list', 'application/vnd.code.uri-list', 'resourceurls', 'codefiles'])
export function imageFile(file: File): boolean {
  return /^image\/(?:png|jpeg|webp)$/.test(file.type) || /\.(?:png|jpe?g|webp)$/i.test(file.name)
}
function textTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable=false])'))
}
function imageFiles(data: DataTransfer): File[] {
  const files = [...data.files].filter(imageFile).slice(0, MAX_IMAGE_IMPORT_FILES)
  for (const item of data.items) {
    if (files.length >= MAX_IMAGE_IMPORT_FILES) break
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file && imageFile(file) && !files.some(existing => existing === file || existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified)) files.push(file)
  }
  return files
}
function localUris(data: DataTransfer): string[] {
  const result = new Set<string>()
  for (const type of data.types) {
    if (!uriTypes.has(type.toLowerCase()) && type.toLowerCase() !== 'text/plain') continue
    for (const uri of imageUrisFromPayload(data.getData(type))) {
      result.add(uri)
      if (result.size >= MAX_IMAGE_IMPORT_FILES) return [...result]
    }
  }
  return [...result]
}

// 面板已经接收的拖放不再转给扩展
export function attachImageTransfer(actions: ImageTransferActions): () => void {
  const controller = new AbortController(), options = { capture: true, signal: controller.signal }
  const draggingFiles = (event: DragEvent): boolean => {
    const data = event.dataTransfer
    if (!data) return false
    const types = [...data.types].map(type => type.toLowerCase())
    return types.some(type => type === 'files' || uriTypes.has(type)) || [...data.items].some(item => item.kind === 'file') || types.includes('text/plain') && !textTarget(event.target)
  }
  const stop = (event: Event): void => { event.preventDefault(); event.stopImmediatePropagation() }
  const reset = (): void => { actions.root.classList.remove('mp-import-drag') }
  const importData = (data: DataTransfer): boolean => {
    const files = imageFiles(data)
    if (files.length) { actions.importFiles(files); return true }
    const uris = localUris(data)
    if (uris.length) { actions.importUris(uris); return true }
    return false
  }
  window.addEventListener('dragenter', event => {
    if (!draggingFiles(event)) return
    stop(event); actions.root.classList.add('mp-import-drag')
  }, options)
  window.addEventListener('dragover', event => {
    if (!draggingFiles(event)) return
    stop(event)
    event.dataTransfer!.dropEffect = 'copy'
  }, options)
  window.addEventListener('dragleave', event => { if (!(event.relatedTarget instanceof Node) || !actions.root.contains(event.relatedTarget)) reset() }, options)
  window.addEventListener('dragend', reset, options)
  window.addEventListener('drop', event => {
    reset()
    if (!draggingFiles(event)) return
    stop(event)
    if (event.dataTransfer && !importData(event.dataTransfer)) actions.notify(uiText("webview.paint.imageTransfer.dragIntoPngJpegOrWebpPictures"))
  }, options)
  window.addEventListener('paste', event => {
    if (textTarget(event.target) || textTarget(document.activeElement)) return
    stop(event)
    if (actions.preferPixelPaste?.() || !event.clipboardData || !importData(event.clipboardData)) actions.pastePixels()
  }, options)
  window.addEventListener('keydown', event => {
    if (event.isComposing || textTarget(event.target) || textTarget(document.activeElement)) return
    if (event.key === 'Escape' && actions.cancelTransform()) { stop(event); return }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'c') { stop(event); actions.copyPixels() }
  }, options)
  window.addEventListener('blur', reset, { signal: controller.signal })
  return () => { controller.abort(); reset() }
}

export async function clipboardImage(): Promise<File | undefined> {
  if (!navigator.clipboard?.read) return undefined
  for (const item of await navigator.clipboard.read()) {
    const type = item.types.find(type => /^image\/(?:png|jpeg|webp)$/.test(type))
    if (type) return new File([await item.getType(type)], uiText("webview.paint.imageTransfer.pastePictures", (type === 'image/jpeg' ? 'jpg' : type.slice(6))), { type })
  }
  return undefined
}
