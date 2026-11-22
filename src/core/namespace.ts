import { uiText } from '../i18n/messages'
// minecraft 是原版和默认的命名空间
export const MINECRAFT_NAMESPACE = 'minecraft'

export const NAMESPACE_PATTERN = /^[a-z0-9_.-]+$/

const UPPERCASE_PATTERN = /[A-Z]/

export function namespaceProblem(value: string): string | undefined {
  if (value.length === 0) return uiText("core.namespace.namespaceCannotBeEmpty")
  if (UPPERCASE_PATTERN.test(value)) return uiText("core.namespace.namespaceMustBeAllLowercase")
  if (!NAMESPACE_PATTERN.test(value)) return uiText("core.namespace.allowLowercaseLettersNumbersUnderlinedsHyphensAnd")
  return undefined
}

// 设置为空或无效时使用 minecraft，不改设置
export function resolveNamespace(configured: string | undefined): { namespace: string; problem?: string } {
  if (configured === undefined || configured === '') return { namespace: MINECRAFT_NAMESPACE }
  const problem = namespaceProblem(configured)
  if (problem === undefined) return { namespace: configured }
  return { namespace: MINECRAFT_NAMESPACE, problem }
}

export function discoverNamespaces(dirNames: string[]): string[] {
  const valid = dirNames.filter(name => namespaceProblem(name) === undefined)
  return [...new Set(valid)].sort()
}
