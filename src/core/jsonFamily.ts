import { uiText } from '../i18n/messages'
import { applyEdits, parseTree, type Node, type ParseError } from 'jsonc-parser'
import { resourceId } from './customModelData'

export interface FamilySource { namespace: string; category: string; directory: string; stem: string }
export interface ReferenceChange { from: string; to: string }
export interface RetargetedJson { content: string; changes: ReferenceChange[] }

export function familySource(relative: string): FamilySource | undefined {
  const match = /^assets\/([^/]+)\/(models|blockstates|items)\/(.+)\.json$/.exec(relative)
  if (!match || !resourceId(match[1] + ':' + match[3])) return undefined
  const slash = relative.lastIndexOf('/')
  return { namespace: match[1], category: match[2], directory: relative.slice(0, slash), stem: relative.slice(slash + 1, -5) }
}

export function familyPatternProblem(pattern: string, source: string): string | undefined {
  if (pattern.length > 256 || !/^[a-z0-9_.\-*]+$/.test(pattern) || pattern.split('*').length !== 2) return uiText("core.jsonFamily.pleaseUseAMatchTheChangeE")
  if (familyVariant(pattern, source) === undefined) return uiText("core.jsonFamily.matchingRulesMustContainTheCurrentResource")
  return undefined
}

export function familyVariant(pattern: string, stem: string): string | undefined {
  const parts = pattern.split('*')
  if (parts.length !== 2 || !stem.startsWith(parts[0]) || !stem.endsWith(parts[1])) return undefined
  const end = stem.length - parts[1].length
  return end > parts[0].length ? stem.slice(parts[0].length, end) : undefined
}

export function suggestFamilyPattern(stem: string, candidates: readonly string[]): string {
  const parts = stem.split('_')
  for (let index = 1; index < parts.length; index++) {
    const pattern = '*_' + parts.slice(index).join('_')
    if (candidates.some(candidate => candidate !== stem && familyVariant(pattern, candidate) !== undefined)) return pattern
  }
  return parts.length > 1 ? '*_' + parts.slice(1).join('_') : '*'
}

function replaceReference(reference: string, source: string, target: string, from: string, to: string): string {
  if (!resourceId(reference)) return reference
  const colon = reference.indexOf(':'), namespace = colon >= 0 ? reference.slice(0, colon + 1) : '', value = reference.slice(colon + 1)
  const segments = value.split('/').map(segment => {
    if (segment === source) return target
    if (segment.startsWith(source + '_')) return target + segment.slice(source.length)
    if (segment === from) return to
    if (segment.startsWith(from + '_')) return to + segment.slice(from.length)
    return segment
  })
  return namespace + segments.join('/')
}

export function retargetFamilyJson(text: string, source: string, target: string, pattern: string): RetargetedJson {
  const problem = familyPatternProblem(pattern, source), from = familyVariant(pattern, source), to = familyVariant(pattern, target)
  if (problem || !from || !to || !resourceId(target) || target.includes('/') || target.includes(':')) throw new Error(problem ?? uiText("core.jsonFamily.targetsDonTMatchTheMatchingRules"))
  if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) throw new Error(uiText("core.jsonFamily.sourceJsonExceededMibLimit"))
  const errors: ParseError[] = [], tree = parseTree(text, errors)
  if (errors.length || tree?.type !== 'object') throw new Error(uiText("core.jsonFamily.sourceJsonIsInvalidPleaseFixThe"))
  const pending: Array<{ node: Node; reference: boolean; textureSlot?: boolean; depth: number }> = [{ node: tree, reference: false, depth: 0 }]
  const edits: Array<{ offset: number; length: number; content: string }> = [], changes = new Map<string, ReferenceChange>()
  let visited = 0
  while (pending.length) {
    const { node, reference, textureSlot, depth } = pending.pop()!
    if (++visited > 100_000 || depth > 128) throw new Error(uiText("core.jsonFamily.sourceJsonStructureExceedingUtilisationLimit"))
    if (node.type === 'property') {
      const [key, value] = node.children ?? []
      if (value) {
        const field = String(key?.value), direct = value.type === 'string' && (reference || textureSlot && field === 'sprite' || ['parent', 'model', 'texture'].includes(field))
        const textures = field === 'textures' && (value.type === 'object' || value.type === 'array')
        pending.push({ node: value, reference: direct || textures, textureSlot: reference && value.type === 'object', depth: depth + 1 })
      }
    } else if (node.type === 'string' && reference) {
      const before = String(node.value), after = replaceReference(before, source, target, from, to)
      if (before !== after) { edits.push({ offset: node.offset, length: node.length, content: JSON.stringify(after) }); changes.set(before, { from: before, to: after }) }
    } else for (const child of node.children ?? []) pending.push({ node: child, reference, textureSlot, depth: depth + 1 })
  }
  return { content: applyEdits(text, edits), changes: [...changes.values()] }
}
