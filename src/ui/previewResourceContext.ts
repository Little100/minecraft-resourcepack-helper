import { uiText } from '../i18n/messages'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { inferPackVersion } from '../core/advanced/packDiagnostics'
import type { ModelPreviewAssets } from '../core/modelPreviewAssets'
import { EditorModelPreviewAssets } from './previewModelAssets'
import { ResourceNameResolver } from '../core/resourceNames'
import { pathKey } from '../core/packScanner'
import { findPreviewClientAssets } from './previewClientAssets'
import { findPreviewLanguageAssets } from './previewLanguageAssets'

export interface ResourceSource { root: string; relative: string }
export interface PreviewResourceContext { source: ResourceSource; assets: ModelPreviewAssets; names: ResourceNameResolver; version?: string; warnings: string[] }

export function sourceOf(file: string): ResourceSource | undefined {
  let current = path.dirname(path.resolve(file))
  while (path.dirname(current) !== current) {
    if (path.basename(current) === 'assets') {
      const relative = path.relative(path.dirname(current), file).split(path.sep).join('/')
      return { root: path.dirname(current), relative }
    }
    current = path.dirname(current)
  }
  return undefined
}

export async function versionOf(roots: readonly string[], includeSetting = true): Promise<{ version?: string; warning?: string }> {
  const configured = includeSetting ? vscode.workspace.getConfiguration('mcrh').get<string>('previewMinecraftVersion', '').trim() : ''
  if (configured) {
    if (!/^\d+(?:\.\d+){1,2}$/.test(configured)) throw new Error(uiText("ui.previewResourceContext.thePreviewVersionShouldHaveAClear"))
    return { version: configured }
  }
  for (const root of roots) {
    try {
      const manifest = path.join(root, '.mcrh-vanilla.json'), stat = await fs.lstat(manifest)
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8192) {
        const value: unknown = JSON.parse(await fs.readFile(manifest, 'utf8')), version = (value as { version?: unknown } | null)?.version
        if (typeof version === 'string' && /^\d+(?:\.\d+){1,2}$/.test(version)) return { version }
      }
    } catch {}
    const matched = /^minecraft-(\d+(?:\.\d+){1,2})$/.exec(path.basename(root))
    if (matched) return { version: matched[1], warning: uiText("ui.previewResourceContext.versionTakenFromResourceDirectoryNamePlease") }
  }
  for (const root of roots) {
    try {
      const metadata = path.join(root, 'pack.mcmeta'), stat = await fs.lstat(metadata)
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024) {
        const version = inferPackVersion(JSON.parse(await fs.readFile(metadata, 'utf8')))
        if (version) return { version, warning: uiText("ui.previewResourceContext.previewVersionExtrapolatedFromTheOnlyCorresponding") }
      }
    } catch {}
  }
  const fallback = includeSetting ? vscode.workspace.getConfiguration('mcrh').get<string>('previewFallbackMinecraftVersion', '').trim() : ''
  if (fallback) {
    if (!/^\d+(?:\.\d+){1,2}$/.test(fallback)) throw new Error(uiText("ui.previewResourceContext.theBackupPreviewClientNeedsAClear"))
    return { version: fallback, warning: uiText("ui.previewResourceContext.undeterminedResourcePackVersionUsingConfiguredJava", fallback) }
  }
  return { warning: uiText("ui.previewResourceContext.unspecifiedMinecraftVersionPleaseSetMcrhPreview") }
}

export async function previewResourceContext(uri: vscode.Uri, context?: vscode.ExtensionContext): Promise<PreviewResourceContext | undefined> {
  const source = sourceOf(uri.fsPath)
  if (!source) return undefined
  const base = vscode.workspace.getConfiguration('mcrh').get<string>('previewBaseAssetsPath', '').trim()
  const detected = await versionOf([source.root, ...(base ? [base] : [])])
  const baseVersion = base ? await versionOf([base], false) : undefined
  const mismatch = baseVersion?.version && detected.version && baseVersion.version !== detected.version
  const nearby = [path.dirname(source.root), ...(vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath)]
  const cached = context && detected.version ? await findPreviewClientAssets(context, detected.version, nearby) : undefined
  const languages = context && detected.version ? await findPreviewLanguageAssets(context, detected.version) : undefined
  const roots = [...new Map([source.root, ...(base && !mismatch ? [base] : []), ...(languages ? [languages] : []), ...(cached ? [cached] : [])].map(root => [pathKey(root), root])).values()]
  const assets = new EditorModelPreviewAssets(roots)
  return { source, assets, names: new ResourceNameResolver(assets), version: detected.version, warnings: [detected.warning, mismatch ? uiText("ui.previewResourceContext.sourceVersionOfAllocatedBaseResourcesWith", baseVersion!.version, detected.version) : undefined].filter((value): value is string => Boolean(value)) }
}
