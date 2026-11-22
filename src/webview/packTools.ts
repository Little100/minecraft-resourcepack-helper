import { uiHtml, uiText } from '../i18n/messages'
import { parsePackFormat } from '../core/packFormatValue'
import { diagnoseResourcePack, inferPackVersion } from '../core/advanced/packDiagnostics'
import { renderPackDiagnosis } from './packDiagnosis'
import { mountModTextures } from './modTextures'
import { withPackRequirements } from '../core/advanced/packRequirements'
import { Zip, ZipDeflate } from 'fflate'
import { readBrowserPackArchive } from '../core/browserPackProject'
import { planPackMerge, resolvePackMerge, type PackMergeInput, type PackMergePlan, type PackMergeChoice, type PackMergeStrategy, type PackMergeEntry } from '../core/advanced/packMerge'
import { listPackConversionTargets, convertResourcePack } from '../core/advanced/packConversion'
import { PACK_TOOLS_LIMITS, PackToolsResponseSchema, decodePackToolsBytes, decodePackToolsFiles, encodePackToolsBytes, filterPackToolsSources, validatePackToolsFiles, type PackToolsFile, type PackToolsResponse } from '../core/advanced/packToolsProtocol'
import { embedTextureWatermark } from '../core/textureWatermark'
import { parseTextureWatermarkSettings } from '../core/textureWatermarkSettings'

interface PackToolsOptions { post(message: unknown): void; includeVanilla(): boolean; includeMcrhEditorData?(): boolean; watermark(): unknown }
interface ImportedPack { input: PackMergeInput; enabled: boolean; selected: Set<string>; archiveBytes: number }
interface PackToolsOutput { files: PackToolsFile[]; name: string; warnings: string[]; changes: string[]; unsupported: string[]; kind: 'merge' | 'conversion' }
interface PendingRequest { resolve(response: PackToolsResponse): void; reject(error: Error): void; timeout: ReturnType<typeof setTimeout> }
const escape = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))
const sizeText = (bytes: number): string => bytes < 1024 ? bytes + ' B' : bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + ' KiB' : (bytes / 1024 / 1024).toFixed(1) + ' MiB'
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => left.length === right.length && left.every((byte, index) => byte === right[index])
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
const PAGE_SIZE = 60

export function createPackTools(container: HTMLElement, options: PackToolsOptions): { hasSession(): boolean; openConversion(projectToken?: string): void; receive(message: unknown): void; dispose(): void } {
  container.classList.add('pack-tools')
  container.innerHTML = `<article class="pack-intro"><div class="pack-import-toolbar"><h2>${uiHtml("webview.packTools.inputPacks")}</h2><div class="pack-actions"><button type="button" data-pack-action="import" class="primary">${uiHtml("webview.packTools.importResourcePackZips")}</button><button type="button" data-pack-action="project">${uiHtml("webview.packTools.readCurrentProject")}</button></div></div><details class="pack-help pack-import-help"><summary><span>${uiHtml("webview.packTools.zipResourcePackMultipleOptionsLocalProcessing")}</span><span class="pack-help-action">${uiHtml("webview.advanced.scopeOfProcessing")}</span></summary><p>${uiHtml("webview.packTools.multipleZipsAreSupportedFilesOnlyHandle")}</p></details></article>
  <div class="pack-feedback"><output class="pack-status" role="status" aria-live="polite">${uiHtml("webview.packTools.importAZipOrReadTheCurrent")}</output><button type="button" data-pack-action="cancel" hidden>${uiHtml("webview.packTools.cancelOperation")}</button></div>
<article class="card pack-sources" data-pack-sources hidden><div class="pack-section-heading"><h2>${uiHtml("webview.packTools.importedResourcePacks")}</h2><span data-pack-count class="muted">${uiHtml("webview.packTools.bags")}</span></div><div class="pack-table-scroll"><table class="pack-table"><thead><tr><th scope="col">${uiHtml("webview.packTools.participationInIntegration")}</th><th scope="col">${uiHtml("ui.advancedPanel.resourcePack")}</th><th scope="col">${uiHtml("webview.packTools.selectedFile")}</th><th scope="col">${uiHtml("webview.packTools.volume")}</th><th scope="col">${uiHtml("webview.packTools.operation")}</th></tr></thead><tbody data-pack-list></tbody></table></div><p data-pack-empty hidden>${uiHtml("webview.packTools.notYetImportedResourcePack")}</p></article>
<div class="pack-mode-tabs" role="tablist" aria-label="${uiHtml("webview.packTools.resourcePackOperation")}"><button type="button" role="tab" id="pack-tab-merge" data-pack-mode="merge" aria-controls="pack-panel-merge" aria-selected="true" tabindex="0">${uiHtml("webview.packTools.collapseAndMerge")}</button><button type="button" role="tab" id="pack-tab-conversion" data-pack-mode="conversion" aria-controls="pack-panel-conversion" aria-selected="false" tabindex="-1">${uiHtml("ui.sidebarTree.versionConversion")}</button><button type="button" role="tab" id="pack-tab-diagnosis" data-pack-mode="diagnosis" aria-controls="pack-panel-diagnosis" aria-selected="false" tabindex="-1">${uiHtml("webview.packTools.diagnosisOfTheResourceKit")}</button><button type="button" role="tab" id="pack-tab-mods" data-pack-mode="mods" aria-controls="pack-panel-mods" aria-selected="false" tabindex="-1">${uiHtml("webview.packTools.modTextures")}</button></div>
<section class="pack-mode-panel" role="tabpanel" id="pack-panel-merge" aria-labelledby="pack-tab-merge" data-pack-panel="merge" ><div class="pack-empty-workspace" data-pack-welcome><h2>${uiHtml("webview.packTools.notYetImportedResourcePack")}</h2><p>${uiHtml("webview.packTools.selectHereTheFileAndHandleConflicts")}</p></div><article class="card" data-pack-files-card hidden><div class="pack-section-heading"><h2>${uiHtml("webview.packTools.selectFiles")}</h2><div class="pack-actions"><button type="button" data-pack-action="select-all">${uiHtml("webview.packTools.checkForFilterResults")}</button><button type="button" data-pack-action="select-none">${uiHtml("webview.packTools.excludesFilterResults")}</button></div></div><div class="pack-filters"><label>${uiHtml("ui.advancedPanel.resourcePack")}<select data-pack-filter><option value="">${uiHtml("webview.packTools.allResourcePacks")}</option></select></label><label>${uiHtml("webview.packTools.filePath")}<input type="search" data-pack-search placeholder="${uiHtml("webview.packTools.filterByPath")}" aria-label="${uiHtml("webview.packTools.filterFilePath")}"></label></div><div class="pack-table-scroll"><table class="pack-table"><thead><tr><th scope="col">${uiHtml("ui.convertCommand.keep")}</th><th scope="col">${uiHtml("webview.packTools.filePath")}</th><th scope="col">${uiHtml("webview.packTools.sourcePackageSource")}</th><th scope="col">${uiHtml("webview.packTools.volume")}</th></tr></thead><tbody data-pack-files></tbody></table></div><div class="pack-pagination" data-pack-pagination="files"></div></article><article class="card" data-pack-conflicts-card hidden><div class="pack-section-heading"><h2>${uiHtml("webview.packTools.conflictWithThePath")}</h2><span data-conflict-count class="muted">${uiHtml("webview.packTools.conflicts")}</span></div><div class="pack-actions"><label>${uiHtml("webview.packTools.batchPolicy")}<select data-pack-strategy><option value="manual">${uiHtml("webview.packTools.selectManually")}</option><option value="latest">${uiHtml("webview.packTools.keepOnlyTheLatestFile")}</option><option value="exclude">${uiHtml("webview.packTools.allConflictsAreGone")}</option></select></label><button type="button" data-pack-action="batch">${uiHtml("webview.packTools.applyToAllConflicts")}</button></div><p class="muted">${uiHtml("webview.packTools.eachLineCanChooseWhichPackageTo")}</p><div class="pack-table-scroll"><table class="pack-table"><thead><tr><th scope="col">${uiHtml("webview.packTools.pathToConflict")}</th><th scope="col">${uiHtml("webview.packTools.candidateSource")}</th><th scope="col">${uiHtml("webview.packTools.retainResults")}</th></tr></thead><tbody data-pack-conflicts></tbody></table></div><div class="pack-pagination" data-pack-pagination="conflicts"></div></article><div class="pack-merge-footer" data-pack-merge-footer hidden><p class="muted" data-pack-merge-summary></p><button type="button" data-pack-action="merge" class="primary">${uiHtml("webview.packTools.previewIntegrationResults")}</button></div></section>
<section class="pack-mode-panel" role="tabpanel" id="pack-panel-conversion" aria-labelledby="pack-tab-conversion" data-pack-panel="conversion" hidden><article class="card pack-task-card" data-conversion-card tabindex="-1"><h2>${uiHtml("ui.sidebarTree.versionConversion")}</h2><p class="muted">${uiHtml("webview.packTools.selectTheActualSourceAndTargetVersions")}</p><details class="pack-help"><summary>${uiHtml("webview.packTools.conversionRangeAndLimits")}</summary><p>${uiHtml("webview.packTools.convertingOnlyUnsupportedContentSuchAsValidated")}</p></details><div class="pack-conversion-fields"><label>${uiHtml("webview.packTools.convertInput")}<select data-conversion-input><option value="merge">${uiHtml("webview.packTools.currentIntegrationResults")}</option></select></label><label>${uiHtml("webview.packTools.actualSourceVersion")}<select data-conversion-source></select></label><label>${uiHtml("webview.packTools.targetVersion")}<select data-conversion-target></select></label></div><p data-conversion-limitations class="notice">${uiHtml("webview.packTools.selectTheActualSourceVersionAndThe")}</p><button type="button" data-pack-action="convert">${uiHtml("webview.packTools.analyseAndPreviewConversions")}</button></article></section>
<section class="pack-mode-panel" role="tabpanel" id="pack-panel-diagnosis" aria-labelledby="pack-tab-diagnosis" data-pack-panel="diagnosis" hidden><article class="card pack-task-card" data-diagnosis-card><h2>${uiHtml("pack.diagnose")}</h2><p class="muted">${uiHtml("webview.packTools.searchForProblemsInJsonVersionStatements")}</p><div class="pack-conversion-fields"><label>${uiHtml("webview.packTools.diagnosisInput")}<select data-diagnosis-input><option value="merge">${uiHtml("webview.packTools.currentIntegrationResults")}</option></select></label><label>${uiHtml("webview.packTools.gameDestinationVersion")}<select data-diagnosis-target></select></label></div><button type="button" data-pack-action="diagnose">${uiHtml("pack.diagnosePack")}</button><div data-diagnosis-report aria-live="polite"></div></article></section>
<section class="pack-mode-panel" role="tabpanel" id="pack-panel-mods" aria-labelledby="pack-tab-mods" data-pack-panel="mods" hidden><div data-mod-textures-root></div></section>
<article class="card pack-output" hidden><div class="pack-section-heading"><h2>${uiHtml("webview.packTools.resultsPreviewAndExport")}</h2><strong data-output-summary>${uiHtml("webview.packTools.resultsNotProduced")}</strong></div><div data-pack-report></div><div class="pack-table-scroll"><table class="pack-table"><thead><tr><th scope="col">${uiHtml("webview.packTools.outputPath")}</th><th scope="col">${uiHtml("webview.packTools.source")}</th><th scope="col">${uiHtml("webview.packTools.volume")}</th></tr></thead><tbody data-pack-output></tbody></table></div><div class="pack-pagination" data-pack-pagination="output"></div><div class="pack-export-row"><label>${uiHtml("webview.packTools.zipFilename")}<input type="text" data-pack-name value="merged-pack" maxlength="240"></label><button type="button" data-pack-action="export" class="primary pack-export-button" disabled>${uiHtml("webview.packTools.exportResultsZip")}</button></div><p class="muted">${uiHtml("webview.packTools.exportOriginalResourceWithTopMrchEditing")}</p></article>`
  const get = <T extends Element = HTMLElement>(selector: string): T => container.querySelector<T>(selector)!
  const targets = listPackConversionTargets()
  get<HTMLSelectElement>('[data-conversion-source]').innerHTML = `<option value="">${uiHtml("webview.packTools.selectTheActualSourceVersion")}</option>${targets.map(target => `<option value="${escape(target.id)}" ${target.supported ? '' : 'disabled'}>${escape(target.label)}${target.supported ? '' : uiHtml("webview.packTools.notSupportedForTheTimeBeingQualifier")}</option>`).join('')}`
  get<HTMLSelectElement>('[data-conversion-target]').innerHTML = `<option value="">${uiHtml("webview.packTools.selectTheSupportedTarget")}</option>${targets.map(target => `<option value="${escape(target.id)}" ${target.supported ? '' : 'disabled'}>${escape(target.label)}${target.supported ? '' : uiHtml("webview.packTools.notSupportedForTheTimeBeingQualifier")}</option>`).join('')}`
  get<HTMLSelectElement>('[data-diagnosis-target]').innerHTML = `<option value="">${uiHtml("webview.packTools.selectARealRunVersionOfThe")}</option>${targets.map(target => `<option value="${escape(target.id)}">${escape(target.id)}</option>`).join('')}`
  const packs: ImportedPack[] = [], pending = new Map<string, PendingRequest>()
  let plan: PackMergePlan | undefined, output: PackToolsOutput | undefined, strategy: PackMergeStrategy = 'manual', resolutions: Record<string, PackMergeChoice> = Object.create(null)
  let filePage = 0, conflictPage = 0, outputPage = 0, serial = 0, busy = false, disposed = false, generation = 0
  let pendingConversion: string | undefined
  const modTextures = mountModTextures(get('[data-mod-textures-root]'), options.post)
  type PackMode = 'merge' | 'conversion' | 'diagnosis' | 'mods'
  const setMode = (mode: PackMode): void => {
    for (const tab of container.querySelectorAll<HTMLButtonElement>('[data-pack-mode]')) { const active = tab.dataset.packMode === mode; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1 }
    for (const panel of container.querySelectorAll<HTMLElement>('[data-pack-panel]')) panel.hidden = panel.dataset.packPanel !== mode
  }
  const keydown = (event: KeyboardEvent): void => {
    const tab = (event.target as Element).closest<HTMLButtonElement>('[data-pack-mode]')
    if (!tab || busy || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[data-pack-mode]')], index = tabs.indexOf(tab)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    setMode(tabs[next]!.dataset.packMode as PackMode); tabs[next]!.focus()
  }
  const setStatus = (text: string): void => { get('.pack-status').textContent = (text) }
  const rpc = (command: string, payload: Record<string, unknown> = {}): Promise<PackToolsResponse> => new Promise((resolve, reject) => {
    const requestId = 'pack-tools-' + Date.now().toString(36) + '-' + (++serial)
    const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error(uiText("webview.packTools.fileOperationWaitingForTimeoutPleaseTry"))) }, 300000)
    pending.set(requestId, { resolve, reject, timeout })
    try { options.post({ command, requestId, ...payload }) } catch (error) { clearTimeout(timeout); pending.delete(requestId); reject(error) }
  })
  const originText = (origin: string | undefined): string => origin === 'vanilla' ? uiText("ui.vanillaPreviewPanel.originalResources") : origin === 'modified' ? uiText("webview.packTools.modified") : uiText("webview.packTools.userUnknown")
  const rows = () => packs.filter(pack => !get<HTMLSelectElement>('[data-pack-filter]').value || pack.input.id === get<HTMLSelectElement>('[data-pack-filter]').value).flatMap(pack => pack.input.files.filter(file => file.path.toLowerCase().includes(get<HTMLInputElement>('[data-pack-search]').value.trim().toLowerCase())).map(file => ({ pack, file })))
  const paginate = (kind: string, page: number, total: number): number => {
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE)), current = Math.max(0, Math.min(page, pages - 1))
    get('[data-pack-pagination="' + kind + '"]').innerHTML = `<span>${uiHtml("webview.packTools.itemPage", total, current + 1, pages)}</span><button type="button" data-page="${kind}" data-direction="-1" ${current === 0 || busy ? 'disabled' : ''}>${uiHtml("browser.resources.previousPage")}</button><button type="button" data-page="${kind}" data-direction="1" ${current === pages - 1 || busy ? 'disabled' : ''}>${uiHtml("browser.resources.nextPage")}</button>`
    return current
  }
  const chosen = (entry: PackMergeEntry): PackMergeChoice | undefined => {
    if (resolutions[entry.path]) return resolutions[entry.path]
    if (strategy === 'exclude') return 'exclude'
    if (typeof strategy === 'object') { const packId = strategy.packId; return entry.candidates.some(candidate => candidate.packId === packId) ? { packId } : undefined }
    if (strategy === 'latest') {
      if (entry.candidates.some(candidate => candidate.modifiedAt === undefined)) return undefined
      const sorted = [...entry.candidates].sort((left, right) => right.modifiedAt! - left.modifiedAt!)
      if (sorted[0] && sorted[0].modifiedAt !== sorted[1]?.modifiedAt) return { packId: sorted[0].packId }
    }
    return undefined
  }
  const renderFiles = (): void => {
    const all = rows(); filePage = paginate('files', filePage, all.length)
    get('[data-pack-files]').innerHTML = all.slice(filePage * PAGE_SIZE, (filePage + 1) * PAGE_SIZE).map(({ pack, file }) => `<tr><td><input type="checkbox" data-file-pack="${escape(pack.input.id)}" data-file-path="${escape(file.path)}" aria-label="${uiHtml("webview.packTools.reservations", pack.input.name + ' / ' + file.path)}" ${pack.selected.has(file.path) ? 'checked' : ''} ${busy ? 'disabled' : ''}></td><td class="pack-path">${escape(file.path)}</td><td>${escape(pack.input.name)}<small>${escape(originText(file.origin))}${pack.enabled ? '' : uiHtml("webview.packTools.packageExcludedQualifier")}</small></td><td>${sizeText(file.bytes.length)}</td></tr>`).join('')
  }
  const renderConflicts = (): void => {
    get<HTMLElement>('[data-pack-conflicts-card]').hidden = !plan?.conflicts.length
    const conflicts = plan?.conflicts ?? []; conflictPage = paginate('conflicts', conflictPage, conflicts.length)
    const unresolved = conflicts.filter(entry => !chosen(entry)).length
    get('[data-conflict-count]').textContent = conflicts.length + uiText("webview.packTools.conflict") + unresolved + uiText("webview.packTools.oneToChoose")
    get('[data-pack-conflicts]').innerHTML = conflicts.slice(conflictPage * PAGE_SIZE, (conflictPage + 1) * PAGE_SIZE).map(entry => {
      const choice = chosen(entry), value = choice === 'exclude' ? 'exclude' : choice?.packId ?? ''
      return `<tr><td class="pack-path">${escape(entry.path)}</td><td>${entry.candidates.map(candidate => `<div>${escape(candidate.packName)}<small>${sizeText(candidate.byteLength)} · ${candidate.modifiedAt === undefined ? uiHtml("webview.packTools.noReliableChangeTime") : escape(new Date(candidate.modifiedAt).toISOString().replace('T', ' ').slice(0, 19) + ' UTC')}</small></div>`).join('')}</td><td><select data-conflict-path="${escape(entry.path)}" aria-label="${uiHtml("webview.packTools.conflictRetainSource", entry.path)}" ${busy ? 'disabled' : ''}><option value="" ${!value ? 'selected' : ''}>${uiHtml("webview.packTools.pleaseChoose")}</option><option value="exclude" ${value === 'exclude' ? 'selected' : ''}>${uiHtml("webview.packTools.noneOfThem")}</option>${entry.candidates.map(candidate => `<option value="${escape(candidate.packId)}" ${value === candidate.packId ? 'selected' : ''}>${escape(candidate.packName)}</option>`).join('')}</select></td></tr>`
    }).join('')
  }
  const reportList = (title: string, items: readonly string[], kind = ''): string => items.length ? `<details class="pack-report ${kind}" open><summary>${escape(title)} (${items.length})</summary><ul>${items.map(item => '<li>' + escape(item) + '</li>').join('')}</ul></details>` : ''
  const renderOutput = (): void => {
    get<HTMLElement>('.pack-output').hidden = !output
    const files = output?.files ?? []; outputPage = paginate('output', outputPage, files.length)
    get('[data-output-summary]').textContent = output ? output.unsupported.length ? uiText("webview.packTools.theConversionIsBlocked") : files.length + uiText("webview.packTools.aFile") + sizeText(files.reduce((total, file) => total + file.content.length, 0)) : uiText("webview.packTools.resultsNotProduced")
    get('[data-pack-output]').innerHTML = files.slice(outputPage * PAGE_SIZE, (outputPage + 1) * PAGE_SIZE).map(file => `<tr><td class="pack-path">${escape(file.path)}</td><td>${escape(originText(file.origin))}</td><td>${sizeText(file.content.length)}</td></tr>`).join('')
    get('[data-pack-report]').innerHTML = output ? reportList(uiText("webview.packTools.actualChanges"), output.changes) + reportList(uiText("webview.packTools.attention"), output.warnings, 'pack-warning') + reportList(uiText("webview.packTools.needManualProcessing"), output.unsupported, 'pack-error') : ''
    get<HTMLButtonElement>('[data-pack-action="export"]').disabled = busy || !output || !output.files.length || output.unsupported.length > 0
  }
  const renderPacks = (): void => {
    for (const selector of ['[data-pack-sources]', '[data-pack-files-card]', '[data-pack-merge-footer]']) get<HTMLElement>(selector).hidden = packs.length === 0
    get<HTMLElement>('[data-pack-welcome]').hidden = packs.length > 0
    get('[data-pack-merge-summary]').textContent = packs.length + uiText("webview.packTools.aBag") + packs.reduce((sum, pack) => sum + (pack.enabled ? pack.selected.size : 0), 0) + uiText("webview.packTools.selectedFiles")
    get('[data-pack-count]').textContent = packs.length + uiText("webview.packTools.aBag") + sizeText(packs.reduce((total, pack) => total + pack.input.files.reduce((sum, file) => sum + file.bytes.length, 0), 0))
    get<HTMLElement>('[data-pack-empty]').hidden = packs.length > 0
    get('[data-pack-list]').innerHTML = packs.map(pack => `<tr><td><input type="checkbox" data-pack-enabled="${escape(pack.input.id)}" aria-label="${uiHtml("webview.packTools.participationInIntegration_2e6ca7", pack.input.name)}" ${pack.enabled ? 'checked' : ''} ${busy ? 'disabled' : ''}></td><td>${escape(pack.input.name)}</td><td>${pack.selected.size} / ${pack.input.files.length}</td><td>${sizeText(pack.input.files.reduce((total, file) => total + file.bytes.length, 0))}</td><td><button type="button" data-remove-pack="${escape(pack.input.id)}" ${busy ? 'disabled' : ''}>${uiHtml("webview.packTools.remove")}</button></td></tr>`).join('')
    const update = (selector: string, initial: string): void => { const select = get<HTMLSelectElement>(selector), previous = select.value; select.innerHTML = initial + packs.map(pack => `<option value="${escape(pack.input.id)}">${escape(pack.input.name)}</option>`).join(''); if ([...select.options].some(option => option.value === previous)) select.value = previous }
    update('[data-pack-filter]', `<option value="">${uiHtml("webview.packTools.allResourcePacks")}</option>`)
    update('[data-conversion-input]', `<option value="merge">${uiHtml("webview.packTools.currentIntegrationResults")}</option>`)
    update('[data-diagnosis-input]', `<option value="merge">${uiHtml("webview.packTools.currentIntegrationResults")}</option>`)
    update('[data-pack-strategy]', `<option value="manual">${uiHtml("webview.packTools.selectManually")}</option><option value="latest">${uiHtml("webview.packTools.keepOnlyTheLatestFile")}</option><option value="exclude">${uiHtml("webview.packTools.allConflictsAreGone")}</option>`)
  }
  const invalidate = (): void => { output = undefined; outputPage = 0; renderOutput() }
  const replan = (): void => {
    invalidate()
    const selections = Object.fromEntries(packs.map(pack => [pack.input.id, { include: pack.enabled ? [...pack.selected] : [] }]))
    plan = packs.length ? planPackMerge(packs.map(pack => pack.input), selections) : undefined
    renderPacks(); renderFiles(); renderConflicts()
  }
  const ensureMetadata = (files: readonly PackToolsFile[]): void => {
    const metadata = files.find(file => file.path === 'pack.mcmeta')
    if (!metadata) throw new Error(uiText("webview.packTools.theResultIsALackOfPack"))
    if (metadata.content.length > 1024 * 1024) throw new Error(uiText("webview.packTools.packMcmetaOverMib"))
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadata.content).replace(/^\uFEFF/, '')) as { pack?: { description?: unknown; pack_format?: unknown; min_format?: unknown; max_format?: unknown } }
    const format = (input: unknown): boolean => Boolean(parsePackFormat(input))
    if (!value?.pack || value.pack.description === undefined || !(typeof value.pack.pack_format === 'number' && format(value.pack.pack_format) || format(value.pack.min_format) && format(value.pack.max_format))) throw new Error(uiText("webview.packTools.packMcmetaMissingPackageDescriptionOrClear"))
  }
  const merged = (): PackToolsOutput => {
    if (!plan) throw new Error(uiText("webview.packTools.pleaseImportAtLeastOneResourcePack"))
    const result = resolvePackMerge(plan, { strategy, resolutions })
    if (result.unresolved.length) throw new Error(uiText("webview.packTools.stillNoConflictsSelectedPleaseProcessA", result.unresolved.length))
    const files = result.files.map(file => ({ path: file.path, content: file.content, origin: file.provenance.origin, modifiedAt: file.provenance.modifiedAt }))
    ensureMetadata(files); validatePackToolsFiles(files)
    return { files, name: 'merged-pack', warnings: result.warnings.map(warning => warning.message), changes: [], unsupported: [], kind: 'merge' }
  }
  const addPacks = async (response: PackToolsResponse): Promise<void> => {
    if (response.canceled) { setStatus(uiText("webview.packTools.cancelledImport")); return }
    if (packs.length + (response.archives?.length ?? 0) + (response.files ? 1 : 0) > PACK_TOOLS_LIMITS.packs) throw new Error(uiText("webview.packTools.theTotalNumberOfImportedPackagesExceeds"))
    const staged: ImportedPack[] = [], token = generation
    let compressed = packs.reduce((total, pack) => total + pack.archiveBytes, 0)
    for (const archive of response.archives ?? []) {
      compressed += archive.base64.length / 4 * 3 - (archive.base64.endsWith('==') ? 2 : archive.base64.endsWith('=') ? 1 : 0)
      if (compressed > PACK_TOOLS_LIMITS.bytes) throw new Error(uiText("webview.packTools.allCompressedAggregatesOfImportedZipExceed"))
      setStatus(uiText("webview.packTools.verifying", archive.name)); await tick(); if (token !== generation) throw new Error(uiText("browser.packToolsBridge.operationCanceled"))
      const bytes = decodePackToolsBytes(archive.base64, PACK_TOOLS_LIMITS.bytes)
      const retained = [...packs, ...staged].flatMap(pack => pack.input.files)
      const remainingBytes = PACK_TOOLS_LIMITS.bytes - retained.reduce((total, file) => total + file.bytes.length, 0), remainingEntries = PACK_TOOLS_LIMITS.entries - retained.length
      if (remainingBytes <= 0 || remainingEntries <= 0) throw new Error(uiText("webview.packTools.importResourceHasExhaustedTheOverallBudget"))
      const resources = readBrowserPackArchive(bytes, { maxArchiveBytes: PACK_TOOLS_LIMITS.bytes, maxCompressedBytes: PACK_TOOLS_LIMITS.bytes, maxUncompressedBytes: remainingBytes, maxFiles: remainingEntries, maxFileBytes: PACK_TOOLS_LIMITS.fileBytes })
      const input: PackMergeInput = { id: 'pack-' + (++serial), name: archive.name, files: resources.map(resource => ({ path: resource.path, bytes: resource.data, modifiedAt: resource.modifiedAt, origin: 'user' })) }
      staged.push({ input, enabled: true, selected: new Set(input.files.map(file => file.path)), archiveBytes: bytes.length })
    }
    if (response.files) {
      const retained = [...packs, ...staged].flatMap(pack => pack.input.files)
      const incoming = response.files.reduce((total, file) => total + file.base64.length / 4 * 3 - (file.base64.endsWith('==') ? 2 : file.base64.endsWith('=') ? 1 : 0), 0)
      if (retained.length + response.files.length > PACK_TOOLS_LIMITS.entries || retained.reduce((total, file) => total + file.bytes.length, 0) + incoming > PACK_TOOLS_LIMITS.bytes) throw new Error(uiText("webview.packTools.projectSnapshotAndExistingPackagesCumulativelyExceed"))
      const files = decodePackToolsFiles(response.files)
      const input: PackMergeInput = { id: 'pack-' + (++serial), name: response.name || uiText("webview.packTools.projectSnapshot"), files: files.map(file => ({ path: file.path, bytes: file.content, origin: file.origin, modifiedAt: file.modifiedAt })) }
      staged.push({ input, enabled: true, selected: new Set(input.files.map(file => file.path)), archiveBytes: 0 })
    }
    if (!staged.length) throw new Error(uiText("webview.packTools.noResourcePackFileToImport"))
    planPackMerge([...packs, ...staged].map(pack => pack.input))
    if (token !== generation) throw new Error(uiText("browser.packToolsBridge.operationCanceled"))
    packs.push(...staged); resolutions = Object.create(null); replan(); setStatus(uiText("webview.packTools.importedPacketPleaseCheckTheFileAnd", staged.length))
  }
  const convert = async (): Promise<void> => {
    const id = get<HTMLSelectElement>('[data-conversion-input]').value, sourceVersion = get<HTMLSelectElement>('[data-conversion-source]').value, targetVersion = get<HTMLSelectElement>('[data-conversion-target]').value
    if (!targets.some(target => target.id === sourceVersion && target.supported) || !targets.some(target => target.id === targetVersion && target.supported)) throw new Error(uiText("webview.packTools.selectTheActualSourceAndSupportedTarget"))
    const pack = packs.find(pack => pack.input.id === id)
    const files: PackToolsFile[] = id === 'merge' ? merged().files : pack ? pack.input.files.filter(file => pack.selected.has(file.path)).map(file => ({ path: file.path, content: file.bytes, origin: file.origin ?? 'user', modifiedAt: file.modifiedAt })) : []
    ensureMetadata(files)
    const token = generation
    setStatus(uiText("webview.packTools.resourceMigrationAndReconciliationOfSupportBorders")); await tick(); if (token !== generation) throw new Error(uiText("browser.packToolsBridge.operationCanceled"))
    const result = convertResourcePack(files, { sourceVersion, targetVersion })
    if (token !== generation) throw new Error(uiText("browser.packToolsBridge.operationCanceled"))
    const byPath = new Map(files.map(file => [file.path, file]))
    const renamedFrom = new Map(result.changes.filter(change => change.kind === 'rename' && change.sourcePath).map(change => [change.path, change.sourcePath!]))
    const converted = result.unsupported.length ? [] : result.files.map(file => {
      const bytes = typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content
      const original = byPath.get(file.path) ?? byPath.get(renamedFrom.get(file.path) ?? '')
      const unchanged = original && sameBytes(original.content, bytes)
      return { path: file.path, content: bytes, origin: unchanged ? original.origin : 'modified' as const, ...(unchanged && original.modifiedAt !== undefined ? { modifiedAt: original.modifiedAt } : {}) }
    })
    if (result.changes.some(change => change.kind === 'generate' && change.sourcePath && byPath.get(change.sourcePath)?.origin === 'vanilla')) result.warnings.push(uiText("webview.packTools.theTailoringOrGeneratingResourceOfThe"))
    validatePackToolsFiles(converted)
    output = { files: converted, name: (pack?.input.name.replace(/\.zip$/i, '') || 'merged-pack') + '-' + targetVersion, warnings: result.warnings, unsupported: result.unsupported, changes: result.changes.map(change => ({ rename: uiText("webview.packTools.pathMigration"), rewrite: uiText("webview.packTools.contentUpdate"), generate: uiText("webview.packTools.addFile"), remove: uiText("webview.packTools.removeFile") }[change.kind]) + ' · ' + (change.sourcePath && change.sourcePath !== change.path ? change.sourcePath + ' → ' : '') + change.path + ' · ' + change.detail), kind: 'conversion' }
    get<HTMLInputElement>('[data-pack-name]').value = output.name; renderOutput(); setStatus(result.unsupported.length ? uiText("webview.packTools.thereIsUnsupportedContentWhichPreventsExport") : uiText("webview.packTools.conversionAnalysisCompleteCheckForActualChanges"))
  }
  const applyWatermark = async (files: readonly PackToolsFile[], token: number): Promise<PackToolsFile[]> => {
    const settings = parseTextureWatermarkSettings(options.watermark())
    if (!settings) return [...files]
    const marked: PackToolsFile[] = [], paths = new Set(files.map(file => file.path)); let count = 0, skipped = 0
    for (const file of files) {
      if (token !== generation) throw new Error(uiText("browser.packToolsBridge.operationCanceled"))
      if (!/^assets\/[^/]+\/textures\/.+\.png$/i.test(file.path) || /\/textures\/(?:colormap|font)\//i.test(file.path) || /_(?:n|s|e|r|m|ao|h|height|normal|roughness|metallic|emissive)\.png$/i.test(file.path) || paths.has(file.path + '.mcmeta')) { marked.push(file); continue }
      const bytes = file.content
      if (bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) { marked.push(file); skipped++; continue }
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), width = view.getUint32(16), height = view.getUint32(20)
      if (width < 256 || height < 256 || width > 4096 || height > 4096 || width * height > 4 * 1024 * 1024) { marked.push(file); skipped++; continue }
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(bytes)], { type: 'image/png' }))
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
      const context = canvas.getContext('2d', { willReadFrequently: true }); if (!context) { bitmap.close(); throw new Error(uiText("webview.packTools.couldNotCloseTemporaryFolderS")) }
      context.drawImage(bitmap, 0, 0); bitmap.close()
      const image = context.getImageData(0, 0, width, height)
      let opaque = true; for (let index = 3; index < image.data.length; index += 4) if (image.data[index] !== 255) { opaque = false; break }
      if (!opaque) { marked.push(file); skipped++; continue }
      const result = await embedTextureWatermark({ width, height, data: image.data }, settings)
      image.data.set(result.image.data); context.putImageData(image, 0, 0)
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error(uiText("webview.packTools.pngWatermarkCodeFailed"))), 'image/png'))
      marked.push({ ...file, content: new Uint8Array(await blob.arrayBuffer()), origin: 'modified' }); count++
      setStatus(uiText("webview.packTools.addingWatermarksProcessedChang", count)); await tick()
    }
    setStatus(uiText("webview.packTools.watermarkProcessedChangSkipTheWrongPng", count, skipped)); return marked
  }
  const save = async (): Promise<void> => {
    if (!output || output.unsupported.length || !output.files.length) throw new Error(uiText("webview.packTools.pleaseSirMakeAPositiveResult"))
    const token = generation, source = output, include = options.includeVanilla()
    let files = source.files
    if (!include) {
      setStatus(uiText("webview.packTools.reconcilingOriginalSourceOfResources"))
      const response = await rpc('packToolsBaseline', { paths: files.map(file => file.path) })
      if (token !== generation) throw new Error(uiText("browser.packToolsBridge.operationCanceled"))
      const originals = new Map(decodePackToolsFiles(response.files ?? []).map(file => [file.path, file.content]))
      files = files.map(file => { const original = originals.get(file.path); return original && sameBytes(original, file.content) ? { ...file, origin: 'vanilla' as const } : file })
    }
    const selected = filterPackToolsSources(files, include, options.includeMcrhEditorData?.() ?? false), omitted = files.length - selected.length
    const marked = await applyWatermark(selected, token), required = withPackRequirements(marked, files.map(file => file.path))
    const processed: PackToolsFile[] = required.files.map(file => ({ ...file, content: typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content, origin: 'modified' as const }))
    validatePackToolsFiles(processed); ensureMetadata(processed)
    if (processed.length > PACK_TOOLS_LIMITS.files) throw new Error(uiText("webview.packTools.theNumberOfExportedFilesExceededBudget"))
    setStatus(uiText("webview.packTools.compressingZipInBrowserFile", processed.length)); await tick()
    const entries: Record<string, Uint8Array> = Object.create(null)
    for (const file of processed) entries[file.path] = file.content
    const chunks: Uint8Array[] = []; let compressedBytes = 0, zipError: Error | undefined, finished = false
    const archive = new Zip((error, chunk, final) => {
      if (error) { zipError = error; return }
      compressedBytes += chunk.length
      if (compressedBytes > PACK_TOOLS_LIMITS.bytes) { zipError = new Error(uiText("webview.packTools.zipVolumeGreaterThanMib")); return }
      chunks.push(chunk); if (final) finished = true
    })
    try {
      for (const [path, data] of Object.entries(entries)) {
        if (token !== generation) throw new Error(uiText("browser.packToolsBridge.operationCanceled"))
        const entry = new ZipDeflate(path, { level: 6 }); archive.add(entry)
        if (!data.length) entry.push(new Uint8Array(), true)
        for (let offset = 0; offset < data.length; offset += 128 * 1024) {
          entry.push(data.subarray(offset, Math.min(data.length, offset + 128 * 1024)), offset + 128 * 1024 >= data.length)
          if (zipError) throw zipError
          await tick(); if (token !== generation) throw new Error(uiText("browser.packToolsBridge.operationCanceled"))
        }
      }
      archive.end(); if (zipError) throw zipError
      if (!finished) throw new Error(uiText("webview.packTools.zipCompressionIncompleteEnd"))
    } finally { archive.terminate() }
    const bytes = new Uint8Array(compressedBytes); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    if (token !== generation) throw new Error(uiText("browser.packToolsBridge.operationCanceled"))
    if (bytes.length > PACK_TOOLS_LIMITS.bytes) throw new Error(uiText("webview.packTools.zipVolumeGreaterThanMib"))
    const name = get<HTMLInputElement>('[data-pack-name]').value.trim() || source.name
    const response = await rpc('packToolsSave', { name, includeMcrhEditorData: options.includeMcrhEditorData?.() ?? false, base64: encodePackToolsBytes(bytes) })
    if (response.canceled) { setStatus(uiText("webview.packTools.unsavedPreviewResultsAreStillExportable")); return }
    if (!response.saved) throw new Error(uiText("webview.packTools.zipNotSavedPleaseTryAgain"))
    setStatus(uiText("webview.packTools.zipSavedOrSentToBrowserFor", processed.length, omitted, sizeText(bytes.length), (required.warnings.length ? ' · ' + required.warnings.join('；') : '')))
  }
  const updateBusy = (): void => {
    for (const control of container.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input, select')) if (!control.closest('.mod-texture-import')) control.disabled = busy
    const cancel = get<HTMLButtonElement>('[data-pack-action="cancel"]'); cancel.hidden = !busy; cancel.disabled = false
    renderOutput()
  }
  const run = async (operation: () => Promise<void> | void): Promise<void> => {
    if (busy) return
    busy = true; updateBusy()
    try { await operation() } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { busy = false; if (!disposed) { updateBusy(); renderPacks(); renderFiles(); renderConflicts(); if (pendingConversion) { const token = pendingConversion; pendingConversion = undefined; openConversion(token) } } }
  }
  const click = (event: Event): void => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button'); if (!button || !container.contains(button) || button.closest('.mod-texture-import')) return
    if (button.dataset.packAction === 'cancel') {
      generation++; options.post({ command: 'packToolsCancel', requestId: 'cancel-' + (++serial) })
      for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(new Error(uiText("browser.packToolsBridge.operationCanceled"))) } pending.clear(); setStatus(uiText("webview.packTools.cancelingOperation")); return
    }
    if (busy) return
    if (button.dataset.packMode) { setMode(button.dataset.packMode as PackMode); return }
    if (button.dataset.page) { const delta = Number(button.dataset.direction); if (button.dataset.page === 'files') { filePage += delta; renderFiles() } else if (button.dataset.page === 'conflicts') { conflictPage += delta; renderConflicts() } else { outputPage += delta; renderOutput() }; return }
    void run(async () => {
      if (button.dataset.removePack) { const index = packs.findIndex(pack => pack.input.id === button.dataset.removePack); if (index >= 0) packs.splice(index, 1); if (typeof strategy === 'object' && strategy.packId === button.dataset.removePack) strategy = 'manual'; resolutions = Object.create(null); replan(); setStatus(uiText("webview.packTools.removedResourcePack")); return }
      const action = button.dataset.packAction
      if (action === 'import' || action === 'project') await addPacks(await rpc(action === 'import' ? 'packToolsImport' : 'packToolsProject'))
      if (action === 'select-all' || action === 'select-none') { for (const { pack, file } of rows()) { if (action === 'select-all') pack.selected.add(file.path); else pack.selected.delete(file.path) }; replan() }
      if (action === 'batch') { const value = get<HTMLSelectElement>('[data-pack-strategy]').value; strategy = ['manual', 'latest', 'exclude'].includes(value) ? value as PackMergeStrategy : { packId: value }; resolutions = Object.create(null); invalidate(); renderConflicts(); setStatus(uiText("webview.packTools.batchConflictStrategyAppliedPleaseCheckConflicts")) }
      if (action === 'merge') { output = merged(); get<HTMLInputElement>('[data-pack-name]').value = output.name; renderOutput(); setStatus(uiText("webview.packTools.theIntegrationResultHasBeenGeneratedPlease")) }
      if (action === 'convert') { invalidate(); await convert() }
      if (action === 'diagnose') {
        const id = get<HTMLSelectElement>('[data-diagnosis-input]').value, pack = packs.find(pack => pack.input.id === id)
        const files = pack ? pack.input.files.map(file => ({ path: file.path, content: file.bytes })) : merged().files
        if (!get<HTMLSelectElement>('[data-diagnosis-target]').value) throw new Error(uiText("webview.packTools.selectTheActualGameVersionAPackage"))
        const token = generation
        setStatus(uiText("webview.packTools.checkingResourcePacks"))
        const report = await diagnoseResourcePack(files, { targetVersion: get<HTMLSelectElement>('[data-diagnosis-target]').value || undefined, canceled: () => token !== generation })
        if (token !== generation || disposed) return
        renderPackDiagnosis(get('[data-diagnosis-report]'), report, pack?.input.name || uiText("webview.packTools.currentIntegrationResults"))
        setStatus(uiText("webview.packTools.diagnosisCompletedItWasAMistakeA", report.errors, report.warnings))
      }
      if (action === 'export') await save()
    })
  }
  const change = (event: Event): void => {
    if (busy) return
    const target = event.target as HTMLInputElement | HTMLSelectElement
    try {
      if (target.dataset.packEnabled) { const pack = packs.find(pack => pack.input.id === target.dataset.packEnabled); if (pack) pack.enabled = (target as HTMLInputElement).checked; resolutions = Object.create(null); replan() }
      if (target.dataset.filePack && target.dataset.filePath) { const pack = packs.find(pack => pack.input.id === target.dataset.filePack); if (pack) { if ((target as HTMLInputElement).checked) pack.selected.add(target.dataset.filePath); else pack.selected.delete(target.dataset.filePath) }; delete resolutions[target.dataset.filePath]; replan() }
      if (target.dataset.conflictPath) { if (!target.value) delete resolutions[target.dataset.conflictPath]; else resolutions[target.dataset.conflictPath] = target.value === 'exclude' ? 'exclude' : { packId: target.value }; invalidate(); renderConflicts() }
      if (target.matches('[data-pack-filter]')) { filePage = 0; renderFiles() }
      if (target.matches('[data-conversion-input], [data-conversion-source], [data-conversion-target]')) { invalidate(); const selected = targets.find(entry => entry.id === get<HTMLSelectElement>('[data-conversion-target]').value); get('[data-conversion-limitations]').textContent = selected ? selected.limitations.join('；') || uiText("webview.packTools.implementationOfCoreSupportedResourceConversionRules") : uiText("webview.packTools.selectTheActualSourceVersionAndThe") }
    } catch (error) { plan = undefined; invalidate(); renderConflicts(); setStatus(error instanceof Error ? error.message : String(error)) }
  }
  const input = (event: Event): void => { if ((event.target as Element).matches('[data-pack-search]')) { filePage = 0; renderFiles() } }
  container.addEventListener('keydown', keydown); container.addEventListener('click', click); container.addEventListener('change', change); container.addEventListener('input', input)
  renderPacks(); renderFiles(); renderConflicts(); renderOutput()
  function openConversion(projectToken?: string): void {
      setMode('conversion')
      const card = get<HTMLElement>('[data-conversion-card]')
      card.scrollIntoView({ block: 'start' }); card.focus({ preventScroll: true })
      if (busy && projectToken) { pendingConversion = projectToken; setStatus(uiText("webview.packTools.readTheNewSelectionResourcePackAfter")); return }
      if (projectToken) void run(async () => {
        await addPacks(await rpc('packToolsProject', { projectToken }))
        const pack = packs.at(-1); if (!pack) return
        get<HTMLSelectElement>('[data-conversion-input]').value = pack.input.id
        get<HTMLSelectElement>('[data-diagnosis-input]').value = pack.input.id
        const meta = pack.input.files.find(file => file.path === 'pack.mcmeta')
        if (meta) { try { const version = inferPackVersion(JSON.parse(new TextDecoder().decode(meta.bytes))); if (version) get<HTMLSelectElement>('[data-conversion-source]').value = version } catch {} }
        setStatus(uiText("webview.packTools.currentPackageReadPleaseConfirmActualSource"))
        card.scrollIntoView({ block: 'start' })
      })
  }
  return {
    hasSession: () => busy || packs.length > 0,
    openConversion,
    receive(raw: unknown): void {
      modTextures.receive(raw)
      if (!raw || typeof raw !== 'object' || !('type' in raw) || raw.type !== 'packToolsResponse' || !('requestId' in raw) || typeof raw.requestId !== 'string') return
      const request = pending.get(raw.requestId); if (!request) return
      clearTimeout(request.timeout); pending.delete(raw.requestId)
      const parsed = PackToolsResponseSchema.safeParse(raw)
      if (!parsed.success) { request.reject(new Error(uiText("webview.packTools.theMaterialPackageManagementResponseWasIneffective"))); return }
      if (!parsed.data.ok) request.reject(new Error(parsed.data.error || uiText("webview.packTools.fileOperationFailed")))
      else request.resolve(parsed.data)
    },
    dispose(): void { modTextures.dispose(); disposed = true; generation++; container.removeEventListener('keydown', keydown); container.removeEventListener('click', click); container.removeEventListener('change', change); container.removeEventListener('input', input); for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(new Error(uiText("webview.packTools.materialPackageManagementClosed"))) }; pending.clear(); packs.length = 0; output = undefined; plan = undefined }
  }
}
