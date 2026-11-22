import { uiText } from '../i18n/messages'
export function mountModTextures(parent: HTMLElement, post: (message: unknown) => void): { receive(raw: unknown): void; dispose(): void } {
  const panel = document.createElement('article'); panel.className = 'card mod-texture-import'
  const heading = document.createElement('h2'); heading.textContent = uiText("webview.modTextures.modelPasteImport")
  const description = document.createElement('p'); description.className = 'muted'; description.textContent = uiText("webview.modTextures.readsAStickerFromTheJarOf")
  const actions = document.createElement('div'); actions.className = 'pack-actions'
  const button = document.createElement('button'); button.type = 'button'; button.dataset.modImport = ''; button.textContent = uiText("webview.modTextures.importModuleJarToItem")
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.hidden = true; cancel.textContent = uiText("webview.modTextures.ungroupImport")
  const status = document.createElement('output'); status.className = 'mod-import-status'; status.setAttribute('role', 'status'); status.textContent = uiText("webview.modTextures.noModuleSelected")
  const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = uiText("webview.modTextures.importReportAndFilePath"); const report = document.createElement('pre'); details.append(summary, report)
  const note = document.createElement('p'); note.className = 'muted'; note.textContent = uiText("webview.modTextures.readResourcesOnlyDoNotExecuteOr")
  actions.append(button, cancel); panel.append(heading, description, actions, status, details); const help = document.createElement('details'); help.className = 'pack-help'; const helpTitle = document.createElement('summary'); helpTitle.textContent = uiText("webview.modTextures.importScopeLimits"); help.append(helpTitle, note); panel.append(help); parent.prepend(panel)
  let requestId = '', disposed = false, timer: ReturnType<typeof setTimeout> | undefined
  const idle = () => { button.disabled = false; cancel.hidden = true; if (timer) clearTimeout(timer); timer = undefined }
  button.addEventListener('click', () => {
    requestId = 'mod-' + Date.now().toString(36); button.disabled = true; cancel.hidden = false; status.textContent = uiText("webview.modTextures.pleaseChooseJarAllContentIsProcessed"); report.textContent = ''
    post({ command: 'modTexturesImport', requestId })
    timer = setTimeout(() => { post({ command: 'modTexturesCancel' }); status.textContent = uiText("webview.modTextures.waitingForTimeoutToRequestCancellationPlease"); cancel.hidden = true }, 600000)
  })
  cancel.addEventListener('click', () => { post({ command: 'modTexturesCancel' }); status.textContent = uiText("webview.modTextures.cancelingWaitingForTheCurrentFileOperation"); cancel.disabled = true })
  return {
    receive(raw) {
      if (disposed || !raw || typeof raw !== 'object' || !('requestId' in raw) || raw.requestId !== requestId || !('text' in raw) || typeof raw.text !== 'string' || !('type' in raw)) return
      if (raw.type === 'modTexturesProgress') { report.textContent = raw.text; details.open = true; const committing = 'committing' in raw && raw.committing === true; cancel.disabled = committing; status.textContent = committing ? (raw.text) : uiText("webview.modTextures.pleaseAddressThePathConflictInThe"); return }
      if (raw.type !== 'modTexturesResult') return
      idle(); cancel.disabled = false; report.textContent = raw.text; details.open = true; status.textContent = (raw.text.split('\n')[0]); requestId = ''
    },
    dispose() { disposed = true; if (timer) clearTimeout(timer); if (requestId) post({ command: 'modTexturesCancel' }); panel.remove() }
  }
}
