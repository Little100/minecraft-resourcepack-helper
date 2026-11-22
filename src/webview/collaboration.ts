import { uiHtml, uiText } from '../i18n/messages'
import { diffLines } from 'diff'
import { enhanceNativeSelects } from './selectControls'
import type { Change, Member, Proposal } from '../collaboration/types'

declare function acquireVsCodeApi(): { postMessage(value: unknown): void }
const api = acquireVsCodeApi(), main = document.createElement('main')
main.className = 'collaboration-page'
main.innerHTML = `<header class="collab-header"><div><h1>${uiHtml("ui.collaborationPanel.collaborationAndReview")}</h1><p id="connection-label">${uiHtml("webview.collaboration.localEditorVoluntarySubmissionApprovalAndUpdate")}</p></div><nav aria-label="${uiHtml("webview.collaboration.connectionOperations")}"><button data-action="host" title="${uiHtml("webview.collaboration.defaultToUseTheCurrentWorkingArea")}">${uiHtml("webview.collaboration.asService")}</button><button data-action="host" data-custom-directory="true">${uiHtml("webview.collaboration.customServiceDirectory")}</button><button data-action="connect" class="primary">${uiHtml("ui.collaborationPanel.connectService")}</button><button data-action="disconnect" hidden>${uiHtml("webview.collaboration.disconnectStopService")}</button></nav></header>
<div class="collab-toolbar"><div><button data-action="refresh">${uiHtml("webview.collaboration.refresh")}</button><button data-action="pull">${uiHtml("webview.collaboration.selectResourcePackAndRip")}</button><button data-action="syncAll">${uiHtml("webview.collaboration.synchronizationRipped")}</button><button data-action="submit" class="primary">${uiHtml("ui.collaborationPanel.submitsTheSelectedChanges")}</button><button data-action="openLocal">${uiHtml("ui.collaborationPanel.canNotOpenMessage_56d75a")}</button><button data-action="logs">${uiHtml("ui.webviewDiagnostics.viewLog")}</button></div><label class="follow-setting"><input id="follow" type="checkbox" checked>${uiHtml("webview.collaboration.automaticallyFollowUpstreamNotAutomaticallySubmit")}</label></div>
<div id="operation-status" class="operation-status" role="status" aria-live="polite" hidden><span class="operation-indicator" aria-hidden="true"></span><div><strong id="operation-label"></strong><span id="operation-detail"></span></div></div><p id="notice" role="status" aria-live="polite" hidden></p>
<div class="collab-layout"><aside class="collab-sidebar"><section><div class="section-title"><h2>${uiHtml("ui.advancedPanel.resourcePack")}</h2><button data-action="discover" class="quiet owner-only">${uiHtml("webview.collaboration.reIdentify")}</button></div><select id="pack" aria-label="${uiHtml("ui.advancedPanel.resourcePack")}"></select><p id="workspace-label" class="muted">${uiHtml("webview.collaboration.noLocalWorkingCopySelected")}</p></section>
<section><div class="section-title"><h2>${uiHtml("webview.collaboration.localChange")} <span id="change-count"></span></h2><button id="toggle-local" class="quiet">${uiHtml("webview.collaboration.selectAllClear")}</button></div><p class="muted">${uiHtml("webview.collaboration.saveOnlyLocallyAndSubmitItOn")}</p><div id="local-changes" class="file-list"></div><div id="conflicts"></div></section>
<section class="proposal-section"><div class="section-title"><h2>${uiHtml("webview.collaboration.submissionOfRecords")}</h2><span id="proposal-count" class="muted"></span></div><select id="author" aria-label="${uiHtml("webview.collaboration.filterByAuthor")}"><option value="">${uiHtml("webview.collaboration.allUsers")}</option></select><div id="proposals" class="proposal-list"></div></section></aside>
<section class="collab-review"><div id="review-empty" class="empty-state"><h2>${uiHtml("webview.collaboration.selectASubmissionToStartReview")}</h2><p>${uiHtml("webview.collaboration.thisWillShowAPreviewOfThe")}</p><p>${uiHtml("webview.collaboration.thePendingItemsWillNotBeIncluded")}</p></div><div id="review-detail" hidden><header class="review-heading"><div><h2 id="proposal-title"></h2><p id="proposal-meta" class="muted"></p></div><button id="toggle-review">${uiHtml("webview.collaboration.selectedDocumentsForConsideration")}</button></header><div id="review-files" class="review-files"></div><div class="review-actions"><input id="comment" type="text" maxlength="4000" placeholder="${uiHtml("webview.collaboration.reviewOpinionLeftBlank")}" aria-label="${uiHtml("cli.collaboration.reviewObservations")}"><button id="reject">${uiHtml("webview.collaboration.rejectSelected")}</button><button id="approve" class="primary">${uiHtml("webview.collaboration.approvedSelected")}</button></div><p id="self-review" class="muted" hidden>${uiHtml("webview.collaboration.iCanTReviewMyOwnSubmission")}</p><section class="change-preview"><header><div><h3 id="preview-title">${uiHtml("webview.collaboration.selectFileToViewDifferences")}</h3><p id="preview-info" class="muted"></p></div><div><button id="model-before">${uiHtml("webview.collaboration.dBeforeChange")}</button><button id="model-after">${uiHtml("webview.collaboration.changedD")}</button></div></header><div id="preview-body" class="preview-body"><p class="empty-note">${uiHtml("webview.collaboration.picturesShowContrastsWithPixelsTextShows")}</p></div></section></div></section>
</div><footer class="collab-footer"><span id="server-info">${uiHtml("ui.collaborationPanel.notConnected")}</span><div><button data-action="members" class="owner-only">${uiHtml("webview.collaboration.membersAndPermissions")}</button><button data-action="settings" class="owner-only">${uiHtml("ui.collaborationPanel.serviceEndSettings")}</button><button data-action="audit" class="owner-only">${uiHtml("webview.collaboration.operationRecords")}</button><button data-action="p2p" class="host-only">${uiHtml("webview.collaboration.p2pSettings")}</button><button data-action="share" class="host-only">${uiHtml("webview.collaboration.copyUuidConnectionInformation")}</button><button data-action="rotate" class="host-only">${uiHtml("ui.collaborationPanel.resetConnectionDocuments")}</button></div></footer>`
document.body.append(main); enhanceNativeSelects()
const el = <T extends HTMLElement = HTMLElement>(id: string): T => main.querySelector<T>('#' + id)!
type Operation = { id: string; command: string; label: string; status: 'queued' | 'running'; proposalId?: string; path?: string }
const operations = new Map<string, Operation>()
let operationSequence = 0, previewGeneration = 0, localScope = '', hasWorkspace = false, hasWorkspaces = false, hosted = false
let activeId = '', activePath = '', proposals: Proposal[] = [], connected = false, me: { role: string; status: string; identity: { id: string; login: string } } | undefined
const localSelected = new Set<string>(), reviewSelected = new Set<string>()
function send(command: string, extra: Record<string, unknown> = {}): void {
  if (command === 'logs') { api.postMessage({ command }); return }
  const id = 'webview-' + ++operationSequence
  const label = command === 'preview' ? uiText("ui.collaborationPanel.loadingFileDifferences") : command === 'model' ? uiText("ui.collaborationPanel.prepareDPreview") : main.querySelector<HTMLButtonElement>('[data-action="' + command + '"]')?.textContent?.trim() || uiText("webview.collaboration.processingRequestsForCollaboration")
  operations.set(id, { id, command, label, status: 'queued', proposalId: typeof extra.id === 'string' ? extra.id : undefined, path: typeof extra.path === 'string' ? extra.path : undefined })
  activityState()
  try { api.postMessage({ command, ...extra, requestId: id }) }
  catch { operations.delete(id); activityState(); notice(uiText("webview.collaboration.couldNotSendCollaborativeRequestPleaseRetry"), true) }
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] { const item = document.createElement(tag); item.textContent = text; item.className = className; return item }
function empty(parent: HTMLElement, text: string): void { parent.replaceChildren(node('p', text, 'empty-note')) }
function checked(parent: HTMLElement): string[] { return [...parent.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked:not(:disabled)')].map(input => input.value) }
function notice(text: string, error = false): void { const target = el('notice'); target.textContent = text; target.hidden = !text; target.classList.toggle('error', error) }
function pending(...commands: string[]): boolean { return [...operations.values()].some(operation => commands.includes(operation.command)) }
function activityState(): void {
  const all = [...operations.values()], running = all.filter(operation => operation.status === 'running'), queued = all.filter(operation => operation.status === 'queued')
  el('operation-status').hidden = !all.length
  el('operation-label').textContent = running.length ? running.map(operation => operation.label).join(' · ') : uiText("webview.collaboration.waitingForProcessing")
  el('operation-detail').textContent = (queued.length ? queued.length + uiText("webview.collaboration.lineUp") : '') + uiText("webview.collaboration.stillBrowsingToSubmitFilterAndSelect")
  const previewing = all.some(operation => operation.command === 'preview' && operation.proposalId === activeId && operation.path === activePath)
  el('preview-body').setAttribute('aria-busy', String(previewing))
  buttonState()
}
function buttonState(): void {
  const canRead = connected && me?.status === 'active', connectionChanging = pending('host', 'connect', 'disconnect', 'rotate')
  const workspaceChanging = connectionChanging || pending('pull', 'syncAll', 'submit', 'resolve', 'pack', 'sync')
  for (const button of main.querySelectorAll<HTMLButtonElement>('[data-action]')) {
    const command = button.dataset.action!
    let disabled = !canRead || connectionChanging || pending(command)
    if (command === 'host' || command === 'connect') disabled = connected || connectionChanging
    else if (command === 'logs') disabled = false
    else if (command === 'disconnect') disabled = !connected || pending('disconnect')
    else if (command === 'refresh') disabled = pending('ready', 'refresh')
    else if (command === 'pull') disabled ||= workspaceChanging || !el<HTMLSelectElement>('pack').value
    else if (command === 'syncAll') disabled ||= workspaceChanging || !hasWorkspaces
    else if (command === 'submit') disabled ||= workspaceChanging || !hasWorkspace || me?.role === 'reviewer' || !checked(el('local-changes')).length
    else if (command === 'openLocal') disabled = !hasWorkspace || connectionChanging || pending(command)
    if (button.classList.contains('owner-only')) disabled ||= me?.role !== 'owner'
    if (button.classList.contains('host-only')) disabled ||= !hosted
    button.disabled = disabled; button.setAttribute('aria-busy', String(pending(command)))
  }
  const proposal = proposals.find(value => value.id === activeId), mayReview = canRead && !!proposal && !!me && ['owner', 'reviewer'].includes(me.role) && me.identity.id !== proposal.author.id
  const reviewBlocked = connectionChanging || pending('review') || !mayReview || !checked(el('review-files')).length
  for (const id of ['approve', 'reject']) { el<HTMLButtonElement>(id).disabled = reviewBlocked; el(id).setAttribute('aria-busy', String(pending('review'))) }
  el('self-review').hidden = !proposal || proposal.author.id !== me?.identity.id
  const change = proposal?.changes.find(value => value.path === activePath)
  for (const side of ['before', 'after']) {
    const button = el<HTMLButtonElement>('model-' + side)
    button.disabled = !canRead || connectionChanging || pending('model') || !activePath || !/\.(?:json|png)$/i.test(activePath) || !(side === 'before' ? change?.base : change?.next)
    button.setAttribute('aria-busy', String(pending('model')))
  }
  el<HTMLSelectElement>('pack').disabled = !canRead || workspaceChanging
  for (const button of main.querySelectorAll<HTMLButtonElement>('.conflict-row button')) button.disabled = !canRead || workspaceChanging
}
function row(change: Change, proposal: Proposal): HTMLElement {
  const line = node('div', '', 'review-file' + (activePath === change.path ? ' active' : '')), input = document.createElement('input'); input.type = 'checkbox'; input.value = change.path; input.checked = reviewSelected.has(change.path); input.disabled = change.decision !== 'pending'; input.setAttribute('aria-label', uiText("webview.collaboration.selection", change.path))
  input.addEventListener('change', () => { if (input.checked) reviewSelected.add(change.path); else reviewSelected.delete(change.path); buttonState() })
  const button = node('button', change.path, 'file-name'); button.title = change.path; button.addEventListener('click', () => { activePath = change.path; previewGeneration++; renderDetail(); empty(el('preview-body'), uiText("webview.collaboration.loadingFileDiscrepancies")); send('preview', { id: proposal.id, path: change.path }) })
  const status = node('span', ({ pending: uiText("webview.collaboration.pending"), approved: uiText("webview.collaboration.approved"), rejected: uiText("webview.collaboration.rejected") })[change.decision], 'decision ' + change.decision); if (change.reviewer) status.title = change.reviewer.login + '：' + (change.comment || uiText("webview.collaboration.noComment"))
  line.append(input, node('span', change.next === null ? uiText("webview.collaboration.delete") : change.base === null ? uiText("webview.collaboration.add") : uiText("webview.collaboration.modify"), 'change-kind'), button, status); return line
}
function renderDetail(): void {
  const proposal = proposals.find(value => value.id === activeId); el('review-empty').hidden = !!proposal; el('review-detail').hidden = !proposal
  if (!proposal) { buttonState(); return }
  el('proposal-title').textContent = proposal.title; el('proposal-meta').textContent = proposal.author.login + ' · ' + new Date(proposal.createdAt).toLocaleString() + ' · ' + proposal.id
  el('review-files').replaceChildren(...proposal.changes.map(change => row(change, proposal))); buttonState()
}
function renderProposals(): void {
  const author = el<HTMLSelectElement>('author').value, visible = proposals.filter(proposal => !author || proposal.author.id === author), list = el('proposals')
  list.replaceChildren(...visible.slice().reverse().map(proposal => { const button = node('button', '', 'proposal-row' + (proposal.id === activeId ? ' active' : '')); button.setAttribute('aria-pressed', String(proposal.id === activeId)); const pending = proposal.changes.filter(change => change.decision === 'pending').length; button.append(node('strong', proposal.title), node('span', proposal.author.login + ' · ' + proposal.changes.length + uiText("webview.collaboration.documentation") + pending + uiText("webview.collaboration.pending_fabe7b"), 'muted')); button.addEventListener('click', () => { activeId = proposal.id; activePath = ''; previewGeneration++; reviewSelected.clear(); for (const change of proposal.changes) if (change.decision === 'pending') reviewSelected.add(change.path); empty(el('preview-body'), uiText("webview.collaboration.selectFileToViewDifferences")); el('preview-title').textContent = uiText("webview.collaboration.selectFileToViewDifferences"); el('preview-info').textContent = ''; renderProposals(); renderDetail(); activityState() }); return button }))
  if (!visible.length) empty(list, uiText("webview.collaboration.noRecordOfSubmission")); el('proposal-count').textContent = String(visible.length); renderDetail()
}
function renderState(data: { connected: boolean; hosted?: boolean; me?: typeof me; packs: { id: string; name: string }[]; proposals: Proposal[]; members?: Member[]; packId?: string; workspace?: string; workspaces?: { packId: string; root: string }[]; checkoutRoot?: string; changes: { path: string; kind: string }[]; conflicts: { path: string }[]; autoFollow?: boolean; port?: number; p2p?: string; p2pUuid?: string }): void {
  connected = data.connected; me = data.me; proposals = data.proposals; hosted = data.hosted === true; hasWorkspace = !!data.workspace; hasWorkspaces = !!data.workspaces?.length || hasWorkspace; const owner = me?.role === 'owner' && me.status === 'active'
  const scope = (data.workspace ?? '') + ':' + (data.packId ?? '')
  if (scope !== localScope || !connected) localSelected.clear()
  localScope = scope
  for (const target of main.querySelectorAll<HTMLElement>('.owner-only')) target.hidden = !owner
  for (const target of main.querySelectorAll<HTMLElement>('.host-only')) target.hidden = !data.hosted
  main.querySelector<HTMLElement>('[data-action=disconnect]')!.hidden = !connected
  el('connection-label').textContent = connected ? (data.hosted ? uiText("webview.collaboration.serviceEndPerspective") : uiText("webview.collaboration.clientView")) + ' · ' + me?.identity.login + ' · ' + ({ owner: uiText("webview.collaboration.superAdministrator"), reviewer: uiText("webview.collaboration.reviewManager"), member: uiText("webview.collaboration.members") })[me?.role ?? 'member'] + (me?.status === 'pending' ? uiText("webview.collaboration.pendingApprovalForAccession") : '') : uiText("webview.collaboration.localEditorVoluntarySubmissionApprovalAndUpdate")
  el('server-info').textContent = connected ? (data.p2pUuid ? 'P2P UUID: ' + data.p2pUuid + ' · ' : data.port ? uiText("webview.collaboration.httpsPort", data.port) : '') + (data.p2p ?? uiText("webview.collaboration.portConnection")) : uiText("ui.collaborationPanel.notConnected")
  const pack = el<HTMLSelectElement>('pack'), selectedPack = data.packId ?? pack.value
  pack.replaceChildren(...data.packs.map(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name + (data.workspaces?.some(workspace => workspace.packId === item.id) ? uiText("webview.collaboration.hasBeenWithdrawn") : ''); return option })); if (data.packs.some(item => item.id === selectedPack)) pack.value = selectedPack
  el('workspace-label').textContent = data.workspace ?? (data.checkoutRoot ? uiText("webview.collaboration.parentDirectoryTheCurrentResourcePackHas", data.checkoutRoot) : uiText("webview.collaboration.clickSelectResourcePacksAndPullTo")); el('workspace-label').title = data.workspace ?? ''
  const author = el<HTMLSelectElement>('author'), selectedAuthor = author.value, authors = new Map(proposals.map(proposal => [proposal.author.id, proposal.author.login])); const all = document.createElement('option'); all.value = ''; all.textContent = uiText("webview.collaboration.allUsers"); author.replaceChildren(all, ...[...authors].map(([id, login]) => { const option = document.createElement('option'); option.value = id; option.textContent = login; return option })); author.value = authors.has(selectedAuthor) ? selectedAuthor : ''
  el('change-count').textContent = String(data.changes.length); const local = el('local-changes')
  local.replaceChildren(...data.changes.map(change => { const label = node('label', '', 'local-file'), input = document.createElement('input'); input.type = 'checkbox'; input.value = change.path; input.checked = localSelected.has(change.path); input.addEventListener('change', () => { if (input.checked) localSelected.add(change.path); else localSelected.delete(change.path); buttonState() }); label.append(input, node('span', ({ added: uiText("webview.collaboration.add"), modified: uiText("webview.collaboration.modify"), deleted: uiText("webview.collaboration.delete") })[change.kind] ?? change.kind, 'change-kind'), node('span', change.path, 'local-file-name')); label.title = change.path; return label })); if (!data.changes.length) empty(local, data.workspace ? uiText("webview.collaboration.noLocalChanges") : uiText("webview.collaboration.editLocallyAfterPullingTheResourcePack"))
  el('conflicts').replaceChildren(...data.conflicts.map(conflict => { const line = node('div', '', 'conflict-row'); line.append(node('strong', uiText("webview.collaboration.conflict", conflict.path))); for (const [text, keep] of [[uiText("webview.collaboration.keepLocalAndPrepareForResubmission"), 'local'], [uiText("ui.collaborationPanel.useUpstream"), 'remote']]) { const button = node('button', text); button.addEventListener('click', () => send('resolve', { path: conflict.path, keep })); line.append(button) } return line }))
  if (data.autoFollow !== undefined) el<HTMLInputElement>('follow').checked = data.autoFollow
  if (!proposals.some(proposal => proposal.id === activeId)) { activeId = ''; activePath = ''; previewGeneration++; reviewSelected.clear() }; renderProposals(); activityState()
}
async function renderPreview(data: { proposalId: string; path: string; kind: string; before: string | null; after: string | null; beforeSize: number; afterSize: number; truncated: boolean }): Promise<void> {
  if (activeId !== data.proposalId || activePath !== data.path) return
  const generation = ++previewGeneration
  el('preview-title').textContent = data.path; el('preview-info').textContent = data.beforeSize + ' → ' + data.afterSize + uiText("browser.resources.bytes") + (data.truncated ? uiText("webview.collaboration.textPreviewsOnlyBeforeMib") : '')
  const body = el('preview-body'); body.replaceChildren()
  if (data.kind === 'text') { const pre = node('pre', '', 'text-diff'); for (const part of diffLines(data.before ?? '', data.after ?? '')) pre.append(node('span', part.value, part.added ? 'diff-added' : part.removed ? 'diff-removed' : '')); body.append(pre); return }
  if (data.kind !== 'image') { empty(body, uiText("webview.collaboration.binaryFileCanExportPreAndPost")); return }
  const pair = node('div', '', 'image-pair'), images: (HTMLImageElement | null)[] = []
  for (const [title, source] of [[uiText("webview.collaboration.beforeChange"), data.before], [uiText("webview.collaboration.afterChange"), data.after]]) { const pane = node('figure'), caption = node('figcaption', title ?? ''), frame = node('div', '', 'checkerboard'); pane.append(caption, frame); if (source) { const image = document.createElement('img'); image.src = source; image.alt = (title ?? '') + ' ' + data.path; frame.append(image); images.push(image) } else { frame.append(node('p', uiText("webview.collaboration.theVersionDoesNotExist"))); images.push(null) }; pair.append(pane) }; body.append(pair)
  if (!images[0] || !images[1]) return
  await Promise.all(images.map(image => image?.decode().catch(() => {})))
  if (activeId !== data.proposalId || activePath !== data.path || generation !== previewGeneration) return
  const [before, after] = images as HTMLImageElement[], width = Math.max(before.naturalWidth, after.naturalWidth), height = Math.max(before.naturalHeight, after.naturalHeight)
  el('preview-info').textContent += ' · ' + before.naturalWidth + '×' + before.naturalHeight + ' → ' + after.naturalWidth + '×' + after.naturalHeight
  if (!width || !height || width * height > 16 * 1024 ** 2) { body.append(node('p', uiText("webview.collaboration.keepAPreviewOfLargeSizePictures"), 'muted')); return }
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const context = canvas.getContext('2d')!; context.drawImage(before, 0, 0); const a = context.getImageData(0, 0, width, height); context.clearRect(0, 0, width, height); context.drawImage(after, 0, 0); const b = context.getImageData(0, 0, width, height), output = context.createImageData(width, height); let changed = 0
  for (let index = 0; index < a.data.length; index += 4) { const differs = [0, 1, 2, 3].some(channel => a.data[index + channel] !== b.data[index + channel]); if (differs) { changed++; output.data.set([235, 117, 64, 255], index) } else output.data.set([b.data[index], b.data[index + 1], b.data[index + 2], Math.round(b.data[index + 3] * 0.2)], index) }
  context.putImageData(output, 0, 0); const figure = node('figure', '', 'pixel-diff'), frame = node('div', '', 'checkerboard'); figure.append(node('figcaption', uiText("webview.collaboration.pixelsDifferencePixelsChangeOrangeMark", changed)), frame); frame.append(canvas); body.append(figure)
}
main.addEventListener('click', event => { const button = (event.target as Element).closest<HTMLButtonElement>('[data-action]'); if (!button || button.disabled) return; const command = button.dataset.action!; send(command, command === 'submit' ? { paths: checked(el('local-changes')) } : command === 'host' ? { customDirectory: button.dataset.customDirectory === 'true' } : command === 'pull' ? { packId: el<HTMLSelectElement>('pack').value } : {}) })
el<HTMLSelectElement>('pack').addEventListener('change', () => send('pack', { id: el<HTMLSelectElement>('pack').value }))
el('author').addEventListener('change', renderProposals)
el('toggle-local').addEventListener('click', () => { const inputs = [...el('local-changes').querySelectorAll<HTMLInputElement>('input')], value = inputs.some(input => !input.checked); for (const input of inputs) { input.checked = value; if (value) localSelected.add(input.value); else localSelected.delete(input.value) }; buttonState() })
el('toggle-review').addEventListener('click', () => { const inputs = [...el('review-files').querySelectorAll<HTMLInputElement>('input:not(:disabled)')], value = inputs.some(input => !input.checked); for (const input of inputs) { input.checked = value; if (value) reviewSelected.add(input.value); else reviewSelected.delete(input.value) }; buttonState() })
for (const [id, decision] of [['approve', 'approved'], ['reject', 'rejected']]) el(id).addEventListener('click', () => send('review', { id: activeId, paths: checked(el('review-files')), decision, comment: el<HTMLInputElement>('comment').value }))
for (const side of ['before', 'after']) el('model-' + side).addEventListener('click', () => send('model', { id: activeId, path: activePath, side }))
el('follow').addEventListener('change', () => send('follow', { value: el<HTMLInputElement>('follow').checked }))
window.addEventListener('message', event => {
  const data = event.data
  if (!data || typeof data !== 'object') return
  if (data.type === 'state') renderState(data)
  else if (data.type === 'notice') notice(data.text, data.error)
  else if (data.type === 'follow' && typeof data.value === 'boolean') el<HTMLInputElement>('follow').checked = data.value
  else if (data.type === 'operation' && typeof data.id === 'string') {
    const previous = operations.get(data.id)
    if (data.status === 'done') {
      operations.delete(data.id)
      if (data.error && previous?.command === 'preview' && previous.proposalId === activeId && previous.path === activePath) empty(el('preview-body'), uiText("webview.collaboration.fileDifferencesFailedToLoadAndRe"))
    } else if (data.status === 'queued' || data.status === 'running') operations.set(data.id, { ...previous, id: data.id, command: data.command, label: data.label, status: data.status })
    activityState()
  } else if (data.type === 'preview') void renderPreview(data).catch(() => notice(uiText("webview.collaboration.imagePreviewFailedTheFileMayNot"), true))
})
buttonState(); send('ready')
