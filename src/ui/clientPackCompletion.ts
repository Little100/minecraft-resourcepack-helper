import { uiText } from '../i18n/messages'
import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { assertClientAssetsPath, clientPackMetadata, type ReleasePlan } from '../core/clientAssets'
import type { VersionDetail } from '../core/versionManifest'
import { ensurePreviewLanguageAssets, findPreviewLanguageAssets } from './previewLanguageAssets'

const chinesePath = 'assets/minecraft/lang/zh_cn.json'

async function readSupplement(filename: string): Promise<Uint8Array> {
  await assertClientAssetsPath(filename)
  const before = await fs.lstat(filename)
  if (!before.isFile() || before.size > 4 * 1024 * 1024) throw new Error(uiText("ui.clientPackCompletion.clientCompletionFileInvalidOrBeyondRead"))
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) throw new Error(uiText("ui.clientPackCompletion.clientCompletionFileChangedPleaseTryAgain"))
    const bytes = await handle.readFile()
    if (bytes.length !== before.size) throw new Error(uiText("ui.clientPackCompletion.clientCompletionFileChangedPleaseTryAgain"))
    JSON.parse(bytes.toString('utf8'))
    return bytes
  } finally { await handle.close() }
}

// 中文由对应客户端的资源索引补充，仍参与同一套覆盖确认
export async function appendClientReleaseLanguage(context: vscode.ExtensionContext, plan: ReleasePlan, detail: VersionDetail): Promise<void> {
  const target = path.join(plan.root, ...chinesePath.split('/'))
  if (plan.files.some(file => file.target.fsPath === target)) return
  const languageRoot = await ensurePreviewLanguageAssets(context, plan.version, { detail, throwOnError: true })
  if (!languageRoot) throw new Error(uiText("ui.clientPackCompletion.chineseLanguageResourceReadyCancelled"))
  plan.files.push({ target: { fsPath: target }, data: await readSupplement(path.join(languageRoot, ...chinesePath.split('/'))) })
}

// 手动补全只新增缺失项，预览后台缓存不会写入用户资源包
export async function completeCurrentClientPack(context: vscode.ExtensionContext, packRoot: string, version: string, vanillaRoot: string): Promise<void> {
  await assertClientAssetsPath(packRoot)
  const sources = [
    { relative: 'pack.mcmeta', load: async () => {
      try { return await readSupplement(path.join(vanillaRoot, 'pack.mcmeta')) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return clientPackMetadata(version) }
    } },
    { relative: chinesePath, load: async () => {
      const languageRoot = await findPreviewLanguageAssets(context, version) ?? await ensurePreviewLanguageAssets(context, version, { throwOnError: true })
      if (!languageRoot) throw new Error(uiText("ui.clientPackCompletion.theOfficialChineseLanguageResourcesAreNot"))
      return readSupplement(path.join(languageRoot, ...chinesePath.split('/')))
    } }
  ]
  const missing: typeof sources = []
  for (const source of sources) {
    const target = path.join(packRoot, ...source.relative.split('/'))
    await assertClientAssetsPath(target)
    try { await fs.lstat(target) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; missing.push(source) }
  }
  if (!missing.length) return
  const chosen = await vscode.window.showInformationMessage(uiText("ui.clientPackCompletion.previewCacheReadyToCompleteMissingFiles"), { modal: true, detail: packRoot + '\n' + missing.map(file => file.relative).join('\n') }, uiText("ui.clientPackCompletion.completeTheCurrentPackage"), uiText("ui.clientPackCompletion.forPreviewOnly"))
  if (chosen !== uiText("ui.clientPackCompletion.completeTheCurrentPackage")) return
  const loaded = await Promise.all(missing.map(async file => ({ ...file, data: await file.load() })))
  let written = 0
  for (const file of loaded) {
    const target = path.join(packRoot, ...file.relative.split('/'))
    await assertClientAssetsPath(target)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await assertClientAssetsPath(target)
    const temporary = path.join(path.dirname(target), '.mcrh-complete-' + randomUUID())
    await assertClientAssetsPath(temporary)
    let created = false
    try {
      const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW)
      created = true
      try { await handle.writeFile(file.data); await handle.sync() } finally { await handle.close() }
      await assertClientAssetsPath(target)
      try { await fs.link(temporary, target); written++ }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    } finally { if (created) await fs.unlink(temporary) }

  }
  void vscode.window.showInformationMessage(uiText("ui.clientPackCompletion.currentPackageCompletedMissingFilesExistingOnes", written))
}
