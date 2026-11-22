import { uiText } from '../i18n/messages'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { decodeAnimation, decodeSingleFrame } from './decoders'
import {
  buildAnimationMcmeta,
  centerCropSquare,
  resolveFrameTicks,
  sniffAnimatedFormat,
  type DecodedAnimation
} from './frameSource'
import { extractFrames, probeFfmpeg } from './ffmpeg'
import { encodeVerticalStrip } from './pngWriter'

const TICKS_PER_SECOND = 20
// 抽帧数量上限, 防止超长视频生成过高的帧条而占用过多内存, 超出部分直接舍弃
const VIDEO_MAX_FRAMES = 240
const MCMETA_SUFFIX = '.mcmeta'

export interface ConvertOptions {
  frametime?: number | readonly number[]
  defaultFrametime: number
}

export interface ConvertResult {
  pngPath: string
  mcmetaPath?: string
  frameCount: number
  frameWidth: number
  frameHeight: number
  stripWidth: number
  stripHeight: number
  frameTicks: number[]
}

export function decodeVideoFrames(pngFrames: readonly Uint8Array[]): DecodedAnimation {
  return { frames: pngFrames.map(bytes => decodeSingleFrame(bytes)), loop: true }
}

// 视频依赖 ffmpeg 抽帧, 不可用时抛出带原因的错误, 由 UI 层负责引导用户配置
async function decodeVideo(sourceFile: string, defaultFrametime: number): Promise<DecodedAnimation> {
  const status = await probeFfmpeg()
  if (!status.available || !status.path) throw new Error(uiText("core.convertPipeline.ffmpegNotAvailable", status.reason ?? uiText("core.convertPipeline.unknownCause")))
  const fps = TICKS_PER_SECOND / Math.max(1, defaultFrametime)
  const extracted = await extractFrames(status.path, sourceFile, undefined, { fps, maxFrames: VIDEO_MAX_FRAMES })
  if (extracted.length === 0) throw new Error(uiText("core.convertPipeline.ffmpegFailedToExtractAnyFrameFrom"))
  return decodeVideoFrames(extracted.map(frame => frame.data))
}

export async function loadSource(sourceFile: string, defaultFrametime: number): Promise<DecodedAnimation> {
  const bytes = new Uint8Array(await vscode.workspace.fs.readFile(vscode.Uri.file(sourceFile)))
  const format = sniffAnimatedFormat(bytes)
  if (format === 'unknown') throw new Error(uiText("core.convertPipeline.canNotGetFolderSS", sourceFile))
  if (format === 'mp4') return decodeVideo(sourceFile, defaultFrametime)
  return decodeAnimation(bytes, format)
}

export function outputFilesFor(pngPath: string): string[] {
  return [pngPath, `${pngPath}${MCMETA_SUFFIX}`]
}

async function removeIfExists(filePath: string): Promise<void> {
  const uri = vscode.Uri.file(filePath)
  try {
    await vscode.workspace.fs.stat(uri)
  } catch {
    return
  }
  await vscode.workspace.fs.delete(uri)
}

export async function writeAnimation(
  decoded: DecodedAnimation,
  outputPng: string,
  options: ConvertOptions
): Promise<ConvertResult> {
  const frames = decoded.frames.map(frame => centerCropSquare(frame))
  const frameTicks = resolveFrameTicks(frames.length, options.frametime, decoded.frameTicks, options.defaultFrametime)
  const strip = encodeVerticalStrip(frames)
  // 先完成所有校验再写盘, 避免 mcmeta 非法时只留下半成品 PNG
  const mcmeta = frames.length > 1 ? buildAnimationMcmeta(frameTicks) : undefined
  const mcmetaPath = `${outputPng}${MCMETA_SUFFIX}`

  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(outputPng)))
  await vscode.workspace.fs.writeFile(vscode.Uri.file(outputPng), strip.buffer)
  const result: ConvertResult = {
    pngPath: outputPng,
    frameCount: strip.frameCount,
    frameWidth: strip.frameWidth,
    frameHeight: strip.frameHeight,
    stripWidth: strip.stripWidth,
    stripHeight: strip.stripHeight,
    frameTicks
  }
  if (mcmeta) {
    await vscode.workspace.fs.writeFile(vscode.Uri.file(mcmetaPath), Buffer.from(JSON.stringify(mcmeta, null, 2), 'utf8'))
    result.mcmetaPath = mcmetaPath
  } else {
    await removeIfExists(mcmetaPath)
  }
  return result
}

export async function convertToAnimatedTexture(
  sourceFile: string,
  outputPng: string,
  options: ConvertOptions
): Promise<ConvertResult> {
  return writeAnimation(await loadSource(sourceFile, options.defaultFrametime), outputPng, options)
}
