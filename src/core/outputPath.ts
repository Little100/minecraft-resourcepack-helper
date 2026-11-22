import { uiText } from '../i18n/messages'
import * as path from 'node:path'
import { namespaceProblem } from './namespace'

const PNG_SUFFIX = '.png'

export function defaultOutputPath(namespace: string, baseName: string): string {
  return `assets/${namespace}/textures/block/${baseName}${PNG_SUFFIX}`
}

export function normalizeOutputPath(input: string): string {
  return input.trim().replace(/\\/g, '/')
}

export function validateOutputPath(relative: string, root: string): string | undefined {
  const normalized = normalizeOutputPath(relative)
  if (normalized.length === 0) return uiText("core.outputPath.outputPathCannotBeEmpty")
  if (!normalized.endsWith(PNG_SUFFIX)) return uiText("core.outputPath.outputPathMustEndWithPng")
  const target = path.resolve(root, normalized)
  if (!isInside(root, target)) return uiText("core.outputPath.outputPathMustBeInTheCurrent")
  return namespaceProblemOf(path.relative(root, target))
}

function namespaceProblemOf(relative: string): string | undefined {
  const [top, segment, ...rest] = relative.split(path.sep)
  if (top !== 'assets' || rest.length === 0) return undefined
  return namespaceProblem(segment)
}

export function resolveOutputPath(relative: string, root: string): string {
  return path.resolve(root, normalizeOutputPath(relative))
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative.length > 0 && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..'
}
