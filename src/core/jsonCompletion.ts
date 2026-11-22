import { createScanner, findNodeAtLocation, getLocation, parseTree, SyntaxKind, type Node, type JSONPath } from 'jsonc-parser'

export interface JsonSpan { start: number; end: number }
interface Token extends JsonSpan { kind: SyntaxKind; value: string; closed: boolean }
export interface JsonKeyContext {
  path: JSONPath
  offset: number
  object?: Node
  existing: string[]
  typed: string
  span: JsonSpan
  quoted: boolean
  closed: boolean
  hasColon: boolean
  leadingComma: boolean
  trailingComma: boolean
}
export interface JsonCompletionContext {
  text: string
  offset: number
  path: JSONPath
  root?: Node
  key?: JsonKeyContext
  string?: JsonSpan & { typed: string; value: string }
  value?: Node
}

// 容错解析整篇文档，注释与字符串值不进入字段补全
export function jsonCompletionContext(text: string, offset: number): JsonCompletionContext | undefined {
  if (text.length > 2 * 1024 * 1024 || offset < 0 || offset > text.length) return undefined
  const location = getLocation(text, offset)
  const root = parseTree(text, [], { allowTrailingComma: true, allowEmptyContent: true })
  const scanner = createScanner(text)
  const tokens: Token[] = []
  for (let kind = scanner.scan(); kind !== SyntaxKind.EOF; kind = scanner.scan()) {
    const start = scanner.getTokenOffset(), end = start + scanner.getTokenLength()
    if (offset >= start && (kind === SyntaxKind.LineCommentTrivia && offset <= end || kind === SyntaxKind.BlockCommentTrivia && (offset < end || offset === end && scanner.getTokenError() !== 0))) return undefined
    if (kind === SyntaxKind.Trivia || kind === SyntaxKind.LineBreakTrivia || kind === SyntaxKind.LineCommentTrivia || kind === SyntaxKind.BlockCommentTrivia) continue
    tokens.push({ kind, start, end, value: scanner.getTokenValue(), closed: kind === SyntaxKind.StringLiteral && scanner.getTokenError() === 0 })
  }
  const context: JsonCompletionContext = { text, offset, path: location.path, root, value: root ? findNodeAtLocation(root, location.path) : undefined }
  let token = tokens.find(entry => entry.start <= offset && offset <= entry.end && [SyntaxKind.StringLiteral, SyntaxKind.Unknown].includes(entry.kind))
  if (!token && location.isAtPropertyKey && location.previousNode?.type === 'property') {
    const previous = tokens.find(entry => entry.start === location.previousNode!.offset)
    if (previous && text.slice(previous.end, offset).trim() === '') token = previous
  }
  if (location.isAtPropertyKey) {
    const objectPath = location.path.slice(0, -1)
    const object = root ? findNodeAtLocation(root, objectPath) : undefined
    if (object && object.type !== 'object') return context
    const quoted = token?.kind === SyntaxKind.StringLiteral
    const span = token ? { start: token.start, end: Math.max(token.end, offset) } : { start: offset, end: offset }
    const before = tokens.filter(entry => entry.end <= span.start).at(-1)
    const after = tokens.find(entry => entry.start >= span.end && entry !== token)
    const closed = token?.closed ?? false
    const hasColon = after?.kind === SyntaxKind.ColonToken
    context.key = {
      path: objectPath, offset, object, span, quoted, closed, hasColon,
      typed: text.slice(span.start + (quoted ? 1 : 0), Math.min(offset, (token?.end ?? offset) - (closed ? 1 : 0))),
      existing: (object?.children ?? []).filter(property => property.children?.[0]?.offset !== token?.start).map(property => String(property.children?.[0]?.value ?? '')),
      leadingComma: Boolean(before && ![SyntaxKind.OpenBraceToken, SyntaxKind.CommaToken].includes(before.kind)),
      trailingComma: !hasColon && after?.kind === SyntaxKind.StringLiteral
    }
  } else if (token?.kind === SyntaxKind.StringLiteral && offset > token.start && offset <= token.end - (token.closed ? 1 : 0)) {
    const start = token.start + 1, end = token.end - (token.closed ? 1 : 0)
    context.string = { start, end, typed: text.slice(start, offset), value: token.value }
  }
  return context
}

// 已有冒号时只替换键名，未形成属性时替换完整片段
export function jsonPropertyEdit(context: JsonKeyContext, name: string, snippet: string): { span: JsonSpan; text: string; filterText: string } {
  if (context.hasColon && context.quoted && context.closed && context.offset >= context.span.start + 1 && context.offset <= context.span.end - 1) {
    return { span: { start: context.span.start + 1, end: context.span.end - 1 }, text: name, filterText: name }
  }
  if (context.hasColon) return { span: context.span, text: JSON.stringify(name), filterText: name }
  return { span: context.span, text: (context.leadingComma ? ', ' : '') + snippet + (context.trailingComma ? ',' : ''), filterText: context.quoted ? JSON.stringify(name) : name }
}

// 插入位置不能拆开字符串转义或 UTF-16 代理对
export function jsonStringBoundary(text: string, span: JsonSpan, offset: number): boolean {
  if (offset < span.start || offset > span.end) return false
  const previous = text.charCodeAt(offset - 1), current = text.charCodeAt(offset)
  if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) return false
  for (let index = span.start; index < offset; index++) {
    if (text[index] !== String.fromCharCode(92)) continue
    const end = index + (text[index + 1] === 'u' ? 6 : 2)
    if (offset < end) return false
    index = end - 1
  }
  return true
}
