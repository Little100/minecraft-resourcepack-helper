declare module 'upng-js' {
  export interface UPNGRect {
    x: number
    y: number
    width: number
    height: number
  }
  export interface UPNGFrame {
    rect: UPNGRect
    delay: number
    dispose: number
    blend: number
    data?: Uint8Array
  }
  export interface UPNGImage {
    width: number
    height: number
    depth: number
    ctype: number
    frames: UPNGFrame[]
    tabs: Record<string, unknown>
    data?: Uint8Array
  }
  export function decode(buffer: ArrayBuffer): UPNGImage
  export function toRGBA8(img: UPNGImage): ArrayBuffer[]
  export function encode(
    imgs: ArrayBuffer[],
    w: number,
    h: number,
    cnum: number,
    dels?: number[]
  ): ArrayBuffer
}
