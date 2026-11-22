declare module 'utif' {
  export interface TiffImage { width: number; height: number; data?: Uint8Array; [tag: string]: unknown }
  export function decode(buffer: ArrayBuffer): TiffImage[]
  export function decodeImage(buffer: ArrayBuffer, image: TiffImage): void
  export function toRGBA8(image: TiffImage): Uint8Array
}
