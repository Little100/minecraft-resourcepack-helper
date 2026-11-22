import { uiText } from '../i18n/messages'
import * as vscode from 'vscode'

export type OverwriteChoice = 'overwrite' | 'skip' | 'cancel'

const SKIP_LABEL = uiText("ui.overwriteDialog.skipExistingFiles")
const OVERWRITE_LABEL = uiText("ui.overwriteDialog.overwriteExistingFiles")
const LISTED_LIMIT = 5

export async function findExisting(targets: vscode.Uri[]): Promise<vscode.Uri[]> {
  const found: vscode.Uri[] = []
  for (const target of targets) {
    try {
      await vscode.workspace.fs.stat(target)
      found.push(target)
    } catch {
      // 文件不存在，可以直接写入
    }
  }
  return found
}

// 已有同名文件时统一询问, 默认选项为跳过, 避免静默覆盖用户自己的内容
export async function askOverwrite(existing: vscode.Uri[]): Promise<OverwriteChoice> {
  if (existing.length === 0) return 'overwrite'
  const listed = existing.slice(0, LISTED_LIMIT).map(uri => vscode.workspace.asRelativePath(uri, false)).join('\n')
  const more = existing.length > LISTED_LIMIT ? uiText("ui.overwriteDialog.waitFile", existing.length) : ''
  const choice = await vscode.window.showWarningMessage(
    uiText("ui.overwriteDialog.theFollowingDocumentsAlreadyExist", listed, more),
    { modal: true },
    SKIP_LABEL,
    OVERWRITE_LABEL
  )
  if (choice === OVERWRITE_LABEL) return 'overwrite'
  if (choice === SKIP_LABEL) return 'skip'
  return 'cancel'
}
