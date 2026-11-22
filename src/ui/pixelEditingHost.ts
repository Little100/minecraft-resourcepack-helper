import { uiText } from '../i18n/messages'
import * as vscode from 'vscode'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { assertClientAssetsPath } from '../core/clientAssets'
import { isArrayBuffer } from '../core/pixelCodec'
import { localImageUri, MAX_IMAGE_IMPORT_BYTES, MAX_IMAGE_IMPORT_FILES } from '../core/imageImportUris'
import { assertEditSize } from '../core/pixelTransforms'
import { canMarkTexture } from '../core/mcrhMark'
import { edgeRecolorOptions } from '../core/edgeRecolor'
import { recolorLayerComposite } from '../core/layerEdgeRecolor'
import { writeLayerExport } from './pixelLayerExport'
import type { PixelDocumentModel } from './pixelEditor'
let clipboard: { width: number; height: number; pixels: Uint8Array; marker: string } | undefined
let clipboardTail: Promise<void> = Promise.resolve()
const queueClipboard = (operation: () => Promise<void>): Promise<void> => {
  const pending = clipboardTail.catch(() => undefined).then(operation)
  clipboardTail = pending
  return pending
}

async function isSameLocalFile(source: vscode.Uri, target: vscode.Uri): Promise<boolean> {
  if (source.toString() === target.toString()) return true
  if (source.scheme !== 'file' || target.scheme !== 'file') return false
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
  const sourcePath = path.resolve(source.fsPath), targetPath = path.resolve(target.fsPath)
  try {
    const [left, right] = await Promise.all([fs.stat(sourcePath), fs.stat(targetPath)])
    if (left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino) return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const resolveExisting = async (filename: string): Promise<string> => {
    try { return await fs.realpath(filename) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return filename
    }
  }
  const sourceReal = await resolveExisting(sourcePath)
  let targetReal: string
  try { targetReal = await fs.realpath(targetPath) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    targetReal = path.join(await resolveExisting(path.dirname(targetPath)), path.basename(targetPath))
  }
  return normalize(sourceReal) === normalize(targetReal)
}

export class PixelEditingHost {
  private disposed = false
  private importing = false
  private exporting = false
  constructor(private readonly model: PixelDocumentModel, private readonly webview: vscode.Webview) {}
  async handle(raw: unknown): Promise<void> {
    if (this.disposed || !raw || typeof raw !== 'object') return
    const input = raw as Record<string, unknown>
    try {
      if (input.action === 'exportLayers') { await this.exportLayers(input); return }
      const rotation = input.rotation === undefined ? 0 : input.rotation
      if (typeof rotation !== 'number' || !Number.isFinite(rotation)) throw new Error(uiText("ui.pixelEditingHost.rotationAngleInvalid"))
      if (input.action === 'edgeRecolor') {
        await this.recolorLayers(input)
        return
      }
      if (input.action === 'importFiles' || input.action === 'importUris') { await this.importImages(input); return }
      if (input.action === 'resize') {
        if (input.perFrame === true) this.model.resizeFrames(Number(input.width), Number(input.height), input.scale === true)
        else this.model.resize(Number(input.width), Number(input.height), input.scale === true)
      }
      else if (input.action === 'frames') {
        if (!Array.isArray(input.order) || input.order.length > 8192) throw new Error(uiText("ui.pixelEditingHost.frameOrderInvalid"))
        this.model.frames(Number(input.height), input.order as number[])
      } else if (input.action === 'transform') {
        if (!Array.isArray(input.layerIds) || input.layerIds.some(id => typeof id !== 'string')) throw new Error(uiText("ui.pixelEditingHost.invalidChangeLayerList"))
        if (input.sourceWidth !== this.model.document.width || input.sourceHeight !== this.model.document.height) throw new Error(uiText("ui.pixelEditingHost.theCanvasHasChangedPleaseStartOver"))
        this.model.transformLayers(input.layerIds as string[], Number(input.x), Number(input.y), Number(input.targetWidth), Number(input.targetHeight), rotation)
        if (!this.disposed) await this.webview.postMessage({ command: 'pixelToolsResult', action: 'transform', ok: true })
      } else if (input.action === 'insert' || input.action === 'copy') {
        const width = Number(input.width), height = Number(input.height)
        assertEditSize(width, height)
        if (!isArrayBuffer(input.pixels) || input.pixels.byteLength !== width * height * 4) throw new Error(uiText("ui.pixelEditingHost.invalidImportPixelData"))
        const pixels = new Uint8Array(input.pixels)
        if (input.action === 'copy') {
          const copied = pixels.slice()
          await queueClipboard(async () => {
            if (this.disposed) return
            const marker = 'mcrh-pixels:' + randomUUID()
            await vscode.env.clipboard.writeText(marker)
            if (await vscode.env.clipboard.readText() !== marker) throw new Error(uiText("ui.pixelEditingHost.systemClipboardChangesWhileCopyingPleaseRecopy"))
            clipboard = { width, height, pixels: copied, marker }
            if (!this.disposed) {
              this.model.notify('info', uiText("ui.pixelEditingHost.pixelsHaveBeenCopiedAndYouCan"))
              await this.webview.postMessage({ command: 'pixelToolsResult', action: 'copy', ok: true })
            }
          })
        } else {
          const x = Number(input.x), y = Number(input.y), targetWidth = Number(input.targetWidth), targetHeight = Number(input.targetHeight)
          const name = typeof input.name === 'string' ? input.name : uiText("ui.pixelEditingHost.pasteLayer")
          if (typeof input.layerId === 'string') {
            const layer = this.model.document.findLayer(input.layerId)
            if (!layer) throw new Error(uiText("ui.pixelEditingHost.theChangedLayerNoLongerExists"))
            this.model.transformLayers([input.layerId], x, y, targetWidth, targetHeight, rotation)
          } else this.model.insertImage(pixels, width, height, x, y, targetWidth, targetHeight, name, rotation)
          if (!this.disposed) await this.webview.postMessage({ command: 'pixelToolsResult', action: 'insert', ok: true })
        }
      } else if (input.action === 'paste') {
        await queueClipboard(async () => {
          if (this.disposed) return
          const copied = clipboard
          if (!copied || await vscode.env.clipboard.readText() !== copied.marker) throw new Error(uiText("ui.pixelEditingHost.clipboardIsNotACopiedPixelPlease"))
          if (!this.disposed) await this.webview.postMessage({ command: 'pixelClipboard', width: copied.width, height: copied.height, pixels: copied.pixels.slice().buffer })
        })
      }
    } catch (error) {
      if (this.disposed) return
      this.model.notify('error', error instanceof Error ? error.message : String(error))
      if (['insert', 'transform', 'edgeRecolor', 'copy', 'exportLayers'].includes(String(input.action))) await this.webview.postMessage({ command: 'pixelToolsResult', action: input.action, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  private async exportLayers(input: Record<string, unknown>): Promise<void> {
    if (this.exporting) return
    const ids = input.layerIds
    if (!Array.isArray(ids) || !ids.length || ids.length > this.model.document.layers.length || ids.some(id => typeof id !== 'string' || !this.model.document.findLayer(id)) || new Set(ids).size !== ids.length) throw new Error(uiText("ui.pixelEditingHost.selectAValidAndNonDuplicativeLayer"))
    if (input.mode !== undefined && input.mode !== 'layers' && input.mode !== 'merged') throw new Error(uiText("ui.pixelEditingHost.theLayerExportMethodIsInvalid"))
    const merged = input.mode === 'merged'
    const document = this.model.document.extractLayers(ids as string[], merged)
    this.exporting = true
    try {
      const target = await vscode.window.showSaveDialog({
        title: merged ? uiText("ui.pixelEditingHost.mergesTheSelectedLayerAsASingle") : uiText("ui.pixelEditingHost.exportSelectedLayerMaintainStandAloneLayer"),
        defaultUri: this.model.uri.with({ path: this.model.uri.path.replace(/\.png$/i, '') + (merged ? '-merged.png' : '-layers.png') }),
        filters: { PNG: ['png'] },
        saveLabel: merged ? uiText("ui.pixelEditingHost.mergeExport") : uiText("ui.pixelEditingHost.keepLayerExport")
      })
      if (!target || this.disposed) return
      const sameFile = await isSameLocalFile(this.model.uri, target)
      if (sameFile) throw new Error(uiText("ui.pixelEditingHost.pleaseExportToANewPngFile"))
      const png = document.toPng(canMarkTexture(target.path))
      this.model.warnIfOutsideWorkspace(target)
      await writeLayerExport(this.model.uri, target, document, png)
      if (!this.disposed) {
        const structure = vscode.workspace.getWorkspaceFolder(target) ? uiText("ui.pixelEditingHost.mcrhHasBeenRetainedLayers", document.layers.length) : uiText("ui.pixelEditingHost.retainOnlySyntheticPngOutsideTheWorkspace")
        this.model.notify('info', '(' + (merged ? uiText("ui.pixelEditingHost.selectedFigureLayersHaveBeenMergedInto") : uiText("ui.pixelEditingHost.selectedLayerExportedToPng")) + structure + ')')
        await this.webview.postMessage({ command: 'pixelToolsResult', action: 'exportLayers', ok: true })
      }
    } finally { this.exporting = false }
  }

  private async recolorLayers(input: Record<string, unknown>): Promise<void> {
    const ids = input.layerIds
    if (!Array.isArray(ids) || !ids.length || ids.length > this.model.document.layers.length || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error(uiText("ui.pixelEditingHost.selectAValidAndNonDuplicativeLayer"))
    const document = this.model.document, options = edgeRecolorOptions(input.options)
    const mask = input.mask === undefined ? undefined : isArrayBuffer(input.mask) ? new Uint8Array(input.mask) : undefined
    if (input.mask !== undefined && (!mask || mask.length !== document.width * document.height || mask.some(value => value !== 0 && value !== 1))) throw new Error(uiText("ui.pixelEditingHost.invalidColoredSelectionData"))
    const frameHeight = document.frameHeight ?? (document.frameCount > 1 ? document.width : document.height)
    if (ids.some(id => !document.findLayer(id as string))) throw new Error(uiText("ui.pixelEditingHost.theSelectedLayerDoesNotExist"))
    const selected = document.layers.filter(layer => ids.includes(layer.id))
    const recolored = recolorLayerComposite(selected, document.width, document.height, { ...options, frameWidth: document.width, frameHeight }, mask)
    const changes = selected.map((layer, index) => ({ layer, pixels: recolored[index] })).filter(change => change.pixels !== change.layer.pixels)
    if (changes.length) this.model.changeDocument(uiText("ui.pixelEditingHost.autoEdgesHeavyOnColourLayers", changes.length), () => { for (const change of changes) change.layer.pixels = change.pixels })
    if (!this.disposed) await this.webview.postMessage({ command: 'pixelToolsResult', action: 'edgeRecolor', ok: true })
  }
  private async importImages(input: Record<string, unknown>): Promise<void> {
    if (this.importing) throw new Error(uiText("ui.pixelEditingHost.importingPicturesPleaseTryAgainLater"))
    this.importing = true
    try {
      let selected: readonly vscode.Uri[] | undefined
      if (input.action === 'importFiles') selected = await vscode.window.showOpenDialog({ title: uiText("ui.pixelEditingHost.importANewLayerOfPicturesAs"), canSelectFiles: true, canSelectFolders: false, canSelectMany: true, filters: { [uiText("ui.pixelEditingHost.picturePngJpegWebp")]: ['png', 'jpg', 'jpeg', 'webp'] }, openLabel: uiText("core.pixelTransforms.importLayer") })
      else {
        if (!Array.isArray(input.uris) || !input.uris.length || input.uris.length > MAX_IMAGE_IMPORT_FILES) throw new Error(uiText("ui.pixelEditingHost.invalidPathOfTheTowedPicture"))
        const uris = input.uris.map(localImageUri)
        if (uris.some(uri => !uri)) throw new Error(uiText("ui.pixelEditingHost.theDragInPhotoPathMustBe"))
        const localFiles = (uris as string[]).map(value => {
          const uri = /^file:\/\//i.test(value) ? vscode.Uri.parse(value, true) : vscode.Uri.file(value)
          return vscode.Uri.file(path.resolve(uri.fsPath))
        })
        selected = [...new Map(localFiles.map(uri => [process.platform === 'win32' ? uri.fsPath.toLowerCase() : uri.fsPath, uri])).values()]
        if (selected.some(uri => uri.scheme !== 'file' || uri.authority || !vscode.workspace.getWorkspaceFolder(uri))) {
          selected = await vscode.window.showOpenDialog({ title: uiText("ui.pixelEditingHost.pleaseConfirmTheLocalPictureToBe"), canSelectFiles: true, canSelectFolders: false, canSelectMany: true, filters: { [uiText("ui.pixelEditingHost.picturePngJpegWebp")]: ['png', 'jpg', 'jpeg', 'webp'] }, openLabel: uiText("core.pixelTransforms.importLayer") })
        }
      }
      if (this.disposed || !selected?.length) return
      if (selected.length > MAX_IMAGE_IMPORT_FILES) throw new Error(uiText("ui.pixelEditingHost.importUpToPicturesAtATime"))
      for (const uri of selected) {
        if (this.disposed) return
        if (uri.scheme !== 'file' || uri.authority) throw new Error(uiText("ui.pixelEditingHost.onlySupportLocalPictureFiles"))
        const extension = path.extname(uri.fsPath).toLowerCase(), mime = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : ['.jpg', '.jpeg'].includes(extension) ? 'image/jpeg' : undefined
        if (!mime) throw new Error(uiText("ui.pixelEditingHost.onlyPngJpegOrWebpPicturesAre"))
        await assertClientAssetsPath(uri.fsPath)
        const before = await fs.lstat(uri.fsPath)
        if (!before.isFile() || before.nlink !== 1 || before.size < 8 || before.size > MAX_IMAGE_IMPORT_BYTES) throw new Error(uiText("ui.pixelEditingHost.picturesAreNotIndependentNormalFilesOr"))
        const handle = await fs.open(uri.fsPath, constants.O_RDONLY | constants.O_NOFOLLOW)
        let bytes: Buffer
        try {
          const stat = await handle.stat()
          if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size) throw new Error(uiText("ui.pixelEditingHost.pictureChangedBeforeReadingPleaseTryAgain"))
          bytes = Buffer.alloc(before.size)
          let offset = 0
          while (offset < bytes.length) { const result = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset); if (!result.bytesRead) throw new Error(uiText("ui.pixelEditingHost.imageReadingIncomplete")); offset += result.bytesRead }
          const after = await handle.stat()
          await assertClientAssetsPath(uri.fsPath)
          if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error(uiText("ui.pixelEditingHost.pictureChangedWhenReadTryAgain"))
        } finally { await handle.close() }
        const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
        if (!(mime === 'image/png' ? png : mime === 'image/jpeg' ? jpeg : webp)) throw new Error(uiText("ui.pixelEditingHost.pictureContentIsNotConsistentWithFile"))
        if (!this.disposed) await this.webview.postMessage({ command: 'pixelImportFile', data: Uint8Array.from(bytes).buffer, name: path.basename(uri.fsPath), mime })
      }
    } finally { this.importing = false }
  }
  dispose(): void { this.disposed = true }

}
