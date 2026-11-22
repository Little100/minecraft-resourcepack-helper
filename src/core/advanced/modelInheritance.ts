import { uiText } from '../../i18n/messages'
export interface ResolvedModel { model: Record<string, unknown>; parents: string[] }

export async function resolveModelInheritance(text: string, loadParent: (id: string) => Promise<string>): Promise<ResolvedModel> {
  const parents: string[] = []
  const parse = (source: string): Record<string, unknown> => {
    if (source.length > 1024 * 1024) throw new Error(uiText("core.advanced.modelInheritance.modelJsonExceededSecurityLimit"))
    const value: unknown = JSON.parse(source)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(uiText("core.advanced.modelInheritance.modelMustBeAJsonObject"))
    return value as Record<string, unknown>
  }
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const resolve = async (child: Record<string, unknown>, seen: Set<string>): Promise<Record<string, unknown>> => {
    if (child.parent === undefined) return child
    if (typeof child.parent !== 'string') throw new Error(uiText("core.advanced.modelInheritance.theModelParentMustBeAResource"))
    const id = child.parent.includes(':') ? child.parent : `minecraft:${child.parent}`
    if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id) || id.split(':')[1].split('/').some(part => !part || part === '.' || part === '..')) throw new Error(uiText("core.advanced.modelInheritance.modelFatherQuoteUnsafe"))
    if (id.startsWith('minecraft:builtin/')) throw new Error(uiText("core.advanced.modelInheritance.internalGeneratingModelWithoutGeometryToRemove"))
    if (seen.has(id) || seen.size >= 32) throw new Error(uiText("core.advanced.modelInheritance.modelParentReferenceLoopOrHierarchyLimit"))
    seen.add(id); parents.push(id)
    const parent = await resolve(parse(await loadParent(id)), seen)
    const result: Record<string, unknown> = { ...parent, ...child, textures: { ...record(parent.textures), ...record(child.textures) }, display: { ...record(parent.display), ...record(child.display) } }
    delete result.parent
    return result
  }
  return { model: await resolve(parse(text), new Set()), parents }
}
