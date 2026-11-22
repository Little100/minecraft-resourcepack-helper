import { uiText } from '../i18n/messages'
import type { ModelPreviewAssets } from './modelPreviewAssets'

export interface NamedResource { kind: 'block' | 'item' | 'model' | 'entity'; id: string }
export interface ResourceDisplayName {
  displayName: string
  translationKey?: string
  translationLocale?: 'zh_cn' | 'en_us'
  translationSource?: string
  nameWarnings?: string[]
}
interface Dictionary { values: ReadonlyMap<string, string>; warning?: string }
const locales = ['zh_cn', 'en_us'] as const
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export function resourceTranslationKeys(target: NamedResource): string[] {
  const match = /^(?:([a-z0-9_.-]+):)?([a-z0-9_./-]+)$/.exec(target.id)
  if (!match || match[2]!.split('/').some(segment => segment === '.' || segment === '..')) return []
  const namespace = match[1] ?? 'minecraft'
  let location = match[2]!, categories: string[]
  if (target.kind === 'model') {
    const prefix = /^(block|item)\/(.+)$/.exec(location)
    if (!prefix) return []
    location = prefix[2]!; categories = prefix[1] === 'block' ? ['block', 'item'] : ['item', 'block']
  } else categories = target.kind === 'block' ? ['block', 'item'] : target.kind === 'item' ? ['item', 'block'] : ['entity', 'item']
  return categories.map(category => category + '.' + namespace + '.' + location.replaceAll('/', '.'))
}

export function resourceFromAssetPath(relative: string): NamedResource | undefined {
  const match = /^assets\/([a-z0-9_.-]+)\/(textures|models|blockstates|items)\/(.+)\.(?:png|json)$/.exec(relative)
  if (!match || match[3]!.split('/').some(segment => !/^[a-z0-9_.-]+$/.test(segment) || segment === '.' || segment === '..')) return undefined
  const [, namespace, category, location] = match
  if (category === 'blockstates') return { kind: 'block', id: namespace + ':' + location }
  if (category === 'items' || category === 'models') return { kind: category === 'items' ? 'item' : 'model', id: namespace + ':' + location }
  const texture = /^(block|item)\/(.+)$/.exec(location!)
  return texture ? { kind: texture[1] as 'block' | 'item', id: namespace + ':' + texture[2] } : { kind: 'entity', id: namespace + ':' + location!.replace(/^entity\//, '') }
}

function missingResourceName(target: NamedResource, keys: readonly string[], warnings: Set<string>): ResourceDisplayName {
  warnings.add(uiText("core.resourceNames.notFoundZhCnOrEnUs", target.id, (keys.length ? uiText("core.resourceNames.translationKeys") : uiText("core.resourceNames.resourceId")), (keys.length ? uiText("core.resourceNames.find", keys.join('、')) : '')))
  return { displayName: keys[0] ?? target.id, translationKey: keys[0], translationLocale: undefined, translationSource: undefined, nameWarnings: [...warnings] }
}

// 同一资源会话共享语言字典，按语言逐键查找而不整表替换
export class ResourceNameResolver {
  private readonly dictionaries = new Map<string, Promise<Dictionary>>()
  private readonly namespaceLists = new Map<number, Promise<string[]>>()
  constructor(private readonly assets: Pick<ModelPreviewAssets, 'roots' | 'readJson' | 'listDirectories'>) {}

  private namespaces(layer: number): Promise<string[]> {
    let pending = this.namespaceLists.get(layer)
    if (!pending) {
      pending = this.assets.listDirectories('assets', layer).then(paths => {
        if (paths.length > 256) throw new Error(uiText("core.resourceNames.languageNamingSpacesMoreThanReadBudget"))
        return paths.map(value => value.slice('assets/'.length)).sort()
      })
      this.namespaceLists.set(layer, pending)
    }
    return pending
  }

  private dictionary(layer: number, namespace: string, locale: typeof locales[number]): Promise<Dictionary> {
    const relative = 'assets/' + namespace + '/lang/' + locale + '.json', key = layer + ':' + relative
    let pending = this.dictionaries.get(key)
    if (!pending) {
      pending = this.assets.readJson(relative, layer).then(raw => {
        if (raw === undefined) return { values: new Map<string, string>() }
        if (!object(raw)) throw new Error(uiText("core.resourceNames.theTopLevelOfTheLanguageFile"))
        const values = new Map<string, string>()
        let malformed = false
        for (const [key, value] of Object.entries(raw)) {
          if (typeof value !== 'string') { malformed = true; continue }
          if (value.trim()) values.set(key, value)
        }
        return { values, warning: malformed ? relative + uiText("core.resourceNames.nonStringLanguageEntrySkippedAndContinues") : undefined }
      }).catch((error: unknown) => ({ values: new Map<string, string>(), warning: relative + uiText("core.resourceNames.canNotGetMessageSS") + (error instanceof Error ? error.message : String(error)) }))
      this.dictionaries.set(key, pending)
    }
    return pending
  }

  async resolve(target: NamedResource): Promise<ResourceDisplayName> {
    const keys = resourceTranslationKeys(target), warnings = new Set<string>()
    if (!keys.length) return missingResourceName(target, keys, warnings)
    for (const locale of locales) {
      for (let layer = 0; layer < this.assets.roots.length; layer++) {
        let namespaces: string[]
        try { namespaces = await this.namespaces(layer) }
        catch (error) { warnings.add(uiText("core.resourceNames.languageDirectoryCannotRead", (error instanceof Error ? error.message : String(error)))); continue }
        const targetNamespace = target.id.includes(':') ? target.id.split(':')[0] : 'minecraft'
        const ordered = [...new Set([targetNamespace, 'minecraft', ...namespaces])]
        for (const namespace of ordered) {
          if (!namespaces.includes(namespace)) continue
          const dictionary = await this.dictionary(layer, namespace, locale)
          if (dictionary.warning) warnings.add(dictionary.warning)
          for (const key of keys) {
            const value = dictionary.values.get(key)
            if (value !== undefined) return { displayName: value, translationKey: key, translationLocale: locale, translationSource: this.assets.roots[layer], nameWarnings: warnings.size ? [...warnings] : undefined }
          }
        }
      }
    }
    return missingResourceName(target, keys, warnings)
  }

  async targets<T extends NamedResource>(targets: readonly T[]): Promise<Array<T & ResourceDisplayName>> {
    const named: Array<T & ResourceDisplayName> = []
    for (const target of targets) named.push({ ...target, ...await this.resolve(target) })
    return named
  }
}
