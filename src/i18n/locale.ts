export type UiLocale = 'en_us' | 'zh_cn'
export type Catalog = Readonly<Record<string, string>>
export interface UiLanguage { locale: UiLocale; messages: Catalog; fallback?: Catalog }
export const localeTags: Record<UiLocale, string> = { en_us: 'en-US', zh_cn: 'zh-CN' }
export const resolveLocale = (tag?: string): UiLocale => /^zh(?:[-_]|$)/i.test(tag ?? '') ? 'zh_cn' : 'en_us'
export const languageGlobals = globalThis as typeof globalThis & { __MCRH_LANGUAGE__?: UiLanguage }

export function formatMessage(message: string, values: readonly unknown[]): string {
  return message.replace(/\{(\d+)\}/g, (token, index: string) => Number(index) < values.length ? String(values[Number(index)]) : token)
}

export function escapeMarkup(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
