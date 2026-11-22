import { languageGlobals, type UiLanguage } from '../i18n/locale'

const pending: MessageEvent[] = []
const bufferRequest = (event: MessageEvent) => pending.push(event)
self.addEventListener('message', bufferRequest)
self.addEventListener('message', async (event: MessageEvent<UiLanguage>) => {
  languageGlobals.__MCRH_LANGUAGE__ = event.data
  pending.shift()
  await import('./projectWorker')
  self.removeEventListener('message', bufferRequest)
  for (const request of pending) self.dispatchEvent(new MessageEvent('message', { data: request.data }))
}, { once: true })
