import { attachLanguagePicker } from './language'
import { uiHtml, uiText } from '../i18n/messages'
import { ARCHIVE_LIMIT, errorText, pickFiles, readFile } from './files'
import { fetchManifest, resolveClient, downloadClient, type VanillaManifest } from './vanilla'
import { ResourceBrowser } from './resources'
import type { BrowserWorkbenchBridge } from './workbenchBridge'
import type { ProjectPort } from './projectPort'
import { listVersionCapabilities } from '../core/advanced/versionCapabilities'

export class BrowserShell {
  private readonly header = document.createElement('header')
  private readonly dialog = document.createElement('dialog')
  private manifest?: VanillaManifest
  private controller?: AbortController
  readonly resources: ResourceBrowser
  constructor(private readonly project: ProjectPort, private readonly bridge: BrowserWorkbenchBridge, hasWorkbenchSession: () => boolean) {
    this.header.id = 'web-project-bar'
    this.header.innerHTML = `<a class="web-wordmark" href="./" aria-label="${uiHtml("shell.workbenchLabel")}">MCRH<span>${uiHtml("browser.shell.webWorkbench")}</span></a><div class="web-project-info"><strong id="web-project-name">${uiHtml("browser.project.untitledResourcePack")}</strong><span id="web-project-meta">${uiHtml("browser.shell.filesStayInThisBrowser")}</span></div><label class="web-theme-label">${uiHtml("browser.shell.appearance")}<select id="web-theme" aria-label="${uiHtml("browser.shell.theme")}"><option value="system">${uiHtml("browser.shell.system")}</option><option value="light">${uiHtml("browser.shell.light")}</option><option value="dark">${uiHtml("browser.shell.dark")}</option></select></label><nav aria-label="${uiHtml("browser.shell.projectActions")}"><div class="web-command-group web-command-open"><span class="web-command-label">${uiHtml("browser.shell.open")}</span><button type="button" id="web-import">${uiHtml("browser.shell.resourcePackClientJar")}</button><button type="button" id="web-start">${uiHtml("browser.shell.startFromVanilla")}</button></div><div class="web-command-group web-command-project"><span class="web-command-label">${uiHtml("browser.shell.project")}</span><button type="button" id="web-mod-import">${uiHtml("shell.importModTextures")}</button><button type="button" id="web-files">${uiHtml("shell.browseResources")}</button></div><div class="web-command-group web-command-save"><button type="button" id="web-export" class="primary">${uiHtml("shell.exportZip")}</button></div></nav><p id="web-status" role="status" aria-live="polite">${uiHtml("browser.shell.localProjectNoSignInRequired")}</p>`
    document.body.prepend(this.header)
    new ResizeObserver(() => document.documentElement.style.setProperty('--web-bar-height', Math.ceil(this.header.getBoundingClientRect().height) + 'px')).observe(this.header)
    this.dialog.id = 'web-start-dialog'; this.dialog.className = 'web-dialog'
    this.dialog.innerHTML = `<header><div><h2>${uiHtml("browser.shell.startFromAVanillaRelease")}</h2></div><button type="button" data-close>${uiHtml("browser.resources.close")}</button></header><p>${uiHtml("browser.shell.selectAnOfficialVersionOrSnapshotAnd")}</p><div class="web-inline"><label>${uiHtml("browser.shell.version")}<select id="web-vanilla-version" aria-label="${uiHtml("browser.shell.vanillaVersion")}"></select></label><button type="button" id="web-refresh-versions">${uiHtml("browser.shell.refreshVersionList")}</button></div><div class="web-inline"><button type="button" id="web-blank">${uiHtml("browser.shell.createEmptyProject")}</button><button type="button" id="web-download-vanilla" class="primary" disabled>${uiHtml("browser.shell.downloadAndExtractVanillaAssets")}</button><button type="button" id="web-local-client">${uiHtml("browser.shell.importLocalClientJarOrZip")}</button><button type="button" id="web-cancel-download" disabled>${uiHtml("browser.shell.cancel")}</button></div><label>${uiHtml("browser.shell.downloadAndExtractionProgress")}<progress id="web-progress" value="0" max="1"></progress></label><p id="web-vanilla-status" role="status">${uiHtml("browser.shell.createABlankItemOrImportLocal")}</p><p class="muted">${uiHtml("browser.shell.downloadLimitMibIfTheProjectS")}</p>`
    document.body.append(this.dialog)
    this.versionSelect().replaceChildren(...listVersionCapabilities().map(version => new Option(version.id + uiText("browser.shell.verifiedFormatQualifier"), version.id)))
    if (project.info().version) this.versionSelect().value = project.info().version!
    const initialTarget = document.querySelector<HTMLSelectElement>('#target-version')
    if (project.info().version && initialTarget && Array.from(initialTarget.options).some(option => option.value === project.info().version)) { initialTarget.value = project.info().version!; initialTarget.dispatchEvent(new Event('change', { bubbles: true })) }
    this.resources = new ResourceBrowser(project, { changed: () => this.refresh(), notify: (text, error) => this.notify(text, error), use: (role, path) => bridge.useResource(role, path) })
    this.header.querySelector('#web-import')!.addEventListener('click', () => { void this.importLocal(false).catch(error => this.notify(errorText(error), true)) })
    this.header.querySelector('#web-mod-import')!.addEventListener('click', () => this.importModTextures())
    this.header.querySelector('#web-start')!.addEventListener('click', () => { this.dialog.showModal() })
    this.header.querySelector('#web-files')!.addEventListener('click', () => this.resources.open())
    this.header.querySelector('#web-export')!.addEventListener('click', () => { void bridge.handle({ command: 'exportPackZip' }).catch(error => this.notify(errorText(error), true)) })
    this.dialog.querySelector('[data-close]')!.addEventListener('click', () => { this.controller?.abort(); this.dialog.close() })
    this.dialog.addEventListener('cancel', () => this.controller?.abort())
    this.dialog.querySelector('#web-refresh-versions')!.addEventListener('click', () => { void this.loadVersions() })
    this.dialog.querySelector('#web-local-client')!.addEventListener('click', () => { void this.importLocal(true).catch(error => this.notify(errorText(error), true)) })
    this.dialog.querySelector('#web-blank')!.addEventListener('click', () => { void this.blank().catch(error => this.notify(errorText(error), true)) })
    this.dialog.querySelector('#web-download-vanilla')!.addEventListener('click', () => { void this.startVanilla() })
    this.dialog.querySelector('#web-cancel-download')!.addEventListener('click', () => this.controller?.abort())
    const theme = this.header.querySelector<HTMLSelectElement>('#web-theme')!
    try { theme.value = localStorage.getItem('mcrh-web-theme') || 'system' } catch {}
    const applyTheme = () => { document.body.classList.remove('vscode-light', 'vscode-dark'); if (theme.value !== 'system') document.body.classList.add('vscode-' + theme.value); try { localStorage.setItem('mcrh-web-theme', theme.value) } catch {} }
    attachLanguagePicker(theme.parentElement!, () => project.info().fileCount > 1 || project.info().dirty || this.resources.hasDraft() || hasWorkbenchSession(), text => this.notify(text))
    theme.addEventListener('change', applyTheme); applyTheme()
    window.addEventListener('beforeunload', event => { if (project.info().dirty || this.resources.hasDraft()) { event.preventDefault(); event.returnValue = '' } })
    this.refresh()
  }
  private importModTextures(): void {
    document.querySelector<HTMLButtonElement>('[data-tab=packs]')?.click()
    const tab = document.querySelector<HTMLButtonElement>('[data-pack-mode=mods]')
    if (!tab || tab.disabled) { this.notify(uiText("browser.shell.theCurrentPackageOperationHasNotBeen")); return }
    tab.click()
    if (tab.getAttribute('aria-selected') === 'true') document.querySelector<HTMLButtonElement>('[data-mod-import]')?.click()
  }
  notify(text: string, error = false): void { const status = this.header.querySelector<HTMLElement>('#web-status')!; status.textContent = (text); status.setAttribute('role', error ? 'alert' : 'status') }
  refresh(): void {
    const info = this.project.info()
    this.header.querySelector('#web-project-name')!.textContent = info.name
    this.header.querySelector('#web-project-meta')!.textContent = info.fileCount + uiText("browser.shell.resources") + (info.bytes / 1024 / 1024).toFixed(2) + ' MiB' + (info.version ? ' · ' + info.version : '') + (info.resourceFormat ? uiText("browser.shell.format", info.resourceFormat) : '') + (info.dirty ? uiText("browser.shell.unexportedChanges") : '')
    this.resources.refresh()
  }
  projectReplaced(): void {
    this.bridge.projectReplaced(); this.resources.reset()
    const version = this.project.info().version, target = document.querySelector<HTMLSelectElement>('#target-version')
    if (version && target && Array.from(target.options).some(option => option.value === version)) { target.value = version; target.dispatchEvent(new Event('change', { bubbles: true })) }
    this.refresh()
  }
  confirmReplace(): boolean {
    if (this.resources.hasDraft()) return confirm(uiText("browser.shell.anyChangeReplacementItemsInTheResource"))
    return !this.project.info().dirty || confirm(uiText("browser.shell.areTheChangesNotYetExportedTo"))
  }
  private beginProjectReplacement(): () => void {
    const release = this.bridge.beginProjectReplacement()
    const browse = this.header.querySelector<HTMLButtonElement>('#web-files')!
    browse.disabled = true
    return () => { browse.disabled = false; release() }
  }
  private async importLocal(vanilla: boolean): Promise<void> {
    this.bridge.assertCanReplaceProject()
    const files = await pickFiles('.zip,.jar'); if (!files[0] || !this.confirmReplace()) return
    const release = this.beginProjectReplacement()
    try {
    this.notify(uiText("browser.shell.safeUnpacking", files[0].name))
    const version = vanilla ? this.versionSelect().value : undefined
    await this.project.importArchive(await readFile(files[0], ARCHIVE_LIMIT), files[0].name, vanilla, version)
    this.projectReplaced(); this.notify(uiText("browser.shell.importCompleteFilesAreStoredInBrowser")); if (this.dialog.open) this.dialog.close()
    } finally { release() }
  }
  private versionSelect(): HTMLSelectElement { return this.dialog.querySelector('#web-vanilla-version')! }
  async loadVersions(): Promise<void> {
    if (this.controller) return
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000)
    this.controller = controller; this.dialog.querySelector<HTMLButtonElement>('#web-cancel-download')!.disabled = false
    const status = this.dialog.querySelector('#web-vanilla-status')!
    status.textContent = uiText("browser.shell.readingTheVersionListFromMojang")
    try {
      this.manifest = await fetchManifest(controller.signal)
      const select = this.versionSelect(); select.replaceChildren(...this.manifest.versions.map(version => new Option(version.id + (version.id === this.manifest!.latest.release ? uiText("browser.shell.latestReleaseQualifier") : version.type === 'release' ? '' : ' (' + version.type + ')'), version.id)))
      select.value = this.manifest.latest.release
      this.bridge.setVersions(this.manifest.versions)
      this.dialog.querySelector<HTMLButtonElement>('#web-download-vanilla')!.disabled = false
      status.textContent = uiText("browser.shell.theListHasBeenUpdatedWithThe", this.manifest.latest.release)
    } catch (error) { status.textContent = errorText(error); this.notify(uiText("browser.shell.versionListIsNotAvailableButCan"), true) }
    finally { clearTimeout(timeout); this.controller = undefined; this.dialog.querySelector<HTMLButtonElement>('#web-cancel-download')!.disabled = true }
  }
  private async blank(): Promise<void> {
    if (!this.confirmReplace()) return
    const version = this.versionSelect().value || document.querySelector<HTMLSelectElement>('#target-version')?.value || ''
    const release = this.beginProjectReplacement()
    try { await this.project.startBlank(version); this.projectReplaced(); this.dialog.close(); this.notify(uiText("browser.shell.aBlankItemWasCreatedAndNo")) } finally { release() }
  }
  private async startVanilla(): Promise<void> {
    if (this.controller || !this.manifest || !this.confirmReplace()) return
    const version = this.manifest.versions.find(entry => entry.id === this.versionSelect().value); if (!version) return
    let release: () => void
    try { release = this.beginProjectReplacement() } catch (error) { this.notify(errorText(error), true); return }
    this.controller = new AbortController(); const signal = this.controller.signal
    const status = this.dialog.querySelector('#web-vanilla-status')!, progress = this.dialog.querySelector<HTMLProgressElement>('#web-progress')!, cancel = this.dialog.querySelector<HTMLButtonElement>('#web-cancel-download')!, download = this.dialog.querySelector<HTMLButtonElement>('#web-download-vanilla')!
    cancel.disabled = false; download.disabled = true; progress.value = 0
    try {
      this.notify(uiText("browser.shell.reconcilingVersionMetadataAndDownloadingOriginalResource"))
      status.textContent = uiText("browser.shell.reconcilingVersionMetadataAndClientDownloadSize")
      const client = await resolveClient(version, signal)
      const bytes = await downloadClient(client, signal, (received, total) => { progress.max = total || client.size; progress.value = received; status.textContent = uiText("browser.shell.directDownloadMib", version.id, (received / 1024 / 1024).toFixed(1), ((total || client.size) / 1024 / 1024).toFixed(1)) })
      status.textContent = uiText("browser.shell.downloadVerifiedSuccessfullySafelyExtractingAssetsAnd"); await this.project.importArchive(bytes, version.id + '-client.jar', true, version.id, signal)
      signal.throwIfAborted(); this.projectReplaced(); this.notify(uiText("browser.shell.fromOriginalAtTheBeginningLocalResources", version.id)); this.dialog.close()
    } catch (error) { status.textContent = signal.aborted ? uiText("browser.shell.downloadedOrUnpackedCancelledCurrentItemNot") : errorText(error); this.notify(status.textContent!, true) }
    finally { this.controller = undefined; cancel.disabled = true; download.disabled = false; release() }
  }
}
