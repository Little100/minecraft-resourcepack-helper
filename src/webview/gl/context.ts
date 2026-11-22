import { uiText } from '../../i18n/messages'
// WebGL1 上下文获取与纹理上传, 不可用时返回原因而不是抛出, 由页面展示中文提示
export type GlContextResult = { ok: true; gl: WebGLRenderingContext } | { ok: false; reason: string }

export function acquireGl(canvas: HTMLCanvasElement): GlContextResult {
  const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true })
  if (!gl) return { ok: false, reason: uiText("webview.gl.context.theCurrentEnvironmentDoesNotSupportWebgl") }
  return { ok: true, gl }
}

export function uploadRgbaTexture(
  gl: WebGLRenderingContext,
  existing: WebGLTexture | undefined,
  width: number,
  height: number,
  data: ArrayBuffer
): WebGLTexture {
  if (data.byteLength !== width * height * 4) throw new Error(uiText("webview.gl.context.theLengthAndSizeOfTheSticker"))
  const texture = existing ?? gl.createTexture()
  if (!texture) throw new Error(uiText("webview.gl.context.cannotCreateWebglTexture"))
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(data))
  return texture
}
