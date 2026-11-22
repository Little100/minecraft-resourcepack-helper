import { uiText } from '../i18n/messages'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { PNG } from 'pngjs'
import { loadFontGlyphs, type FontGlyphResult } from '../core/fontGlyphs'
import { texturePreviewState } from '../core/texturePreviewState'
import { previewResourceContext, sourceOf } from './previewResourceContext'

export function fontRoot(uri: vscode.Uri): string | undefined {
  return path.basename(uri.fsPath).toLowerCase() === 'pack.mcmeta' ? path.dirname(uri.fsPath) : sourceOf(uri.fsPath)?.root
}
export async function fontResources(uri: vscode.Uri, context: vscode.ExtensionContext): Promise<NonNullable<Awaited<ReturnType<typeof previewResourceContext>>>> {
  const root = fontRoot(uri)
  if (!root) throw new Error(uiText("ui.fontSupport.pleaseUseFontAidsFromThePack"))
  const resources = await previewResourceContext(vscode.Uri.file(path.join(root, 'assets', 'minecraft', 'font', 'default.json')), context)
  if (!resources) throw new Error(uiText("ui.fontSupport.noResourcePackFontDirectoryFound"))
  return resources
}
export async function fontGlyphs(uri: vscode.Uri, context: vscode.ExtensionContext, font: string, requested?: ReadonlySet<string>, search = ''): Promise<FontGlyphResult> {
  const resources = await fontResources(uri, context)
  const result = await loadFontGlyphs({ readFonts: async file => {
    const layers: Array<{ bytes: Uint8Array; layer: number }> = []
    for (let index = 0; index < resources.assets.roots.length; index++) { const bytes = await resources.assets.read(file, index); if (bytes) layers.push({ bytes, layer: index }) }
    return layers
  }, read: async file => {
    if (file.endsWith('.png')) {
      for (const root of resources.assets.roots) {
        const memory = texturePreviewState.read(path.join(root, file))
        if (memory) { const image = new PNG({ width: memory.width, height: memory.height }); image.data = Buffer.from(memory.pixels); return PNG.sync.write(image) }
        if (await resources.assets.read(file, resources.assets.roots.indexOf(root))) break
      }
    }
    return resources.assets.read(file)
  } }, font, requested, search)
  return result
}
