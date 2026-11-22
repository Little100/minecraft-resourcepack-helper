// 单个 WebGL 上下文内的绘制器, 纹理只在新图到达时上传, 绘制阶段不做逐像素 CPU 运算
import { buildCubeMesh } from './cube'
import { uploadRgbaTexture } from './context'
import type { Mat4 } from './math'
import type { FrameSample, Rect, Rgba } from './types'
import { attribLocation, bindFloatAttribute, compileProgram, createStaticBuffer, uniformLocation } from './program'
import { CUBE_FRAGMENT_SHADER, CUBE_VERTEX_SHADER, QUAD_FRAGMENT_SHADER, QUAD_VERTEX_SHADER } from './shaders'

export type TextureKey = 'strip' | 'hotbar' | 'hotbarSelection' | 'slot' | 'frame' | 'solid'

export interface TextureSize {
  width: number
  height: number
}
export const STATIC_FRAME: FrameSample = { frame: 0, nextFrame: 0, mix: 0, frameScale: 1 }

const WHITE: Rgba = [1, 1, 1, 1]
const CUBE_UNIFORMS = ['uMvp', 'uTexture', 'uFrame', 'uNextFrame', 'uMix', 'uFrameScale'] as const
const QUAD_UNIFORMS = ['uRect', 'uViewport', 'uTexture', 'uFrame', 'uNextFrame', 'uMix', 'uFrameScale', 'uTint'] as const

type FrameUniforms = Record<'uFrame' | 'uNextFrame' | 'uMix' | 'uFrameScale', WebGLUniformLocation>

interface CubeProgram {
  program: WebGLProgram
  position: number
  uv: number
  shade: number
  uniforms: Record<(typeof CUBE_UNIFORMS)[number], WebGLUniformLocation>
}

interface QuadProgram {
  program: WebGLProgram
  corner: number
  uniforms: Record<(typeof QUAD_UNIFORMS)[number], WebGLUniformLocation>
}

export class PreviewRenderer {
  private readonly gl: WebGLRenderingContext
  private readonly textures = new Map<TextureKey, WebGLTexture>()
  private readonly sizes = new Map<TextureKey, TextureSize>()
  private readonly cube: CubeProgram
  private readonly quad: QuadProgram
  private readonly cubeBuffers: { position: WebGLBuffer; uv: WebGLBuffer; shade: WebGLBuffer; index: WebGLBuffer }
  private readonly quadBuffer: WebGLBuffer
  private readonly indexCount: number
  private viewportWidth = 1
  private viewportHeight = 1

  constructor(gl: WebGLRenderingContext) {
    this.gl = gl
    const cubeProgram = compileProgram(gl, CUBE_VERTEX_SHADER, CUBE_FRAGMENT_SHADER)
    this.cube = {
      program: cubeProgram,
      position: attribLocation(gl, cubeProgram, 'aPosition'),
      uv: attribLocation(gl, cubeProgram, 'aUv'),
      shade: attribLocation(gl, cubeProgram, 'aShade'),
      uniforms: uniformTable(gl, cubeProgram, CUBE_UNIFORMS)
    }
    const quadProgram = compileProgram(gl, QUAD_VERTEX_SHADER, QUAD_FRAGMENT_SHADER)
    this.quad = {
      program: quadProgram,
      corner: attribLocation(gl, quadProgram, 'aCorner'),
      uniforms: uniformTable(gl, quadProgram, QUAD_UNIFORMS)
    }
    const mesh = buildCubeMesh()
    this.indexCount = mesh.indices.length
    this.cubeBuffers = {
      position: createStaticBuffer(gl, gl.ARRAY_BUFFER, mesh.positions),
      uv: createStaticBuffer(gl, gl.ARRAY_BUFFER, mesh.uvs),
      shade: createStaticBuffer(gl, gl.ARRAY_BUFFER, mesh.shades),
      index: createStaticBuffer(gl, gl.ELEMENT_ARRAY_BUFFER, mesh.indices)
    }
    this.quadBuffer = createStaticBuffer(gl, gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]))
    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    this.setImage('solid', 1, 1, new Uint8Array([255, 255, 255, 255]).buffer)
  }

  setImage(key: TextureKey, width: number, height: number, data: ArrayBuffer): void {
    this.textures.set(key, uploadRgbaTexture(this.gl, this.textures.get(key), width, height, data))
    this.sizes.set(key, { width, height })
  }

  clearImage(key: Exclude<TextureKey, 'solid'>): void {
    const texture = this.textures.get(key)
    if (!texture) return
    this.gl.deleteTexture(texture)
    this.textures.delete(key)
    this.sizes.delete(key)
  }

  hasImage(key: TextureKey): boolean {
    return this.textures.has(key)
  }

  sizeOf(key: TextureKey): TextureSize | undefined {
    return this.sizes.get(key)
  }

  begin(width: number, height: number): void {
    const gl = this.gl
    this.viewportWidth = width
    this.viewportHeight = height
    gl.viewport(0, 0, width, height)
    gl.clearColor(0, 0, 0, 0)
    gl.clearDepth(1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
  }

  drawCube(mvp: Mat4, frame: FrameSample): void {
    const strip = this.textures.get('strip')
    if (!strip) return
    const { gl, cube } = this
    gl.useProgram(cube.program)
    gl.disableVertexAttribArray(this.quad.corner)
    gl.enable(gl.DEPTH_TEST)
    gl.enable(gl.CULL_FACE)
    gl.cullFace(gl.BACK)
    bindFloatAttribute(gl, cube.position, this.cubeBuffers.position, 3)
    bindFloatAttribute(gl, cube.uv, this.cubeBuffers.uv, 2)
    bindFloatAttribute(gl, cube.shade, this.cubeBuffers.shade, 1)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.cubeBuffers.index)
    gl.uniformMatrix4fv(cube.uniforms.uMvp, false, mvp)
    this.applyFrame(cube.uniforms, frame)
    this.bindTexture(strip, cube.uniforms.uTexture)
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0)
  }

  drawSprite(key: TextureKey, dst: Rect, frame: FrameSample = STATIC_FRAME, tint: Rgba = WHITE): void {
    const texture = this.textures.get(key)
    if (texture) this.drawQuad(texture, dst, frame, tint)
  }

  drawSolid(dst: Rect, color: Rgba): void {
    const texture = this.textures.get('solid')
    if (texture) this.drawQuad(texture, dst, STATIC_FRAME, color)
  }

  private drawQuad(texture: WebGLTexture, dst: Rect, frame: FrameSample, tint: Rgba): void {
    const { gl, quad } = this
    gl.useProgram(quad.program)
    gl.disableVertexAttribArray(this.cube.position)
    gl.disableVertexAttribArray(this.cube.uv)
    gl.disableVertexAttribArray(this.cube.shade)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
    bindFloatAttribute(gl, quad.corner, this.quadBuffer, 2)
    gl.uniform4f(quad.uniforms.uRect, dst.x, dst.y, dst.width, dst.height)
    gl.uniform2f(quad.uniforms.uViewport, this.viewportWidth, this.viewportHeight)
    gl.uniform4f(quad.uniforms.uTint, tint[0], tint[1], tint[2], tint[3])
    this.applyFrame(quad.uniforms, frame)
    this.bindTexture(texture, quad.uniforms.uTexture)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  private applyFrame(uniforms: FrameUniforms, frame: FrameSample): void {
    const gl = this.gl
    gl.uniform1f(uniforms.uFrame, frame.frame)
    gl.uniform1f(uniforms.uNextFrame, frame.nextFrame)
    gl.uniform1f(uniforms.uMix, frame.mix)
    gl.uniform1f(uniforms.uFrameScale, frame.frameScale)
  }

  private bindTexture(texture: WebGLTexture, sampler: WebGLUniformLocation): void {
    this.gl.activeTexture(this.gl.TEXTURE0)
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture)
    this.gl.uniform1i(sampler, 0)
  }
}

function uniformTable<T extends string>(gl: WebGLRenderingContext, program: WebGLProgram, names: readonly T[]): Record<T, WebGLUniformLocation> {
  const table = {} as Record<T, WebGLUniformLocation>
  for (const name of names) table[name] = uniformLocation(gl, program, name)
  return table
}
