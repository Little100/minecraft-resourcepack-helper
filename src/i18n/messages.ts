import defaultMessages from '../../locales/zh_cn.json'
import { escapeMarkup, formatMessage, languageGlobals, type Catalog, type UiLanguage, type UiLocale } from './locale'

const defaults: Catalog = defaultMessages

function catalog(value: unknown): Catalog | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  return entries.length ? Object.fromEntries(entries) : undefined
}

export function selectLanguage(locale: UiLocale, selected: unknown, chinese?: unknown): UiLanguage {
  const messages = catalog(selected)
  const fallback = locale === 'zh_cn' ? undefined : catalog(chinese)
  return messages ? { locale, messages, fallback } : { locale: 'zh_cn', messages: fallback ?? defaults }
}

export function activeLanguage(): UiLanguage {
  return languageGlobals.__MCRH_LANGUAGE__ ?? { locale: 'zh_cn', messages: defaults }
}

export function uiText(key: string, ...values: unknown[]): string {
  const { messages, fallback } = activeLanguage()
  return formatMessage(messages[key] ?? fallback?.[key] ?? defaults[key] ?? key, values)
}

export function uiHtml(key: string, ...values: unknown[]): string {
  return escapeMarkup(uiText(key, ...values))
}
