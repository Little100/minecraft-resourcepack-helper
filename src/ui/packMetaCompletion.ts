import { uiText } from '../i18n/messages'
import * as vscode from 'vscode'
import { findNodeAtLocation, getLocation } from 'jsonc-parser'
import { loadTable, type PackFormatTable } from '../core/packFormatTable'
import type { ResourceSnippet } from '../core/advanced/resourceSyntax'
import { completionContext, completionRange, contextualFields } from './jsonCompletion'

export class PackMetaCompletionProvider implements vscode.CompletionItemProvider, vscode.Disposable {
  static readonly selector: vscode.DocumentSelector = [
    { language: 'json', scheme: 'file', pattern: '**/pack.mcmeta' },
    { language: 'jsonc', scheme: 'file', pattern: '**/pack.mcmeta' }
  ]

  constructor(private readonly table: PackFormatTable | vscode.ExtensionContext) {}

  private currentTable(): PackFormatTable {
    return 'extensionPath' in this.table ? loadTable(this.table) : this.table
  }

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
    if (document.uri.fsPath.split(/[\\/]/).pop()?.toLowerCase() !== 'pack.mcmeta') return []
    const context = completionContext(document, position)
    if (!context) return []
    if (context.key) {
      const scope = context.key.path.join('.')
      const fields = scope === '' ? rootFields(this.currentTable()) : Object.hasOwn(PACK_FIELDS, scope) ? PACK_FIELDS[scope] : []
      const filterEntry = context.key.path.length === 3 && context.key.path[0] === 'filter' && context.key.path[1] === 'block' && typeof context.key.path[2] === 'number'
      const overlayEntry = context.key.path.length === 3 && context.key.path[0] === 'overlays' && context.key.path[1] === 'entries' && typeof context.key.path[2] === 'number'
      return contextualFields(document, context, filterEntry ? FILTER_FIELDS : overlayEntry ? OVERLAY_FIELDS : fields)
    }
    const field = context.path[1]
    if (context.path[0] !== 'pack' || !['min_format', 'max_format', 'pack_format', 'supported_formats'].includes(String(field))) return []
    if (context.path.length > 3 || (context.path.length === 3 && typeof context.path[2] !== 'number')) return []
    if (context.value && !['array', 'number'].includes(context.value.type)) return []
    const value = context.root ? findNodeAtLocation(context.root, ['pack', field]) : undefined
    let span = value ? { start: value.offset, end: value.offset + value.length } : { start: context.offset, end: context.offset }
    let range = completionRange(document, span)
    let component: number | undefined
    if (!range.isSingleLine) {
      component = typeof context.path[2] === 'number' ? context.path[2] : undefined
      if (component === undefined || component > 1) return []
      span = context.value?.type === 'number' ? { start: context.value.offset, end: context.value.offset + context.value.length } : { start: context.offset, end: context.offset }
      range = completionRange(document, span)
    }
    if (!range.isSingleLine || !range.contains(position)) return []
    const exact = field === 'min_format' || field === 'max_format'
    return this.currentTable().versions.slice(0, 80).map((entry, index) => {
      const item = new vscode.CompletionItem(entry.id, vscode.CompletionItemKind.Value)
      const format = exact ? `[${entry.rpk}, ${entry.rpkMinor}]` : String(entry.rpk)
      item.detail = uiText("ui.packMetaCompletion.mcrhAccurateFormatOfResourcePacksT", entry.rpk, entry.rpkMinor)
      item.insertText = component !== undefined ? String(exact && component === 1 ? entry.rpkMinor : entry.rpk) : field === 'supported_formats' && value?.type === 'array' ? `[${entry.rpk}, ${entry.rpk}]` : format
      item.filterText = `${entry.id} ${item.insertText}`
      item.range = range
      item.sortText = '00mcrh' + String(index).padStart(4, '0')
      return item
    })
  }

  dispose(): void {}
}

const field = (name: string, detail: string, value: string): ResourceSnippet => ({ name, detail, snippet: JSON.stringify(name) + ': ' + value })
const FORMAT_FIELDS = [
  field('pack_format', uiText("ui.packMetaCompletion.integerOfTheOldVersionOfThe"), '${1:44}'),
  field('min_format', uiText("ui.packMetaCompletion.newMinimumFormatKeepMainSubFormat"), '[${1:65}, ${2:0}]'),
  field('max_format', uiText("ui.packMetaCompletion.newMaximumFormatKeepMainFormat"), '[${1:65}, ${2:0}]'),
  field('description', uiText("ui.packMetaCompletion.descriptionInResourcePackList"), JSON.stringify('${1:' + uiText('template.defaultPackName') + '}')),
  field('supported_formats', uiText("ui.packMetaCompletion.oldFormatCompatibilityRange"), '[${1:34}, ${2:99}]')
]
const FILTER_FIELDS = [field('namespace', uiText("ui.packMetaCompletion.expressionMatchingTheResourceNamespace"), '"${1:minecraft}"'), field('path', uiText("ui.packMetaCompletion.expressionMatchingResourcePath"), '"${1:.*}"')]
const OVERLAY_FIELDS = [field('directory', uiText("ui.packMetaCompletion.overwriteDirectoryRelativeToBoxRoot"), '"${1:overlay}"'), field('formats', uiText("ui.packMetaCompletion.overwriteTheOldFormatRangeForDirectories"), '[${1:34}, ${2:99}]'), ...FORMAT_FIELDS.filter(value => ['min_format', 'max_format'].includes(value.name))]
const PACK_FIELDS: Record<string, ResourceSnippet[]> = {
  pack: FORMAT_FIELDS,
  'pack.supported_formats': [field('min_inclusive', uiText("ui.packMetaCompletion.lowerCompatibilityRange"), '${1:34}'), field('max_inclusive', uiText("ui.packMetaCompletion.compatibilityCeiling"), '${1:99}')],
  filter: [field('block', uiText("ui.packMetaCompletion.resourcesExcludingLowerPriority"), '[\n\t{"namespace": "${1:minecraft}", "path": "${2:.*}"}\n]')],
  overlays: [field('entries', uiText("ui.packMetaCompletion.overridedDirectoriesLoadedByFormatRange"), '[\n\t{"formats": [${1:34}, ${2:99}], "directory": "${3:overlay}"}\n]')]
}

function rootFields(table: PackFormatTable): ResourceSnippet[] {
  const latest = table.versions.find(entry => entry.stable && entry.type === 'release') ?? table.versions[0]
  const bounds = latest && latest.rpk >= 65
    ? `"min_format": [${latest.rpk}, ${latest.rpkMinor}],\n\t"max_format": [${latest.rpk}, ${latest.rpkMinor}],`
    : `"pack_format": ${latest?.rpk ?? 44},`
  return [
    field('pack', uiText("ui.packMetaCompletion.packageMetadataObjects"), '{\n\t' + bounds + '\n\t"description": ' + JSON.stringify('${1:' + uiText('template.defaultPackName') + '}') + '\n}'),
    field('filter', uiText("ui.packMetaCompletion.excludesLowerPriorityResources"), '{\n\t"block": [{"namespace": "${1:minecraft}", "path": "${2:.*}"}]\n}'),
    field('overlays', uiText("ui.packMetaCompletion.resourceOverridesDirectoryByVersion"), '{\n\t"entries": []\n}')
  ]
}

export function register(context: vscode.ExtensionContext): vscode.Disposable {
  const selector = PackMetaCompletionProvider.selector
  const descriptions = new Set(["pack","pack.description","pack.pack_format","pack.min_format","pack.max_format","pack.supported_formats","filter","overlays"])
  return vscode.Disposable.from(
    vscode.languages.registerCompletionItemProvider(selector, new PackMetaCompletionProvider(context), '"', ':', '{', ','),
    vscode.languages.registerHoverProvider(selector, {
      provideHover(document, position) {
        const location = getLocation(document.getText(), document.offsetAt(position))
        const key = location.path.join('.')
        if (location.isAtPropertyKey && descriptions.has(key)) return new vscode.Hover(uiText('schema.' + key))
      }
    })
  )
}

// 保留旧调用入口，数组替换范围始终包含完整值
export function formatBoundRange(line: string, character: number): { start: number; end: number } | undefined {
  const keys = [...line.matchAll(/"(min_format|max_format)"\s*:\s*/g)]
  const key = keys.reverse().find(match => match.index! + match[0].length <= character)
  if (!key) return undefined
  const start = key.index! + key[0].length
  const value = /^(?:\[[\d.,\s]*\]?|[\d.]+)/.exec(line.slice(start))?.[0] ?? ''
  const end = start + value.trimEnd().length
  if (character > end && line.slice(end, character).trim() !== '') return undefined
  return { start, end }
}
