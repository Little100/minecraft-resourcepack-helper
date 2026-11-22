import * as vscode from 'vscode'
import { previewClientStoragePath } from '../core/previewClientStorage'
import { previewPathKey } from '../core/texturePreviewState'
import { sourceOf } from './previewResourceContext'

export function isPreviewLanguageFile(file: string): boolean {
  return /(?:^|[\\/])assets[\\/][a-z0-9_.-]+[\\/]lang[\\/](?:zh_cn|en_us)\.json$/i.test(file) || /(?:^|[\\/])\.mcrh-(?:languages|vanilla)\.json$/i.test(file)
}

// 语言监听覆盖当前包、基础资源与缓存发布，不跟随像素更新重建模型
export function watchPreviewLanguages(uri: vscode.Uri, context: vscode.ExtensionContext, changed: () => void, roots: readonly string[] = []): vscode.Disposable {
  const current = sourceOf(uri.fsPath)?.root
  const base = vscode.workspace.getConfiguration('mcrh').get<string>('previewBaseAssetsPath', '').trim()
  const locations = [...new Map([...(current ? [current] : []), ...(base ? [base] : []), ...roots].map(root => [previewPathKey(root), root])).values()]
  const patterns = locations.map(root => new vscode.RelativePattern(root, 'assets/*/lang/{zh_cn,en_us}.json'))
  try {
    const storage = previewClientStoragePath(context)
    patterns.push(new vscode.RelativePattern(storage, 'preview-{assets,languages}/minecraft-*/assets/*/lang/{zh_cn,en_us}.json'))
    patterns.push(new vscode.RelativePattern(storage, 'preview-{assets,languages}/minecraft-*/.mcrh-{languages,vanilla}.json'))
  } catch {}
  const subscriptions: vscode.Disposable[] = []
  for (const pattern of patterns) {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern)
    subscriptions.push(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed))
  }
  return vscode.Disposable.from(...subscriptions)
}
