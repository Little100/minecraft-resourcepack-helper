import { uiText } from '../i18n/messages'
import { texturePreviewState } from '../core/texturePreviewState'
import { fontGlyphs, fontRoot } from './fontSupport'
import { unicodeLabel, unicodeEscape, type FontGlyph } from '../core/fontGlyphs'
import { familySource } from '../core/jsonFamily'
import { sourceOf } from './previewResourceContext'
import { postPreviewSession, type PreviewSession } from '../core/previewSession'
import { onWebviewMessage } from './webviewDiagnostics'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { getHtml } from './htmlShell'
import { detectPack } from '../core/packDetector'
import { getVersionCapabilities } from '../core/advanced/versionCapabilities'
import { loadTable, versionsForFormat } from '../core/packFormatTable'
import { sniffFormat, type DecodedFrame } from '../core/frameSource'
import { decodePng } from '../core/decoders'
import { checkLang, isLangFile } from '../core/langCheck'
import { MCMETA_FIELDS, MODEL_FIELDS } from './resourceDocs'
import { parseMinecraftText, type McRun } from '../core/mcText'
import { buildSchedule, parseAnimationMeta } from '../core/animationTimeline'
import { describeSequence, describeTiming } from './animationTiming'
import { createDebounced } from './debounce'
import { describeTextureProblem, mcmetaJsonProblem } from './textureMetaMessages'

export interface SyntaxField { name: string; detail: string; example?: string }
export interface SyntaxTextBlock { label: string; lines: McRun[][]; pixelSize: number }
export interface SyntaxImage { label: string; width: number; height: number; data: ArrayBuffer }
export interface SyntaxPackEntry { title: string; icon?: SyntaxImage; description: McRun[][] }
export interface SyntaxModel {
  command: 'syntax'
  canApplyFamily?: boolean
  glyphs?: FontGlyph[]
  fileName: string
  kind: string
  title: string
  packEntry?: SyntaxPackEntry
  effectTitle?: string
  effectLines: string[]
  images: SyntaxImage[]
  fieldsTitle: string
  fields: SyntaxField[]
  notes: string[]
  // 按游戏样式显示资源包描述等文字
  text?: SyntaxTextBlock[]
}

// 资源包相关的 json 与 mcmeta 才触发预览, 避免打扰普通文件
export function isSyntaxFile(document: vscode.TextDocument): boolean {
  if (document.uri.scheme !== 'file') return false
  const normalized = document.uri.fsPath.replace(/\\/g, '/').toLowerCase()
  if (/\.mcmeta$/.test(normalized)) return true
  if (!normalized.endsWith('.json')) return false
  return /\/assets\/|\/models\/|\/blockstates\/|\/lang\/|pack\.mcmeta$/.test(normalized)
}

export function shouldAutoOpenPreview(document: vscode.TextDocument): boolean {
  if (document.uri.scheme !== 'file') return false
  const normalized = document.uri.fsPath.replace(/\\/g, '/').toLowerCase()
  const name = normalized.split('/').pop() ?? ''
  if (name === 'pack.mcmeta') return true
  if (/\.png\.mcmeta$/.test(normalized)) return true
  return /\/models\/|\/blockstates\/|\/font\//.test(normalized)
}

function isModelDocument(document: vscode.TextDocument): boolean {
  return isSyntaxFile(document) && /\/models\//.test(document.uri.fsPath.replace(/\\/g, '/').toLowerCase())
}

export async function buildSyntaxModel(context: vscode.ExtensionContext, document: vscode.TextDocument): Promise<SyntaxModel> {
  const fsPath = document.uri.fsPath
  const normalized = fsPath.replace(/\\/g, '/').toLowerCase()
  const name = path.basename(fsPath)

  if (name.toLowerCase() === 'pack.mcmeta') return buildPackMeta(context, document, name)
  if (/\.png\.mcmeta$/.test(normalized)) return buildTextureMeta(document, name)
  if (/\/assets\/[^/]+\/font\/.+\.json$/.test(normalized)) return buildFontModel(context, document, name)
  if (/\/models\//.test(normalized)) return buildModel(document, name)
  if (/\/blockstates\//.test(normalized)) return buildBlockstate(document, name)
  if (isLangFile(fsPath)) return buildLang(document, name)
  return buildGeneric(name)
}

async function readPackIcon(metaPath: string): Promise<SyntaxImage | undefined> {
  const png = path.join(path.dirname(metaPath), 'pack.png')
  try {
    const bytes = new Uint8Array(await vscode.workspace.fs.readFile(vscode.Uri.file(png)))
    if (sniffFormat(bytes) !== 'png') return undefined
    const decoded = decodePng(bytes)
    const frame = decoded.frames[0]
    const copy = new Uint8Array(frame.data.length)
    copy.set(frame.data)
    return { label: 'pack.png', width: frame.width, height: frame.height, data: copy.buffer }
  } catch {
    return undefined
  }
}

async function buildPackMeta(context: vscode.ExtensionContext, document: vscode.TextDocument, name: string): Promise<SyntaxModel> {
  const lines: string[] = []
  const parsed = safeParse(document.getText())
  const format = parsed?.pack?.pack_format
  const table = loadTable(context)
  const isData = (await detectPack(path.dirname(document.uri.fsPath))).kind === 'datapack'
  const bound = (value: unknown, maximum = false): [number, number] | undefined => {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return [value, maximum ? Number.MAX_SAFE_INTEGER : 0]
    if (Array.isArray(value) && value.length === 2 && value.every(part => typeof part === 'number' && Number.isInteger(part) && part >= 0)) return [value[0], value[1]]
    return undefined
  }
  const min = bound(parsed?.pack?.min_format), max = bound(parsed?.pack?.max_format, true)
  const compare = (left: [number, number], right: [number, number]) => left[0] - right[0] || left[1] - right[1]
  if (min && max && compare(min, max) <= 0) {
    lines.push(uiText("ui.syntaxPreview.supportFormatToMajorMinor", JSON.stringify(parsed.pack.min_format), JSON.stringify(parsed.pack.max_format)))
    const versions = table.versions.filter(entry => entry.stable).filter(entry => {
      const known = getVersionCapabilities(entry.id)
      const reviewed = isData ? known?.dataPackFormat : known?.resourcePackFormat
      const target: [number, number] = reviewed ? [reviewed.major, reviewed.minor] : isData ? [entry.dpk, entry.dpkMinor ?? 0] : [entry.rpk, entry.rpkMinor]
      return compare(target, min) >= 0 && compare(target, max) <= 0
    }).map(entry => entry.id)
    lines.push(uiText("ui.syntaxPreview.applicableVersion", (versions.length ? versions.join(', ') : uiText("ui.syntaxPreview.notFoundInTheVersionTableCheck"))))
  } else if (parsed?.pack?.min_format !== undefined || parsed?.pack?.max_format !== undefined) {
    lines.push(uiText("ui.syntaxPreview.minFormatMaxFormatIsInvalidOr"))
  } else if (typeof format === 'number' && Number.isInteger(format) && format >= 0) {
    const versions = (isData ? table.versions.filter(entry => entry.dpk === format && entry.stable) : versionsForFormat(table, format)).map(entry => entry.id)
    lines.push(uiText("ui.syntaxPreview.applicableVersion", (versions.length ? versions.join(', ') : uiText("ui.syntaxPreview.notFoundOnTheVersionTableProbably"))))
  } else {
    lines.push(uiText("ui.syntaxPreview.notYetCompletedWithAValidPack"))
  }
  const supported = parsed?.pack?.supported_formats ?? parsed?.supported_formats
  if (supported) lines.push(uiText("ui.syntaxPreview.supportedFormatsCompatibleFormatCompartments", JSON.stringify(supported)))

  const description = parsed?.pack?.description
  const title = path.basename(path.dirname(document.uri.fsPath)) || uiText("ui.advancedPanel.resourcePack")
  const packEntry: SyntaxPackEntry = {
    title,
    icon: await readPackIcon(document.uri.fsPath),
    description: description !== undefined ? parseMinecraftText(description) : [[{ text: uiText("ui.syntaxPreview.missingDescription"), color: '#ff5555' }]]
  }

  const glyphs: FontGlyph[] = [], fontNotes: string[] = []
  const requested = new Map<string, Set<string>>()
  for (const run of packEntry.description.flat()) {
    const id = run.font ?? 'minecraft:default', chars = requested.get(id) ?? new Set<string>()
    for (const char of run.text) chars.add(char)
    requested.set(id, chars)
  }
  for (const [id, chars] of [...requested].slice(0, 16)) {
    const result = await fontGlyphs(document.uri, context, id, chars)
    glyphs.push(...result.glyphs)
    if (id !== 'minecraft:default' || !result.missingRootDefinition) fontNotes.push(...result.warnings)
  }
  return {
    command: 'syntax',
    glyphs,
    fileName: name,
    kind: 'pack.mcmeta',
    title: uiText("ui.syntaxPreview.packageDescriptionFile"),
    packEntry,
    effectTitle: isData ? uiText("ui.syntaxPreview.packageInformation") : uiText("ui.syntaxPreview.resourcePackInformation"),
    effectLines: lines,
    images: [],
    fieldsTitle: uiText("ui.syntaxPreview.availableFields"),
    fields: packMetaFields(),
    notes: [
      uiText("ui.syntaxPreview.oldVersionWithPackFormatNewVersion"),
      uiText("ui.syntaxPreview.decrimtionSupportsFormatCodeJsonTextComponent"),
      ...fontNotes
    ]
  }
}

async function buildTextureMeta(document: vscode.TextDocument, name: string): Promise<SyntaxModel> {
  const text = document.getText()
  const pngPath = document.uri.fsPath.replace(/\.mcmeta$/i, '')
  const pngName = path.basename(pngPath)
  const lines: string[] = []
  const strip = await readFrameStrip(pngPath)

  if (strip.kind === 'ok') {
    lines.push(uiText("ui.syntaxPreview.associationStickersX", pngName, strip.width, strip.height))
  } else if (strip.kind === 'missing') {
    lines.push(describeTextureProblem({ kind: 'missing-png', pngName }))
  } else {
    lines.push(describeTextureProblem({ kind: 'decode-failed', pngName, reason: strip.reason }))
  }

  const jsonReason = mcmetaJsonProblem(text)
  if (jsonReason !== undefined) {
    lines.push(describeTextureProblem({ kind: 'invalid-json', reason: jsonReason }))
  } else if (strip.kind === 'ok') {
    lines.push(...timingLines(strip.frameCount, text))
  }

  return {
    command: 'syntax',
    fileName: name,
    kind: 'texture-mcmeta',
    title: uiText("ui.syntaxPreview.animationMcmeta"),
    effectTitle: uiText("ui.syntaxPreview.animationEffects"),
    effectLines: lines,
    images: strip.kind === 'ok' ? strip.frames : [],
    fieldsTitle: uiText("ui.syntaxPreview.availableFields"),
    fields: MCMETA_FIELDS.map(f => ({ name: f.name, detail: f.detail })),
    notes: [
      uiText("ui.syntaxPreview.framesAreVerticallyOrganizedEachFrameIs"),
      uiText("ui.syntaxPreview.framesPlayedInArrayOrderAndDuplicated"),
      uiText("ui.syntaxPreview.ifYouWantToSeeTheEffects")
    ]
  }
}

// 按实际播放计划显示时长，设置无效时不估算
function timingLines(frameCount: number, text: string): string[] {
  const { animation } = parseAnimationMeta(text)
  if (!animation) return [describeTextureProblem({ kind: 'missing-animation' })]
  try {
    const schedule = buildSchedule(frameCount, animation)
    const lines = [describeTiming(frameCount, schedule), describeSequence(schedule)]
    if (animation.interpolate) lines.push(uiText("ui.syntaxPreview.openFramePlugsTransitionSmoother"))
    return lines
  } catch (error) {
    return [uiText("ui.syntaxPreview.animationSettingsCannotGeneratePlaySchedule", errorMessage(error))]
  }
}

type FrameStrip =
  | { kind: 'ok'; width: number; height: number; frameCount: number; frames: SyntaxImage[] }
  | { kind: 'missing' }
  | { kind: 'decode-failed'; reason: string }

// 缩略图只展示前几帧, 数量上限避免长帧条撑满信息区
const THUMB_FRAME_LIMIT = 6

async function readFrameStrip(pngPath: string): Promise<FrameStrip> {
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await vscode.workspace.fs.readFile(vscode.Uri.file(pngPath)))
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') return { kind: 'missing' }
    return { kind: 'decode-failed', reason: errorMessage(error) }
  }
  if (sniffFormat(bytes) !== 'png') return { kind: 'decode-failed', reason: uiText("ui.syntaxPreview.theHeaderIsNotAPngFormat") }
  try {
    const { frames } = decodePng(bytes)
    const first = frames[0]
    if (!first) return { kind: 'decode-failed', reason: uiText("ui.syntaxPreview.noImageFrameAvailableInTheFile") }
    return { kind: 'ok', width: first.width, height: first.height, frameCount: frames.length, frames: thumbnails(frames) }
  } catch (error) {
    return { kind: 'decode-failed', reason: errorMessage(error) }
  }
}

function thumbnails(frames: DecodedFrame[]): SyntaxImage[] {
  return frames.slice(0, THUMB_FRAME_LIMIT).map((frame, index) => {
    const buffer = new Uint8Array(frame.data.length)
    buffer.set(frame.data)
    return { label: uiText("ui.syntaxPreview.frame", index), width: frame.width, height: frame.height, data: buffer.buffer }
  })
}

async function buildModel(document: vscode.TextDocument, name: string): Promise<SyntaxModel> {
  const parsed = safeParse(document.getText())
  const lines: string[] = []
  const images: SyntaxImage[] = []
  if (parsed?.parent) lines.push(uiText("ui.syntaxPreview.inheritanceParentModel", parsed.parent))
  const textures = parsed?.textures && typeof parsed.textures === 'object' ? parsed.textures as Record<string, string> : {}
  const keys = Object.keys(textures)
  if (keys.length) {
    lines.push(uiText("ui.syntaxPreview.pasteVariables", keys.map(k => `${k} → ${textures[k]}`).join(', ')))
    for (const key of keys.slice(0, 4)) {
      const image = await resolveTextureImage(document.uri, textures[key])
      if (image) images.push({ ...image, label: `${key} · ${image.label}` })
    }
  } else {
    lines.push(uiText("ui.syntaxPreview.undeclaredTexturesStickerWillInheritTheParent"))
  }
  return {
    command: 'syntax',
    fileName: name,
    kind: 'model',
    title: uiText("ui.syntaxPreview.model"),
    effectTitle: uiText("ui.syntaxPreview.modelReference"),
    effectLines: lines,
    images,
    fieldsTitle: uiText("ui.syntaxPreview.availableFields"),
    fields: MODEL_FIELDS.map(f => ({ name: f.name, detail: f.detail })),
    notes: [uiText("ui.syntaxPreview.pixmapPathsLikeNamespaceBlockNameCorresponding")]
  }
}

function buildBlockstate(document: vscode.TextDocument, name: string): SyntaxModel {
  const parsed = safeParse(document.getText())
  const lines: string[] = []
  if (parsed?.variants && typeof parsed.variants === 'object') {
    for (const [state, value] of Object.entries(parsed.variants as Record<string, unknown>)) {
      const model = (value as { model?: string })?.model ?? (Array.isArray(value) ? uiText("ui.syntaxPreview.multipleRandomModels") : '')
      lines.push(uiText("ui.syntaxPreview.status", state || uiText("collaboration.openp2p.default"), model))
    }
  } else if (Array.isArray(parsed?.multipart)) {
    lines.push(uiText("ui.syntaxPreview.multipartRulesBarSuperimposeTheModelAs", parsed.multipart.length))
  } else {
    lines.push(uiText("ui.syntaxPreview.notYetDeclaredVariansOrMultipart"))
  }
  return {
    command: 'syntax',
    fileName: name,
    kind: 'blockstate',
    title: uiText("ui.syntaxPreview.blockstate"),
    effectTitle: uiText("ui.syntaxPreview.statusToModelMap"),
    effectLines: lines,
    images: [],
    fieldsTitle: uiText("ui.syntaxPreview.availableFields"),
    fields: MODEL_FIELDS.filter(f => ['variants', 'multipart', 'model', 'x', 'y', 'uvlock', 'weight'].includes(f.name)).map(f => ({ name: f.name, detail: f.detail })),
    notes: [uiText("ui.syntaxPreview.variantsMapTheSquareStateToThe")]
  }
}

async function buildLang(document: vscode.TextDocument, name: string): Promise<SyntaxModel> {
  const parsed = safeParse(document.getText())
  const lines: string[] = []
  const keyCount = parsed && typeof parsed === 'object' ? Object.keys(parsed).length : 0
  lines.push(uiText('syntax.language.count', keyCount))
  const report = await checkLang({ file: document.uri.fsPath, content: document.getText() })
  if (report && report.missing.length > 0) {
    const here = report.missing.filter(m => !m.files.includes(path.normalize(document.uri.fsPath)))
    if (here.length) lines.push(uiText('syntax.language.missing', here.length, here.slice(0, 8).map(m => m.key).join(', '), here.length > 8 ? ' …' : ''))
    else lines.push(uiText("syntax.language.noMissing"))
  } else if (report) {
    lines.push(uiText("syntax.language.noMissing"))
  }
  return {
    command: 'syntax',
    fileName: name,
    kind: 'lang',
    title: uiText("syntax.language.title"),
    effectTitle: uiText("syntax.language.statistics"),
    effectLines: lines,
    images: [],
    fieldsTitle: uiText("syntax.language.keys"),
    fields: [
      { name: uiText("syntax.language.blockKey"), detail: uiText("syntax.language.blockName") },
      { name: uiText("syntax.language.itemKey"), detail: uiText("syntax.language.itemName") },
      { name: uiText("syntax.language.groupKey"), detail: uiText("syntax.language.groupName") },
      { name: uiText("syntax.language.subtitleKey"), detail: uiText("syntax.language.subtitle") }
    ],
    notes: [uiText("syntax.language.fallback")]
  }
}

function buildGeneric(name: string): SyntaxModel {
  return {
    command: 'syntax',
    fileName: name,
    kind: 'json',
    title: uiText("ui.syntaxPreview.resourceFile", name),
    effectLines: [],
    images: [],
    fieldsTitle: uiText("ui.syntaxPreview.commonFieldReferences"),
    fields: [...MODEL_FIELDS, ...MCMETA_FIELDS].map(f => ({ name: f.name, detail: f.detail })),
    notes: [uiText("ui.syntaxPreview.theFileHasNoVisualEffectsAnd")]
  }
}

export const REFERENCE_PATTERN = /^(?:([a-z0-9_.-]+):)?(.+)$/

// 只取引用贴图的首帧预览
async function resolveTextureImage(base: vscode.Uri, reference: string): Promise<SyntaxImage | undefined> {
  const match = REFERENCE_PATTERN.exec(reference)
  if (!match) return undefined
  const normalizedBase = base.fsPath.replace(/\\/g, '/')
  const assetsIndex = normalizedBase.indexOf('/assets/')
  if (assetsIndex < 0) return undefined
  const root = base.fsPath.slice(0, assetsIndex)
  const rel = match[2]

  // 未写命名空间时尝试原版和当前文件的命名空间
  const ownNamespace = normalizedBase.slice(assetsIndex + '/assets/'.length).split('/')[0]
  const candidates = match[1] ? [match[1]] : [...new Set([ownNamespace, 'minecraft'].filter(Boolean))]

  for (const namespace of candidates) {
    const file = path.join(root, 'assets', namespace, 'textures', `${rel}.png`)
    try {
      const bytes = new Uint8Array(await vscode.workspace.fs.readFile(vscode.Uri.file(file)))
      if (sniffFormat(bytes) !== 'png') continue
      const decoded = decodePng(bytes)
      const frame = decoded.frames[0]
      const copy = new Uint8Array(frame.data.length)
      copy.set(frame.data)
      return { label: `${namespace}:${rel}`, width: frame.width, height: frame.height, data: copy.buffer }
    } catch {
      // 找不到时换一个命名空间
    }
  }
  return undefined
}

function packMetaFields(): SyntaxField[] {
  return [
    { name: 'pack.pack_format', detail: uiText("ui.syntaxPreview.resourcePackFormatNumberDetermineWhichVersion") },
    { name: 'pack.min_format', detail: uiText("ui.syntaxPreview.newVersionOfTheMinimumSupportFormat") },
    { name: 'pack.max_format', detail: uiText("ui.syntaxPreview.newMaximumSupportFormatIntegerMeansAll") },
    { name: 'pack.description', detail: uiText("ui.syntaxPreview.descriptionsDisplayedInTheResourcePackList") },
    { name: 'pack.supported_formats', detail: uiText("ui.syntaxPreview.compatibleFormatPartitionsWriteArraysOrMin") },
    { name: 'filter.block', detail: uiText("ui.syntaxPreview.filterRulesToExcludeOriginalResourcesBy") }
  ]
}

function emptyModel(): SyntaxModel {
  return {
    command: 'syntax',
    fileName: '',
    kind: 'none',
    title: uiText("ui.htmlShell.mcrhSyntaxPreview"),
    effectLines: [],
    images: [],
    fieldsTitle: '',
    fields: [],
    notes: [uiText("ui.syntaxPreview.opensTheJsonOrMcmetaFileOf")]
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeParse(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// 连续输入时合并刷新，避免重复读取
const SYNTAX_REFRESH_DELAY_MS = 300

export class SyntaxPreviewPanel {
  public static readonly viewType = 'mcrh.syntaxPreview'

  private static current: SyntaxPreviewPanel | undefined

  private readonly disposables: vscode.Disposable[] = []
  private glyphs: FontGlyph[] = []
  private assetRoot?: string
  private assetWatcher?: vscode.FileSystemWatcher
  private closed = false
  private revision = 0
  private pending?: vscode.TextDocument
  private readonly refresh = createDebounced(() => void this.render(), SYNTAX_REFRESH_DELAY_MS)

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly context: vscode.ExtensionContext) {
    this.panel.webview.html = getHtml(this.panel.webview, context.extensionUri, 'syntax', this.panel)
    onWebviewMessage(this.panel.webview, message => {
      const command = (message as { command?: string })?.command
      if (command === 'syntaxReady') void this.render()
      if (command === 'openInBlockbench') void this.openInBlockbench()
      if (command === 'applyJsonFamily' && this.pending && familySource(sourceOf(this.pending.uri.fsPath)?.relative ?? '')) void vscode.commands.executeCommand('mcrh.applyJsonFamily', this.pending.uri)
      if (command === 'pickFontGlyph') void vscode.commands.executeCommand('mcrh.insertFontGlyph', this.pending?.uri)
      if (command === 'copyFontGlyph') {
        const raw = message as { char?: unknown; font?: unknown }
        const glyph = this.glyphs.find(value => value.char === raw.char && value.font === raw.font)
        if (glyph) void vscode.env.clipboard.writeText(unicodeEscape(glyph.char))
      }
      if (command === 'createFontTemplate') void vscode.commands.executeCommand('mcrh.createFontTemplate', this.pending?.uri)
    }, undefined, this.disposables)
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables)

    this.disposables.push(
      texturePreviewState.subscribe(event => { if (event.type === 'texture' && this.assetRoot && fontRoot(vscode.Uri.file(event.uri)) === this.assetRoot) this.refresh.trigger() }),
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor && isSyntaxFile(editor.document)) {
          this.pending = editor.document
          void this.render()
        }
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document === this.pending || this.assetRoot && fontRoot(event.document.uri) === this.assetRoot) this.refresh.trigger()
      })
    )
  }

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const open = vscode.commands.registerCommand('mcrh.openSyntaxPreview', () => {
      SyntaxPreviewPanel.show(context, vscode.window.activeTextEditor?.document)
    })
    const auto = vscode.window.onDidChangeActiveTextEditor(editor => {
      if (!editor || !shouldAutoOpenPreview(editor.document)) return
      if (!vscode.workspace.getConfiguration('mcrh').get<boolean>('autoOpenSyntaxPreview', true)) return
      SyntaxPreviewPanel.show(context, editor.document, true)
    })
    context.subscriptions.push(open, auto)
    return vscode.Disposable.from(open, auto)
  }

  static show(context: vscode.ExtensionContext, document?: vscode.TextDocument, preserveFocus = false): void {
    if (!SyntaxPreviewPanel.current) {
      const panel = vscode.window.createWebviewPanel(
        SyntaxPreviewPanel.viewType,
        uiText("ui.htmlShell.mcrhSyntaxPreview"),
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] }
      )
      SyntaxPreviewPanel.current = new SyntaxPreviewPanel(panel, context)
    } else if (!preserveFocus) {
      SyntaxPreviewPanel.current.panel.reveal(vscode.ViewColumn.Beside, preserveFocus)
    }
    const target = document ?? vscode.window.activeTextEditor?.document
    if (target && isSyntaxFile(target)) SyntaxPreviewPanel.current.pending = target
    void SyntaxPreviewPanel.current.render()
  }

  static async restore(context: vscode.ExtensionContext, panel: vscode.WebviewPanel, session: PreviewSession): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(session.source))
    this.current?.dispose()
    panel.webview.options = { enableScripts: true, localResourceRoots: [context.extensionUri] }
    const instance = new SyntaxPreviewPanel(panel, context)
    this.current = instance
    instance.pending = document
    await instance.render()
  }

  private async render(): Promise<void> {
    const revision = ++this.revision
    if (this.closed) return
    const document = this.pending ?? vscode.window.activeTextEditor?.document
    if (!document || !isSyntaxFile(document)) {
      void this.panel.webview.postMessage(emptyModel())
      return
    }
    this.pending = document
    const root = fontRoot(document.uri)
    if (root && root !== this.assetRoot) {
      this.assetWatcher?.dispose(); this.assetRoot = root
      this.assetWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, 'assets/**'))
      for (const event of [this.assetWatcher.onDidChange, this.assetWatcher.onDidCreate, this.assetWatcher.onDidDelete]) event(() => this.refresh.trigger())
    }
    postPreviewSession(this.panel.webview, { kind: 'syntax', source: document.uri.fsPath })
    try {
      const model = await buildSyntaxModel(this.context, document)
      model.canApplyFamily = Boolean(familySource(sourceOf(document.uri.fsPath)?.relative ?? ''))
      if (!this.closed && revision === this.revision) { this.glyphs = model.glyphs ?? []; void this.panel.webview.postMessage(model) }
    } catch (error) {
      if (!this.closed && revision === this.revision) void this.panel.webview.postMessage({ ...emptyModel(), notes: [uiText("ui.syntaxPreview.parsingFailed", errorMessage(error))] })
    }
  }

  private async openInBlockbench(): Promise<void> {
    const document = this.pending
    if (!document || !isModelDocument(document)) return
    await vscode.commands.executeCommand('mcrh.openInBlockbench', document.uri)
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.revision++
    this.assetWatcher?.dispose()
    if (SyntaxPreviewPanel.current === this) SyntaxPreviewPanel.current = undefined
    this.refresh.dispose()
    this.panel.dispose()
    for (const item of this.disposables) item.dispose()
    this.disposables.length = 0
  }
}

async function buildFontModel(context: vscode.ExtensionContext, document: vscode.TextDocument, name: string): Promise<SyntaxModel> {
  const source = sourceOf(document.uri.fsPath)
  const match = source && /^assets\/([^/]+)\/font\/(.+)\.json$/.exec(source.relative)
  if (!match) return buildGeneric(name)
  const result = await fontGlyphs(document.uri, context, match[1] + ':' + match[2])
  return { command: 'syntax', fileName: name, kind: 'font', title: uiText("ui.syntaxPreview.unicodeFontAndPasteCharacters"), glyphs: result.glyphs,
    effectTitle: uiText("ui.syntaxPreview.fontCharacters"), effectLines: [uiText("ui.syntaxPreview.characters", result.glyphs.length), uiText("ui.syntaxPreview.supportsBitmapSpaceAccessToCharacterSelection")], images: [],
    text: [{ label: uiText("ui.syntaxPreview.characterPreview"), pixelSize: 16, lines: [result.glyphs.slice(0, 64).map(glyph => ({ text: glyph.char, font: glyph.font }))] }],
    fieldsTitle: uiText("ui.syntaxPreview.charactermap"), fields: result.glyphs.map(glyph => ({ name: unicodeLabel(glyph.char), detail: glyph.texture ?? uiText("ui.resourceTemplates.space_892281", glyph.advance), example: glyph.source })), notes: result.warnings }
}
