export interface TextureSource {
  width: number
  height: number
  data: ArrayBuffer
}

export type SyncAction = 'upload' | 'keep' | 'remove' | 'none'

export interface TextureSink<K extends string> {
  upload(key: K, source: TextureSource): void
  remove(key: K): void
}

export class TextureSync<K extends string> {
  private readonly last = new Map<K, TextureSource>()
  private readonly sink: TextureSink<K>

  constructor(sink: TextureSink<K>) {
    this.sink = sink
  }

  sync(key: K, source: TextureSource | undefined): SyncAction {
    const previous = this.last.get(key)
    if (!source) {
      if (!previous) return 'none'
      this.sink.remove(key)
      this.last.delete(key)
      return 'remove'
    }
    if (previous && isSameSource(previous, source)) return 'keep'
    this.sink.upload(key, source)
    this.last.set(key, source)
    return 'upload'
  }
}

// 先比对尺寸与长度, 再逐字节比较, 同一尺寸但内容不同必须重新上传
function isSameSource(a: TextureSource, b: TextureSource): boolean {
  if (a.width !== b.width || a.height !== b.height || a.data.byteLength !== b.data.byteLength) return false
  if (a.data === b.data) return true
  const left = new Uint8Array(a.data)
  const right = new Uint8Array(b.data)
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false
  }
  return true
}
