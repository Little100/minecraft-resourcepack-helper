import { uiText } from '../../i18n/messages'
import * as vscode from 'vscode'
import { SCHEMAS } from './schema'
import { findExisting } from '../../ui/overwriteDialog'
import { resolveNamespace } from '../namespace'

// 生成 Markdown 教程, 内容完全由同一份 schema 驱动避免文档与代码不一致
export function renderOptiFineTutorial(namespace: string): string {
  const resolved = resolveNamespace(namespace).namespace
  const lines: string[] = []
  lines.push('# OptiFine 附属支持指南')
  lines.push('')
  lines.push('本页说明 MCRH 支持的 OptiFine 属性文件类型, 全部位于 `assets/minecraft/optifine/` 下')
  lines.push('')
  lines.push('## 通用约定')
  lines.push('')
  lines.push('属性文件为 ini 风格, 每行一条 `键=值`, 井号开头的行是注释')
  lines.push('')
  lines.push('- 键名**大小写敏感**, `renderPass` 与 `renderpass` 是两回事')
  lines.push('- 属性顺序不影响生效')
  lines.push('- 路径一律使用正斜杠 `/`, 即使运行在 Windows 上')
  lines.push('- `~` 等价于 `assets/minecraft/optifine`, 可直接写 `~/dial/clock.png`')
  lines.push('- 贴图可带命名空间如 `minecraft:textures/block/stone.png`')
  lines.push('- 同一个 `matchTiles` 可被多个属性文件引用, 命中后按文件名字母序处理, 首个匹配生效')
  lines.push('')
  lines.push('## 混合模式')
  lines.push('')
  lines.push('多层纹理叠加时可选的混合方式:')
  lines.push('')
  lines.push('| 值 | 效果 |')
  lines.push('| --- | --- |')
  lines.push('| `replace` | 完全替换底层, 仅简单透明 |')
  lines.push('| `alpha` | 按 alpha 混合, 最常用 |')
  lines.push('| `overlay` | 大于 0.5 提亮, 小于 0.5 压暗 |')
  lines.push('| `add` | 按 alpha 叠加 RGB |')
  lines.push('| `subtract` | 从底层减去 RGB |')
  lines.push('| `multiply` | RGB 相乘 |')
  lines.push('| `dodge` | 直接相加 RGB |')
  lines.push('| `burn` | 反色相乘 |')
  lines.push('| `screen` | 滤色, 常见于发光 |')
  lines.push('')
  lines.push('## 方块与物品的书写')
  lines.push('')
  lines.push('```bash')
  lines.push('# 方块短名与全名')
  lines.push('matchBlocks=oak_stairs')
  lines.push('matchBlocks=minecraft:oak_stairs')
  lines.push('')
  lines.push('# 带方块状态属性')
  lines.push('matchBlocks=oak_stairs:facing=east,west:half=bottom')
  lines.push('```')
  lines.push('')
  lines.push('1.13 之后数字 ID 已废弃, 只能使用名称')
  lines.push('')
  lines.push('## 数字列表')
  lines.push('')
  lines.push('支持单值, 空格分隔与范围:')
  lines.push('')
  lines.push('```bash')
  lines.push('list=1')
  lines.push('list=1 2 3')
  lines.push('list=1-3')
  lines.push('list=1-3 6 8 10-15')
  lines.push('```')
  lines.push('')
  lines.push('高度允许负数, 用于范围时需加括号:')
  lines.push('')
  lines.push('```bash')
  lines.push('heights=(-3)-(-1) 6 8 (-10)-15')
  lines.push('```')
  lines.push('')

  lines.push('## 可生成的属性文件')
  lines.push('')
  for (const schema of SCHEMAS) {
    const target = `assets/minecraft/optifine/${schema.folder}/${schema.fileName ?? `${schema.folder.split('/').pop()}.properties`}`
    lines.push(`### ${schema.label}`)
    lines.push('')
    lines.push(schema.description)
    lines.push('')
    lines.push(`路径: \`${target}\``)
    lines.push('')
    const required = schema.props.filter(spec => spec.required)
    if (required.length > 0) {
      lines.push('必填属性:')
      lines.push('')
      for (const spec of required) lines.push(`- \`${spec.name}\` ${spec.doc}`)
      lines.push('')
    }
    lines.push('```properties')
    for (const spec of schema.props) {
      lines.push(`# ${spec.doc}`)
      lines.push(`${spec.name}=${sampleFor(spec.name, spec.type, spec.values, spec.default)}`)
    }
    lines.push('```')
    lines.push('')
  }

  lines.push('## 常见问题')
  lines.push('')
  lines.push('| 现象 | 原因 |')
  lines.push('| --- | --- |')
  lines.push('| HD 贴图全部不生效 | 缺少 `optifine/texture/texture.properties` 的 size 声明 |')
  lines.push('| 属性文件看起来没读 | 文件名被隐藏扩展名写成了 `xxx.properties.txt` |')
  lines.push('| 多规则只命中一个 | `matchTiles` 相同时按文件名字母序取首个 |')
  lines.push('| CTM 四角有黑缝 | `innerSeams` 与相邻纹理不一致 |')
  lines.push('')
  lines.push(`命名空间为 \`${resolved}\`, 生成示例时会把模板中的 \`mcrh:\` 前缀替换为该值`)
  lines.push('')
  return lines.join('\n')
}

function sampleFor(name: string, type: string, values?: readonly string[], fallback?: string): string {
  if (fallback) return fallback
  if (name === 'matchTiles') return 'glass'
  if (name === 'matchBlocks') return 'minecraft:glass'
  if (values && values.length > 0) return values[0]
  switch (type) {
    case 'int': return '0'
    case 'float': return '1'
    case 'bool': return 'false'
    case 'list': return '0-3'
    case 'tile-list': return '0-3'
    default: return 'myvalue'
  }
}

const TUTORIAL_DIR = 'docs'
const TUTORIAL_FILE = 'mcrh-optifine.md'
const STATUS_HINT_MS = 4000

export interface TutorialResult {
  path: string
  created: boolean
}

export async function ensureTutorial(namespace: string, root: string): Promise<TutorialResult> {
  const docsDir = vscode.Uri.joinPath(vscode.Uri.file(root), TUTORIAL_DIR)
  const target = vscode.Uri.joinPath(docsDir, TUTORIAL_FILE)
  if ((await findExisting([target])).length > 0) return { path: target.fsPath, created: false }

  await vscode.workspace.fs.createDirectory(docsDir)
  await vscode.workspace.fs.writeFile(target, Buffer.from(renderOptiFineTutorial(namespace), 'utf8'))
  return { path: target.fsPath, created: true }
}

export async function writeTutorial(namespace: string, root: string): Promise<string> {
  const result = await ensureTutorial(namespace, root)
  if (!result.created) void vscode.window.setStatusBarMessage(uiText("optifine.existingTutorial"), STATUS_HINT_MS)
  return result.path
}
