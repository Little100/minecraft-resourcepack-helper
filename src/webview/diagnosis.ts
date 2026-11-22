import { uiHtml, uiText } from '../i18n/messages'
import type { PackDiagnosticReport } from '../core/advanced/packDiagnostics'
import { renderPackDiagnosis } from './packDiagnosis'

declare function acquireVsCodeApi(): { postMessage(value: unknown): void }
const vscode = acquireVsCodeApi(), main = document.createElement('main')
main.className = 'diagnosis-page'
main.innerHTML = `<header class="diagnosis-page-header"><div><h1>${uiHtml("webview.diagnosis.resourceKitIssues")}</h1><p class="diagnosis-page-note">${uiHtml("webview.diagnosis.listsOnlyTheErrorsAndItemsTo")}</p><p class="diagnosis-page-source"></p></div><button type="button" class="diagnosis-rerun">${uiHtml("webview.diagnosis.recheck")}</button></header><p class="diagnosis-status" role="status">${uiHtml("webview.diagnosis.preparingTheResults")}</p><section class="diagnosis-report" aria-live="polite"></section>`
document.body.append(main)
const status = main.querySelector<HTMLElement>('.diagnosis-status')!, rerun = main.querySelector<HTMLButtonElement>('.diagnosis-rerun')!, source = main.querySelector<HTMLElement>('.diagnosis-page-source')!, results = main.querySelector<HTMLElement>('.diagnosis-report')!
let reportId = 0
rerun.addEventListener('click', () => { rerun.disabled = true; vscode.postMessage({ command: 'diagnosisRerun' }) })
window.addEventListener('message', event => {
  const data = event.data
  if (!data || typeof data !== 'object') return
  if (data.command === 'diagnosisReport' && Number.isSafeInteger(data.reportId) && data.reportId >= reportId && data.report && Array.isArray(data.report.issues)) {
    reportId = data.reportId
    source.textContent = data.root
    const report = data.report as PackDiagnosticReport
    renderPackDiagnosis(results, report, data.name, { openIssue: index => vscode.postMessage({ command: 'diagnosisOpenIssue', reportId, index }) })
    status.textContent = uiText("ui.packDiagnosisPanel.checkCompletedRecheckIfYouChangeThe")
    status.setAttribute('role', 'status'); rerun.disabled = Boolean(data.busy)
  }
  if (data.command === 'diagnosisStatus' && typeof data.message === 'string') { status.textContent = data.message; if (typeof data.root === 'string') source.textContent = data.root; status.setAttribute('role', data.error ? 'alert' : 'status'); rerun.disabled = Boolean(data.busy) }
  if (data.command === 'diagnosisBusy' && typeof data.busy === 'boolean') rerun.disabled = data.busy
})
vscode.postMessage({ command: 'diagnosisReady' })
