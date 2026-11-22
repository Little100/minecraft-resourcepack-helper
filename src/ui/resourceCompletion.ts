import { uiText } from '../i18n/messages'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { runtimeConfig } from '../core/config'
import { MINECRAFT_NAMESPACE, discoverNamespaces, namespaceProblem } from '../core/namespace'
import { completionContext, completionRange, contextualFields } from './jsonCompletion'
import { resourceFields, referenceFolder } from './resourceCompletionFields'

const PNG_SUFFIX = '.png'
const PACK_ROOT_PATTERN = /^(.*)\/assets\/[a-z0-9_.-]+\/(?:models|blockstates|items|atlases|font)\//

export class ResourceCompletionProvider implements vscode.CompletionItemProvider, vscode.Disposable {
  static readonly selector: vscode.DocumentSelector = [
    { language: 'json', scheme: 'file' },
    { language: 'jsonc', scheme: 'file' }
  ]

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
    const context = completionContext(document, position)
    return context?.key ? contextualFields(document, context, resourceFields(document.uri.fsPath, context.key.path)) : []
  }

  async provideReferenceCompletions(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.CompletionItem[] | undefined> {
    const context = completionContext(document, position)
    if (!context?.string) return undefined
    const folder = referenceFolder(document.uri.fsPath, context.path)
    if (!folder || context.string.typed.startsWith('#')) return undefined
    const range = completionRange(document, context.string)
    if (!range.isSingleLine || !range.contains(position)) return []
    return namespaceCompletions(document, context.string.typed, range, token, folder)
  }

  dispose(): void { /* 说明: 无托管资源 */ }
}

export function typedReference(line: string, character: number): { text: string; start: number } | undefined {
  const match = /:\s*"([^"]*)$/.exec(line.slice(0, character))
  if (!match) return undefined
  return { text: match[1], start: character - match[1].length }
}

export function packRootOf(file: string): string | undefined {
  const normalized = file.replace(/\\/g, '/')
  const match = PACK_ROOT_PATTERN.exec(normalized.toLowerCase())
  return match ? normalized.slice(0, match.index + match[1].length) : undefined
}

async function namespaceCompletions(
  document: vscode.TextDocument,
  typed: string,
  range: vscode.Range,
  token: vscode.CancellationToken,
  folder: 'models' | 'textures'
): Promise<vscode.CompletionItem[] | undefined> {
  const root = packRootOf(document.uri.fsPath)
  const colon = typed.indexOf(':')
  if (colon < 0) {
    const folders = root ? await readSubdirectories(path.join(root, 'assets')) : []
    const namespaces = discoverNamespaces([...folders, MINECRAFT_NAMESPACE, runtimeConfig().defaultNamespace])
    return namespaces.map(namespace => referenceItem(namespace, `${namespace}:`, range, vscode.CompletionItemKind.Module, uiText("core.advanced.textures.namespace")))
  }
  const namespace = typed.slice(0, colon)
  if (!root || namespaceProblem(namespace) !== undefined) return []
  const textures = await listTextures(path.join(root, 'assets', namespace, folder), token, folder === 'models' ? '.json' : PNG_SUFFIX)
  return textures.map(texture => referenceItem(`${namespace}:${texture}`, `${namespace}:${texture}`, range, vscode.CompletionItemKind.File, folder === 'models' ? uiText("ui.resourceCompletion.modelGeometry") : uiText("core.advanced.pngCodec.paste")))
}

function referenceItem(label: string, insertText: string, range: vscode.Range, kind: vscode.CompletionItemKind, detail: string): vscode.CompletionItem {
  const item = new vscode.CompletionItem(label, kind)
  item.insertText = insertText
  item.range = range
  item.detail = 'MCRH · ' + detail
  item.filterText = insertText
  item.sortText = '00mcrh' + label
  return item
}

// 读取目录条目, 目录不存在或不可读时视为空
async function readEntries(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function readSubdirectories(dir: string): Promise<string[]> {
  return (await readEntries(dir)).filter(entry => entry.isDirectory()).map(entry => entry.name)
}

async function listTextures(dir: string, token: vscode.CancellationToken, suffix = PNG_SUFFIX): Promise<string[]> {
  const found: string[] = []
  await collectTextures(dir, '', found, token, suffix)
  return found.sort()
}

async function collectTextures(dir: string, prefix: string, found: string[], token: vscode.CancellationToken, suffix = PNG_SUFFIX): Promise<void> {
  if (token.isCancellationRequested) return
  for (const entry of await readEntries(dir)) {
    if (entry.isDirectory()) {
      await collectTextures(path.join(dir, entry.name), `${prefix}${entry.name}/`, found, token, suffix)
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      found.push(`${prefix}${entry.name.slice(0, -suffix.length)}`)
    }
  }
}

function isResourceJson(file: string): boolean {
  const normalized = file.replace(/\\/g, '/').toLowerCase()
  if (/\/node_modules\//.test(normalized)) return false
  return /\/assets\/|\/models\/|\/blockstates\/|pack\.mcmeta$/.test(normalized)
}

export function register(context: vscode.ExtensionContext): vscode.Disposable {
  const provider = new ResourceCompletionProvider()
  const registration = vscode.languages.registerCompletionItemProvider(
    ResourceCompletionProvider.selector,
    {
      provideCompletionItems: async (document, position, token) => {
        if (!isResourceJson(document.uri.fsPath)) return []
        if (token.isCancellationRequested) return []
        const references = await provider.provideReferenceCompletions(document, position, token)
        return references ?? provider.provideCompletionItems(document, position)
      }
    },
    '"',
    '/',
    ':',
    '{',
    ','
  )
  context.subscriptions.push(provider)
  return registration
}

