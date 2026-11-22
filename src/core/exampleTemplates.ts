import * as path from 'node:path'
import { uiText } from '../i18n/messages'
import * as vscode from 'vscode'
import { CYAN, flatPng, MAGENTA, STRIP_20 } from './exampleAssets'
import { generateOptiFineExample } from './optifine/generator'
import { MINECRAFT_NAMESPACE, namespaceProblem } from './namespace'

export interface ExampleFile {
  relativePath: string
  content: string | Uint8Array
}

export interface TemplateBundle {
  id: string
  label: string
  description: string
  namespace: string
  files: ExampleFile[]
}

export interface PlannedFile {
  target: vscode.Uri
  bytes: Uint8Array
}

interface TemplateSpec {
  id: string
  build: (namespace: string) => ExampleFile[]
}

const packMcmeta = JSON.stringify({
  pack: { description: 'MCRH 示例材质包', pack_format: 44, supported_formats: [34, 44] }
}, null, 2)

const blockstate = (model: string) => JSON.stringify({ variants: { '': { model } } }, null, 2)

const cubeModel = (texture: string) => JSON.stringify({
  parent: 'minecraft:block/cube_all',
  textures: { all: texture }
}, null, 2)

const itemModel = (texture: string) => JSON.stringify({
  parent: 'minecraft:item/generated',
  textures: { layer0: texture }
}, null, 2)

function optifineFiles(schemaId: string): ExampleFile[] {
  const generated = generateOptiFineExample(schemaId)
  return [{ relativePath: generated.relativePath, content: generated.content }]
}

const SPECS: TemplateSpec[] = [
  {
    id: 'pack-root',
    build: () => [{ relativePath: 'pack.mcmeta', content: packMcmeta }]
  },
  {
    id: 'block-texture',
    build: namespace => [
      { relativePath: `assets/${namespace}/textures/block/example_block.png`, content: MAGENTA },
      { relativePath: `assets/${namespace}/models/block/example_block.json`, content: cubeModel('mcrh:block/example_block') },
      { relativePath: `assets/${namespace}/blockstates/example_block.json`, content: blockstate('mcrh:block/example_block') }
    ]
  },
  {
    id: 'item-texture',
    build: namespace => [
      { relativePath: `assets/${namespace}/textures/item/example_item.png`, content: CYAN },
      { relativePath: `assets/${namespace}/models/item/example_item.json`, content: itemModel('mcrh:item/example_item') }
    ]
  },
  {
    id: 'animation-texture',
    build: namespace => [
      { relativePath: `assets/${namespace}/textures/block/example_animated.png`, content: STRIP_20 },
      { relativePath: `assets/${namespace}/textures/block/example_animated.png.mcmeta`, content: JSON.stringify({ animation: { frametime: 1 } }, null, 2) }
    ]
  },
  {
    id: 'sounds',
    build: namespace => [{
      relativePath: `assets/${namespace}/sounds.json`,
      content: JSON.stringify({
        'mcrh.custom.idle': {
          replace: false,
          subtitle: 'MCRH 示例音效',
          sounds: [{ name: 'mcrh:custom/idle', stream: false }]
        }
      }, null, 2)
    }]
  },
  {
    id: 'lang',
    build: namespace => [{
      relativePath: `assets/${namespace}/lang/en_us.json`,
      content: JSON.stringify({
        'block.mcrh.example_block': 'MCRH Example Block',
        'item.mcrh.example_item': 'MCRH Example Item'
      }, null, 2)
    }]
  },
  {
    id: 'named-item-cit',
    build: () => [
      {
        relativePath: `assets/${MINECRAFT_NAMESPACE}/optifine/cit/named_sword.properties`,
        content: [
          '# 铁砧重命名为示例名后, 铁剑替换为右侧贴图',
          'type=item',
          'items=iron_sword',
          `nbt.display.name=示例名`,
          'texture=named_sword',
          ''
        ].join('\n')
      },
      { relativePath: `assets/${MINECRAFT_NAMESPACE}/optifine/cit/named_sword.png`, content: flatPng(16, 16, [240, 170, 60, 255]) }
    ]
  },
  {
    id: 'item-model-overrides',
    build: namespace => [
      {
        relativePath: `assets/${namespace}/models/item/example_item.json`,
        content: JSON.stringify({
          parent: 'minecraft:item/generated',
          textures: { layer0: 'mcrh:item/example_item' },
          overrides: [
            { predicate: { custom_model_data: 1 }, model: 'mcrh:item/example_item_alt' }
          ]
        }, null, 2)
      },
      {
        relativePath: `assets/${namespace}/models/item/example_item_alt.json`,
        content: JSON.stringify({
          parent: 'minecraft:item/generated',
          textures: { layer0: 'mcrh:item/example_item_alt' }
        }, null, 2)
      },
      { relativePath: `assets/${namespace}/textures/item/example_item.png`, content: CYAN },
      { relativePath: `assets/${namespace}/textures/item/example_item_alt.png`, content: MAGENTA }
    ]
  },
  {
    id: 'optifine-ctm',
    build: namespace => [
      ...optifineFiles('ctm'),
      { relativePath: `assets/${namespace}/optifine/ctm/glass/0.png`, content: flatPng(16, 16, [200, 230, 240, 190]) },
      { relativePath: `assets/${namespace}/optifine/ctm/glass/1.png`, content: flatPng(16, 16, [190, 220, 235, 190]) }
    ]
  },
  {
    id: 'optifine-cit',
    build: () => [
      ...optifineFiles('cit-single'),
      ...optifineFiles('cit-global')
    ]
  },
  {
    id: 'optifine-emissive',
    build: namespace => [
      ...optifineFiles('emissive'),
      { relativePath: `assets/${namespace}/optifine/emissive/glowstone_e.png`, content: flatPng(16, 16, [255, 240, 180, 255]) }
    ]
  },
  {
    id: 'optifine-anim',
    build: namespace => [
      ...optifineFiles('anim'),
      { relativePath: `assets/${namespace}/optifine/anim/water/water_0.png`, content: flatPng(16, 16, [40, 90, 200, 255]) },
      { relativePath: `assets/${namespace}/optifine/anim/water/water_1.png`, content: flatPng(16, 16, [50, 110, 220, 255]) }
    ]
  },
  {
    id: 'optifine-random-entities',
    build: namespace => [
      ...optifineFiles('random-entities'),
      { relativePath: `assets/${namespace}/optifine/random_entities/mobs/creeper/creeper1.png`, content: MAGENTA },
      { relativePath: `assets/${namespace}/optifine/random_entities/mobs/creeper/creeper2.png`, content: CYAN }
    ]
  },
  {
    id: 'optifine-hd',
    build: namespace => [
      ...optifineFiles('texture-size'),
      { relativePath: `assets/${namespace}/textures/block/example_hd.png`, content: flatPng(32, 32, [120, 220, 140, 255]) }
    ]
  }
]

// 模板统一以原版命名空间为基准生成, 写入时再换算为用户选择的命名空间
export function listTemplates(): TemplateBundle[] {
  return SPECS.map(spec => ({
    id: spec.id,
    label: uiText('exampleTemplate.' + spec.id + '.label'),
    description: uiText('exampleTemplate.' + spec.id + '.description'),
    namespace: MINECRAFT_NAMESPACE,
    files: spec.build(MINECRAFT_NAMESPACE)
  }))
}

export function planTemplate(bundle: TemplateBundle, root: string, namespace: string): PlannedFile[] {
  const problem = namespaceProblem(namespace)
  if (problem !== undefined) throw new Error(uiText('exampleTemplate.invalidNamespace', problem))
  return bundle.files.map(file => ({
    target: vscode.Uri.file(path.join(root, resolveTemplatePath(file.relativePath, namespace))),
    bytes: typeof file.content === 'string'
      ? Buffer.from(substituteNamespace(file.content, namespace), 'utf8')
      : file.content
  }))
}

export function selectTargets(plan: PlannedFile[], existing: vscode.Uri[], choice: 'overwrite' | 'skip'): Set<string> | 'all' {
  if (choice === 'overwrite') return 'all'
  const taken = new Set(existing.map(uri => uri.fsPath))
  return new Set(plan.map(file => file.target.fsPath).filter(fsPath => !taken.has(fsPath)))
}

export async function writeTemplate(plan: PlannedFile[], targets: Set<string> | 'all'): Promise<string[]> {
  const written: string[] = []
  for (const file of plan) {
    const fsPath = file.target.fsPath
    if (targets !== 'all' && !targets.has(fsPath)) continue
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(fsPath)))
    await vscode.workspace.fs.writeFile(file.target, file.bytes)
    written.push(fsPath)
  }
  return written
}

function substituteNamespace(content: string, namespace: string): string {
  return content.replaceAll('mcrh:', `${namespace}:`).replaceAll('mcrh.', `${namespace}.`)
}

// OptiFine 属性与贴图固定放在原版命名空间的 optifine 目录, 与教程和结构补齐的约定一致, 不随自有命名空间迁移
const OPTIFINE_DIR = `assets/${MINECRAFT_NAMESPACE}/optifine/`

// assets/<基准命名空间> 段与 mcrh 占位都替换为目标命名空间, 原版命名空间与 OptiFine 目录保持不动
function resolveTemplatePath(relativePath: string, namespace: string): string {
  const withPlaceholders = relativePath.replaceAll('mcrh:', `${namespace}:`)
  if (namespace === MINECRAFT_NAMESPACE || withPlaceholders.startsWith(OPTIFINE_DIR)) return withPlaceholders
  return withPlaceholders.replace(/^assets\/[^/]+\//, `assets/${namespace}/`)
}

