import { uiText } from '../i18n/messages'
import { findNodeAtLocation, getNodeValue, parseTree, type Node, type ParseError } from 'jsonc-parser'
import { generatedBaseElementCount } from './generatedItemGeometry'

function treeOf(text: string): Node | undefined {
  const errors: ParseError[] = [], tree = parseTree(text, errors)
  return errors.length ? undefined : tree
}

function lineLookup(text: string): (offset: number) => number {
  const starts = [0]
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) starts.push(index + 1)
  return offset => {
    let low = 0, high = starts.length
    while (low + 1 < high) { const middle = (low + high) >>> 1; if (starts[middle]! <= offset) low = middle; else high = middle }
    return low
  }
}

export function compactGeneratedModelText(text: string): string {
  const tree = treeOf(text)
  if (!tree) return text
  const count = generatedBaseElementCount(getNodeValue(tree)), array = findNodeAtLocation(tree, ['elements']), nodes = array?.children
  if (!count || !nodes || !array) return text
  const generated = nodes.slice(-count), first = generated[0]!, last = generated[generated.length - 1]!
  const eol = text.includes('\r\n') ? '\r\n' : '\n', unit = /^([\t ]+)"/m.exec(text)?.[1] ?? '  '
  const arrayLine = text.lastIndexOf('\n', array.offset) + 1, padding = /^[\t ]*/.exec(text.slice(arrayLine))![0]
  const lineStart = text.lastIndexOf('\n', first.offset) + 1, ownLine = /^[\t ]*$/.test(text.slice(lineStart, first.offset))
  const prefix = text.slice(0, ownLine ? lineStart : first.offset) + (ownLine ? '' : eol) + padding + unit + unit
  const suffix = text.slice(last.offset + last.length)
  return prefix + generated.map(node => JSON.stringify(getNodeValue(node))).join(',') + (/^[\t ]*\]/.test(suffix) ? eol + padding + suffix.trimStart() : suffix)

}

export function appendGeneratedElements(text: string, elements: readonly unknown[], eol: string, indent: string): string {
  const tree = treeOf(text), array = tree && findNodeAtLocation(tree, ['elements'])
  if (!array || array.type !== 'array') throw new Error(uiText("core.generatedModelText.modelMissingAdditionalElementsArrays"))
  const previous = array.children?.at(-1), offset = previous ? previous.offset + previous.length : array.offset + 1
  const lineStart = text.lastIndexOf('\n', array.offset) + 1, padding = /^[\t ]*/.exec(text.slice(lineStart))![0]
  const trailing = text.slice(offset, array.offset + array.length - 1)
  return compactGeneratedModelText(text.slice(0, offset) + (previous ? ',' : '') + eol + padding + indent + elements.map(value => JSON.stringify(value)).join(',') + (/\r?\n/.test(trailing) ? trailing : eol + padding) + text.slice(array.offset + array.length - 1))
}

export function generatedModelFold(text: string): { start: number; end: number } | undefined {
  const tree = treeOf(text)
  if (!tree) return
  const count = generatedBaseElementCount(getNodeValue(tree)), array = findNodeAtLocation(tree, ['elements'])
  if (!count || !array?.children) return
  const first = array.children[array.children.length - count]!, last = array.children.at(-1)!
  const line = lineLookup(text)
  const start = line(first.offset) - 1, end = line(last.offset + last.length)
  const previous = array.children[array.children.length - count - 1]
  if (start < line(array.offset) || previous && line(previous.offset + previous.length) > start || start >= end) return
  return { start, end }
}

export function generatedModelFoldingRanges(text: string): { start: number; end: number }[] | undefined {
  const generated = generatedModelFold(text), tree = treeOf(text)
  if (!generated || !tree) return
  const ranges = [generated], line = lineLookup(text)
  const visit = (node: Node): void => {
    if (node.type === 'object' || node.type === 'array') {
      const start = line(node.offset), end = line(node.offset + node.length) - 1
      if (end > start && (end < generated.start || start > generated.end || start < generated.start && end >= generated.end)) ranges.push({ start, end })
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(tree)
  return ranges.sort((a, b) => a.start - b.start || b.end - a.end)
}
