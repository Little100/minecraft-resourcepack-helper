import { uiText } from '../i18n/messages'
import { createVanillaTemplate } from './vanillaTemplates'
import { applyJsonFamily } from './jsonFamily'
import { jsonStringBoundary } from '../core/jsonCompletion'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { parse, modify, applyEdits } from 'jsonc-parser'
import { customModelDataCommand, customModelDataDefinition, customModelDataSchema, customModelDataVersions, resourceId, validateCustomModelData } from '../core/customModelData'
import { CYAN } from '../core/exampleAssets'
import { unicodeEscape, unicodeLabel, type FontGlyph } from '../core/fontGlyphs'
import { assertExportPathWithoutLinks } from '../core/advanced/exportPolicy'
import { runtimeConfig } from '../core/config'
import { namespaceProblem } from '../core/namespace'
import { fontGlyphs, fontResources, fontRoot } from './fontSupport'
import { pickWorkspaceRoot } from './workspacePicker'
import { versionOf } from './previewResourceContext'
import { completionContext } from './jsonCompletion'
import { findExisting, askOverwrite, type OverwriteChoice } from './overwriteDialog'

async function targetRoot(uri?: vscode.Uri): Promise<string | undefined> {
  const active = uri ?? vscode.window.activeTextEditor?.document.uri
  return active?.scheme === 'file' ? fontRoot(active) ?? await pickWorkspaceRoot() : pickWorkspaceRoot()
}
function json(value: unknown): string { return JSON.stringify(value, null, 2) + '\n' }
async function readJson(file: string): Promise<{ text: string; value: Record<string, unknown> } | undefined> {
  await assertExportPathWithoutLinks(file, true)
  const uri = vscode.Uri.file(file)
  if (vscode.workspace.textDocuments.some(document => document.uri.toString() === uri.toString() && document.isDirty)) throw new Error(uiText("ui.resourceTemplates.targetJsonHasUnsavedChangesSaveAnd"))
  try {
    const stat = await vscode.workspace.fs.stat(uri)
    if (stat.size > 2 * 1024 * 1024) throw new Error(uiText("ui.resourceTemplates.targetJsonExceededTemplateEditingLimit"))
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)), errors: import('jsonc-parser').ParseError[] = []
    const value = parse(text, errors)
    if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error(uiText("ui.resourceTemplates.targetJsonIsInvalidPleaseFixIt"))
    return { text, value }
  } catch (error) { if ((error as { code?: string }).code === 'FileNotFound' || (error as { code?: string }).code === 'ENOENT') return undefined; throw error }
}
async function writeFiles(root: string, files: Array<{ relative: string; content: string | Uint8Array }>, merge = new Set<string>(), expected = new Map<string, string>()): Promise<string[]> {
  const entries = files.map(file => {
    const target = path.resolve(root, file.relative), relative = path.relative(root, target)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(uiText("ui.resourceTemplates.templatePathExceedingResourcePackDirectory"))
    return { ...file, target, uri: vscode.Uri.file(target) }
  })
  for (const entry of entries) {
    await assertExportPathWithoutLinks(entry.target, true)
    if (vscode.workspace.textDocuments.some(document => document.uri.toString() === entry.uri.toString() && document.isDirty)) throw new Error(uiText("ui.resourceTemplates.targetFileHasUnsavedChanges", entry.relative))
  }
  const existing = await findExisting(entries.filter(entry => !merge.has(entry.relative)).map(entry => entry.uri))
  const policy: OverwriteChoice = await askOverwrite(existing)
  if (policy === 'cancel') return []
  if (policy === 'skip' && existing.length) { void vscode.window.showInformationMessage(uiText("ui.resourceTemplates.inOrderToAvoidCreatingTemplatesThat")); return [] }
  for (const entry of entries) {
    if (vscode.workspace.textDocuments.some(document => document.uri.toString() === entry.uri.toString() && document.isDirty)) throw new Error(uiText("ui.resourceTemplates.targetFileCreatedUnsavedEditingDuringCreation"))
    const previous = expected.get(entry.relative)
    if (previous !== undefined && new TextDecoder().decode(await vscode.workspace.fs.readFile(entry.uri)) !== previous) throw new Error(uiText("ui.resourceTemplates.targetConfigurationChangedDuringCreationTryAgain"))
  }
  const written: string[] = []
  for (const entry of entries) {
    await assertExportPathWithoutLinks(entry.target, true)
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(entry.target)))
    await vscode.workspace.fs.writeFile(entry.uri, typeof entry.content === 'string' ? new TextEncoder().encode(entry.content) : entry.content)
    written.push(entry.target)
  }
  return written
}
async function namespace(): Promise<string | undefined> {
  return vscode.window.showInputBox({ title: uiText("ui.resourceTemplates.templateNamespace"), value: runtimeConfig().defaultNamespace, validateInput: namespaceProblem })
}
async function pickVersion(root: string): Promise<string | undefined> {
  const detected = await versionOf([root])
  const choices = customModelDataVersions().map(version => ({ label: version, description: customModelDataSchema(version) === 'unsupported' ? uiText("ui.resourceTemplates.thisVersionHasNoOriginalCustommodeldata") : customModelDataSchema(version) === 'component-lists' ? uiText("ui.resourceTemplates.itemsFloatsFlagsStlingsColores") : customModelDataSchema(version) === 'nbt' ? 'models/item overrides / NBT' : uiText("ui.resourceTemplates.modelsItemOverridesNumericalComponent") }))
  const selected = await vscode.window.showQuickPick(choices, { title: uiText("ui.resourceTemplates.selectTargetMinecraftVersion"), placeHolder: detected.version ? uiText("ui.resourceTemplates.currentPreviewVersion", detected.version) : uiText("ui.resourceTemplates.templatesOnlyWriteToTheConfigurationApplicable"), matchOnDescription: true })
  return selected?.label
}
export async function createCustomModelData(uri?: vscode.Uri): Promise<void> {
  const root = await targetRoot(uri); if (!root) return
  const version = await pickVersion(root); if (!version) return
  if (customModelDataSchema(version) === 'unsupported') { await vscode.window.showInformationMessage(uiText("ui.resourceTemplates.javaNoOriginalCustommodeldataCanUseCit", version)); return }
  const ns = await namespace(); if (ns === undefined) return
  const item = await vscode.window.showInputBox({ title: uiText("ui.resourceTemplates.basicItemResourceIdentifier"), value: 'minecraft:paper', validateInput: value => resourceId(value) ? undefined : uiText("ui.resourceTemplates.enterAValidItemResourceIdentifier") }); if (!item) return
  const model = await vscode.window.showInputBox({ title: uiText("ui.resourceTemplates.customModelResourceIdentifier"), value: ns + ':item/custom_item', validateInput: value => resourceId(value) ? undefined : uiText("ui.resourceTemplates.pleaseEnterAValidModelResourceIdentifier") }); if (!model) return
  const raw = await vscode.window.showInputBox({ title: uiText("ui.resourceTemplates.custommodeldataValue"), value: '1', validateInput: value => { try { if (!value.trim()) return uiText("ui.resourceTemplates.pleaseEnterAValue"); validateCustomModelData(Number(value), version); return undefined } catch (error) { return String((error as Error).message) } } }); if (raw === undefined) return
  const value = Number(raw), definition = customModelDataDefinition(item, model, value, version)
  const [modelNs, modelName] = model.includes(':') ? model.split(':') : ['minecraft', model]
  const customPath = 'assets/' + modelNs + '/models/' + modelName + '.json', texturePath = 'assets/' + modelNs + '/textures/' + modelName + '.png'
  if (customPath === definition.path) throw new Error(uiText("ui.resourceTemplates.theCustomModelDoesNotCoverThe"))
  const previous = await readJson(path.join(root, definition.path))
  let content = json(definition.content)
  if (previous) {
    if (customModelDataSchema(version) === 'component-lists') {
      const current = previous.value.model as Record<string, unknown> | undefined
      const compatible = current && String(current.type).replace(/^minecraft:/, '') === 'range_dispatch' && String(current.property).replace(/^minecraft:/, '') === 'custom_model_data' && (current.index === undefined || current.index === 0) && (current.scale === undefined || current.scale === 1) && Array.isArray(current.entries)
      if (compatible) {
        if ((current!.entries as Array<{ threshold?: unknown }>).some(entry => entry?.threshold === value)) throw new Error(uiText("ui.resourceTemplates.thisCmdThresholdAlreadyExistsPleaseSelect"))
        const entry = ((definition.content.model as Record<string, unknown>).entries as unknown[])[0]
        const entries = [...current!.entries as unknown[], entry].sort((a, b) => Number((a as { threshold: number }).threshold) - Number((b as { threshold: number }).threshold))
        content = applyEdits(previous.text, modify(previous.text, ['model', 'entries'], entries, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
      } else {
        const wrapped = { ...definition.content.model as Record<string, unknown>, fallback: previous.value.model }
        if (!previous.value.model || typeof previous.value.model !== 'object') throw new Error(uiText("ui.resourceTemplates.existingItemDefinitionMissingModelUnableTo"))
        content = applyEdits(previous.text, modify(previous.text, ['model'], wrapped, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
      }
    } else {
      const overrides = previous.value.overrides ?? []
      if (!Array.isArray(overrides)) throw new Error(uiText("ui.resourceTemplates.existingOverridesAreNotArraysAndCannot"))
      if (overrides.some(entry => (entry?.predicate?.custom_model_data ?? entry?.predicate?.['minecraft:custom_model_data']) === value)) throw new Error(uiText("ui.resourceTemplates.thisCmdValueAlreadyExistsPleaseSelect"))
      const entry = (definition.content.overrides as unknown[])[0]
      const insertion = overrides.findIndex(existing => typeof (existing?.predicate?.custom_model_data ?? existing?.predicate?.['minecraft:custom_model_data']) === 'number' && (existing.predicate.custom_model_data ?? existing.predicate['minecraft:custom_model_data']) > value)
      const merged = [...overrides]
      merged.splice(insertion < 0 ? merged.length : insertion, 0, entry)
      content = applyEdits(previous.text, modify(previous.text, ['overrides'], merged, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
    }
  }
  const command = customModelDataCommand(item, value, version)
  const files = [{ relative: definition.path, content }, { relative: customPath, content: json({ parent: 'minecraft:item/generated', textures: { layer0: modelNs + ':' + modelName } }) }, { relative: texturePath, content: CYAN }, { relative: '.mcrh/templates/' + modelNs + '/' + modelName + '.md', content: uiText("ui.resourceTemplates.custommodeldataTemplateTargetVersionInnerGameTest", version, command) + uiText("ui.resourceTemplates.enterCmdValuesInTheMcrhModel") }]
  const written = await writeFiles(root, files, new Set(previous ? [definition.path] : []), new Map(previous ? [[definition.path, previous.text]] : [])); if (!written.length) return
  await vscode.env.clipboard.writeText(command)
  await vscode.window.showTextDocument(vscode.Uri.file(written[0]))
  void vscode.window.showInformationMessage(uiText("ui.resourceTemplates.createdCmdConfigurationModelAndPasteTest", version))
}
export async function createFontTemplate(uri?: vscode.Uri): Promise<void> {
  const root = await targetRoot(uri); if (!root) return
  const detected = await versionOf([root])
  if (detected.version && Number(detected.version.split('.')[0]) === 1 && Number(detected.version.split('.')[1]) < 13) throw new Error(uiText("ui.resourceTemplates.thisVersionDoesNotYetSupportJson"))
  const ns = await namespace(); if (ns === undefined) return
  const font = await vscode.window.showInputBox({ title: uiText("ui.resourceTemplates.fontResourceIdentification"), value: 'minecraft:default', prompt: uiText("ui.resourceTemplates.defaultCanBeUsedDirectlyForPackage"), validateInput: value => resourceId(value) ? undefined : uiText("ui.resourceTemplates.fontResourceIdentifierInvalid") }); if (!font) return
  const raw = await vscode.window.showInputBox({ title: uiText("ui.resourceTemplates.characterCodePoints"), value: 'E000', prompt: uiText("ui.resourceTemplates.e000UE000OrSingleCharactersCan"), validateInput: value => codePoint(value) === undefined ? uiText("ui.resourceTemplates.enterAValidUncontrolledUnicodeCharacterOr") : undefined }); if (!raw) return
  const char = String.fromCodePoint(codePoint(raw)!)
  const source = await vscode.window.showQuickPick([{ label: uiText("ui.resourceTemplates.useAnExistingPngPoster"), existing: true }, { label: uiText("ui.resourceTemplates.createExamplePaste"), existing: false }], { title: uiText("ui.resourceTemplates.characterPasteSource") }); if (!source) return
  let texture = ns + ':font/icon_' + codePoint(raw)!.toString(16) + '.png', sample = true
  if (source.existing) {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { PNG: ['png'] }, defaultUri: vscode.Uri.file(root), title: uiText("ui.resourceTemplates.selectACharacterStickerInTheResource") }); if (!picked?.[0]) return
    const relative = path.relative(root, picked[0].fsPath).split(path.sep).join('/'), match = /^assets\/([a-z0-9_.-]+)\/textures\/(.+\.png)$/.exec(relative)
    if (!match || relative.split('/').includes('..')) throw new Error(uiText("ui.resourceTemplates.selectThePngInTheCurrentResource"))
    await assertExportPathWithoutLinks(picked[0].fsPath)
    texture = match[1] + ':' + match[2]; sample = false
  }
  const height = await vscode.window.showInputBox({ title: uiText("ui.resourceTemplates.theHeightOfTheCharactersInThe"), value: '8', validateInput: value => /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 256 ? undefined : uiText("ui.resourceTemplates.heightRequiresIntegerNumbersOfTo") }); if (height === undefined) return
  const ascent = await vscode.window.showInputBox({ title: uiText("ui.resourceTemplates.characterAscent"), value: String(Number(height) - 1), validateInput: value => /^-?\d+$/.test(value) && Number(value) <= Number(height) && Number(value) >= -256 ? undefined : uiText("ui.resourceTemplates.ascentNeedsIntegerNumbersAndCannotExceed") }); if (ascent === undefined) return
  const [fontNs, fontName] = font.includes(':') ? font.split(':') : ['minecraft', font], relative = 'assets/' + fontNs + '/font/' + fontName + '.json'
  const previous = await readJson(path.join(root, relative)), providers = previous?.value.providers ?? []
  if (!Array.isArray(providers)) throw new Error(uiText("ui.resourceTemplates.currentFontsprovidersNotNumerical"))
  if (providers.some(provider => provider?.type?.replace(/^minecraft:/, '') === 'bitmap' && Array.isArray(provider.chars) && provider.chars.some((row: unknown) => typeof row === 'string' && row.includes(char)))) throw new Error(uiText("ui.resourceTemplates.thisCharacterHasBeenMappedInThe"))
  const provider = { type: 'bitmap', file: texture, ascent: Number(ascent), height: Number(height), chars: [char] }
  const content = previous ? applyEdits(previous.text, modify(previous.text, ['providers'], [provider, ...providers], { formattingOptions: { insertSpaces: true, tabSize: 2 } })) : json({ providers: [provider] })
  const files: Array<{ relative: string; content: string | Uint8Array }> = [{ relative, content }]
  if (sample) { const [tns, tname] = texture.split(':'); files.push({ relative: 'assets/' + tns + '/textures/' + tname, content: CYAN }) }
  const written = await writeFiles(root, files, new Set(previous ? [relative] : []), new Map(previous ? [[relative, previous.text]] : [])); if (!written.length) return
  await vscode.env.clipboard.writeText(font === 'minecraft:default' ? unicodeEscape(char) : JSON.stringify({ text: char, font }))
  await vscode.window.showTextDocument(vscode.Uri.file(written[0]))
  void vscode.window.showInformationMessage(uiText("ui.resourceTemplates.createdPasteCharacterMcmetaHasBeenCopied", unicodeLabel(char)))
}
function codePoint(raw: string): number | undefined {
  const value = raw.trim(), point = /^(?:U\+|\\u)?[0-9a-f]{2,6}$/i.test(value) ? Number.parseInt(value.replace(/^(?:U\+|\\u)/i, ''), 16) : Array.from(value).length === 1 ? value.codePointAt(0) : undefined
  return point !== undefined && point >= 0x20 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? point : undefined
}
export async function insertFontGlyph(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  const editor = vscode.window.activeTextEditor, target = uri ?? editor?.document.uri
  if (!target) throw new Error(uiText("ui.resourceTemplates.useCharacterSelectionAfterOpeningThePack"))
  const resources = await fontResources(target, context)
  const fonts = new Set(['minecraft:default'])
  for (const directory of await resources.assets.listDirectories('assets')) {
    const ns = directory.split('/').pop()!
    for (const file of await resources.assets.list('assets/' + ns + '/font')) { const match = /^assets\/([^/]+)\/font\/(.+)\.json$/.exec(file); if (match) fonts.add(match[1] + ':' + match[2]); if (fonts.size >= 512) break }
    if (fonts.size >= 512) break
  }
  const font = await vscode.window.showQuickPick([...fonts], { title: uiText("ui.resourceTemplates.selectFont"), placeHolder: uiText("ui.resourceTemplates.theDefaultFontCanBeUsedDirectly") }); if (!font) return
  const glyph = await pickFontGlyph(context, target, font); if (!glyph) return
  const action = await vscode.window.showQuickPick([uiText("ui.resourceTemplates.insertUnicodeConversion"), uiText("ui.resourceTemplates.copyUnicodeConversion"), uiText("ui.resourceTemplates.copyOriginalCharacters"), uiText("ui.resourceTemplates.copyTextComponents"), uiText("ui.resourceTemplates.openFontConfiguration"), uiText("ui.resourceTemplates.openCharacterPaste")], { title: unicodeLabel(glyph.char) + ' · ' + font }); if (!action) return
  if (action === uiText("ui.resourceTemplates.openFontConfiguration") || action === uiText("ui.resourceTemplates.openCharacterPaste")) {
    const file = action === uiText("ui.resourceTemplates.openFontConfiguration") ? glyph.source : glyph.texture
    if (!file) return
    const indices = action === uiText("ui.resourceTemplates.openFontConfiguration") && glyph.sourceLayer !== undefined ? [glyph.sourceLayer] : resources.assets.roots.map((_, index) => index)
    for (const index of indices) if (await resources.assets.read(file, index)) { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(resources.assets.roots[index], file))); return }
  }
  if (action === uiText("ui.resourceTemplates.insertUnicodeConversion")) {
    if (!editor || editor.document.uri.toString() !== target.toString()) throw new Error(uiText("ui.resourceTemplates.pleaseInsertCharacterInTheTargetJson"))
    const insertion = completionContext(editor.document, editor.selection.active)?.string
    const start = editor.document.offsetAt(editor.selection.start), end = editor.document.offsetAt(editor.selection.end)
    if (!insertion || start < insertion.start || end > insertion.end) throw new Error(uiText("ui.resourceTemplates.insertingASelectionMustBeEntirelyWithin"))
    if (font !== 'minecraft:default') {
      const context = completionContext(editor.document, editor.selection.active)
      const value = context?.value?.parent?.parent
      const activeFont = value?.children?.find(property => property.children?.[0]?.value === 'font')?.children?.[1]?.value
      if (activeFont !== font) { await vscode.env.clipboard.writeText(JSON.stringify({ text: glyph.char, font })); void vscode.window.showInformationMessage(uiText("ui.resourceTemplates.theCurrentTextComponentHasNotSpecified")); return }
    }
    const currentText = editor.document.getText(), replacement = unicodeEscape(glyph.char)
    if (!jsonStringBoundary(currentText, insertion, start) || !jsonStringBoundary(currentText, insertion, end)) throw new Error(uiText("ui.resourceTemplates.theCurrentPositionWillUnseparateTheJson"))
    try { JSON.parse('"' + currentText.slice(insertion.start, start) + replacement + currentText.slice(end, insertion.end) + '"') }
    catch { throw new Error(uiText("ui.resourceTemplates.theCurrentPositionWillUnseparateTheJson_286ece")) }
    await editor.edit(builder => builder.replace(editor.selection, replacement)); return
  }
  await vscode.env.clipboard.writeText(action === uiText("ui.resourceTemplates.copyOriginalCharacters") ? glyph.char : action === uiText("ui.resourceTemplates.copyTextComponents") ? JSON.stringify({ text: glyph.char, font }) : unicodeEscape(glyph.char))
}
export function registerResourceTemplates(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider([{ scheme: 'file', language: 'json' }, { scheme: 'file', language: 'jsonc' }], {
    async provideCompletionItems(document, position, token) {
      const location = completionContext(document, position)
      if (!location?.string || !fontRoot(document.uri)) return undefined
      const fontFile = /\/assets\/[^/]+\/font\/.+\.json$/i.test(document.uri.fsPath.replace(/\\/g, '/'))
      const description = path.basename(document.uri.fsPath).toLowerCase() === 'pack.mcmeta' && location.path[0] === 'pack' && location.path[1] === 'description'
      if (!fontFile && !description) return undefined
      if (location.path.at(-1) === 'font' || location.path.at(-1) === 'file' || location.path.at(-1) === 'type' || location.path.at(-1) === 'id') return undefined
      const owner = location.value?.parent?.parent
      const activeFont = owner?.children?.find(property => property.children?.[0]?.value === 'font')?.children?.[1]?.value
      const search = /\\u[0-9a-f]{0,4}$/i.exec(document.getText(new vscode.Range(document.positionAt(location.string.start), position)))?.[0] ?? ''
      const result = await fontGlyphs(document.uri, context, typeof activeFont === 'string' ? activeFont : 'minecraft:default', undefined, search)
      if (token.isCancellationRequested) return []
      const stringStart = location.string.start
      return result.glyphs.map(glyph => {
        const escaped = unicodeEscape(glyph.char), item = new vscode.CompletionItem({ label: unicodeLabel(glyph.char), description: glyph.texture ?? uiText("ui.resourceTemplates.space") }, vscode.CompletionItemKind.Value)
        item.insertText = escaped; item.detail = 'MCRH · ' + glyph.font
        item.filterText = escaped + ' ' + unicodeLabel(glyph.char) + ' ' + (glyph.texture ?? '')
        item.documentation = glyph.source + (glyph.texture ? '\n' + glyph.texture : uiText("ui.resourceTemplates.space_77580b", glyph.advance))
        const typed = /\\u[0-9a-f]{0,4}$/i.exec(document.getText(new vscode.Range(document.positionAt(stringStart), position)))
        item.range = new vscode.Range(document.positionAt(document.offsetAt(position) - (typed?.[0].length ?? 0)), position)
        return item
      })
    }
  }, 'u'))
  for (const [id, callback] of [['mcrh.createVanillaTemplate', (uri?: vscode.Uri) => createVanillaTemplate(context, uri)], ['mcrh.applyJsonFamily', (uri?: vscode.Uri) => applyJsonFamily(context, uri)], ['mcrh.createCustomModelData', createCustomModelData], ['mcrh.createFontTemplate', createFontTemplate], ['mcrh.insertFontGlyph', (uri?: vscode.Uri) => insertFontGlyph(context, uri)]] as const) context.subscriptions.push(vscode.commands.registerCommand(id, async (uri?: vscode.Uri) => {
    try { await callback(uri) } catch (error) { void vscode.window.showErrorMessage(uiText("ui.resourceTemplates.resourceTemplateOperationNotCompleted", (error instanceof Error ? error.message : String(error)))) }
  }))
}

async function pickFontGlyph(context: vscode.ExtensionContext, target: vscode.Uri, font: string): Promise<FontGlyph | undefined> {
  const picker = vscode.window.createQuickPick<vscode.QuickPickItem & { glyph: FontGlyph }>()
  picker.title = uiText("ui.resourceTemplates.selectTheCharacterOfThePaste", font)
  picker.placeholder = uiText("ui.resourceTemplates.enterUE000UnicodeConversionCharacterOr")
  picker.matchOnDescription = true; picker.matchOnDetail = true
  let revision = 0, closed = false, timer: ReturnType<typeof setTimeout> | undefined
  const load = async (search: string): Promise<void> => {
    const ticket = ++revision; picker.busy = true
    try {
      const result = await fontGlyphs(target, context, font, undefined, search)
      if (closed || revision !== ticket) return
      picker.items = result.glyphs.map(glyph => ({ label: unicodeLabel(glyph.char) + ' ' + unicodeEscape(glyph.char), description: glyph.texture ?? uiText("ui.resourceTemplates.space_892281", glyph.advance), detail: glyph.source, glyph, alwaysShow: true }))
      picker.placeholder = result.glyphs.length ? uiText("ui.resourceTemplates.enterCodePointCharacterOrPastePath") : result.warnings[0] ?? uiText("ui.resourceTemplates.noCharacterMatchingChangeCodePointOr")
    } catch (error) { if (!closed && revision === ticket) { picker.items = []; picker.placeholder = error instanceof Error ? error.message : String(error) } }
    finally { if (!closed && revision === ticket) picker.busy = false }
  }
  return new Promise(resolve => {
    const disposables = [picker.onDidChangeValue(value => { revision++; picker.items = []; picker.busy = true; if (timer) clearTimeout(timer); timer = setTimeout(() => { void load(value) }, 180) }),
      picker.onDidAccept(() => { const selected = picker.selectedItems[0]; if (selected) { resolve(selected.glyph); picker.hide() } }),
      picker.onDidHide(() => { closed = true; revision++; if (timer) clearTimeout(timer); for (const disposable of disposables) disposable.dispose(); picker.dispose(); resolve(undefined) })]
    picker.show(); void load('')
  })
}
