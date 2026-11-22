import { uiText } from '../i18n/messages'
import * as path from 'node:path'
import { MAX_PNG_EDGE, MAX_PNG_PIXELS } from './document'

export interface PreviewDisposable { dispose(): void }
export interface TexturePreviewRegistration extends PreviewDisposable { changed(): void; activate(): void }
export interface TexturePreviewPixels { width: number; height: number; pixels: Uint8Array }
export interface TexturePreviewSnapshot extends TexturePreviewPixels { uri: string; revision: number }
export type TexturePreviewEvent =
  | { type: 'active'; uri: string }
  | { type: 'texture'; uri: string; revision: number; reason: 'change' | 'close' }

type Source = { size?: () => { width: number; height: number }; read(): TexturePreviewPixels; revision: number; snapshot?: TexturePreviewSnapshot }

export function previewPathKey(uri: string): string {
  const resolved = path.resolve(uri)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

// 仅跟随贴图与实际模型资源，普通文本和预览面板不会改变目标
export function isPreviewResource(uri: string): boolean {
  const normalized = uri.replace(/\\/g, '/')
  return /\.png$/i.test(normalized) || /\/assets\/[^/]+\/(?:models|blockstates|items)\/.+\.json$/i.test(normalized)
}

export class TexturePreviewState {
  private readonly sources = new Map<string, Source[]>()
  private readonly listeners = new Set<(event: TexturePreviewEvent) => void>()
  private revision = 0
  activeUri?: string

  activate(uri: string): boolean {
    if (!isPreviewResource(uri)) return false
    if (this.activeUri && previewPathKey(this.activeUri) === previewPathKey(uri)) return false
    this.activeUri = uri
    this.emit({ type: 'active', uri })
    return true
  }

  // 同一文件有多个编辑器时预览正在编辑的那份
  register(uri: string, readPixels: () => TexturePreviewPixels, readSize?: () => { width: number; height: number }): TexturePreviewRegistration {
    const key = previewPathKey(uri), source: Source = { read: readPixels, size: readSize, revision: ++this.revision }
    const sources = this.sources.get(key) ?? []
    sources.push(source)
    this.sources.set(key, sources)
    this.emit({ type: 'texture', uri, revision: source.revision, reason: 'change' })
    return {
      changed: () => {
        if (!sources.includes(source)) return
        this.changeSource(uri, source, sources.at(-1) === source)
      },
      activate: () => {
        const index = sources.indexOf(source)
        if (index < 0) return
        if (index !== sources.length - 1) {
          sources.splice(index, 1); sources.push(source)
          this.changeSource(uri, source, true)
        }
        this.activate(uri)
      },
      dispose: () => {
        const index = sources.indexOf(source)
        if (index < 0) return
        const selected = index === sources.length - 1
        sources.splice(index, 1)
        if (!sources.length) this.sources.delete(key)
        if (!selected) return
        const remaining = sources.at(-1)
        if (remaining) this.changeSource(uri, remaining, true)
        else this.emit({ type: 'texture', uri, revision: ++this.revision, reason: 'close' })
      }
    }
  }

  changed(uri: string): void {
    const source = this.sources.get(previewPathKey(uri))?.at(-1)
    if (source) this.changeSource(uri, source, true)
  }

  private changeSource(uri: string, source: Source, selected: boolean): void {
    source.revision = ++this.revision
    source.snapshot = undefined
    if (selected) this.emit({ type: 'texture', uri, revision: source.revision, reason: 'change' })
  }

  // 打开预览才读取像素，内容不变就用缓存
  read(uri: string, maxPixels = MAX_PNG_PIXELS): TexturePreviewSnapshot | undefined {
    if (!Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > MAX_PNG_PIXELS) throw new Error(uiText("core.texturePreviewState.memoryPasteReadBudgetInvalid"))
    const source = this.sources.get(previewPathKey(uri))?.at(-1)
    if (!source) return undefined
    const checkSize = (value: { width: number; height: number }): void => {
      if (!Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) || value.width < 1 || value.height < 1 || value.width > MAX_PNG_EDGE || value.height > MAX_PNG_EDGE || value.width * value.height > maxPixels) throw new Error(uiText("core.texturePreviewState.memoryStickerSizeIsInvalidOrExceeds"))
    }
    if (source.snapshot) checkSize(source.snapshot)
    else {
      if (source.size) checkSize(source.size())
      else if (maxPixels < MAX_PNG_PIXELS) throw new Error(uiText("core.texturePreviewState.theMemoryStickerSourceDidNotProvide"))
      const value = source.read()
      checkSize(value)
      if (!(value.pixels instanceof Uint8Array) || value.pixels.length !== value.width * value.height * 4) throw new Error(uiText("core.texturePreviewState.invalidMemoryPasteImageLength"))
      source.snapshot = { uri, revision: source.revision, width: value.width, height: value.height, pixels: value.pixels.slice() }
    }
    return { ...source.snapshot, pixels: source.snapshot.pixels.slice() }
  }

  subscribe(listener: (event: TexturePreviewEvent) => void): PreviewDisposable {
    this.listeners.add(listener)
    return { dispose: () => { this.listeners.delete(listener) } }
  }

  private emit(event: TexturePreviewEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}

export const texturePreviewState = new TexturePreviewState()
