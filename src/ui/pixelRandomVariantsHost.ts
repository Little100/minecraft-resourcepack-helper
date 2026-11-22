import { uiText } from '../i18n/messages'
import * as vscode from 'vscode'
import * as path from 'node:path'
import { readSafeExportFile } from '../core/advanced/exportPolicy'
import { buildProjectText, encodeProjectText } from '../core/project'
import { assertEditSize } from '../core/pixelGeometry'
import { editRandomVariant } from '../core/randomVariantEdits'
import { defaultVariantId } from '../core/randomVariants'
import { zipSync, strToU8 } from 'fflate'
import type { PixelDocumentModel } from './pixelEditor'
import { previewResourceContext } from './previewResourceContext'
import { generateRandomBlockPatch } from '../core/randomBlockExport'
import { PixelDocument } from '../core/document'

export class PixelRandomVariantsHost {
  private busy = false
  private disposed = false
  private readonly disposal: vscode.Disposable
  constructor(private readonly context: vscode.ExtensionContext, private readonly model: PixelDocumentModel) { this.disposal = model.onDidDispose(() => this.dispose()) }
  dispose(): void { this.disposed = true; this.disposal?.dispose() }
  async addImages(): Promise<void> {
    if (this.busy || this.disposed) return
    this.busy = true
    try {
      if (!vscode.workspace.isTrusted) throw new Error(uiText("ui.pixelRandomVariantsHost.pleaseTrustTheWorkspaceBeforeImportingRandom"))
      const uris = await vscode.window.showOpenDialog({ title: uiText("ui.pixelRandomVariantsHost.addRandomPastePngOfTheLayout"), filters: { PNG: ['png'] }, canSelectMany: true, canSelectFiles: true, canSelectFolders: false })
      if (!uris?.length || this.disposed) return
      const doc = this.model.document, width = doc.width, height = doc.height
      assertEditSize(width, height, doc.layers.length + uris.length)
      const images: { name: string; pixels: Uint8Array }[] = []
      let bytes = 0
      for (const uri of uris) {
        if (uri.scheme !== 'file') throw new Error(uiText("ui.pixelRandomVariantsHost.onlyLocalPngFilesCanBeSelected"))
        const data = await readSafeExportFile(path.dirname(uri.fsPath), path.basename(uri.fsPath), 16 * 1024 * 1024)
        if ((bytes += data.byteLength) > 64 * 1024 * 1024) throw new Error(uiText("ui.pixelRandomVariantsHost.singleImportInExcessOfMibAdd"))
        const source = PixelDocument.fromPng(data)
        if (source.width !== width || source.height !== height) throw new Error(path.basename(uri.fsPath) + uiText("ui.pixelRandomVariantsHost.yes") + source.width + '×' + source.height + uiText("ui.pixelRandomVariantsHost.needsACanvasWith") + width + '×' + height + uiText("ui.pixelRandomVariantsHost.consistencyResizeFirstInPixelEditor"))
        images.push({ name: path.basename(uri.fsPath).slice(0, 40), pixels: source.flatten() })
      }
      if (this.disposed) return
      if (this.model.document !== doc || doc.width !== width || doc.height !== height) throw new Error(uiText("ui.pixelRandomVariantsHost.theCanvasHasChangedPleaseReAdd"))
      assertEditSize(width, height, doc.layers.length + images.length)
      this.model.changeDocument(uiText("ui.pixelRandomVariantsHost.addRandomPaste"), () => {
        if (!doc.layers.some(layer => layer.randomVariant)) editRandomVariant(doc, { command: 'editRandomVariant', layerId: doc.activeLayer()!.id, action: 'enable' })
        const active = doc.activeLayer(), reference = active?.randomVariant ? active.id : defaultVariantId(doc.layers)
        let insertAt = doc.layers.findIndex(layer => layer.id === reference)
        if (insertAt < 0) throw new Error(uiText("ui.pixelRandomVariantsHost.noRandomCandidateLayerFoundReSelect"))
        for (const image of images) {
          const layer = doc.insertLayer(insertAt++, image.name, image.pixels)
          layer.randomVariant = { weight: 1 }; doc.setActiveLayer(layer.id)
        }
      })
    } catch (error) { this.model.notify('error', uiText("ui.pixelRandomVariantsHost.couldNotCloseTemporaryFolder", String(error))) }
    finally { this.busy = false }
  }
  async handle(raw: unknown): Promise<void> {
    if (this.busy || this.disposed || !raw || typeof raw !== 'object') return
    const input = raw as Record<string, unknown>
    if (input.command === 'randomVariants' && input.action === 'addImages') { await this.addImages(); return }
    if (input.command !== 'randomVariants' || input.action !== 'export' || !['vanilla', 'optifine'].includes(String(input.mode)) || typeof input.block !== 'string' || input.block.length > 512 || !['all', 'opposite', 'none'].includes(String(input.symmetry)) || typeof input.linked !== 'boolean') return
    this.busy = true
    try {
      if (!vscode.workspace.isTrusted) throw new Error(uiText("ui.pixelRandomVariantsHost.pleaseTrustTheWorkspaceBeforeGeneratingA"))
      const snapshot = this.model.document.snapshot(), doc = PixelDocument.fromLayers(snapshot.width, snapshot.height, snapshot.layers, snapshot.activeLayerId)
      doc.frameHeight = snapshot.frameHeight
      const context = await previewResourceContext(this.model.uri, this.context)
      if (!context || !context.source.relative.endsWith('.png')) throw new Error(uiText("ui.pixelRandomVariantsHost.pleaseGenerateRandomSquaresFromPngIn"))
      const block = input.block.trim() || context.source.relative.replace(/^assets\/([^/]+)\/textures\/block\/(.+)\.png$/, '$1:$2')
      const metadata = await context.assets.readJson('pack.mcmeta', 0)
      const animationBytes = await context.assets.read(context.source.relative + '.mcmeta')
      if (animationBytes && animationBytes.byteLength > 1024 * 1024) throw new Error(uiText("ui.pixelRandomVariantsHost.animatedMetadataExceedingSizeLimit"))
      const animation = animationBytes ? JSON.parse(Buffer.from(animationBytes).toString('utf8')) : undefined
      const files = await generateRandomBlockPatch({ document: doc, assets: context.assets, texturePath: context.source.relative, block, metadata, animation, mode: input.mode as 'vanilla' | 'optifine', symmetry: input.symmetry as 'all' | 'opposite' | 'none', linked: input.linked })
      if (input.includeMcrh === true) {
        const base = files.find(file => file.path === context.source.relative)!
        const text = buildProjectText(doc, base.content as Uint8Array, new Date(), context.source.relative)
        files.push({ path: '.mcrh/resources/' + context.source.relative + '.mcrh', content: encodeProjectText(text) })
      }
      const totalBytes = files.reduce((sum, file) => sum + (typeof file.content === 'string' ? Buffer.byteLength(file.content) : file.content.byteLength), 0)
      if (totalBytes > 64 * 1024 * 1024) throw new Error(uiText("ui.pixelRandomVariantsHost.patchesAndEditingDataInExcessOf"))
      if (this.disposed) return
      const target = await vscode.window.showSaveDialog({ title: uiText("ui.pixelRandomVariantsHost.saveRandomBlockResourcePatchesMountedAbove"), filters: { [uiText("ui.pixelRandomVariantsHost.resourcePackZip")]: ['zip'] }, defaultUri: vscode.Uri.joinPath(this.model.uri, '..', path.basename(this.model.uri.fsPath, '.png') + '-random.zip') })
      if (!target || this.disposed) return
      const entries: Record<string, Uint8Array> = Object.create(null)
      for (const file of files) entries[file.path] = typeof file.content === 'string' ? strToU8(file.content) : file.content
      await vscode.workspace.fs.writeFile(target, zipSync(entries, { level: 6 }))
      this.model.notify('info', uiText("ui.pixelRandomVariantsHost.randomResourcePatchSavedTotalOneFile", files.length))
    } catch (error) {
      const message = uiText("ui.pixelRandomVariantsHost.couldNotCloseTemporaryFolderS", (error instanceof Error ? error.message : String(error)))
      this.model.notify('error', message)
      void vscode.window.showErrorMessage(message)
    } finally { this.busy = false }
  }
}

