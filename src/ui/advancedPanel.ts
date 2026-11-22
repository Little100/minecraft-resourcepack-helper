import { uiText } from '../i18n/messages'
import { onWebviewMessage } from './webviewDiagnostics'
import { ModTexturesHost } from './modTexturesHost'
import * as vscode from 'vscode'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { generateTintPreset } from '../core/advanced/tintPresets'
import { PNG } from 'pngjs'
import { processExportTextures, type ExportTextureProcessingOptions } from '../core/advanced/exportTextureProcessing'
import { getHtml } from './htmlShell'
import { SceneStudioHost } from './sceneStudioHost'
import { PackToolsHost } from './packToolsHost'
import { listVersionCapabilities, getVersionCapabilities, createPackMcmeta } from '../core/advanced/versionCapabilities'
import { scanSampleCatalog, planSampleImport, type SampleCatalog } from '../core/advanced/sampleCatalog'
import { generateTotemFiles, fetchMojangSkin, type TotemModel, type TotemPose } from '../core/advanced/totem'
import { optimizePortablePack } from '../core/advanced/portableOptimizer'
import { validatePackSquashRequest, runPackSquash, type PackSquashOptions } from '../core/advanced/optimizer'
import { compileShaderGraph, type ShaderGraphBlock } from '../core/advanced/shaderGraph'
import { runtimeConfig } from '../core/config'
import { WorkbenchMessage, textValue, numberValue, type WorkbenchRequest } from '../core/advanced/workbenchProtocol'
import { prepareExport, commitExport, safeRelativePath, type GeneratedFile } from '../core/advanced/safeExport'
import { decodeColormapPng, getColormapCoordinate, sampleColormap, tintColorToHex, generateColormapFiles, exportBiomeTintDatapack, exportUntintedModel, removeModelTintIndices, type BiomeTintOverrides } from '../core/advanced/colormap'
import { generateCtmTextures, generateNaturalTextures, generateRandomEntityTextures, expandTextureTiles, type CtmMethod, type NaturalTransform } from '../core/advanced/textures'
import { resolveModelInheritance } from '../core/advanced/modelInheritance'
import { generatePbrgenFiles } from '../core/advanced/pbrgenCompat'
import { scanPbrTextures } from '../core/advanced/pbrBatch'
import { generateOldPbrFiles, generatePbrFiles } from '../core/advanced/pbr'

const INPUT_LIMIT = 32 * 1024 * 1024
const ROLES = ['colormap', 'model', 'biome', 'pbr', 'skin', 'optimizer', 'samples', 'tiles', 'randomBase', 'pbrFolder'] as const
type Role = typeof ROLES[number]

export class AdvancedPanel {
  static readonly viewType = 'mcrh.advancedWorkbench'
  private static current: AdvancedPanel | undefined
  private readonly sources = new Map<Role, string[]>()
  private readonly disposables: vscode.Disposable[] = []
  private readonly modTextures: ModTexturesHost
  private readonly packTools: PackToolsHost
  private readonly studio: SceneStudioHost
  private controller: AbortController | undefined
  private catalog: SampleCatalog | undefined
  private busy = false
  private disposed = false
  private ready = false
  private pendingPage?: { action: 'conversion'; projectToken?: string }

  static show(context: vscode.ExtensionContext): AdvancedPanel {
    if (this.current) { this.current.panel.reveal(); return this.current }
    const panel = vscode.window.createWebviewPanel(this.viewType, uiText("ui.advancedPanel.mcrhAdvancedMaterialsWorkbench"), vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')] })
    this.current = new AdvancedPanel(panel, context)
    return this.current
  }

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly context: vscode.ExtensionContext) {
    this.packTools = new PackToolsHost(panel.webview, () => !this.busy && !this.modTextures?.busy)
    this.modTextures = new ModTexturesHost(panel.webview, () => !this.busy && !this.packTools.isBusy)
    this.disposables.push(this.modTextures)
    this.disposables.push(this.packTools)
    this.studio = new SceneStudioHost(panel.webview, context)
    this.disposables.push(this.studio)
    panel.webview.html = getHtml(panel.webview, context.extensionUri, 'advanced', panel)
    onWebviewMessage(panel.webview, message => { void this.handle(message).catch(error => this.report(error)) }, undefined, this.disposables)
    panel.onDidDispose(() => { this.disposed = true; this.controller?.abort(); AdvancedPanel.current = undefined; for (const item of this.disposables) item.dispose() }, undefined, this.disposables)
  }

  openPackTools(action: 'conversion', root?: string): void {
    this.pendingPage = { action, ...(root ? { projectToken: this.packTools.authorizeProject(root) } : {}) }
    this.navigatePackTools()
  }
  private navigatePackTools(): void {
    if (!this.ready || !this.pendingPage) return
    this.post({ type: 'workbenchNavigate', page: 'packs', ...this.pendingPage })
    this.pendingPage = undefined
  }
  private post(message: object): void { if (!this.disposed) void this.panel.webview.postMessage(message) }
  private report(error: unknown): void { const text = error instanceof Error ? error.message : String(error); this.post({ type: 'result', text: uiText("ui.advancedPanel.exportNotCompleted", text) }); this.post({ type: 'status', busy: this.busy, text: uiText("ui.advancedPanel.operationNotCompleted", text) }) }
  private async handle(raw: unknown): Promise<void> {
    if (await this.modTextures.handle(raw)) return
    if (await this.packTools.handle(raw)) return
    if (this.modTextures.busy) throw new Error(uiText("ui.advancedPanel.moduleImportIsNotFinishedPleaseTry"))
    if (await this.studio.handle(raw)) return
    const parsed = WorkbenchMessage.safeParse(raw)
    if (!parsed.success) throw new Error(uiText("ui.advancedPanel.invalidWorkbenchRequest"))
    const request = parsed.data
    if (request.command === 'copyShaderCode') {
      try {
        await vscode.env.clipboard.writeText(request.text)
        this.post({ type: 'shaderCodeCopied', requestId: request.requestId, ok: true })
      } catch (error) {
        this.post({ type: 'shaderCodeCopied', requestId: request.requestId, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    if (request.command === 'cancel') { this.controller?.abort(); return }
    if (request.command === 'ready') { await this.initialize(); this.ready = true; this.navigatePackTools(); return }
    if (request.command === 'sampleColor') {
      if (!this.sources.has('colormap')) return
      const image = decodeColormapPng(await this.readInput('colormap'))
      const climate = { temperature: request.temperature, downfall: request.downfall }
      this.post({ type: 'sampleColor', ...getColormapCoordinate(climate), color: tintColorToHex(sampleColormap(image, climate)) }); return
    }
    if (this.packTools.isBusy) throw new Error(uiText("ui.advancedPanel.theResourcePackFileOperationIsOngoing"))
    if (this.busy) return
    this.busy = true
    this.controller = new AbortController()
    this.post({ type: 'status', busy: true, text: uiText("ui.advancedPanel.processingPleaseCheckFileSelectionAndExport") })
    try {
      if (request.command === 'exportPackZip') {
        const includeVanillaTextures = request.params.includeVanillaTextures
        if (typeof includeVanillaTextures !== 'boolean') throw new Error(uiText("core.advanced.exportPolicy.theOriginalPosterExportOptionMustBe"))
        await vscode.commands.executeCommand('mcrh.exportPackZip', undefined, { includeVanillaTextures, includeMcrhEditorData: request.params.includeMcrhEditorData, watermark: request.params.watermark })
      }
      if (request.command === 'editSkin') {
        const file = this.sources.get('skin')?.[0]
        if (!file) throw new Error(uiText("ui.advancedPanel.pleaseSelectTheSkinPngAndThen"))
        await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), 'mcrh.pixelEditor')
      }
      if (request.command === 'pick') await this.pick(request.role)
      if (request.command === 'shaderPreview') await this.shaderPreview(request.params, request.requestId)
      if (request.command === 'generate') await this.generate(request)
    } finally {
      this.busy = false; this.controller = undefined
      this.post({ type: 'status', busy: false, text: uiText("ui.advancedPanel.readySuccessfulResultsAreRecordedCancellationDoes") })
    }
  }

  private async initialize(): Promise<void> {
    await this.sendVersions()
    const folders = vscode.workspace.workspaceFolders ?? []
    for (const root of [this.context.extensionPath, ...folders.map(folder => folder.uri.fsPath)]) {
      const sampleRoot = path.join(root, uiText("ui.advancedPanel.exampleOfMaterialPackages"))
      try { if ((await fs.stat(sampleRoot)).isDirectory()) { this.sources.set('samples', [sampleRoot]); break } } catch {}
    }
    await this.sendSamples()
  }

  private async pick(role: Role): Promise<void> {
    const folder = role === 'samples' || role === 'pbrFolder'
    const json = role === 'model' || role === 'biome'
    const binary = role === 'optimizer'
    const selected = await vscode.window.showOpenDialog({ canSelectFolders: folder, canSelectFiles: !folder, canSelectMany: role === 'tiles' || role === 'randomBase', title: role === 'pbrFolder' ? uiText("ui.advancedPanel.selectTheMaterialPackageRootThatContains") : folder ? uiText("ui.advancedPanel.selectADirectoryContainingIllustrativeResourcePacks") : binary ? uiText("ui.advancedPanel.selectATrustedPacksquashApplication") : json ? uiText("ui.advancedPanel.selectJsonFile") : uiText("ui.advancedPanel.selectPngPaste"), filters: folder || binary ? undefined : json ? { JSON: ['json'] } : { PNG: ['png'] } })
    if (!selected?.length) return
    if (selected.some(uri => uri.scheme !== 'file')) throw new Error(uiText("ui.advancedPanel.thisFeatureOnlySupportsLocalFiles"))
    if (selected.length > 256) throw new Error(uiText("ui.advancedPanel.theSelectedFileExceededTheSecurityLimit"))
    const candidates = selected.map(uri => uri.fsPath)
    let bytesTotal = 0
    if (!folder && !binary) for (const candidate of candidates) {
      const bytes = await this.readFile(candidate)
      bytesTotal += bytes.byteLength
      if (bytesTotal > 128 * 1024 * 1024) throw new Error(uiText("browser.workbenchBridge.theTotalNumberOfSelectedFilesExceeds"))
      if (json) { const value: unknown = JSON.parse(bytes.toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(uiText("ui.advancedPanel.modelsAndClustersJsonMustBeAn")) }
      else validatePreviewPng(bytes)
    }
    const candidateCatalog = role === 'samples' ? await scanSampleCatalog(candidates[0]) : undefined
    let image: string | undefined
    if (['colormap', 'pbr', 'skin'].includes(role)) {
      const bytes = await this.readFile(candidates[0])
      validatePreviewPng(bytes)
      if (role === 'colormap') decodeColormapPng(bytes)
      image = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
    }
    if (this.controller?.signal.aborted) return
    this.sources.set(role, candidates)
    if (candidateCatalog) this.catalog = candidateCatalog
    this.post({ type: 'source', role, name: selected.map(uri => path.basename(uri.fsPath)).join(', '), image })
    if (role === 'samples') await this.sendSamples(false)
  }

  private async readFile(file: string): Promise<Buffer> {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > INPUT_LIMIT) throw new Error(uiText("ui.advancedPanel.inputFileIsNotANormalFile"))
    const buffer = await fs.readFile(file)
    if (buffer.byteLength > INPUT_LIMIT) throw new Error(uiText("ui.advancedPanel.enterFileAboveSecurityLimit"))
    return buffer
  }
  private async readInput(role: Role): Promise<Buffer> {
    const file = this.sources.get(role)?.[0]
    if (!file) throw new Error(uiText("ui.advancedPanel.pleaseChooseFirstEnterFile", role))
    return this.readFile(file)
  }
  private async chooseOutput(datapack = false): Promise<string | undefined> {
    const result = await vscode.window.showOpenDialog({ title: datapack ? uiText("ui.advancedPanel.selectASeparatePackageRootDirectoryDo") : uiText("ui.advancedPanel.selectResourcePackRootDirectoryNotAssets"), canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri })
    if (!result?.[0]) return undefined
    if (result[0].scheme !== 'file') throw new Error(uiText("ui.advancedPanel.exportOnlyLocalDirectoriesSupported"))
    const output = result[0].fsPath
    if (datapack) {
      try { if ((await fs.stat(path.join(output, 'assets'))).isDirectory()) throw new Error(uiText("ui.advancedPanel.theGroupSystemJsonMustExportTo")) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    return output
  }

  private metadata(target: string, datapack: boolean): GeneratedFile {
    return { path: 'pack.mcmeta', content: JSON.stringify(createPackMcmeta(target, datapack ? 'data' : 'resource', `MCRH ${target} ${datapack ? uiText("ui.advancedPanel.groupSystemPackages") : uiText("ui.advancedPanel.resourcePack")}`), null, 2) + '\n' }
  }

  private async exportFiles(files: GeneratedFile[], output: string, target: string, warnings: string[] = [], datapack = false, metadata = true, options: ExportTextureProcessingOptions = {}): Promise<void> {
    if (this.controller?.signal.aborted) throw new Error(uiText("browser.packToolsBridge.operationCanceled"))
    if (metadata && !files.some(file => file.path === 'pack.mcmeta')) {
      try { await fs.stat(path.join(output, 'pack.mcmeta')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; files = [...files, this.metadata(target, datapack)] }
    }
    const processed = await processExportTextures(files, vscode.workspace.getConfiguration('mcrh').get<string>('previewBaseAssetsPath', ''), options)
    files = processed.files
    warnings = [...warnings, ...processed.warnings]
    const plan = await prepareExport(output, files)
    const listing = files.map(file => `${file.path} (${typeof file.content === 'string' ? Buffer.byteLength(file.content) : file.content.byteLength} bytes)`).join('\n')
    this.post({ type: 'result', text: uiText("ui.advancedPanel.objectivesPendingConfirmationNotYetWritten", warnings.length ? warnings.join('\n') + '\n\n' : '', output, listing) })
    const choice = await vscode.window.showWarningMessage(uiText("ui.advancedPanel.exportFile", files.length, plan.conflicts.length ? uiText("ui.advancedPanel.overrideExistingFilesAutobackUpOfOriginal", plan.conflicts.length) : ''), { modal: true, detail: `${warnings.join('\n')}\n${listing.slice(0, 7000)}` }, plan.conflicts.length ? uiText("ui.advancedPanel.backupAndOverwrite") : uiText("ui.advancedPanel.confirmExport"))
    if (!choice || this.controller?.signal.aborted) return
    const result = await commitExport(plan, plan.conflicts.length > 0, this.controller?.signal)
    this.post({ type: 'result', text: uiText("ui.advancedPanel.exportedDocuments", result.written.length, listing, result.backup ? uiText("ui.advancedPanel.originalBackup", result.backup) : '', warnings.length ? '\n\n' + warnings.join('\n') : '') })
  }

  private async generate(request: Extract<WorkbenchRequest, { command: 'generate' }>): Promise<void> {
    const p = request.params
    const target = textValue(p, 'targetVersion', '1.20.4')
    if (!getVersionCapabilities(target)) throw new Error(uiText("ui.advancedPanel.targetVersionDoesNotHaveValidatedCapability"))
    const ns = 'minecraft'
    if (request.kind === 'optimize') { await this.optimize(p); return }
    if (request.kind === 'sample') { await this.importSample(textValue(p, 'id'), target, { includeVanillaTextures: p.includeVanillaTextures as boolean | undefined, includeMcrhEditorData: p.includeMcrhEditorData as boolean | undefined, watermark: p.watermark }); return }
    const datapack = request.kind === 'biome'
    const output = await this.chooseOutput(datapack)
    if (!output || this.controller?.signal.aborted) return
    let files: GeneratedFile[] = []
    const warnings: string[] = []
    switch (request.kind) {
      case 'tintPreset': { files = generateTintPreset(p); break }
      case 'colormap': {
        const map = textValue(p, 'map')
        if (map === 'dry_foliage' && !getVersionCapabilities(target)?.features.itemDefinitions) throw new Error(uiText("ui.advancedPanel.theSelectedOldVersionDoesNotSupport"))
        if (map !== 'grass' && map !== 'foliage' && map !== 'dry_foliage') throw new Error(uiText("ui.advancedPanel.invalidColourChartType"))
        files = generateColormapFiles(map, { cold: textValue(p, 'cold'), dry: textValue(p, 'dry'), wet: textValue(p, 'wet') })
        break
      }
      case 'biome': {
        await this.assertBiomeVersion(target, textValue(p, 'dryFoliage', '') !== '')
        const overrides: BiomeTintOverrides = {}
        for (const [key, field] of [['foliage', 'foliage_color'], ['grass', 'grass_color'], ['dryFoliage', 'dry_foliage_color']] as const) {
          const value = textValue(p, key, '').trim()
          if (value) overrides[field] = value
        }
        const modifier = textValue(p, 'modifier', 'keep')
        if (!['keep', 'none', 'dark_forest', 'swamp'].includes(modifier)) throw new Error(uiText("ui.advancedPanel.theLawnModifierIsInvalid"))
        if (modifier !== 'keep') overrides.grass_color_modifier = modifier as 'none' | 'dark_forest' | 'swamp'
        files = exportBiomeTintDatapack(textValue(p, 'biomeId'), (await this.readInput('biome')).toString('utf8'), overrides)
        warnings.push(uiText("ui.advancedPanel.groupSystemRegistrationIsADataPackage"), modifier === 'keep' ? uiText("ui.advancedPanel.noChangeGrassColorModifierBlackForest") : uiText("ui.advancedPanel.weedColouredAcceleratorSetFinalSwampColours", modifier))
        break
      }
      case 'untint': {
        const relative = safeRelativePath(textValue(p, 'modelPath'))
        const match = /^assets\/([a-z0-9_.-]+)\/models\/(.+)\.json$/.exec(relative)
        if (!match) throw new Error(uiText("ui.advancedPanel.theModelPathShouldBeAssetsNamespace"))
        let model = (await this.readInput('model')).toString('utf8')
        const parsed = JSON.parse(model) as Record<string, unknown>
        if (parsed.parent) {
          const source = this.sources.get('model')![0].replace(/\\/g, '/')
          const origin = /^(.*)\/assets\/[^/]+\/models\//.exec(source)?.[1]
          const resolved = await resolveModelInheritance(model, async id => {
            if (this.controller?.signal.aborted) throw new Error(uiText("browser.packToolsBridge.operationCanceled"))
            const [namespace, name] = id.split(':')
            if (origin) {
              const candidate = path.join(origin, safeRelativePath(`assets/${namespace}/models/${name}.json`))
              try {
                const base = await fs.realpath(origin), actual = await fs.realpath(candidate)
                const relative = path.relative(base, actual)
                if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error(uiText("ui.advancedPanel.fatherModelCannotJumpOutOfThe"))
                return (await this.readFile(candidate)).toString('utf8')
              } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
            }
            const selected = await vscode.window.showOpenDialog({ title: uiText("ui.advancedPanel.missingParentModelSelectTheCorrespondingJson", id), canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { JSON: ['json'] } })
            if (!selected?.[0] || selected[0].scheme !== 'file') throw new Error(uiText("ui.advancedPanel.noCompleteParentModelCancelToTint"))
            return (await this.readFile(selected[0].fsPath)).toString('utf8')
          })
          model = JSON.stringify(resolved.model)
          warnings.push(uiText("ui.advancedPanel.theParentModelHasBeenExpandedTo", resolved.parents.join(' → ')))
        }
        const result = removeModelTintIndices(model)
        if (!result.removed) throw new Error(uiText("ui.advancedPanel.modelsDoNotHaveRemoveableDirectTindex"))
        files = exportUntintedModel(`${match[1]}:${match[2]}`, model)
        warnings.push(uiText("ui.advancedPanel.removeATintindexPosterItselfNeedsTo", result.removed))
        break
      }
      case 'ctm': {
        const selected = this.sources.get('tiles') ?? []
        const images = await Promise.all(selected.map(async (file, index) => { const content = await this.readFile(file); validatePreviewPng(content); return { name: `${index}.png`, content } }))
        const method = textValue(p, 'method') as CtmMethod
        const weights = textValue(p, 'weights', '').trim() || undefined
        const tiles = textValue(p, 'tiles', '').trim() || (images.length ? `0-${images.length - 1}` : '')
        if (!tiles) throw new Error(uiText("ui.advancedPanel.pleaseSupplyTilesOrChoosePngTexture"))
        if (!images.length) warnings.push(uiText("ui.advancedPanel.generateAttributeRulesOnlyTilesCorrespondTo"))
        if (images.length && expandTextureTiles(tiles).some(tile => !images.some(image => image.name === `${tile}.png`))) throw new Error(uiText("ui.advancedPanel.tilesDoNotMatchTheSelectedPng"))
        files = generateCtmTextures({ namespace: ns, name: textValue(p, 'name'), matchBlocks: textValue(p, 'matchBlocks'), method, tiles, images, weights: method === 'random' ? weights : undefined, symmetry: method === 'random' ? textValue(p, 'symmetry', 'none') as 'none' | 'opposite' | 'all' : undefined })
        warnings.push(uiText("ui.advancedPanel.optifineCtmIsRequiredOrCompatibleModule"))
        break
      }
      case 'natural': {
        files = generateNaturalTextures({ namespace: ns, texture: textValue(p, 'texture'), transform: textValue(p, 'transform') as NaturalTransform })
        const file = files[0]
        try {
          const previous = (await this.readFile(path.join(output, file.path))).toString('utf8')
          const key = String(file.content).split('\n').find(line => line.includes('='))?.split('=')[0]
          const remaining = previous.split(/\r?\n/).filter(line => line.split('=')[0].trim() !== key).join('\n').replace(/\n+$/, '')
          file.content = `${remaining}\n${file.content}`
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        warnings.push(uiText("ui.advancedPanel.naturalTextureRequiresOptifineNaturalTexturesOr"))
        break
      }
      case 'randomEntity': {
        const skins = textValue(p, 'skins').trim().split(/\s+/).map(Number)
        const selected = this.sources.get('randomBase') ?? []
        if (selected.length && selected.length !== skins.length) throw new Error(uiText("ui.advancedPanel.theNumberOfPngsSelectedMustMatch"))
        const variants = await Promise.all(selected.map(async (file, index) => { const content = await this.readFile(file); validatePreviewPng(content); return { index: skins[index], content } }))
        const name = textValue(p, 'entity').replace(/^entity\//, '')
        files = generateRandomEntityTextures({ namespace: ns, texture: `entity/${name}`, skins, variants, weights: textValue(p, 'weights', '').trim() || undefined, biomes: textValue(p, 'biomes', '').trim() || undefined })
        warnings.push(uiText("ui.advancedPanel.needOptifineRandomEntitsOrCompatibilityNumber"))
        if (!variants.length) warnings.push(uiText("ui.advancedPanel.noVariantPngSelectedOnlyAttributeRules"))
        break
      }
      case 'pbr': {
        const profile = textValue(p, 'profile', 'labpbr')
        if (!['labpbr', 'oldpbr', 'pbrgen'].includes(profile)) throw new Error(uiText("ui.advancedPanel.unknownPbrAlgorithm"))
        const scope = textValue(p, 'scope', 'single')
        if (!['single', 'pack'].includes(scope)) throw new Error(uiText("ui.advancedPanel.unknownPbrProcessingRange"))
        const generate = (texturePath: string, albedoPng: Uint8Array) => profile === 'pbrgen'
          ? generatePbrgenFiles({ texturePath, albedoPng })
          : (profile === 'oldpbr' ? generateOldPbrFiles : generatePbrFiles)({ texturePath, albedoPng, normalStrength: numberValue(p, 'strength', 1), roughness: numberValue(p, 'roughness', 0.6), metalness: numberValue(p, 'metalness', 0), porosity: numberValue(p, 'porosity', 0), emission: numberValue(p, 'emission', 0) })
        if (scope === 'single') {
          const result = generate(textValue(p, 'texturePath'), await this.readInput('pbr'))
          files = result.files; warnings.push(...result.warnings)
        } else {
          const source = this.sources.get('pbrFolder')?.[0]
          if (!source) throw new Error(uiText("ui.advancedPanel.selectTheResourcePackDirectoryForVolume"))
          const realSource = await fs.realpath(source), realOutput = await fs.realpath(output)
          const relativeOutput = path.relative(realSource, realOutput)
          if (relativeOutput === '' || (!path.isAbsolute(relativeOutput) && relativeOutput !== '..' && !relativeOutput.startsWith(`..${path.sep}`))) throw new Error(uiText("ui.advancedPanel.batchPbrOutputMustBeLocatedOutside"))
          const scan = await scanPbrTextures(source, this.controller?.signal)
          let outputBytes = 0
          for (const [index, entry] of scan.entries.entries()) {
            if (this.controller?.signal.aborted) throw new Error(uiText("ui.advancedPanel.batchPbrCancelledNotExported"))
            const result = generate(entry.path, await this.readFile(entry.source))
            files.push(...result.files)
            warnings.push(...result.warnings)
            if (entry.animation) for (const file of result.files) files.push({ path: file.path + '.mcmeta', content: entry.animation })
            outputBytes += result.files.reduce((sum, file) => sum + (typeof file.content === 'string' ? Buffer.byteLength(file.content) : file.content.byteLength), 0) + (entry.animation ? Buffer.byteLength(entry.animation) * result.files.length : 0)
            if (outputBytes > 128 * 1024 * 1024) throw new Error(uiText("browser.workbenchBridge.pbrOutputExceedingMibBatchProcessing"))
            this.post({ type: 'status', busy: true, text: uiText("ui.advancedPanel.generatePbr", (index + 1), scan.entries.length, entry.path) })
            await new Promise<void>(resolve => setImmediate(resolve))
          }
          if (scan.skipped.length) warnings.push(uiText("ui.advancedPanel.skipExistingDerivativesOrInvalidNamingSpaces", scan.skipped.join(', ')))
          warnings.push(uiText("ui.advancedPanel.batchOutputOnlyContainsBasePasteDerivative"))
          const unique = [...new Set(warnings)]; warnings.length = 0; warnings.push(...unique)
        }
        break
      }
      case 'totem': files = await this.totemFiles(p, target, warnings); break
      case 'shader': files = await this.shaderFiles(p, warnings); break
    }
    await this.exportFiles(files, output, target, warnings, datapack, request.kind !== 'shader', { includeVanillaTextures: p.includeVanillaTextures as boolean | undefined, includeMcrhEditorData: p.includeMcrhEditorData as boolean | undefined, watermark: p.watermark })
  }

  private async sendVersions(): Promise<void> {
    this.post({ type: 'versions', entries: listVersionCapabilities().map(entry => ({ id: entry.id, status: entry.status === 'release' ? uiText("browser.workbenchBridge.release") : entry.status, summary: entry.summary + ' · ' + (entry.features.itemDefinitions ? uiText("ui.advancedPanel.aModernBeamsBinding") : uiText("ui.advancedPanel.modelsOfOldItems")) + (entry.features.atlases ? 'atlas sources；' : uiText("ui.advancedPanel.noModernAlasJson")) + (entry.features.postEffectActivation === 'posteffect-command' ? uiText("ui.advancedPanel.customizedPostProcessingCanBeActivatedBy") : '') + entry.limitations.join(' ') })) })
  }
  private async sendSamples(rescan = true): Promise<void> {
    const folder = this.sources.get('samples')?.[0]
    if (!folder) { this.post({ type: 'catalog', entries: [] }); return }
    if (rescan || !this.catalog) this.catalog = await scanSampleCatalog(folder)
    this.post({ type: 'source', role: 'samples', name: folder })
    this.post({ type: 'catalog', entries: this.catalog!.samples.map(entry => ({ id: entry.id, name: entry.label, description: entry.mechanisms.map(item => item.label + ': ' + item.notes).join(' · ') || entry.error || uiText("ui.advancedPanel.generalResourcesFiles"), requirements: entry.mechanisms.map(item => item.runtime).join(' / ') + ' · ' + entry.importableFileCount + uiText("ui.advancedPanel.anImportableResource") + entry.warnings.join(' '), canImport: !entry.error && entry.sourceType !== 'jar' && entry.importableFileCount > 0 })) })
  }
  private async assertBiomeVersion(target: string, dry: boolean): Promise<void> {
    const entry = getVersionCapabilities(target)
    if (!entry?.dataPackFormat || !entry.features.coreShaders) throw new Error(uiText("ui.advancedPanel.thisDeskOnlyExportGroupsOfCertified"))
    if (dry && !entry.features.itemDefinitions) throw new Error(uiText("ui.advancedPanel.theSelectedOldVersionDoesNotSupport_915b52"))
  }
  private async importSample(id: string, target: string, options: ExportTextureProcessingOptions = {}): Promise<void> {
    const sample = this.catalog?.samples.find(entry => entry.id === id)
    if (!sample || sample.error || sample.sourceType === 'jar') throw new Error(uiText("ui.advancedPanel.exampleNotScannedOrBelongToA"))
    let packRoot = sample.packRoots[0]
    if (sample.packRoots.length > 1) {
      const choice = await vscode.window.showQuickPick(sample.packRoots.map(value => ({ label: value || uiText("ui.advancedPanel.packRootDirectory"), value })), { placeHolder: uiText("ui.advancedPanel.thisExampleContainsSeveralResourcePacksSelect") })
      if (!choice) return
      packRoot = choice.value
    }
    {
      const ack = await vscode.window.showWarningMessage(uiText("ui.advancedPanel.exampleResourceIncludesThirdPartyLicensingPlease"), { modal: true, detail: (sample.license.evidence.length ? sample.license.evidence.join('\n') : uiText("ui.advancedPanel.readTheExampleOfReadmePermitWithout")) }, uiText("ui.advancedPanel.readAndComplyWithPermissions"))
      if (!ack) return
    }
    const plan = await planSampleImport(sample.sourcePath, { acknowledgeLicense: true, repairTotemModels: true, includePackMetadata: true, packRoot })
    const output = await this.chooseOutput()
    if (!output) return
    const warnings = [...plan.warnings, ...plan.repairs.map(item => uiText("ui.advancedPanel.places", item.path, item.description, item.replacements)), uiText("ui.advancedPanel.keepTheOriginalExamplePackMcmetaThe")]
    if (plan.skipped.length) warnings.push(uiText("ui.advancedPanel.secureFilterEntriesDoNotImportExecutables", plan.skipped.length))
    await this.exportFiles(plan.files, output, target, warnings, false, true, options)
  }
  private async optimize(params: Record<string, unknown>): Promise<void> {
    const engine = textValue(params, 'engine', 'portable')
    if (!['portable', 'packsquash'].includes(engine)) throw new Error(uiText("ui.advancedPanel.unknownOptimizationBackend"))
    const binaryPath = this.sources.get('optimizer')?.[0]
    if (engine === 'packsquash' && !vscode.workspace.isTrusted) throw new Error(uiText("ui.advancedPanel.theRestrictedWorkspaceCannotRunAnExternal"))
    if (engine === 'packsquash' && !binaryPath) throw new Error(uiText("ui.advancedPanel.pleaseSelectASelfInstalledAndTrusted"))
    const input = await vscode.window.showOpenDialog({ title: uiText("ui.advancedPanel.selectTheResourcePackRootDirectoryTo"), canSelectFiles: false, canSelectFolders: true, canSelectMany: false })
    if (!input?.[0]) return
    const output = await vscode.window.showSaveDialog({ title: uiText("ui.advancedPanel.saveOptimizedZipMustBeOutsideThe"), filters: { ZIP: ['zip'] } })
    if (!output) return
    if (input[0].scheme !== 'file' || output.scheme !== 'file') throw new Error(uiText("ui.advancedPanel.optimizationOnlySupportsLocalPaths"))
    const mode = textValue(params, 'mode', 'safe')
    if (mode !== 'safe' && mode !== 'balanced') throw new Error(uiText("ui.advancedPanel.unknownOptimisationMode"))
    if (engine === 'portable') {
      const ack = await vscode.window.showInformationMessage(uiText("ui.advancedPanel.useTheBuiltInZipOptimizationFilter"), { modal: true, detail: uiText("ui.advancedPanel.jsonStreamlinesOnlyIfThereIsA") }, uiText("ui.advancedPanel.startInternalOptimization"))
      if (!ack || this.controller?.signal.aborted) return
      const result = await optimizePortablePack({ inputDirectory: input[0].fsPath, outputFile: output.fsPath, minifyJson: true, vanillaBasePath: vscode.workspace.getConfiguration('mcrh').get<string>('previewBaseAssetsPath', ''), exportTextures: { includeVanillaTextures: params.includeVanillaTextures as boolean | undefined, includeMcrhEditorData: params.includeMcrhEditorData as boolean | undefined, watermark: params.watermark }, signal: this.controller?.signal, onLog: text => this.post({ type: 'log', text }) })
      this.post({ type: 'result', text: uiText("ui.advancedPanel.inlinedWithoutLossOfOptimizationCompletedOutput", result.outputFile, result.fileCount, result.inputBytes, result.outputBytes, result.minifiedFiles, result.temporaryDirectory, result.skipped.join(', ')) })
      return
    }
    const options: PackSquashOptions = { allowMods: ['OptiFine'], pngQuantization: mode === 'safe' ? 'none' : 'auto', minifyJson: mode !== 'safe', transcodeOgg: false, shaderSourceTransformation: 'keep_as_is', recompressCompressedFiles: mode !== 'safe', zipCompressionIterations: mode === 'safe' ? 5 : 15 }
    const request = { includeMcrhEditorData: params.includeMcrhEditorData as boolean | undefined, binaryPath: binaryPath!, inputDirectory: input[0].fsPath, outputFile: output.fsPath, options, signal: this.controller?.signal, onStdout: (text: string) => this.post({ type: 'log', text }), onStderr: (text: string) => this.post({ type: 'log', text }) }
    const validation = await validatePackSquashRequest(request)
    if (!validation.valid) throw new Error(validation.errors.join('\n'))
    this.post({ type: 'result', text: uiText("ui.advancedPanel.notYetOperationalAwaitingConfirmation", validation.config, validation.warnings.join('\n')) })
    const ack = await vscode.window.showWarningMessage(uiText("ui.advancedPanel.theSelectedExternalPacksquashResourcePackWill"), { modal: true, detail: uiText("ui.advancedPanel.procedureInputOutputTheExistingOutputZip", binaryPath, input[0].fsPath, output.fsPath, mode === 'balanced' ? uiText("ui.advancedPanel.standardModeAllowsPngToBeQuantified") : uiText("ui.advancedPanel.conservativeModeDoesNotQuantifyPng")) }, uiText("ui.advancedPanel.trustTheProgramAndStartOptimising"))
    if (!ack || this.controller?.signal.aborted) return
    const result = await runPackSquash(request)
    this.post({ type: 'result', text: uiText("ui.advancedPanel.optificationStatusOutputKeepTemporaryDirectory", result.status, result.outputFile, result.error ?? '', result.temporaryDirectory ?? uiText("ui.advancedPanel.uncreated"), result.stdout, result.stderr, result.logsTruncated ? uiText("ui.advancedPanel.logsExceededTheSecurityLimit") : '') })
    if (result.status === 'failed') throw new Error(result.error ?? uiText("ui.advancedPanel.packsquashRunningFailedPleaseCheckLog"))
  }
  private async totemFiles(params: Record<string, unknown>, target: string, warnings: string[]): Promise<GeneratedFile[]> {
    const model = textValue(params, 'model') as TotemModel
    const pose = textValue(params, 'pose') as TotemPose
    if (!['alex', 'steve'].includes(model) || !['standing', 'sitting'].includes(pose)) throw new Error(uiText("ui.advancedPanel.totemModelOrAttitudeInvalid"))
    let skinPng: Uint8Array
    const player = textValue(params, 'player', '').trim()
    if (player) {
      const fetched = await fetchMojangSkin(player, { signal: this.controller?.signal })
      skinPng = fetched.skinPng
      const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mcrh-skin-'))
      const downloaded = path.join(temporary, 'skin.png')
      await fs.writeFile(downloaded, skinPng, { flag: 'wx' })
      this.sources.set('skin', [downloaded])
      if (fetched.model !== model) warnings.push(uiText("ui.advancedPanel.mojangSkinCurrentManualSelectionCheckYour", fetched.model, model))
      this.post({ type: 'source', role: 'skin', name: fetched.playerName, image: 'data:image/png;base64,' + Buffer.from(skinPng).toString('base64') })
    } else skinPng = await this.readInput('skin')
    const data = path.join(this.context.extensionPath, 'out', 'data', 'totem')
    const templateModel = JSON.parse((await this.readFile(path.join(data, model + '.json'))).toString('utf8'))
    const result = generateTotemFiles({ skinPng, model, pose, templateModel, namespace: runtimeConfig().defaultNamespace })
    warnings.push(...result.warnings)
    const files: GeneratedFile[] = result.files
    if (getVersionCapabilities(target)?.features.itemDefinitions) {
      const modelId = result.modelPath.replace(/^assets\/([^/]+)\/models\/(.+)\.json$/, '$1:$2')
      files.push({ path: 'assets/minecraft/items/totem_of_undying.json', content: JSON.stringify({ model: { type: 'minecraft:model', model: modelId } }, null, 2) + '\n' })
    }
    if (target === '1.12.2') {
      for (const file of files) if (file.path.endsWith('.json')) { file.content = String(file.content).replaceAll('minecraft:item/totem_of_undying', 'minecraft:items/totem'); if (file.path === 'assets/minecraft/models/item/totem_of_undying.json') file.path = 'assets/minecraft/models/item/totem.json' }
      warnings.push(uiText("ui.advancedPanel.useOldTotemJsonAndTexturesItems"))
    }
    files.push({ path: 'MCRH-TOTEM-LICENSE.md', content: (await this.readFile(path.join(data, 'LICENSE.md'))).toString('utf8') })
    return files
  }
  private async shaderFiles(params: Record<string, unknown>, warnings: string[]): Promise<GeneratedFile[]> {
    const result = compileShaderGraph({ targetVersion: textValue(params, 'targetVersion', '1.20.4'), blocks: params.blocks as ShaderGraphBlock[] })
    warnings.push(...result.warnings)
    return result.files
  }

  private async shaderPreview(params: Record<string, unknown>, requestId?: string): Promise<void> {
    const warnings: string[] = []
    const files = await this.shaderFiles(params, warnings)
    const sources = files.filter(file => typeof file.content === 'string' && /\.(?:glsl|vsh|fsh)$/.test(file.path))
      .map(file => ({ id: file.path, label: path.basename(file.path), content: file.content as string }))
    this.post({ type: 'shaderCode', requestId, sources, warnings })
  }
}

function validatePreviewPng(bytes: Uint8Array): void {
  const buffer = Buffer.from(bytes)
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error(uiText("ui.advancedPanel.previewInputMustBeAValidPng"))
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20)
  if (!width || !height || width > 4096 || height > 4096 || width * height > 4 * 1024 * 1024) throw new Error(uiText("ui.advancedPanel.previewOfTheSizesAboveSecurityLimit"))
  PNG.sync.read(buffer, { checkCRC: true })
}
