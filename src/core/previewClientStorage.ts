import { uiText } from '../i18n/messages'
import * as path from 'node:path'

export interface PreviewStorageContext {
  globalStorageUri?: { scheme: string; fsPath: string }
  globalStoragePath?: string
}

// 扩展宿主的本地路径兼容用户数据协议与旧版存储接口
export function previewClientStoragePath(context: PreviewStorageContext): string {
  const uri = context.globalStorageUri
  const storage = uri && ['file', 'vscode-userdata'].includes(uri.scheme) && path.isAbsolute(uri.fsPath)
    ? uri.fsPath : context.globalStoragePath
  if (!storage || !path.isAbsolute(storage)) throw new Error(uiText("core.previewClientStorage.couldNotGetLocalStoragePathFor"))
  return path.resolve(storage)
}
