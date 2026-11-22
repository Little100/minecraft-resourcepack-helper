import { uiText } from '../i18n/messages'
import { optimizeAlphaModel } from '../core/alphaModelOptimizer'
import { foldGeneratedModel } from './generatedModelFolding'
import { constants, lstatSync } from 'node:fs'
import { applyEdits, modify } from 'jsonc-parser'
import { GENERATED_BASE_FIELD, generatedBaseElementCount } from '../core/generatedItemGeometry'
import { planGeneratedItemAddition } from '../core/generatedItemModel'
import { JAVA_MODEL_LIMITS, validateJavaModel, javaModelResourcePath } from '../core/javaModelResources'
import { previewPathKey, texturePreviewState } from '../core/texturePreviewState'
import { PNG } from 'pngjs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { appendGeneratedElements, compactGeneratedModelText } from '../core/generatedModelText'
import * as vscode from 'vscode'
import { assertClientAssetsPath, CLIENT_ASSETS_LIMITS, CLIENT_ASSETS_MANIFEST } from '../core/clientAssets'
import { ModelPreviewAssets } from '../core/modelPreviewAssets'
import { previewClientStoragePath } from '../core/previewClientStorage'

const generatedUpdates = new Set<string>()
const documents = new Map<string, string>()
const providers = new WeakSet<vscode.ExtensionContext>()
const modelPath = /^assets\/[a-z0-9_.-]+\/models\/[a-z0-9_./-]+\.json$/

export function validPreviewModelPath(relative: string): boolean {
  return modelPath.test(relative) && !relative.split('/').some(part => part === '.' || part === '..')
}

type ModelRootAccess = 'editable' | 'vanilla' | 'unconfirmed'
const MAX_SOURCE_MARKER_BYTES = 64 * 1024
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

function insideRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), target)
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

async function completeVanillaRoot(root: string): Promise<boolean> {
  const file = path.join(root, CLIENT_ASSETS_MANIFEST)
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    await assertClientAssetsPath(file)
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_SOURCE_MARKER_BYTES) return false
    const buffer = Buffer.alloc(stat.size + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    const after = await handle.stat()
    if (size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error(uiText("ui.modelPreviewDocuments.originalSourceTagChangedWhileReadingPlease"))
    const marker: unknown = JSON.parse(buffer.subarray(0, size).toString('utf8'))
    // 提取结构升级不改变完整原版来源的只读属性
    return object(marker) && typeof marker.version === 'string' && Boolean(marker.version.trim())
      && marker.assetsRoot === 'assets' && marker.complete === true && marker.versionConfirmed === true && marker.failedCount === 0
      && Number.isSafeInteger(marker.extractionSchema) && Number(marker.extractionSchema) > 0
      && typeof marker.assetPolicy === 'string' && Boolean(marker.assetPolicy)
      && Number.isSafeInteger(marker.fileCount) && Number(marker.fileCount) > 0 && Number(marker.fileCount) <= CLIENT_ASSETS_LIMITS.maxEntries
      && Number.isSafeInteger(marker.totalBytes) && Number(marker.totalBytes) >= 0 && Number(marker.totalBytes) <= CLIENT_ASSETS_LIMITS.maxTotalBytes
      && Array.isArray(marker.includedNamespaces) && marker.includedNamespaces.length > 0 && marker.includedNamespaces.every(value => typeof value === 'string' && Boolean(value))
      && Array.isArray(marker.includedCategories) && marker.includedCategories.length > 0 && marker.includedCategories.every(value => typeof value === 'string' && Boolean(value))
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') || error instanceof SyntaxError) return false
    throw error
  } finally { await handle?.close() }
}

function knownVanillaLocation(context: vscode.ExtensionContext, target: string, packRoot?: string): boolean {
  if (insideRoot(previewClientStoragePath(context), target)) return true
  const registered: unknown = context.globalState?.get('mcrh.previewClientAssets', {})
  if (object(registered) && Object.values(registered).some(value => typeof value === 'string' && path.isAbsolute(value) && insideRoot(value, target))) return true
  const base: unknown = vscode.workspace.getConfiguration('mcrh').get('previewBaseAssetsPath', '')
  if (typeof base !== 'string' || !base.trim() || !path.isAbsolute(base.trim()) || !insideRoot(base.trim(), target)) return false
  // 当前工作区的编辑包可以同时被选为基础资源，目录配置不改变它的编辑身份
  const workspacePack = packRoot && path.relative(path.resolve(base.trim()), path.resolve(packRoot)) === '' && vscode.workspace.isTrusted
    && vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme === 'file' && insideRoot(folder.uri.fsPath, packRoot))
  return !workspacePack
}

async function protectedVanillaLocation(context: vscode.ExtensionContext, target: string): Promise<boolean> {
  if (knownVanillaLocation(context, target)) return true
  for (let directory = path.dirname(path.resolve(target)); ; directory = path.dirname(directory)) {
    if (await completeVanillaRoot(directory)) return true
    if (path.dirname(directory) === directory) return false
  }
}

export async function assertEditableResourceRoot(context: vscode.ExtensionContext, root: string): Promise<void> {
  if (!vscode.workspace.isTrusted) throw new Error(uiText("ui.modelPreviewDocuments.pleaseUseResourcesToCreateAndBatch"))
  await assertClientAssetsPath(path.join(root, 'pack.mcmeta'))
  if (await modelRootAccess(context, new ModelPreviewAssets([root]), path.join(root, 'assets')) !== 'editable') throw new Error(uiText("ui.modelPreviewDocuments.pleaseOperateInAnEditableResourcePack"))
}

async function modelRootAccess(context: vscode.ExtensionContext, assets: ModelPreviewAssets, target: string): Promise<ModelRootAccess> {
  const root = assets.roots[0]!
  if (knownVanillaLocation(context, target, root)) return 'vanilla'
  try {
    if (await completeVanillaRoot(root)) return 'vanilla'
    const metadata = await assets.readJson('pack.mcmeta', 0)
    return object(metadata) && object(metadata.pack) ? 'editable' : 'unconfirmed'
  } catch { return 'unconfirmed' }
}

function assertEditableRoot(access: ModelRootAccess): void {
  if (access === 'vanilla') throw new Error(uiText("ui.modelPreviewDocuments.originalResourceOrPreviewCacheCannotBe"))
  if (access !== 'editable') throw new Error(uiText("ui.modelPreviewDocuments.noEditableMaterialPackageRootConfirmedPlease"))
}

export async function openPreviewModel(context: vscode.ExtensionContext, assets: ModelPreviewAssets, relative: string, create: boolean, fallback?: Record<string, unknown>, showDocument = true): Promise<vscode.Uri | undefined> {
  if (!validPreviewModelPath(relative)) throw new Error(uiText("ui.modelPreviewDocuments.modelPathsMustBeInTheCurrent"))
  const root = assets.roots[0]!, target = path.resolve(root, ...relative.split('/'))
  const access = await modelRootAccess(context, assets, target)
  if (create) assertEditableRoot(access)
  const local = await assets.read(relative, 0)
  if (local && access === 'editable') {
    const uri = vscode.Uri.file(target)
    if (showDocument) await vscode.window.showTextDocument(uri, { preview: true })
    return uri
  }
  const inherited = await assets.readJson(relative)
  const value = inherited && typeof inherited === 'object' && !Array.isArray(inherited) ? inherited : fallback
  if (!create) {
    if (!value) throw new Error(uiText("ui.modelPreviewDocuments.unableToFindAnOpenModelJson"))
    if (!providers.has(context)) {
      context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('mcrh-model-source', { provideTextDocumentContent: uri => documents.get(uri.query) ?? uiText("ui.modelPreviewDocuments.modelshotIsInvalidReopenFromPreview") }))
      providers.add(context)
    }
    const key = randomUUID()
    documents.set(key, JSON.stringify(value, null, 2))
    while (documents.size > 32) documents.delete(documents.keys().next().value!)
    await vscode.window.showTextDocument(vscode.Uri.from({ scheme: 'mcrh-model-source', path: '/' + relative, query: key }), { preview: true })
    return
  }
  if (!value) throw new Error(uiText("ui.modelPreviewDocuments.pleaseFillInTheOriginalClientResource"))
  if (await vscode.window.showWarningMessage(uiText("ui.modelPreviewDocuments.addToTheCurrentPackageCopysThe", relative), { modal: true }, uiText("ui.modelPreviewDocuments.addModelFile")) !== uiText("ui.modelPreviewDocuments.addModelFile")) return
  assertEditableRoot(await modelRootAccess(context, assets, target))
  await assertClientAssetsPath(target)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await assertClientAssetsPath(target)
  try { await fs.writeFile(target, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  await assertClientAssetsPath(target)
  const uri = vscode.Uri.file(target)
  if (showDocument) await vscode.window.showTextDocument(uri, { preview: false })
  return uri
}

export async function openPreviewModelInBlockbench(context: vscode.ExtensionContext, assets: ModelPreviewAssets, relative: string, fallback?: Record<string, unknown>): Promise<void> {
  if (!validPreviewModelPath(relative)) throw new Error(uiText("core.generatedItemModel.modelPathInvalid"))
  const target = path.resolve(assets.roots[0]!, ...relative.split('/'))
  const access = await modelRootAccess(context, assets, target)
  if (access === 'editable') {
    const uri = await openPreviewModel(context, assets, relative, true, fallback, false)
    if (uri) await vscode.commands.executeCommand('mcrh.openInBlockbench', uri)
    return
  }
  const value = await assets.readJson(relative) ?? fallback
  if (!object(value)) throw new Error(uiText("ui.modelPreviewDocuments.couldNotFindAnOpenModelPlease"))
  const folder = vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === 'file')?.uri.fsPath
  const suggested = folder ? path.join(folder, path.basename(relative)) : undefined
  const defaultUri = suggested && !await protectedVanillaLocation(context, suggested) ? vscode.Uri.file(suggested) : undefined
  const uri = await vscode.window.showSaveDialog({ title: uiText("ui.modelPreviewDocuments.savesCopiesOfModelsThatCanBe"), defaultUri, filters: { [uiText("ui.modelPreviewDocuments.minecraftModel")]: ['json'] } })
  if (!uri) return
  if (uri.scheme !== 'file') throw new Error(uiText("ui.modelPreviewDocuments.blockbenchNeedsLocalModelFiles"))
  await assertClientAssetsPath(uri.fsPath)
  if (await protectedVanillaLocation(context, uri.fsPath) || assets.roots.some(base => insideRoot(base, uri.fsPath))) throw new Error(uiText("ui.modelPreviewDocuments.saveACopyFromTheOriginalResource"))
  if ((vscode.workspace.textDocuments ?? []).some(document => document.uri.toString() === uri.toString() && document.isDirty)) throw new Error(uiText("ui.modelPreviewDocuments.targetModelHasUnsavedChangesProcessChanges"))
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n'))
  await vscode.commands.executeCommand('mcrh.openInBlockbench', uri)
}


export async function addPreviewGeneratedBase(context: vscode.ExtensionContext, assets: ModelPreviewAssets, relative: string, valid: () => boolean = () => true): Promise<{ changed: boolean; message: string }> {
  return updatePreviewGeneratedBase(context, assets, relative, 'add', valid)
}

export async function compactPreviewGeneratedBase(context: vscode.ExtensionContext, assets: ModelPreviewAssets, relative: string, valid: () => boolean = () => true): Promise<{ changed: boolean; message: string }> {
  return updatePreviewGeneratedBase(context, assets, relative, 'compact', valid)
}

export async function optimizePreviewAlphaModel(context: vscode.ExtensionContext, assets: ModelPreviewAssets, relative: string, valid: () => boolean = () => true, rebuildSides = false): Promise<{ changed: boolean; message: string }> {
  return updatePreviewGeneratedBase(context, assets, relative, 'optimize', valid, rebuildSides)
}

async function updatePreviewGeneratedBase(context: vscode.ExtensionContext, assets: ModelPreviewAssets, relative: string, mode: 'add' | 'compact' | 'optimize', valid: () => boolean, rebuildSides = false): Promise<{ changed: boolean; message: string }> {
  const key = previewPathKey(path.resolve(assets.roots[0]!, ...relative.split('/')))
  if (generatedUpdates.has(key)) throw new Error(uiText("ui.modelPreviewDocuments.theCurrentModelIsBeingProcessedPlease"))
  generatedUpdates.add(key)
  try { return await applyPreviewGeneratedBase(context, assets, relative, mode, valid, rebuildSides) }
  finally { generatedUpdates.delete(key) }
}

async function applyPreviewGeneratedBase(context: vscode.ExtensionContext, assets: ModelPreviewAssets, relative: string, mode: 'add' | 'compact' | 'optimize', valid: () => boolean, rebuildSides = false): Promise<{ changed: boolean; message: string }> {
  if (!vscode.workspace.isTrusted) throw new Error(uiText("ui.modelPreviewDocuments.pleaseTrustTheWorkspaceAndThenChange"))
  if (!validPreviewModelPath(relative)) throw new Error(uiText("core.generatedItemModel.modelPathInvalid"))
  const target = path.resolve(assets.roots[0]!, ...relative.split('/'))
  assertEditableRoot(await modelRootAccess(context, assets, target))
  await assertClientAssetsPath(target)
  if (!await assets.read(relative, 0)) throw new Error(uiText("ui.modelPreviewDocuments.couldOnlyModifyTheExistingModelOf"))
  const uri = vscode.Uri.file(target), document = await vscode.workspace.openTextDocument(uri)
  const text = document.getText(), version = document.version
  if (Buffer.byteLength(text) > JAVA_MODEL_LIMITS.maxBytes) throw new Error(uiText("core.javaModelResources.modelJsonExceedsSizeLimit"))
  const raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  validateJavaModel(raw)
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? '  ', eol = text.includes('\r\n') ? '\r\n' : '\n'
  const formattingOptions = { insertSpaces: !indent.includes('\t'), tabSize: indent.includes('\t') ? 2 : indent.length, eol }
  let optimization: string | undefined
  let updated = text, retained = false
  const observed = new Map<vscode.TextDocument, { version: number; text: string }>()
  let validateInputs: (() => Promise<void>) | undefined, verifyInputs: (() => void) | undefined
  const change = (location: (string | number)[], value: unknown): void => { updated = applyEdits(updated, modify(updated, location, value, { formattingOptions })) }
  if (mode === 'optimize') {
    if (!Array.isArray(raw.elements)) throw new Error(uiText("ui.modelPreviewDocuments.useAsAListOrSaveThe"))
    const resolved = await assets.resolveModel(relative)
    const digest = (bytes: Uint8Array | undefined): string | undefined => bytes && createHash('sha256').update(bytes).digest('hex')
    const signature = (file: string): string | undefined => {
      try { const stat = lstatSync(file, { bigint: true }); return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') }
      catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return; throw error }
    }
    const modelInputs = [...new Set([relative, ...(resolved?.parents ?? [])])].flatMap(file => assets.roots.map(root => {
      const source = path.join(root, ...file.split('/')), doc = vscode.workspace.textDocuments.find(value => value.uri.scheme === 'file' && previewPathKey(value.uri.fsPath) === previewPathKey(source))
      return { source, signature: signature(source), doc, version: doc?.version, text: doc?.getText() }
    }))
    const resources = new Map<string, { file: string; layer: number; hash?: string; source: string; signature?: string }>(), memorySources = new Map<string, number | undefined>()
    const read = async (file: string, pixels = false): Promise<Uint8Array | undefined> => {
      for (let layer = 0; layer < assets.roots.length; layer++) {
        if (pixels) {
          const source = path.join(assets.roots[layer]!, ...file.split('/')), memory = texturePreviewState.read(source)
          memorySources.set(source, memory?.revision)
          if (memory) { const png = new PNG({ width: memory.width, height: memory.height }); png.data.set(memory.pixels); return PNG.sync.write(png) }
        }
        const source = path.join(assets.roots[layer]!, ...file.split('/')), before = signature(source), bytes = await assets.read(file, layer)
        if (signature(source) !== before) throw new Error(uiText("ui.modelPreviewDocuments.changeTheStickerWhileReadingNoModel"))
        resources.set(layer + ':' + file, { file, layer, hash: digest(bytes), source, signature: before })
        if (bytes) return bytes
      }
      return undefined
    }
    const result = await optimizeAlphaModel({ ...raw, textures: { ...resolved?.model.textures as Record<string, unknown>, ...raw.textures as Record<string, unknown> } }, file => read(file, true), async file => {
      const bytes = await read(file)
      return bytes ? JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, '')) : undefined
    }, { rebuildSides })
    validateInputs = async () => {
      const current = await assets.resolveModel(relative)
      if (!isDeepStrictEqual(current?.model.textures, resolved?.model.textures) || !isDeepStrictEqual(current?.parents, resolved?.parents)) throw new Error(uiText("ui.modelPreviewDocuments.changesInTextureReferencesToModelsDuring"))
      for (const resource of resources.values()) if (digest(await assets.read(resource.file, resource.layer)) !== resource.hash) throw new Error(uiText("ui.modelPreviewDocuments.pasteOrAnimationMetadataChangesDuringOptimization"))
    }
    verifyInputs = () => {
      for (const input of modelInputs) {
        const doc = vscode.workspace.textDocuments.find(value => value.uri.scheme === 'file' && previewPathKey(value.uri.fsPath) === previewPathKey(input.source))
        if (signature(input.source) !== input.signature || doc !== input.doc || doc?.version !== input.version || doc?.getText() !== input.text) throw new Error(uiText("ui.modelPreviewDocuments.changeInParentModelOrTextureReference"))
      }
      for (const resource of resources.values()) if (signature(resource.source) !== resource.signature) throw new Error(uiText("ui.modelPreviewDocuments.pasteOrAnimationMetadataChangesDuringOptimization"))
      for (const [source, revision] of memorySources) if (texturePreviewState.read(source)?.revision !== revision) throw new Error(uiText("ui.modelPreviewDocuments.changeInTheStickerDuringOptimizationNo"))
    }
    if (!result.changedElements) return { changed: false, message: uiText("ui.modelPreviewDocuments.noTransparentContoursToBeRebuilt", (result.skipped.length ? '；' + result.skipped.join('；') : '')) }
    change(['elements'], result.model.elements)
    updated = compactGeneratedModelText(updated)
    optimization = uiText("ui.modelPreviewDocuments.optimizedByTransparentContourAThinPiece", result.changedElements, result.before, result.after, (result.skipped.length ? '；' + result.skipped.join('；') : ''))
  } else if (mode === 'compact') {
    const marker = raw[GENERATED_BASE_FIELD]
    if (object(marker) && marker.version === 1 && marker.storage === 'reference') {
      if (typeof marker.model !== 'string' || raw.parent !== marker.model || raw.elements !== undefined) throw new Error(uiText("ui.modelPreviewDocuments.generatedReferencesHaveBeenModifiedCheckParent"))
      const helperPath = javaModelResourcePath(marker.model, 'models'), helperTarget = path.resolve(assets.roots[0]!, ...helperPath.split('/'))
      if (previewPathKey(helperTarget) === previewPathKey(target)) throw new Error(uiText("ui.modelPreviewDocuments.generatedReferencesCannotPointToTheCurrent"))
      assertEditableRoot(await modelRootAccess(context, assets, helperTarget))
      await assertClientAssetsPath(helperTarget)
      if (!await assets.read(helperPath, 0)) throw new Error(uiText("ui.modelPreviewDocuments.theCurrentPackageIsMissingTheOriginal"))
      const helperUri = vscode.Uri.file(helperTarget), helperDocument = await vscode.workspace.openTextDocument(helperUri)
      const helperText = helperDocument.getText(), helper = JSON.parse(helperText.replace(/^\uFEFF/, ''))
      validateJavaModel(helper)
      const count = generatedBaseElementCount(helper), geometryMarker = helper[GENERATED_BASE_FIELD]
      if (!count || !object(geometryMarker) || geometryMarker.storage !== 'geometry' || marker.elements !== count || !isDeepStrictEqual(marker.layers, geometryMarker.layers)) throw new Error(uiText("ui.modelPreviewDocuments.invalidOrInconsistentReferenceTagModelUnmodified"))
      const resolved = await assets.resolveModel(relative)
      if (!resolved || resolved.missingPaths.some(file => file.endsWith('.json'))) throw new Error(uiText("ui.modelPreviewDocuments.modelParentChainIncompletePleaseFillIn"))
      observed.set(helperDocument, { version: helperDocument.version, text: helperText })
      for (const [key, value] of Object.entries(helper)) if (![GENERATED_BASE_FIELD, 'parent', 'textures', 'elements'].includes(key) && !Object.prototype.hasOwnProperty.call(raw, key)) change([key], value)
      change(['parent'], helper.parent)
      change(['textures'], { ...(object(helper.textures) ? helper.textures : {}), ...(object(raw.textures) ? raw.textures : {}) })
      if (object(helper.display) || object(raw.display)) change(['display'], { ...(object(helper.display) ? helper.display : {}), ...(object(raw.display) ? raw.display : {}) })
      change(['elements'], helper.elements)
      const { storage: _storage, operation: _operation, ...inlineMarker } = geometryMarker
      change([GENERATED_BASE_FIELD], inlineMarker)
      retained = true
    } else if (!generatedBaseElementCount(raw)) return { changed: false, message: uiText("ui.modelPreviewDocuments.currentModelDoesNotHaveOrganizedGeometry") }
    updated = compactGeneratedModelText(updated)
    if (updated === text) return { changed: false, message: uiText("ui.modelPreviewDocuments.generatedHasBeenPressedIntoASingle") }
  } else {
    const addition = await planGeneratedItemAddition(assets, relative, raw, async file => {
      for (let layer = 0; layer < assets.roots.length; layer++) {
        const memory = texturePreviewState.read(path.join(assets.roots[layer]!, ...file.split('/')))
        if (memory) { const png = new PNG({ width: memory.width, height: memory.height }); png.data.set(memory.pixels); return PNG.sync.write(png) }
        const bytes = await assets.read(file, layer)
        if (bytes) return bytes
      }
      return undefined
    })
    if (!addition.elements.length) return { changed: false, message: addition.reason ?? uiText("ui.modelPreviewDocuments.noDuplicatesRequired") }
    for (const [slot, texture] of Object.entries(addition.textures)) change(['textures', slot], texture)
    if (raw.elements === undefined) change(['elements'], addition.inheritedElements ?? [])
    change([GENERATED_BASE_FIELD], addition.marker)
    updated = appendGeneratedElements(updated, addition.elements, eol, indent)
  }
  validateJavaModel(JSON.parse(updated.replace(/^\uFEFF/, '')))
  if (Buffer.byteLength(updated) > JAVA_MODEL_LIMITS.maxBytes) throw new Error(uiText("ui.modelPreviewDocuments.theGeneratedModelJsonExceededTheSize"))
  await assertClientAssetsPath(target)
  assertEditableRoot(await modelRootAccess(context, assets, target))
  await validateInputs?.()
  verifyInputs?.()
  if (!vscode.workspace.isTrusted) throw new Error(uiText("ui.modelPreviewDocuments.pleaseTrustTheWorkspaceAndThenChange"))
  if (!valid() || document.isClosed || document.version !== version || document.getText() !== text || [...observed].some(([doc, before]) => doc.isClosed || doc.version !== before.version || doc.getText() !== before.text)) throw new Error(uiText("ui.modelPreviewDocuments.modelOrPreviewChangedDuringGenerationNot"))
  const edit = new vscode.WorkspaceEdit()
  edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(text.length)), updated)
  if (!await vscode.workspace.applyEdit(edit)) throw new Error(uiText("ui.modelPreviewDocuments.editorDoesNotAcceptModelChangesPlease"))
  try { await foldGeneratedModel(await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false })) } catch {}
  return { changed: true, message: optimization ?? (mode === 'compact' ? uiText("ui.modelPreviewDocuments.organisedAsASingleModelJsonGeometriced", (retained ? uiText("ui.modelPreviewDocuments.theOriginalReferenceFileWasRetainedTo") : '')) : uiText("ui.modelPreviewDocuments.addedToTheCurrentJsonOriginalGeometrical")) }
}
