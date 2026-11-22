declare module 'gifuct-js' {
  export interface GifDims {
    top: number
    left: number
    width: number
    height: number
  }
  export interface ParsedFrame {
    dims: GifDims
    colorTable: number[]
    delay: number
    disposalType: number
    patch: Uint8ClampedArray
    transparentIndex: number
  }
  export interface GifLogicalScreen {
    width: number
    height: number
  }
  export interface ParsedGif {
    lsd: GifLogicalScreen
    gct: number[][]
    frames: unknown[]
  }
  export function parseGIF(buffer: ArrayBuffer): ParsedGif
  export function decompressFrames(parsed: ParsedGif, buildImagePatch: true): ParsedFrame[]
  export function decompressFrames(parsed: ParsedGif, buildImagePatch: false): Omit<ParsedFrame, 'patch'>[]
}
