import { uiText } from '../i18n/messages'
import type { PackDiagnosticIssue, PackDiagnosticReport } from '../core/advanced/packDiagnostics'

export interface DiagnosisViewOptions { openIssue?(index: number): void }
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] => {
  const value = document.createElement(tag); value.className = className; if (text !== undefined) value.textContent = text; return value
}
export function renderPackDiagnosis(container: HTMLElement, report: PackDiagnosticReport, name: string, options: DiagnosisViewOptions = {}): void {
  container.replaceChildren(); container.classList.add('diagnosis-results')
  const issues = report.issues.map((issue, index) => ({ issue, index })).filter(entry => entry.issue.severity !== 'info')
  const header = element('div', 'diagnosis-result-heading'), title = element('h2', '', uiText("webview.packDiagnosis.checkResults")), badges = element('div', 'diagnosis-badges')
  const total = report.errors + report.warnings
  const summary = element('p', 'diagnosis-summary', name + ' · ' + report.files + uiText("browser.resources.files") + (report.targetVersion ? ' · Java ' + report.targetVersion : ''))
  if (report.errors) badges.append(element('span', 'diagnosis-badge diagnosis-error', report.errors + uiText("webview.packDiagnosis.aMistake")))
  if (report.warnings) badges.append(element('span', 'diagnosis-badge diagnosis-warning', report.warnings + uiText("webview.packDiagnosis.itemsToBeVerified")))
  header.append(title, badges); container.append(header, summary)
  if (!total && !issues.length) {
    container.append(element('p', 'diagnosis-empty', uiText("webview.packDiagnosis.noProblemsFromThisInspection")))
    return
  }
  const tools = element('div', 'diagnosis-tools'), search = element('input'), filter = element('select'), count = element('p', 'diagnosis-visible-count'), list = element('div', 'diagnosis-file-list'), more = element('button', 'diagnosis-more', uiText("webview.packDiagnosis.showMoreProblems"))
  search.type = 'search'; search.placeholder = uiText("webview.packDiagnosis.searchForFilePathOrQuestion"); search.setAttribute('aria-label', uiText("webview.packDiagnosis.searchForDiagnosticProblems"))
  filter.setAttribute('aria-label', uiText("webview.packDiagnosis.diagnosisLevel"))
  for (const [value, label] of [['all', uiText("webview.packDiagnosis.allIssues")], ['error', uiText("webview.packDiagnosis.error")], ['warning', uiText("webview.guiPreview.needsReview")]]) {
    if (value !== 'all' && !issues.some(entry => entry.issue.severity === value)) continue
    const option = element('option', '', label); option.value = value!; filter.append(option)
  }
  filter.hidden = filter.options.length <= 2
  tools.append(search, filter); container.append(tools, count, list, more)
  more.type = 'button'
  let limit = 80
  const render = (): void => {
    const query = search.value.trim().toLocaleLowerCase(), groups = new Map<string, Array<{ issue: PackDiagnosticIssue; index: number }>>()
    const matches = issues.filter(({ issue }) => (filter.value === 'all' || issue.severity === filter.value) && (!query || [issue.path, issue.message, issue.suggestion].join(' ').toLocaleLowerCase().includes(query)))
    matches.sort((a, b) => Number(b.issue.severity === 'error') - Number(a.issue.severity === 'error'))
    for (const entry of matches.slice(0, limit)) {
      const key = (entry.issue.source === 'base' ? uiText("webview.packDiagnosis.basicResources") : '') + (entry.issue.path || uiText("webview.packDiagnosis.resourcePackAsAWhole"))
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(entry)
    }
    list.replaceChildren(); count.textContent = uiText("webview.packDiagnosis.displayedQuestions", Math.min(limit, matches.length), matches.length)
    if (!matches.length) list.append(element('p', 'diagnosis-empty', uiText("webview.packDiagnosis.noProblemWithMatching")))
    for (const [path, entries] of groups) {
      const group = element('section', 'diagnosis-file'), fileHeading = element('h3', 'diagnosis-file-heading'), filename = element('code', '', path)
      fileHeading.append(filename, element('span', 'diagnosis-file-count', entries.length + uiText("webview.packDiagnosis.item"))); group.append(fileHeading)
      for (const { issue, index } of entries) {
        const article = element('article', 'diagnosis-issue diagnosis-' + issue.severity), row = element('div', 'diagnosis-issue-heading'), badge = element('span', 'diagnosis-severity', issue.severity === 'error' ? uiText("webview.packDiagnosis.error") : uiText("webview.guiPreview.needsReview"))
        row.append(badge, element('strong', '', issue.message))
        article.append(row)
        if (issue.line) article.append(element('p', 'diagnosis-location', uiText("webview.packDiagnosis.lineReference", issue.line, (issue.column ? uiText("webview.packDiagnosis.columns", issue.column) : ''))))
        if (issue.excerpt) article.append(element('pre', 'diagnosis-excerpt', issue.excerpt))
        article.append(element('p', 'diagnosis-advice', issue.suggestion))
        if (options.openIssue && issue.path) {
          const open = element('button', 'diagnosis-open', issue.line ? uiText("webview.packDiagnosis.openFileAndPosition") : uiText("webview.packDiagnosis.openRelatedFiles"))
          open.type = 'button'; open.addEventListener('click', () => options.openIssue!(index)); article.append(open)
        }
        group.append(article)
      }
      list.append(group)
    }
    more.hidden = matches.length <= limit
  }
  search.addEventListener('input', () => { limit = 80; render() })
  filter.addEventListener('change', () => { limit = 40; render() })
  more.addEventListener('click', () => { limit += 80; render() })
  if (report.truncated) container.append(element('p', 'diagnosis-budget', uiText("webview.packDiagnosis.theProblemExceedsThePresentationBudgetAnd")))
  render()
}
