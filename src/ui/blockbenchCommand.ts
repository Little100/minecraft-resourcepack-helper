import { uiText } from '../i18n/messages'
import * as path from 'node:path'
import { TextDecoder } from 'node:util'
import * as vscode from 'vscode'
import { extensionLog } from './extensionLog'
import { findBlockbench, hasBlockbenchExtension, isExistingFile, launchBlockbench, looksLikeModel } from '../core/blockbench'

const SECTION = 'mcrh'
const SETTING_KEY = 'blockbenchPath'
const OPEN_COMMAND = 'mcrh.openInBlockbench'
const PICK_COMMAND = 'mcrh.pickBlockbenchPath'
const CONFIRM_OPEN = uiText("ui.blockbenchCommand.openStill")
const SELECT_PROGRAM = uiText("ui.blockbenchCommand.selectBlockbenchProgram")
const OPEN_SETTINGS = uiText("ui.blockbenchCommand.openSettings")

export function registerBlockbenchCommands(): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(OPEN_COMMAND, (uri?: vscode.Uri) => openInBlockbench(uri).catch(error => vscode.window.showErrorMessage(uiText("ui.blockbenchCommand.openBlockbenchNotFinished", errorMessage(error))))),
    vscode.commands.registerCommand(PICK_COMMAND, () => pickBlockbenchPath())
  ]
}

async function openInBlockbench(uri?: vscode.Uri): Promise<void> {
  const active = vscode.window.activeTextEditor?.document.uri
  const target = uri ?? (active && hasBlockbenchExtension(active.fsPath) ? active : undefined) ?? (await pickModelFile())
  if (!target) return
  if (target.scheme !== 'file') {
    void vscode.window.showWarningMessage(uiText("ui.blockbenchCommand.openLocalFilesOnlyInBlockbench"))
    return
  }
  if (!hasBlockbenchExtension(target.fsPath)) {
    void vscode.window.showWarningMessage(uiText("ui.blockbenchCommand.blockbechCanOnlyOpenBbmodeOrJson", path.basename(target.fsPath)))
    return
  }
  const document = vscode.workspace.textDocuments.find(value => value.uri.toString() === target.toString())
  if (document?.isDirty) {
    if (await vscode.window.showWarningMessage(uiText("ui.blockbenchCommand.modelWithUnsavedChangesToSaveAnd"), { modal: true }, uiText("ui.blockbenchCommand.saveAndOpen")) !== uiText("ui.blockbenchCommand.saveAndOpen")) return
    if (!(await document.save())) throw new Error(uiText("ui.blockbenchCommand.modelFailedToSaveOldVersionNot"))
  }
  if (!(await confirmModelJson(target))) return
  const executable = await resolveExecutable()
  if (!executable) return
  await launch(executable, target.fsPath)
}

async function pickModelFile(): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: uiText("ui.blockbenchCommand.openInBlockbench"),
    title: uiText("ui.blockbenchCommand.selectTheModelToOpenInBlockbench"),
    filters: { [uiText("ui.blockbenchCommand.blockbechModel")]: ['bbmodel', 'json'] }
  })
  return picked?.[0]
}

async function confirmModelJson(uri: vscode.Uri): Promise<boolean> {
  if (!/\.json$/i.test(uri.fsPath)) return true
  let text: string
  try {
    text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))
  } catch (error) {
    void vscode.window.showErrorMessage(uiText("ui.blockbenchCommand.failedToReadFile", errorMessage(error)))
    return false
  }
  if (looksLikeModel(text)) return true
  const choice = await vscode.window.showWarningMessage(
    uiText("ui.blockbenchCommand.theJsonDoesNotLookLikeThe"),
    { modal: true },
    CONFIRM_OPEN
  )
  return choice === CONFIRM_OPEN
}

async function resolveExecutable(): Promise<string | undefined> {
  const configured = vscode.workspace.getConfiguration(SECTION).get<string>(SETTING_KEY, '')
  const found = await findBlockbench(process.platform, process.env, configured)
  if (found) return found
  const choice = await vscode.window.showWarningMessage(uiText("ui.blockbenchCommand.blockbechApplicationNotFound"), SELECT_PROGRAM, OPEN_SETTINGS)
  if (choice === SELECT_PROGRAM) return vscode.commands.executeCommand<string | undefined>(PICK_COMMAND)
  if (choice === OPEN_SETTINGS) await openSettings()
  return undefined
}

// 外部程序不继承扩展宿主的 Electron 与 IPC 启动环境
async function launch(executable: string, file: string): Promise<void> {
  const child = launchBlockbench(executable, file)
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
  child.once('exit', code => {
    if (code !== null && code !== 0) void vscode.window.showErrorMessage(uiText("ui.blockbenchCommand.blockbenchExitsCodeCheckThePathOf", code))
  })
  extensionLog('info', uiText("ui.blockbenchCommand.sendingModelToExternalBlockbench", path.basename(file)))
  void vscode.window.showInformationMessage(uiText("ui.blockbenchCommand.sendedToBlockbenchIfNoWindowAppears", path.basename(file)), SELECT_PROGRAM).then(choice => { if (choice === SELECT_PROGRAM) void pickBlockbenchPath() })
}

async function pickBlockbenchPath(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: uiText("ui.blockbenchCommand.selectBlockbench"),
    title: uiText("ui.blockbenchCommand.selectBlockbenchProgram"),
    filters: process.platform === 'win32' ? { [uiText("ui.blockbenchCommand.blockbenchProgram")]: ['exe'], 所有文件: ['*'] } : undefined
  })
  const target = picked?.[0]?.fsPath
  if (!target) return undefined
  if (!(await isExistingFile(target))) {
    void vscode.window.showWarningMessage(uiText("ui.blockbenchCommand.theSelectedPathIsNotAFile", target))
    return undefined
  }
  try {
    await vscode.workspace.getConfiguration(SECTION).update(SETTING_KEY, target, vscode.ConfigurationTarget.Global)
  } catch (error) {
    void vscode.window.showErrorMessage(uiText("ui.blockbenchCommand.writingToBlockbenchSettingsFailed", errorMessage(error)))
    return undefined
  }
  void vscode.window.showInformationMessage(uiText("ui.blockbenchCommand.blockbenchProgramSetUp", target))
  return target
}

async function openSettings(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', `${SECTION}.${SETTING_KEY}`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
