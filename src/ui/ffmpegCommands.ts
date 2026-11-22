import { uiText } from '../i18n/messages'
import * as vscode from 'vscode'
import { probeFfmpeg, probeFfmpegAt, type FfmpegSource } from '../core/ffmpeg'

const SECTION = 'mcrh'
const SETTING_KEY = 'ffmpegPath'
// 找不到 ffmpeg 时提供官方下载页
const DOWNLOAD_URL = 'https://ffmpeg.org/download.html'
const SOURCE_LABELS: Record<FfmpegSource, string> = { setting: uiText("ui.ffmpegCommands.fromSettings"), path: uiText("ui.ffmpegCommands.fromSystemPath") }

export function registerFfmpegCommands(): vscode.Disposable {
  const checkFfmpeg = vscode.commands.registerCommand('mcrh.checkFfmpeg', () => checkStatus())
  const pickFfmpegPath = vscode.commands.registerCommand('mcrh.pickFfmpegPath', () => pickFfmpeg())
  return vscode.Disposable.from(checkFfmpeg, pickFfmpegPath)
}

// 展示当前 ffmpeg 的来源与版本, 不可用时给出选择, 设置与下载页三个出口
async function checkStatus(): Promise<void> {
  const status = await probeFfmpeg()
  if (status.available) {
    const choice = await vscode.window.showInformationMessage(
      uiText("ui.ffmpegCommands.ffmpegAvailableModelVersion", originSuffix(status.source), status.path, status.version ?? uiText("collaboration.openp2p.unknown")),
      uiText("ui.blockbenchCommand.openSettings")
    )
    if (choice === uiText("ui.blockbenchCommand.openSettings")) await openSettings()
    return
  }
  const choice = await vscode.window.showWarningMessage(
    uiText("ui.ffmpegCommands.ffmpegNotAvailable", originSuffix(status.source), status.reason ?? uiText("core.convertPipeline.unknownCause")),
    uiText("ui.ffmpegCommands.selectFfmpegFile"), uiText("ui.blockbenchCommand.openSettings"), uiText("ui.ffmpegCommands.viewDownloadPages")
  )
  if (choice === uiText("ui.ffmpegCommands.selectFfmpegFile")) {
    await vscode.commands.executeCommand('mcrh.pickFfmpegPath')
  } else if (choice === uiText("ui.blockbenchCommand.openSettings")) {
    await openSettings()
  } else if (choice === uiText("ui.ffmpegCommands.viewDownloadPages")) {
    await vscode.env.openExternal(vscode.Uri.parse(DOWNLOAD_URL))
  }
}

// 先询问选文件还是选文件夹, 因为 Windows 对话框不能同时选择两者; 验证通过才写入设置
async function pickFfmpeg(): Promise<void> {
  const mode = await vscode.window.showInformationMessage(
    uiText("ui.ffmpegCommands.pleaseSelectAFfmpegExecutableOrA"),
    uiText("ui.ffmpegCommands.chooseFile"), uiText("ui.ffmpegCommands.selectFolder")
  )
  if (!mode) return
  const folder = mode === uiText("ui.ffmpegCommands.selectFolder")
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: !folder,
    canSelectFolders: folder,
    canSelectMany: false,
    openLabel: folder ? uiText("ui.ffmpegCommands.selectFolder") : uiText("ui.convertCommand.selectFfmpeg"),
    title: folder ? uiText("ui.ffmpegCommands.selectAFolderToStoreFfmpeg") : uiText("ui.ffmpegCommands.selectFfmpegExecutable"),
    filters: folder || process.platform !== 'win32' ? undefined : { [uiText("ui.ffmpegCommands.ffmpegExecutable")]: ['exe'], 所有文件: ['*'] }
  })
  const target = picked?.[0]?.fsPath
  if (!target) return

  const status = await probeFfmpegAt(target, 'setting')
  if (!status.available) {
    void vscode.window.showWarningMessage(uiText("ui.ffmpegCommands.theSelectedPathIsNotAvailableNo", status.reason ?? uiText("core.convertPipeline.unknownCause")))
    return
  }
  try {
    await vscode.workspace.getConfiguration(SECTION).update(SETTING_KEY, target, vscode.ConfigurationTarget.Global)
  } catch (error) {
    void vscode.window.showErrorMessage(uiText("ui.ffmpegCommands.writingToFfmpegSettingsFailed", error instanceof Error ? error.message : String(error)))
    return
  }
  void vscode.window.showInformationMessage(uiText("ui.ffmpegCommands.setupFfmpegVersion", status.version ?? uiText("collaboration.openp2p.unknown"), status.path))
}

// 来源缺失时不展示括注, 避免出现来源未知的误导文案
function originSuffix(source: FfmpegSource | undefined): string {
  return source ? `（${SOURCE_LABELS[source]}）` : ''
}

async function openSettings(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', `${SECTION}.${SETTING_KEY}`)
}
