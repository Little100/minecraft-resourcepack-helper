import { uiText } from '../i18n/messages'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { ModelPreviewAssets } from '../core/modelPreviewAssets'
import { validJavaModelResourcePath } from '../core/javaModelResources'
import { previewPathKey } from '../core/texturePreviewState'

// 模型预览读取编辑器中的未保存 JSON，路径与文件权限仍由资源层校验
export class EditorModelPreviewAssets extends ModelPreviewAssets {
  override async read(file: string, layer?: number): Promise<Uint8Array | undefined> {
    if (!validJavaModelResourcePath(file) && !/^assets\/[a-z0-9_.-]+\/(?:font|items)\/[a-z0-9_./-]+\.json$/.test(file)) return super.read(file, layer)
    const layers = layer === undefined ? this.roots.map((_, index) => index) : [layer]
    for (const index of layers) {
      const bytes = await super.read(file, index)
      if (!bytes) continue
      const target = previewPathKey(path.join(this.roots[index]!, ...file.split('/')))
      const document = (vscode.workspace.textDocuments ?? []).find(value => value.uri.scheme === 'file' && !value.isClosed && value.isDirty && previewPathKey(value.uri.fsPath) === target)
      if (!document) return bytes
      const text = document.getText()
      if (Buffer.byteLength(text) > this.limits.maxJsonBytes) throw new Error(uiText("ui.previewModelAssets.unsavedModelJsonExceededPreviewSizeLimit"))
      return new TextEncoder().encode(text)
    }
    return undefined
  }
}
