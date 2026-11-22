import { uiHtml, uiText } from '../i18n/messages'
import { onHostMessage } from './bus'
interface Change { path: string; status: string }
interface Commit { hash: string; author: string; date: string; subject: string }
export function mountGitView(parent: HTMLElement, post: (message: { command: 'gitWorkbench'; action: string; [key: string]: unknown }) => void, compact = false): void {
  const panel = document.createElement('section'); panel.className = 'mcrh-git-view mp-panel'
  panel.innerHTML = `<header class="mp-panel-head">${uiHtml("webview.gitView.gitHistoryAndChange")}<button data-git="refresh">${uiHtml("webview.collaboration.refresh")}</button></header><p data-git-status class="mp-panel-detail"></p><div data-git-setup></div><div data-git-changes></div><div data-git-commit><input data-git-message placeholder="${uiHtml("webview.gitView.manualSubmissionOfStatements")}" aria-label="${uiHtml("webview.gitView.gitSubmissionStatement")}"><button data-git="commit">${uiHtml("webview.gitView.commitdQuery")}</button></div><p class="mp-panel-detail">${uiHtml("webview.gitView.saveNonSubmissionSubmitNonDispatchAnd")}</p><div data-git-log></div><div data-git-files></div>`
  parent.append(panel)
  const send = (action: string, params: Record<string, unknown> = {}) => post({ command: 'gitWorkbench', action, ...params })
  let selectedHash: string | undefined, currentFile: string | undefined
  const button = (label: string, action: () => void) => { const node = document.createElement('button'); node.textContent = label; node.addEventListener('click', action); return node }
  function files(container: HTMLElement, changes: Change[], hash?: string): void {
    container.replaceChildren()
    for (const change of changes) {
      const row = document.createElement('div'); row.className = 'mcrh-git-file'
      const label = document.createElement('span'); label.textContent = change.status + ' ' + change.path; label.title = change.path
      row.append(label, button(uiText("webview.gitView.variance"), () => send('diff', { path: change.path, hash })))
      if (hash) { row.append(button(uiText("webview.gitView.view"), () => send('openRevision', { path: change.path, hash })), button(uiText("webview.gitView.restore"), () => send('restore', { path: change.path, hash }))) }
      else row.append(button(uiText("webview.gitView.suspended"), () => send('stage', { paths: [change.path] })), button(uiText("webview.gitView.unsuspension"), () => send('unstage', { paths: [change.path] })))
      container.append(row)
    }
  }
  panel.querySelector('[data-git=refresh]')!.addEventListener('click', () => send('refresh'))
  panel.querySelector('[data-git=commit]')!.addEventListener('click', () => send('commit', { message: panel.querySelector<HTMLInputElement>('[data-git-message]')!.value }))
  onHostMessage(raw => {
    const value = raw as { command: string; error: string; installed: boolean; repository: boolean; root: string; file?: string; changes: Change[]; commits: Commit[]; files: Change[]; hash: string }
    const status = panel.querySelector<HTMLElement>('[data-git-status]')!
    if (value.command === 'gitError') { status.textContent = value.error; return }
    if (value.command === 'gitCommitFiles') { if (selectedHash === value.hash) files(panel.querySelector('[data-git-files]')!, value.files, value.hash); return }
    if (value.command !== 'gitState') return
    currentFile = value.file
    status.textContent = value.root
    const setup = panel.querySelector<HTMLElement>('[data-git-setup]')!; setup.replaceChildren()
    if (!value.installed) { status.textContent = uiText("webview.gitView.githubIsNotInstalledThisToolDoes"); setup.append(button(uiText("ui.collaborationPanel.openGitInstallPage"), () => send('install'))) }
    else if (!value.repository) setup.append(button(uiText("webview.gitView.initializeTheCurrentDirectoryGit"), () => send('init')))
    files(panel.querySelector('[data-git-changes]')!, value.changes)
    const log = panel.querySelector<HTMLElement>('[data-git-log]')!; log.replaceChildren()
    for (const commit of value.commits) {
      const row = document.createElement('div'); row.className = 'mcrh-git-commit'
      const select = button(commit.hash.slice(0, 8) + ' ' + commit.subject, () => { selectedHash = commit.hash; if (currentFile) files(panel.querySelector('[data-git-files]')!, [{ path: currentFile, status: uiText("webview.gitView.history") }], commit.hash); else send('files', { hash: commit.hash }) }); select.title = commit.author + ' · ' + commit.date
      row.append(select)
      if (!compact) row.append(button(uiText("webview.gitView.withdrawal"), () => send('revert', { hash: commit.hash })))
      log.append(row)
    }
    panel.querySelector<HTMLElement>('[data-git-commit]')!.hidden = compact
  })
  send('refresh')
}
