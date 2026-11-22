import { uiText } from '../../i18n/messages'
import type { PropSpec, PropType } from './schema'
import { SCHEMAS } from './schema'

export interface ParsedProp {
  name: string
  value: string
  line: number
}

export interface ParseResult {
  props: ParsedProp[]
  comments: Array<{ text: string; line: number }>
  errors: Diagnostic[]
}

export interface Diagnostic {
  line: number
  message: string
  severity: 'error' | 'warning'
  // 有建议时可自动修复
  fix?: { replacement: string }
}

export function parseProperties(text: string): ParseResult {
  const props: ParsedProp[] = []
  const comments: Array<{ text: string; line: number }> = []
  const errors: Diagnostic[] = []
  const seen = new Map<string, ParsedProp>()
  const lines = text.split(/\r?\n/)

  lines.forEach((raw, index) => {
    const line = index + 1
    const trimmed = raw.trim()
    if (trimmed.length === 0) return
    if (trimmed.startsWith('#') || trimmed.startsWith('!')) {
      comments.push({ text: trimmed.slice(1).trim(), line })
      return
    }
    const eq = trimmed.indexOf('=')
    if (eq < 0) {
      errors.push({ line, message: uiText("core.optifine.properties.missingEqualSignFormatShouldBeKey"), severity: 'error' })
      return
    }
    const name = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (name.length === 0) {
      errors.push({ line, message: uiText("core.optifine.properties.keynameIsEmpty"), severity: 'error' })
      return
    }
    if (value.length === 0) {
      errors.push({ line, message: uiText("core.optifine.properties.propertiesTheValueIsEmpty", name), severity: 'error', fix: { replacement: `${name}=` } })
      return
    }
    const previous = seen.get(name)
    if (previous) {
      errors.push({
        line,
        message: uiText("core.optifine.properties.propertiesRepeatDefinitionFirstAppearingInThe", name, previous.line),
        severity: 'warning'
      })
    }
    const parsed: ParsedProp = { name, value, line }
    seen.set(name, parsed)
    props.push(parsed)
  })

  return { props, comments, errors }
}

export function schemaForPath(relativePath: string) {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase()
  const fileName = normalized.split('/').pop() ?? ''
  if (fileName === 'cit_global.properties') return SCHEMAS.find(s => s.id === 'cit-global')
  if (fileName === 'ctm_global.properties') return SCHEMAS.find(s => s.id === 'ctm-global')
  if (fileName === 'block.properties') return SCHEMAS.find(s => s.id === 'block')
  if (fileName === 'bettergrass.properties') return SCHEMAS.find(s => s.id === 'bettergrass')
  if (fileName === 'color.properties') return SCHEMAS.find(s => s.id === 'color')
  if (fileName === 'texture.properties') return SCHEMAS.find(s => s.id === 'texture-size')
  if (fileName === 'dynamiclights.properties') return SCHEMAS.find(s => s.id === 'dynamic-lights')
  if (fileName.includes('.animation.txt')) return SCHEMAS.find(s => s.id === 'cem-animation')
  if (/\.animation\.json$/.test(fileName)) return SCHEMAS.find(s => s.id === 'cem-animation')
  if (normalized.includes('/ctm/')) return SCHEMAS.find(s => s.id === 'ctm')
  if (normalized.includes('/cit/')) return SCHEMAS.find(s => s.id === 'cit-single')
  if (normalized.includes('/emissive/')) return SCHEMAS.find(s => s.id === 'emissive')
  if (normalized.includes('/anim/')) return SCHEMAS.find(s => s.id === 'anim')
  if (normalized.includes('/cem/anim/')) return SCHEMAS.find(s => s.id === 'cem-animation')
  if (normalized.includes('/random_entities/')) return SCHEMAS.find(s => s.id === 'random-entities')
  if (normalized.includes('/cem/')) return SCHEMAS.find(s => s.id === 'cem-model')
  if (normalized.includes('/natural')) return SCHEMAS.find(s => s.id === 'natural-textures')
  return undefined
}

// 路径不能判断类型时，看文件里的字段
function schemaForContent(text: string) {
  const keys = new Set(parseProperties(text).props.map(prop => prop.name))
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('!')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    keys.add(trimmed.slice(0, eq).trim())
  }
  if (keys.has('method') && (keys.has('tiles') || keys.has('matchTiles'))) return SCHEMAS.find(s => s.id === 'ctm')
  if (keys.has('items') || keys.has('enchantmentIds') || keys.has('useGlint')) return SCHEMAS.find(s => s.id === 'cit-single')
  if (keys.has('suffix.emissive') || keys.has('texture.emissive')) return SCHEMAS.find(s => s.id === 'emissive')
  if (keys.has('from') && keys.has('to') && keys.has('duration')) return SCHEMAS.find(s => s.id === 'anim')
  if (keys.has('textures') && keys.has('weights')) return SCHEMAS.find(s => s.id === 'random-entities')
  return undefined
}

// 按路径或内容识别规则
export function resolveSchema(relativePath: string, text: string) {
  return schemaForPath(relativePath) ?? schemaForContent(text)
}

function matchesEnum(spec: PropSpec, value: string): boolean {
  if (!spec.values) return true
  if (spec.type === 'list') return value.split(/\s+/).length === 1 ? spec.values.includes(value) : true
  return spec.values.includes(value)
}

function checkType(spec: PropSpec, value: string): string | undefined {
  switch (spec.type) {
    case 'int':
      if (!/^-?\d+$/.test(value)) return uiText("core.optifine.properties.propertiesIntegerNumberRequiredCurrentlyAs", spec.name, value)
      return undefined
    case 'float':
      if (!Number.isFinite(Number(value))) return uiText("core.optifine.properties.propertiesNumberRequiredCurrentlyAs", spec.name, value)
      return undefined
    case 'bool':
      if (!/^(true|false)$/i.test(value)) return uiText("core.optifine.properties.propertiesOnlyTrueOrFalseCurrentlyAs", spec.name, value)
      return undefined
    case 'enum':
      if (matchesEnum(spec, value)) return undefined
      return uiText("core.optifine.properties.propertiesValueOfNotToTheExtent", spec.name, value, (spec.values ?? []).join(', '))
    default:
      return undefined
  }
}

export function validate(relativePath: string, text: string): Diagnostic[] {
  const parsed = parseProperties(text)
  const schema = schemaForPath(relativePath) ?? schemaForContent(text)
  const diagnostics = [...parsed.errors]
  if (!schema) return diagnostics

  const known = new Map<string, PropSpec>()
  for (const spec of schema.props) known.set(spec.name, spec)

  for (const prop of parsed.props) {
    const spec = known.get(prop.name)
    if (!spec) {
      const wildcard = schema.props.find(candidate => candidate.name.endsWith('.*') && prop.name.startsWith(candidate.name.slice(0, -1)))
      if (wildcard) {
        const typeError = checkType(wildcard, prop.value)
        if (typeError) diagnostics.push({ line: prop.line, message: typeError, severity: 'error' })
        continue
      }
      diagnostics.push({ line: prop.line, message: uiText("core.optifine.properties.unknownProperties", prop.name), severity: 'warning' })
      continue
    }
    const typeError = checkType(spec, prop.value)
    if (typeError) diagnostics.push({ line: prop.line, message: typeError, severity: 'error' })
  }

  for (const spec of schema.props) {
    if (!spec.required) continue
    const present = parsed.props.some(prop => prop.name === spec.name)
    if (!present) diagnostics.push({ line: 1, message: uiText("core.optifine.properties.missingRequiredProperties", spec.name), severity: 'error' })
  }

  return diagnostics
}

export interface CompletionItem {
  name: string
  doc: string
  type: PropType
  required: boolean
  values?: readonly string[]
  default?: string
}

export function completionsFor(relativePath: string, existing: string[], text?: string): CompletionItem[] {
  const schema = schemaForPath(relativePath) ?? (text ? schemaForContent(text) : undefined)
  if (!schema) return []
  const taken = new Set(existing)
  return schema.props
    .filter(spec => !taken.has(spec.name))
    .map(spec => ({
      name: spec.name,
      doc: spec.doc,
      type: spec.type,
      required: spec.required,
      values: spec.values,
      default: spec.default
    }))
}
