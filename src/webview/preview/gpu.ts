import { uiText } from '../../i18n/messages'
// WebGL 生命周期, 纹理同步与画布尺寸, 上下文不可用或初始化失败时在页面内给出中文提示
import { acquireGl } from '../gl/context'
import { PreviewRenderer } from '../gl/renderer'
import { TextureSync, type TextureSink } from '../gl/textureSync'
import type { PreviewMessage } from '../messages'
import { errorText, TEXTURE_SLOTS, textureSourcesOf, type TextureSlot } from './model'
import type { PreviewShell } from './shell'

export interface Gpu {
  renderer: PreviewRenderer
  textures: TextureSync<TextureSlot>
}

export function attachGpu(shell: PreviewShell): Gpu | undefined {
  const result = acquireGl(shell.canvas)
  if (!result.ok) {
    showFallback(shell, result.reason)
    return undefined
  }
  try {
    const gpu = createGpu(result.gl)
    shell.canvas.hidden = false
    shell.fallback.hidden = true
    return gpu
  } catch (error) {
    showFallback(shell, uiText("webview.preview.gpu.initializationOfThePasteFailed", errorText(error)))
    return undefined
  }
}

function createGpu(gl: WebGLRenderingContext): Gpu {
  const renderer = new PreviewRenderer(gl)
  const sink: TextureSink<TextureSlot> = {
    upload: (slot, source) => renderer.setImage(slot, source.width, source.height, source.data),
    remove: slot => renderer.clearImage(slot)
  }
  return { renderer, textures: new TextureSync(sink) }
}

function showFallback(shell: PreviewShell, reason: string): void {
  shell.canvas.hidden = true
  shell.fallback.hidden = false
  shell.fallback.textContent = uiText("webview.preview.gpu.pleaseCheckVsCodeHardwareAccelerationSettings", reason)
}

export function uploadTextures(gpu: Gpu, message: PreviewMessage, notices: string[]): boolean {
  const sources = textureSourcesOf(message)
  let hasStrip = false
  for (const slot of TEXTURE_SLOTS) {
    try {
      gpu.textures.sync(slot, sources[slot])
      if (slot === 'strip') hasStrip = sources.strip !== undefined
    } catch (error) {
      notices.push(slot === 'strip' ? uiText("webview.preview.gpu.pasteUploadFailed", errorText(error)) : uiText("webview.preview.gpu.originalPasteInvalidPlaceholderIsUsedTo", slot, errorText(error)))
    }
  }
  return hasStrip
}

// 画布像素尺寸跟随舞台的 CSS 尺寸与设备像素比, 只在变化时赋值以避免多余重排
export function sizeCanvas(canvas: HTMLCanvasElement): { width: number; height: number } {
  const ratio = Math.min(2, window.devicePixelRatio || 1)
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio))
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio))
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  return { width, height }
}
