import { uiText } from '../../i18n/messages'
// WebGL1 程序与缓冲的底层辅助函数, 编译失败或定位失败时抛出带原因的中文错误
export function compileProgram(gl: WebGLRenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const program = gl.createProgram()
  if (!program) throw new Error(uiText("webview.gl.program.couldNotCreateWebglApplication"))
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource))
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(uiText("webview.gl.program.couldNotCloseTemporaryFolderS", gl.getProgramInfoLog(program) ?? ''))
  }
  return program
}

export function uniformLocation(gl: WebGLRenderingContext, program: WebGLProgram, name: string): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name)
  if (!location) throw new Error(uiText("webview.gl.program.colourColourIsMissingUnit", name))
  return location
}

export function attribLocation(gl: WebGLRenderingContext, program: WebGLProgram, name: string): number {
  const location = gl.getAttribLocation(program, name)
  if (location < 0) throw new Error(uiText("webview.gl.program.colorColoursMissingAttribute", name))
  return location
}

export function createStaticBuffer(gl: WebGLRenderingContext, target: number, data: ArrayBufferView): WebGLBuffer {
  const buffer = gl.createBuffer()
  if (!buffer) throw new Error(uiText("webview.gl.program.couldNotCreateWebglBuffer"))
  gl.bindBuffer(target, buffer)
  gl.bufferData(target, data, gl.STATIC_DRAW)
  return buffer
}

export function bindFloatAttribute(gl: WebGLRenderingContext, location: number, buffer: WebGLBuffer, size: number): void {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.enableVertexAttribArray(location)
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0)
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error(uiText("webview.gl.program.couldNotCreateColoreder"))
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? ''
    gl.deleteShader(shader)
    throw new Error(uiText("webview.gl.program.colourColourFilterCompiled", log))
  }
  return shader
}
