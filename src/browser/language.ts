import { languageGlobals, localeTags, resolveLocale, type UiLocale } from '../i18n/locale'
import { activeLanguage, selectLanguage, uiText } from '../i18n/messages'

const storageKey = 'mcrh-interface-language'
async function loadCatalog(locale: UiLocale): Promise<unknown> {
  try {
    const response = await fetch(new URL('./locales/' + locale + '.json', document.baseURI))
    return response.ok ? await response.json() : undefined
  } catch { return undefined }
}

export async function loadInterfaceLanguage(): Promise<void> {
  let preferred: string | null = null
  try { preferred = localStorage.getItem(storageKey) } catch {}
  const locale = preferred ? resolveLocale(preferred) : 'zh_cn'
  const [selected, chinese] = await Promise.all([loadCatalog(locale), locale === 'zh_cn' ? undefined : loadCatalog('zh_cn')])
  languageGlobals.__MCRH_LANGUAGE__ = selectLanguage(locale, selected, chinese)
  document.documentElement.lang = localeTags[activeLanguage().locale]
  document.title = uiText('web.title')
  document.querySelector('meta[name="description"]')?.setAttribute('content', uiText('web.description'))
  const loading = document.querySelector('#web-loading')
  if (loading) loading.textContent = uiText('web.loading')
}

export function attachLanguagePicker(anchor: HTMLElement, hasProject: () => boolean, notify: (message: string) => void): void {
  const select = document.createElement('select')
  select.id = 'web-language'
  select.setAttribute('aria-label', uiText('language.label'))
  const names = new Intl.DisplayNames(['en'], { type: 'language' })
  for (const key of Object.keys(localeTags) as UiLocale[]) {
    const tag = localeTags[key]
    const name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag.split('-')[0]) ?? names.of(tag) ?? tag
    select.add(new Option(name, key))
  }
  select.value = activeLanguage().locale
  select.addEventListener('change', () => {
    try { localStorage.setItem(storageKey, select.value) } catch { select.value = activeLanguage().locale; return }
    if (hasProject()) notify(uiText('language.onReopen'))
    else location.reload()
  })
  const label = document.createElement('label')
  label.className = anchor.className
  label.append(uiText('language.label'), select)
  anchor.after(label)
}
