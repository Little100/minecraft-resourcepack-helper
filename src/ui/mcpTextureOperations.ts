import { uiText } from '../i18n/messages'
import * as vscode from 'vscode'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { PixelDocument } from '../core/document'
import { assertEditSize } from '../core/pixelGeometry'
import { updateAnimationMetadata } from '../core/pixelAnimation'
import { prepareTexturePainting } from '../mcp/texturePainting'
import { previewTexture, textureInfo, textureRevision, MCP_PREVIEW_PNG_BYTES } from '../mcp/imagePreview'
import { operationSchemas } from '../mcp/toolSchemas'
import { resolveResource } from '../mcp/resourceAccess'
import { assertMcpRevision, mcpFailure } from '../mcp/errors'
import type { McpProject } from '../mcp/contracts'
import { ReferenceImagesHost, referenceStorageKey } from './referenceImagesHost'
import { inspectReferenceImage } from '../core/referenceImageFormats'
import { PixelEditorProvider, type PixelDocumentModel } from './pixelEditor'

interface TextureAccess { read(root: string, relative: string): Promise<PixelDocument>; edit(root: string, relative: string): Promise<PixelDocumentModel>; authorize(): void }
export const textureWorkflowOperations = new Set(['get_textures','context','references','create_texture','batch_texture','resize_texture','texture_frames'])
export async function invokeTextureWorkflow(project: McpProject, operation: string, raw: Record<string, unknown>, access: TextureAccess, context?: vscode.ExtensionContext): Promise<unknown> {
  const { authorize } = access
  if (operation === 'context') {
    const tabs = vscode.window.tabGroups?.all.flatMap(group => group.tabs) ?? []
    const active = vscode.window.tabGroups?.activeTabGroup.activeTab
    const input = active?.input as { uri?: vscode.Uri } | undefined
    const relative = (uri: vscode.Uri): string | undefined => { const value = path.relative(project.root, uri.fsPath); return value && !value.startsWith('..') && !path.isAbsolute(value) ? value.split(path.sep).join('/') : undefined }
    return { active_path: input?.uri ? relative(input.uri) ?? null : null, textures: PixelEditorProvider.listOpenModels().flatMap(model => {
      const file = relative(model.uri); if (!file) return []
      const tab = tabs.find(tab => (tab.input as { uri?: vscode.Uri })?.uri?.toString() === model.uri.toString())
      return [{ path: file, ...textureInfo(model.document), active_layer_id: model.document.activeLayerId, dirty: tab?.isDirty ?? null, drawing: model.hasLivePreview, history_entries: model.timeline.entries.length, history_cursor: model.timeline.current }]
    }), note: uiText("ui.mcpTextureOperations.dirtyNullIndicatesThatTheCurrentHost") }
  }
  if (operation === 'get_textures') {
    const args = operationSchemas.get_textures.parse(raw), textures: Record<string, unknown>[] = []; let total = 0
    for (const file of args.paths) {
      authorize()
      try {
        const document = await access.read(project.root, file)
        const image = previewTexture(document, operationSchemas.get_texture.parse({ path: file, view: args.view, max_size: args.max_size }))
        if (total + image.encoded_bytes > 4 * 1024 * 1024) throw new Error(uiText("ui.mcpTextureOperations.batchPreviewsExceedingMibPleaseSplitOr"))
        total += image.encoded_bytes
        textures.push({ ...image, path: file, source: PixelEditorProvider.findOpenModel(vscode.Uri.file(await resolveResource(project.root, file))) ? 'current_editor_document' : 'disk' })
      } catch (error) { textures.push({ path: file, error: mcpFailure(error) }) }
    }
    authorize(); return { textures }
  }
  if (operation === 'references') {
    if (!context) throw new Error(uiText("ui.mcpTextureOperations.referenceDiagramNeedsToExpandStorageContext"))
    const args = operationSchemas.references.parse(raw)
    if (!/\.png$/i.test(args.path)) throw new Error(uiText("ui.mcpTextureOperations.theReferenceChartListNeedsTheCorresponding"))
    const uri = vscode.Uri.file(await resolveResource(project.root, args.path))
    const host = new ReferenceImagesHost({ postMessage: async () => true }, { state: context.workspaceState, key: referenceStorageKey(uri) })
    try {
      const references = await host.catalog(); authorize()
      if (args.action === 'list') return { references: references.slice(args.offset, args.offset + args.limit), total_count: references.length, next_offset: args.offset + args.limit < references.length ? args.offset + args.limit : null, untrusted_content: true }
      if (!args.id) throw new Error(uiText("ui.mcpTextureOperations.pleaseGetIdFromTheChartList"))
      const bytes = await host.readApproved(args.id), info = inspectReferenceImage(bytes); authorize()
      if (info.format === 'png') {
        const document = PixelDocument.fromPng(bytes); document.frameHeight = document.height
        const preview = previewTexture(document, operationSchemas.get_texture.parse({ path: args.path, max_size: args.max_size, scale: 1 }))
        return { id: args.id, name: references.find(entry => entry.id === args.id)?.name, width: info.width, height: info.height, png_base64: preview.png_base64, untrusted_content: true }
      }
      if (!['image/jpeg','image/webp','image/gif'].includes(info.mime) || bytes.length > MCP_PREVIEW_PNG_BYTES) throw new Error(uiText("ui.mcpTextureOperations.thisReferenceCanBeShownInThe"))
      return { id: args.id, width: info.width, height: info.height, image_base64: Buffer.from(bytes).toString('base64'), mime_type: info.mime, note: uiText("ui.mcpTextureOperations.returnsTheOriginalFigureInThisFormat"), untrusted_content: true }
    } finally { host.dispose() }
  }
  if (operation === 'create_texture') {
    const args = operationSchemas.create_texture.parse(raw)
    if (!/\.png$/i.test(args.path)) throw new Error(uiText("ui.mcpTextureOperations.requirePngResourcePath"))
    assertEditSize(args.width, args.height)
    if (args.frame_height && args.height % args.frame_height) throw new Error(uiText("ui.mcpTextureOperations.theTotalHeightMustBeAMultiple"))
    const frameHeight = args.frame_height ?? (args.height % args.width === 0 ? Math.min(args.width, args.height) : args.height)
    const metadata = updateAnimationMetadata(args.frame_height === undefined ? undefined : { animation: {} }, args.width, frameHeight, args.height / frameHeight)
    const file = await resolveResource(project.root, args.path, true)
    const targets = [file, ...(metadata ? [await resolveResource(project.root, args.path + '.mcmeta', true)] : [])]
    for (const target of targets) {
      try { await fs.stat(target); throw new Error(uiText("ui.mcpTextureOperations.fileExistsDoNotOverwrite")) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    const plan = { path: args.path, width: args.width, height: args.height, frame_height: frameHeight, files: [args.path, ...(metadata ? [args.path + '.mcmeta'] : [])] }
    authorize()
    if (args.dry_run) return { dry_run: true, created: false, plan }
    const document = PixelDocument.create(args.width, args.height)
    const contents = [document.toPng(false), ...(metadata ? [Buffer.from(JSON.stringify(metadata, null, 2) + '\n')] : [])]
    const created: { path: string; dev: number; ino: number }[] = []
    try {
      for (let index = 0; index < targets.length; index++) {
        authorize()
        await resolveResource(project.root, plan.files[index], true)
        const handle = await fs.open(targets[index], 'wx')
        try {
          const stat = await handle.stat(); created.push({ path: targets[index], dev: stat.dev, ino: stat.ino })
          authorize(); await handle.writeFile(contents[index])
        } finally { await handle.close() }
      }
      authorize()
      return { ...plan, ...textureInfo(await access.read(project.root, args.path)), created: true, saved: true, note: uiText("ui.mcpTextureOperations.createdABlankPngAndNecessaryAnimation") }
    } catch (error) {
      for (const owned of created.reverse()) {
        const stat = await fs.lstat(owned.path).catch(() => undefined)
        if (stat?.isFile() && stat.dev === owned.dev && stat.ino === owned.ino) await fs.unlink(owned.path)
      }
      throw error
    }
  }
  if (operation === 'batch_texture') {
    const args = operationSchemas.batch_texture.parse(raw)
    const paths = await Promise.all(args.targets.map(target => resolveResource(project.root, target.path)))
    if (new Set(paths.map(file => process.platform === 'win32' ? file.toLowerCase() : file)).size !== paths.length) throw new Error(uiText("ui.mcpTextureOperations.theBulkTargetCannotBeRepeated"))
    const prepared = []; let totalPixels = 0
    for (const target of args.targets) {
      authorize()
      const document = await access.read(project.root, target.path)
      totalPixels += document.width * document.height * (document.layers.length + (target.layer_id ? 0 : 1))
      if (totalPixels > 8 * 1024 * 1024) throw new Error(uiText("ui.mcpTextureOperations.batchLayerTotalPixelsInExcessOf"))
      assertMcpRevision(textureRevision(document), target.expected_revision)
      const result = prepareTexturePainting(document, { ...args, layer_id: target.layer_id, layer_name: args.layer_name })
      prepared.push({ target, result })
    }
    authorize()
    if (args.dry_run) return { dry_run: true, changed: false, files: prepared.map(({ target, result }) => ({ path: target.path, width: result.document.width, height: result.document.height, layer_count: result.document.layers.length })) }
    const ready = []
    for (const item of prepared) ready.push({ ...item, model: await access.edit(project.root, item.target.path) })
    authorize(); for (const item of ready) assertMcpRevision(textureRevision(item.model.document), item.target.expected_revision)
    for (const item of ready) item.model.changeDocument(uiText("ui.mcpOperations.mcpBatchDrawing"), () => item.model.document.restore(item.result.document.snapshot()))
    return { saved: false, files: ready.map(item => ({ path: item.target.path, ...textureInfo(item.model.document) })), note: uiText("ui.mcpTextureOperations.filesIndependentlySupportOriginalRevocationUnsavedGet") }
  }
  const args = operation === 'resize_texture' ? operationSchemas.resize_texture.parse(raw) : operationSchemas.texture_frames.parse(raw)
  const model = await access.edit(project.root, args.path); authorize(); assertMcpRevision(textureRevision(model.document), args.expected_revision)
  if ('order' in args) model.frames(args.frame_height, args.order)
  else if (args.per_frame) model.resizeFrames(args.width, args.height, args.mode === 'scale')
  else model.resize(args.width, args.height, args.mode === 'scale')
  return { ...textureInfo(model.document), saved: false }
}
