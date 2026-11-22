import { uiText } from '../i18n/messages'
import { BrowserProjectStore } from './project'
import { BrowserWorkbenchBridge } from './workbenchBridge'
import { BrowserShell } from './shell'
import { errorText } from './files'
import { watermarkExport } from './watermarkExport'
import type { BrowserExportHook } from './projectPort'

interface WebApi {
  acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): unknown; setState(value: unknown): void }
  __MCRH__: { blocklyMedia: string; modelAssets: string }
  mcrhWeb?: { setExportHook(hook: BrowserExportHook): void; projectInfo(): ReturnType<BrowserProjectStore['info']> }
}
async function start(): Promise<void> {
  const globals = globalThis as unknown as WebApi, project = new BrowserProjectStore()
  await project.initialize()
  let shell: BrowserShell | undefined, exportHook: BrowserExportHook | undefined, state: unknown
  try { state = JSON.parse(sessionStorage.getItem('mcrh-web-state') || 'null') } catch {}
  const reportExport = (text: string) => { window.postMessage({ type: 'log', text: (text + "\n") }, location.origin); shell?.notify(text) }
  const beforeExport: BrowserExportHook = async (files, context) => { const marked = await watermarkExport(files, reportExport); return exportHook ? exportHook(marked, context) : marked }
  const bridge = new BrowserWorkbenchBridge(project, { confirmReplace: () => shell?.confirmReplace() ?? !project.info().dirty, replaced: () => shell?.projectReplaced(), beforeExport, changed: () => shell?.refresh(), notify: (text, error) => shell?.notify(text, error), edit: path => shell?.resources.open(path) })
  globals.__MCRH__ = { blocklyMedia: './assets/blockly-media/', modelAssets: new URL('./assets/model-assets.zip', location.href).href }
  globals.acquireVsCodeApi = () => ({ postMessage: message => { void bridge.handle(message).catch(error => shell?.notify(errorText(error), true)) }, getState: () => state, setState: value => { state = value; try { sessionStorage.setItem('mcrh-web-state', JSON.stringify(value)) } catch {} } })
  globals.mcrhWeb = { setExportHook: hook => { exportHook = hook }, projectInfo: () => project.info() }
  const { hasWorkbenchSession } = await import('../webview/advanced')
  shell = new BrowserShell(project, bridge, hasWorkbenchSession)
  document.querySelector('#web-loading')?.remove()
  document.documentElement.dataset.webReady = 'true'
  await shell.loadVersions()
}
void start().catch(error => { const status = document.querySelector('#web-loading'); if (status) status.textContent = uiText("browser.index.couldNotCloseTemporaryFolderS", errorText(error)); console.error(error) })
