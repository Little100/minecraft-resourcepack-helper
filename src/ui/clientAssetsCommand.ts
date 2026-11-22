import { uiText } from '../i18n/messages'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { planClientReleaseAsync, selectReleaseTargets, writeClientRelease, cacheDir, validateClientVersion } from '../core/clientAssets'
import { ensureCachedClientJar } from '../core/clientJarCache'
import { downloadClientJar, fetchVersionDetail, fetchVersionManifest, pickVersions } from '../core/versionManifest'
import { workspaceRoots } from '../core/packDetector'
import { askOverwrite, findExisting } from './overwriteDialog'
import { registerPreviewClientAssets } from './previewClientAssets'
import { appendClientReleaseLanguage } from './clientPackCompletion'
import { pickClientTextureResolution } from './clientTextureResolutionPicker'

// 提取原版资源并保留已检查的客户端缓存
export async function extractVanillaAssets(context: vscode.ExtensionContext): Promise<void> {
  let manifest: Awaited<ReturnType<typeof fetchVersionManifest>>
  try {
    manifest = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: uiText("ui.clientAssetsCommand.mrchGetMinecraftVersionOfTheList") },
      () => fetchVersionManifest()
    )
  } catch (error) {
    void vscode.window.showErrorMessage(uiText("ui.clientAssetsCommand.couldNotCloseTemporaryFolderS", error instanceof Error ? error.message : String(error)))
    return
  }

  const includeSnapshots = vscode.workspace.getConfiguration('mcrh').get<boolean>('includeSnapshots', false)
  const picked = await vscode.window.showQuickPick(
    pickVersions(manifest, includeSnapshots).map(entry => ({
      label: entry.id,
      description: entry.type === 'release' ? uiText("browser.workbenchBridge.release") : entry.type,
      detail: entry.releaseTime.slice(0, 10),
      entry
    })),
    { placeHolder: uiText("ui.clientAssetsCommand.selectClientVersionToReleaseOriginalResource"), matchOnDescription: true }
  )
  if (!picked) return

  // 目标目录每次都手动选, 避免把原版资源混进用户自己的包
  const target = await pickTargetDir()
  if (!target) return
  const resolution = await pickClientTextureResolution()
  if (!resolution) return

  try {
    validateClientVersion(picked.entry.id)
    const detail = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: uiText("ui.clientAssetsCommand.mrchParsingDownloadAddress", picked.entry.id) },
      () => fetchVersionDetail(picked.entry)
    )
    const url = detail.downloads?.client?.url
    if (!url || detail.id !== picked.entry.id) throw new Error(uiText("ui.clientAssetsCommand.noMatchingClientDownloadMetadataForThis"))
    const expected = detail.downloads!.client!
    if (!Number.isSafeInteger(expected.size) || expected.size <= 0 || !/^[a-f0-9]{40}$/i.test(expected.sha1)) throw new Error(uiText("ui.clientAssetsCommand.invalidOfficialClientSizeOrShaMetadata"))

    const jar = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: uiText("ui.clientAssetsCommand.mcrhReadyClientCache", picked.entry.id), cancellable: true },
      async (progress, token) => {
        const controller = new AbortController()
        const subscription = token.onCancellationRequested(() => controller.abort())
        if (token.isCancellationRequested) controller.abort()
        try {
          return await ensureCachedClientJar(cacheDir(context), picked.entry.id, expected, (file, signal) => downloadClientJar(url, file, received => {
            progress.report({ message: uiText("ui.clientAssetsCommand.downloadClient", formatSize(received)) })
          }, signal, expected), controller.signal, status => progress.report({ message: status === 'cached' ? uiText("ui.clientAssetsCommand.reuseVerifiedClientCache") : status === 'checking' ? uiText("ui.clientAssetsCommand.verifyLocalClientCaches") : uiText("ui.clientAssetsCommand.downloadClient_2e1d36") }))
        } finally {
          subscription.dispose()
        }
      }
    )

    const plan = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: uiText("ui.clientAssetsCommand.mrchReadClientJar") },
      async progress => planClientReleaseAsync(jar.file, target, picked.entry.id, info => progress.report(info), { version: picked.entry.id, size: expected.size, sha1: expected.sha1 }, undefined, resolution)
    )

    let languageMissing = false
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: uiText("ui.clientAssetsCommand.mcrhCompletingOfficialChineseLanguageResources") }, () => appendClientReleaseLanguage(context, plan, detail))
    } catch (error) {
      languageMissing = true
      const choice = await vscode.window.showWarningMessage(uiText("ui.clientAssetsCommand.chineseLanguageResourcesAreNotComplete", (error instanceof Error ? error.message : String(error))), { modal: true, detail: uiText("ui.clientAssetsCommand.continueToReleaseOnlyTheClientS") }, uiText("ui.clientAssetsCommand.continueEnglishOnly"), uiText("browser.shell.cancel"))
      if (choice !== uiText("ui.clientAssetsCommand.continueEnglishOnly")) return
    }

    if (plan.textureResize?.warnings.length) {
      const warnings = plan.textureResize.warnings
      const choice = await vscode.window.showWarningMessage(uiText("ui.clientAssetsCommand.yeahThePostingChartCannotBeSafely", warnings.length), { modal: true, detail: warnings.slice(0, 20).join('\n') + (warnings.length > 20 ? uiText("ui.clientAssetsCommand.theRestItemsNotExpandedQualifier", (warnings.length - 20)) : '') }, uiText("ui.clientAssetsCommand.continueCompletion"), uiText("browser.shell.cancel"))
      if (choice !== uiText("ui.clientAssetsCommand.continueCompletion")) return
    }

    // 所有生成和补充文件一起进行覆盖确认
    const existing = await findExisting(plan.files.map(file => vscode.Uri.file(file.target.fsPath)))
    const policy = await askOverwrite(existing)
    if (policy === 'cancel') {
      void vscode.window.showInformationMessage(uiText("ui.clientAssetsCommand.releaseCancelledNotWrittenToAnyDocument"))
      return
    }

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: uiText("ui.clientAssetsCommand.mcrhReleaseOriginalResources") },
      async progress => writeClientRelease(
        plan,
        selectReleaseTargets(plan, existing, policy),
        info => progress.report(info)
      )
    )

    if (!plan.textureResize) await registerPreviewClientAssets(context, picked.entry.id, result.targetDir)
    const skippedCount = plan.files.length - result.fileCount
    const resolutionNote = plan.textureResize ? uiText("ui.clientAssetsCommand.basicResolutionAdjustedPostingGraphsFixedSize", plan.textureResize.resolution, plan.textureResize.resolution, plan.textureResize.resized, plan.textureResize.fixedSize) : uiText("ui.clientAssetsCommand.retainOriginalResolution")
    const skippedNote = skippedCount > 0 ? uiText("ui.clientAssetsCommand.skipExistingFile", skippedCount) : ''
    // jar 中损坏或加密的条目无法解压, 数量不为零时提示用户, 避免贴图凭空缺失且无提示
    const failedNote = plan.failedCount > 0 ? uiText("ui.clientAssetsCommand.anEntryWasDamagedOrEncryptedWithout", plan.failedCount) : ''
    const action = await vscode.window.showInformationMessage(
      uiText("ui.clientAssetsCommand.releasedAnOriginalFileToClientJar", result.fileCount, path.basename(result.targetDir), skippedNote, failedNote, resolutionNote, languageMissing ? uiText("ui.clientAssetsCommand.chineseUncompleted") : uiText("ui.clientAssetsCommand.alreadyChineseLanguageAndPackageMetadata")),
      uiText("ui.clientAssetsCommand.openDirectory"), uiText("ui.clientAssetsCommand.openAsWorkspace")
    )
    if (action === uiText("ui.clientAssetsCommand.openDirectory")) {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(result.targetDir))
    } else if (action === uiText("ui.clientAssetsCommand.openAsWorkspace")) {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(result.targetDir), { forceNewWindow: true })
    }
  } catch (error) {
    if (isAbortError(error)) {
      void vscode.window.showInformationMessage(uiText("ui.clientAssetsCommand.canceledDownloadsNotWrittenToAnyFiles"))
    } else {
      void vscode.window.showErrorMessage(uiText("ui.clientAssetsCommand.unleashingOriginalResourceFailed", error instanceof Error ? error.message : String(error)))
    }
  }
}

async function pickTargetDir(): Promise<string | undefined> {
  const roots = workspaceRoots()
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: roots[0] ? vscode.Uri.file(roots[0]) : undefined,
    openLabel: uiText("ui.clientAssetsCommand.releaseOriginalResourceToThisDirectory")
  })
  return picked?.[0]?.fsPath
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
