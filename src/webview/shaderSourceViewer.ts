import { uiHtml, uiText } from '../i18n/messages'
export interface ShaderSourceFile { id: string; label: string; content: string }
export interface ShaderSourceViewerOptions { post(message: object): void; scope: string }
export interface ShaderSourceViewer {
  setSources(sources: readonly ShaderSourceFile[], notes?: readonly string[]): void
  clear(message?: string): void
  receive(message: Record<string, unknown>): void
  dispose(): void
}

export function createShaderSourceViewer(container: HTMLElement, options: ShaderSourceViewerOptions): ShaderSourceViewer {
  container.classList.add('shader-source-viewer')
  container.innerHTML = `<div class="shader-source-actions"><label>${uiHtml("webview.shaderSourceViewer.source")}<select aria-label="${uiHtml("webview.shaderSourceViewer.coloredSource")}"></select></label><button type="button" data-shader-copy disabled>${uiHtml("webview.shaderSourceViewer.copyCode")}</button></div><pre class="shader-source-code" tabindex="0"></pre><p class="shader-source-status" role="status"></p><details class="shader-source-notes" hidden><summary>${uiHtml("webview.shaderSourceViewer.descriptionAndWarningNotCopying")}</summary><ul></ul></details>`
  const select = container.querySelector<HTMLSelectElement>('select')!
  const copy = container.querySelector<HTMLButtonElement>('[data-shader-copy]')!
  const code = container.querySelector<HTMLPreElement>('pre')!
  const status = container.querySelector<HTMLParagraphElement>('.shader-source-status')!
  const notes = container.querySelector<HTMLDetailsElement>('details')!
  const list = notes.querySelector('ul')!
  let sources: readonly ShaderSourceFile[] = [], pending: string | undefined, disposed = false
  const current = () => sources.find(source => source.id === select.value)
  const render = () => { code.textContent = current()?.content ?? ''; copy.disabled = !current()?.content.trim() || Boolean(pending); select.disabled = sources.length === 0 }
  const onChange = () => { pending = undefined; status.textContent = ''; render() }
  const onCopy = () => {
    const source = current()
    if (disposed || pending || !source?.content.trim()) return
    const requestId = options.scope + '_' + crypto.randomUUID()
    pending = requestId
    status.textContent = uiText("webview.shaderSourceViewer.copyingSourceCode")
    render()
    try { options.post({ command: 'copyShaderCode', requestId, text: source.content }) }
    catch (error) { pending = undefined; status.textContent = uiText("webview.shaderSourceViewer.copyingFailed", (error instanceof Error ? error.message : String(error))); render() }
  }
  select.addEventListener('change', onChange)
  copy.addEventListener('click', onCopy)
  return {
    setSources(next, messages = []) {
      if (disposed) return
      const selected = select.value
      pending = undefined
      sources = next.filter(source => source && typeof source.id === 'string' && typeof source.label === 'string' && typeof source.content === 'string').map(source => ({ ...source }))
      select.replaceChildren(...sources.map(source => { const option = document.createElement('option'); option.value = source.id; option.textContent = source.label; return option }))
      if (sources.some(source => source.id === selected)) select.value = selected
      list.replaceChildren(...messages.map(message => { const item = document.createElement('li'); item.textContent = message; return item }))
      notes.hidden = messages.length === 0
      status.textContent = ''
      render()
    },
    clear(message = uiText("webview.shaderSourceViewer.copyableAfterGeneratingCode")) {
      if (disposed) return
      sources = []; pending = undefined; select.replaceChildren(); list.replaceChildren(); notes.hidden = true
      status.textContent = (message); render()
    },
    receive(message) {
      if (disposed || !pending || message.type !== 'shaderCodeCopied' || message.requestId !== pending) return
      pending = undefined
      status.textContent = message.ok === true ? uiText("webview.shaderSourceViewer.sourceCodeCopiedWithoutFilenameDescriptionOr") : uiText("webview.shaderSourceViewer.copyingFailed", String(message.error ?? uiText("webview.shaderSourceViewer.pleaseTryAgain")))
      render()
    },
    dispose() { disposed = true; pending = undefined; select.removeEventListener('change', onChange); copy.removeEventListener('click', onCopy) }
  }
}
