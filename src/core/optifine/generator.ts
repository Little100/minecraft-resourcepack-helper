import { uiText } from '../../i18n/messages'
import { SCHEMAS, type FileSchema } from './schema'

export interface GeneratedFile {
  relativePath: string
  content: string
}

function renderSchema(schema: FileSchema, options?: { minimal?: boolean }): string {
  const header = [
    `# ${schema.label} 属性文件`,
    `# ${schema.description}`,
    '# 路径约定: 所有贴图路径相对 assets/minecraft, ~ 等价于 assets/minecraft/optifine',
    '# 键名大小写敏感, 顺序不影响生效',
    ''
  ].join('\n')

  const required = schema.props.filter(spec => spec.required)
  const optional = schema.props.filter(spec => !spec.required)
  const chosen = options?.minimal ? required : [...required, ...optional]

  const body = chosen.map(spec => {
    const lines: string[] = []
    lines.push(`# ${spec.doc}`)
    lines.push(`${spec.name}=${sampleValue(spec)}`)
    lines.push('')
    return lines.join('\n')
  }).join('')

  return `${header}${body}`.replace(/\n{3,}$/, '\n')
}

function sampleValue(schema: { name: string; type: string; values?: readonly string[]; default?: string }): string {
  if (schema.default) return schema.default
  if (schema.name === 'matchTiles') return 'glass'
  if (schema.name === 'matchBlocks') return 'minecraft:glass'
  if (schema.values && schema.values.length > 0) return schema.values[0]
  switch (schema.type) {
    case 'int': return '0'
    case 'float': return '1'
    case 'bool': return 'false'
    case 'list': return '0-3'
    case 'tile-list': return '0-3'
    default: return 'myvalue'
  }
}

export function generateOptiFineExample(schemaId: string, options?: { minimal?: boolean }): GeneratedFile {
  const schema = SCHEMAS.find(candidate => candidate.id === schemaId)
  if (!schema) throw new Error(uiText('optifine.unsupportedSchema', schemaId))
  const fileName = schema.fileName ?? `${lastSegment(schema.folder)}.properties`
  return { relativePath: `assets/minecraft/optifine/${schema.folder}/${fileName}`, content: renderSchema(schema, options) }
}

function lastSegment(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? 'config'
}

