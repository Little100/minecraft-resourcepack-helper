import { uiText } from '../i18n/messages'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { loadTable } from './packFormatTable'
import { createPackMetadata, metadataSchemaForFormat } from './advanced/versionCapabilities'
import { runtimeConfig } from './config'
import { MINECRAFT_NAMESPACE } from './namespace'
import { ASSET_FOLDERS } from '../ui/resourceDocs'

export interface StructureSpec {
  id: string
  label: string
  relative: string
  kind: 'dir' | 'file'
  hint: string
}

// 示例按所选命名空间建目录，OptiFine 固定放在 minecraft 下
export function buildStructureSpecs(namespace: string): StructureSpec[] {
  return [
    { id: 'pack-meta', label: 'pack.mcmeta', relative: 'pack.mcmeta', kind: 'file', hint: uiText("core.structures.materialPackageIdentificationFileDecideWhetherThe") },
    { id: 'textures', label: uiText("core.structures.listOfSquaresAndObjects"), relative: `assets/${namespace}/textures`, kind: 'dir', hint: uiText("core.structures.theRootDirectoryOfAllStickersBlock") },
    { id: 'models', label: uiText("core.structures.modelDirectory"), relative: `assets/${namespace}/models`, kind: 'dir', hint: uiText("core.structures.modelJsonDecidesHowToPostThe") },
    { id: 'blockstates', label: uiText("core.structures.blockStatusDirectory"), relative: `assets/${namespace}/blockstates`, kind: 'dir', hint: uiText("core.structures.blockstateModelMapping") },
    { id: 'lang', label: uiText("core.structures.languageFileCatalogue"), relative: `assets/${namespace}/lang`, kind: 'dir', hint: uiText("core.structures.zhCnJsonEtcLanguageFileDefinition") },
    { id: 'optifine', label: uiText("core.structures.optifineAuxiliaryDirectory"), relative: `assets/${MINECRAFT_NAMESPACE}/optifine`, kind: 'dir', hint: uiText("core.structures.ctmCitEmmissionEtcRootDirectoryOf") }
  ]
}

export function structureSpecs(): StructureSpec[] {
  return buildStructureSpecs(runtimeConfig().defaultNamespace)
}

export function findSpec(id: string): StructureSpec | undefined {
  return structureSpecs().find(spec => spec.id === id)
}

export interface CreateResult {
  created: string[]
  skipped: string[]
  root: string
}

// 只补缺少的目录和文件，不覆盖现有内容
export async function createStructure(root: string, spec: StructureSpec, context: vscode.ExtensionContext): Promise<CreateResult> {
  const target = path.join(root, spec.relative)
  const created: string[] = []
  const skipped: string[] = []

  if (spec.kind === 'dir') {
    const existed = fs.existsSync(target)
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(target))
    if (existed) skipped.push(target)
    else created.push(target)
    return { created, skipped, root }
  }

  if (fs.existsSync(target)) {
    skipped.push(target)
    return { created, skipped, root }
  }
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target)))
  await vscode.workspace.fs.writeFile(vscode.Uri.file(target), Buffer.from(fileContent(spec.relative, context), 'utf8'))
  created.push(target)
  return { created, skipped, root }
}

function fileContent(relative: string, context: vscode.ExtensionContext): string {
  const name = path.basename(relative).toLowerCase()
  if (name === 'pack.mcmeta') {
    const entries = loadTable(context).versions
    const latest = entries.find(entry => entry.stable && entry.type === 'release') ?? entries[0]
    return packMcmeta(latest?.rpk ?? latestFormat(context), latest?.rpkMinor ?? 0)
  }
  if (name.endsWith('.json')) return '{}\n'
  return ''
}

export function latestFormat(context: vscode.ExtensionContext): number {
  const table = loadTable(context)
  const stable = table.versions.filter(entry => entry.stable && entry.type === 'release')
  const first = stable[0] ?? table.versions[0]
  // 找不到格式记录时沿用示例模板的默认值
  return first?.rpk ?? 44
}

export interface ScaffoldResult {
  created: string[]
  root: string
}

export async function scaffoldPack(root: string, context: vscode.ExtensionContext): Promise<ScaffoldResult> {
  const created: string[] = []
  const namespace = runtimeConfig().defaultNamespace
  for (const spec of buildStructureSpecs(namespace)) {
    const result = await createStructure(root, spec, context)
    created.push(...result.created)
  }

  for (const folder of ASSET_FOLDERS) {
    if (!folder.path.includes('<namespace>')) continue
    const relative = folder.path.replace('<namespace>', namespace)
    if (!/textures\/(block|item|entity|gui|particle|environment|effect|colormap|misc|font|models|painting)$|models\/(block|item)$|blockstates$/.test(relative)) continue
    const target = path.join(root, relative)
    if (fs.existsSync(target)) continue
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(target))
    created.push(target)
  }

  return { created, root }
}

export function packMcmeta(format: number, minor = 0): string {
  const target = { major: format, minor }
  return JSON.stringify(createPackMetadata(target, metadataSchemaForFormat('resource', target), `MCRH ${runtimeConfig().defaultNamespace} 材质包`), null, 2) + '\n'
}
