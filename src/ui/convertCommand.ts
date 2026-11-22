import { uiText } from '../i18n/messages'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as vscode from 'vscode'
import { loadSource, outputFilesFor, writeAnimation } from '../core/convertPipeline'
import { runtimeConfig } from '../core/config'
import { probeFfmpeg } from '../core/ffmpeg'
import { defaultOutputPath, normalizeOutputPath, resolveOutputPath, validateOutputPath } from '../core/outputPath'
import { sniffAnimatedFormat, stripFrameCount } from '../core/frameSource'
import { askOverwrite, findExisting } from './overwriteDialog'
import { pickWorkspaceRoot } from './workspacePicker'

const CONVERT_ACTION = uiText("ui.convertCommand.convert")
const SKIP_ACTION = uiText("ui.convertCommand.skip")
const PICK_FFMPEG_ACTION = uiText("ui.convertCommand.selectFfmpeg")
const OPEN_SETTINGS_ACTION = uiText("ui.blockbenchCommand.openSettings")
const DELETE_ACTION = uiText("ui.convertCommand.removeOriginalFile")
const KEEP_ACTION = uiText("ui.convertCommand.keep")
const PICK_FFMPEG_COMMAND = 'mcrh.pickFfmpegPath'
const FFMPEG_SETTING = 'mcrh.ffmpegPath'

type SourceKind = 'animation' | 'video' | 'texture' | 'static' | 'unsupported'

interface OutputTarget {
  absolutePath: string
  relativePath: string
}

interface FrametimeAnswer {
  override?: number
}

// 取消转换不会写入文件
export function registerConvertCommand(_context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.commands.registerCommand('mcrh.convertAnimation', async (uri?: vscode.Uri) => {
    const source = uri ?? await pickSource()
    if (!source) return
    try {
      await convertSource(source)
    } catch (error) {
      void vscode.window.showErrorMessage(uiText("ui.convertCommand.conversionFailed", error instanceof Error ? error.message : String(error)))
    }
  })
}

async function pickSource(): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 动图: ['gif', 'apng', 'png'], 视频: ['mp4', 'mov'] }
  })
  return picked?.[0]
}

// 图片太高可能无法在游戏里显示，只警告，不阻止转换
const MAX_TEXTURE_SIZE = 16384

async function convertSource(source: vscode.Uri): Promise<void> {
  const name = vscode.workspace.asRelativePath(source.fsPath)
  // 只读文件开头来识别格式
  const kind = classifySource(new Uint8Array(await readHeaderBytes(source)))
  if (kind === 'texture') {
    void vscode.window.showInformationMessage(uiText("ui.convertCommand.alreadyOnTheMinecraftAnimatedStickerNo", name))
    return
  }
  if (kind === 'static') {
    void vscode.window.showInformationMessage(uiText("ui.convertCommand.itSAStaticPictureNoNeed", name))
    return
  }
  if (kind === 'unsupported') {
    void vscode.window.showErrorMessage(uiText("ui.convertCommand.couldNotCloseTemporaryFolderS", name))
    return
  }

  const confirmed = await vscode.window.showWarningMessage(
    uiText("ui.convertCommand.animationFileDetectedConvertToMinecraftAction", name),
    CONVERT_ACTION,
    SKIP_ACTION
  )
  if (confirmed !== CONVERT_ACTION) return
  if (kind === 'video' && !(await ensureFfmpeg())) return

  const root = await pickWorkspaceRoot()
  if (!root) return
  const decoded = await loadSource(source.fsPath, runtimeConfig().animationFrametime)
  const output = await askOutputPath(root, path.basename(source.fsPath, path.extname(source.fsPath)))
  if (!output) return
  const answer = await askFrametime(decoded.frameTicks)
  if (!answer) return

  const targets = outputFilesFor(output.absolutePath).map(file => vscode.Uri.file(file))
  const choice = await askOverwrite(await findExisting(targets))
  if (choice === 'cancel') return
  if (choice === 'skip') {
    void vscode.window.showInformationMessage(uiText("ui.convertCommand.skippedDoesNotWriteAnyFiles", output.relativePath))
    return
  }

  const result = await writeAnimation(decoded, output.absolutePath, {
    frametime: answer.override,
    defaultFrametime: runtimeConfig().animationFrametime
  })
  void vscode.window.showInformationMessage(
    uiText("ui.convertCommand.generatedAllFrameFrameX", output.relativePath, result.frameCount, result.stripWidth, result.stripHeight, describeTiming(result.frameTicks))
  )
  if (result.stripHeight > MAX_TEXTURE_SIZE) {
    void vscode.window.showWarningMessage(
      uiText("ui.convertCommand.frameHeightPxExceedingTheCommonGpu", result.stripHeight, MAX_TEXTURE_SIZE)
    )
  }
  await offerDeleteOriginal(source, output.absolutePath)
}

function classifySource(bytes: Uint8Array): SourceKind {
  const format = sniffAnimatedFormat(bytes)
  if (format === 'gif' || format === 'apng') return 'animation'
  if (format === 'mp4') return 'video'
  if (format === 'png') return isStripTexture(bytes) ? 'texture' : 'static'
  return 'unsupported'
}

async function readHeaderBytes(uri: vscode.Uri, size = 64): Promise<Uint8Array> {
  const buffer = Buffer.alloc(size)
  const handle = await fs.promises.open(uri.fsPath, 'r')
  try {
    const { bytesRead } = await handle.read(buffer, 0, size, 0)
    return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead)
  } finally {
    await handle.close()
  }
}

function isStripTexture(bytes: Uint8Array): boolean {
  if (bytes.length < 24) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return stripFrameCount(view.getUint32(16), view.getUint32(20)) > 1
}

async function ensureFfmpeg(): Promise<boolean> {
  const status = await probeFfmpeg()
  if (status.available) return true
  const choice = await vscode.window.showWarningMessage(
    uiText("ui.convertCommand.couldNotCloseTemporaryFolderS_352de1", status.reason ?? uiText("ui.convertCommand.ffmpegNotFound")),
    PICK_FFMPEG_ACTION,
    OPEN_SETTINGS_ACTION
  )
  if (choice === PICK_FFMPEG_ACTION) {
    await vscode.commands.executeCommand(PICK_FFMPEG_COMMAND)
    return (await probeFfmpeg()).available
  }
  if (choice === OPEN_SETTINGS_ACTION) await vscode.commands.executeCommand('workbench.action.openSettings', FFMPEG_SETTING)
  return false
}

// 默认用设置中的命名空间，可另选工作区内的 PNG 路径
async function askOutputPath(root: string, baseName: string): Promise<OutputTarget | undefined> {
  const input = await vscode.window.showInputBox({
    title: uiText("ui.convertCommand.mrchConfirmOutputPath"),
    prompt: uiText("ui.convertCommand.theOutputPositionRelativeToTheWorkspace"),
    value: defaultOutputPath(runtimeConfig().defaultNamespace, baseName),
    validateInput: value => validateOutputPath(value, root)
  })
  if (input === undefined) return undefined
  return { absolutePath: resolveOutputPath(input, root), relativePath: normalizeOutputPath(input) }
}

async function askFrametime(sourceTicks: number[] | undefined): Promise<FrametimeAnswer | undefined> {
  const input = await vscode.window.showInputBox({
    title: uiText("ui.convertCommand.mcrhEveryFrameOfGameCarving"),
    prompt: uiText("ui.convertCommand.inASecondThenTheValueIs"),
    value: frametimePrefill(sourceTicks, runtimeConfig().animationFrametime),
    validateInput: text => (isBlankOrPositiveInteger(text) ? undefined : uiText("ui.convertCommand.enterAPositiveNumberOrLeaveEmpty"))
  })
  if (input === undefined) return undefined
  const trimmed = input.trim()
  return { override: trimmed === '' ? undefined : Number(trimmed) }
}

function frametimePrefill(sourceTicks: number[] | undefined, fallback: number): string {
  return String(sourceTicks?.[0] ?? fallback)
}

function isBlankOrPositiveInteger(text: string): boolean {
  const trimmed = text.trim()
  return trimmed === '' || (/^\d+$/.test(trimmed) && Number(trimmed) > 0)
}

// 自定义逐帧时长只显示项数
function describeTiming(ticks: number[]): string {
  return ticks.every(tick => tick === ticks[0]) ? uiText("ui.convertCommand.unanimousLengthEngraving", ticks[0]) : uiText("ui.convertCommand.longTimeByFrameItem", ticks.length)
}

async function offerDeleteOriginal(source: vscode.Uri, outputPath: string): Promise<void> {
  if (path.resolve(source.fsPath) === path.resolve(outputPath)) return
  const choice = await vscode.window.showWarningMessage(
    uiText("ui.convertCommand.whetherToDeleteOriginalFiles", vscode.workspace.asRelativePath(source.fsPath)),
    DELETE_ACTION,
    KEEP_ACTION
  )
  if (choice === DELETE_ACTION) await vscode.workspace.fs.delete(source, { useTrash: true })
}
