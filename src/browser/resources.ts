import { uiHtml, uiText } from '../i18n/messages'
import { mountReferencePanel, type ReferencePanel } from '../webview/referencePanel'
import { BrowserReferenceSource } from './referenceImages'
import type { ProjectPort } from './projectPort'
import { decodePng, download, encodePng, errorText, fileName, pickFiles, readFile, textDecoder } from './files'

interface ResourceActions { changed(): void; notify(text: string, error?: boolean): void; use(role: string, path: string): Promise<void> }
export class ResourceBrowser {
  private readonly dialog = document.createElement('dialog')
  private selected?: string
  private selectedRevision = 0
  private image?: { width: number; height: number; data: Uint8Array; savedPixels: Uint8Array }
  private savedText?: string
  private busy = false
  private undo: Uint8Array[] = []
  private page = 0
  private readonly references: ReferencePanel
  constructor(private readonly project: ProjectPort, private readonly actions: ResourceActions) {
    this.dialog.id = 'web-resources'; this.dialog.className = 'web-dialog resource-dialog'
    this.dialog.setAttribute('aria-labelledby', 'web-resources-title')
    this.dialog.innerHTML = `<header><div><h2 id="web-resources-title">${uiHtml("browser.resources.projectResources")}</h2></div><button type="button" data-close>${uiHtml("browser.resources.close")}</button></header><div class="resource-layout"><aside><label>${uiHtml("browser.resources.searchResources")}<input id="resource-search" type="search" placeholder="${uiHtml("browser.resources.pathFilenameOrExtension")}"></label><p id="resource-count" class="muted"></p><div id="resource-list" role="list" aria-label="${uiHtml("browser.resources.projectResourceList")}"></div><div class="web-inline"><button type="button" data-page="prev">${uiHtml("browser.resources.previousPage")}</button><span id="resource-page"></span><button type="button" data-page="next">${uiHtml("browser.resources.nextPage")}</button></div></aside><section class="resource-editor"><p id="resource-path">${uiHtml("browser.resources.selectAFileToPreviewReplaceOr")}</p><div id="resource-tools" hidden><div class="web-inline"><button type="button" data-replace>${uiHtml("browser.resources.replaceFromDisk")}</button><button type="button" data-download>${uiHtml("browser.resources.downloadFile")}</button><label>${uiHtml("browser.resources.useAs")}<select id="resource-role"><option value="pbr">${uiHtml("browser.resources.pbrBaseColor")}</option><option value="colormap">${uiHtml("browser.resources.biomeColormap")}</option><option value="skin">${uiHtml("browser.resources.totemSkin")}</option><option value="albedo">${uiHtml("browser.resources.sceneBaseColor")}</option><option value="normal">${uiHtml("browser.resources.sceneNormalMap")}</option><option value="specular">${uiHtml("browser.resources.sceneMaterial")}</option><option value="model">${uiHtml("browser.resources.modelJson")}</option><option value="biome">${uiHtml("browser.resources.biomeJson")}</option></select></label><button type="button" data-use>${uiHtml("browser.resources.applyToWorkbench")}</button></div><div id="pixel-tools" class="web-inline" hidden><label>${uiHtml("browser.resources.brushColor")}<input id="pixel-color" type="color" value="#d45f38"></label><label><input id="pixel-eraser" type="checkbox">${uiHtml("browser.resources.erase")}</label><button type="button" data-undo>${uiHtml("browser.resources.undoStroke")}</button><button type="button" data-save-pixels>${uiHtml("browser.resources.savePixelsToProject")}</button><span id="pixel-info" class="muted"></span></div></div><div class="pixel-stage" hidden><canvas id="resource-canvas" aria-label="${uiHtml("browser.resources.pixelEditorCanvas")}"></canvas></div><textarea id="resource-text" aria-label="${uiHtml("browser.resources.resourceTextEditor")}" spellcheck="false" hidden></textarea><button type="button" data-save-text hidden>${uiHtml("browser.resources.saveTextToProject")}</button><p id="resource-status" role="status" hidden></p><p id="resource-info" class="muted">${uiHtml("browser.resources.pngSupportsSimplePixelBrushesAndReplacements")}</p></section></div>`
    document.body.append(this.dialog)
    this.references = mountReferencePanel(this.query('.resource-editor'), new BrowserReferenceSource())
    this.references.element.hidden = true
    this.dialog.addEventListener('close', () => this.references.suspend())
    this.query('[data-close]').addEventListener('click', () => this.close())
    this.query<HTMLInputElement>('#resource-search').addEventListener('input', () => { this.page = 0; this.renderList() })
    this.dialog.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button'); if (!button) return
      if (button.dataset.resource) { this.openResource(button.dataset.resource); return }
      if (button.dataset.page) { this.page = Math.max(0, this.page + (button.dataset.page === 'next' ? 1 : -1)); this.renderList(); return }
      if (!this.selected || this.busy || !button.matches('[data-replace], [data-download], [data-use], [data-undo], [data-save-pixels], [data-save-text]')) return
      void this.perform(button, this.selected).catch(error => this.notify(errorText(error), true))
    })
    const canvas = this.query<HTMLCanvasElement>('#resource-canvas')
    let drawing = false
    const paint = (event: PointerEvent) => {
      if (!drawing || this.busy || !this.image) return
      const bounds = canvas.getBoundingClientRect(), x = Math.floor((event.clientX - bounds.left) * this.image.width / bounds.width), y = Math.floor((event.clientY - bounds.top) * this.image.height / bounds.height)
      if (x < 0 || y < 0 || x >= this.image.width || y >= this.image.height) return
      const color = this.query<HTMLInputElement>('#pixel-color').value, offset = (y * this.image.width + x) * 4
      this.image.data.set([parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16), this.query<HTMLInputElement>('#pixel-eraser').checked ? 0 : 255], offset); this.draw()
    }
    canvas.addEventListener('pointerdown', event => { if (event.button !== 0 || this.busy || !this.image) return; drawing = true; this.undo.push(this.image.data.slice()); if (this.undo.length > 12) this.undo.shift(); canvas.setPointerCapture(event.pointerId); paint(event) })
    canvas.addEventListener('pointermove', paint)
    canvas.addEventListener('pointerup', () => { drawing = false })
    canvas.addEventListener('pointercancel', () => { drawing = false })
  }
  private query<T extends HTMLElement>(selector: string): T { return this.dialog.querySelector<T>(selector)! }
  open(path?: string): void { this.renderList(); if (!this.dialog.open) this.dialog.showModal(); this.references.resume(); if (path) this.openResource(path) }
  hasDraft(): boolean {
    if (this.image) {
      const { data, savedPixels } = this.image
      return data.some((value, index) => value !== savedPixels[index])
    }
    return this.savedText !== undefined && this.query<HTMLTextAreaElement>('#resource-text').value !== this.savedText
  }
  private confirmDiscard(): boolean {
    return !this.hasDraft() || confirm(uiText("browser.resources.discardTheUnsavedChangesToThisFile"))
  }
  private notify(text: string, error = false): void {
    const status = this.query('#resource-status')
    status.setAttribute('role', error ? 'alert' : 'status')
    status.hidden = false
    status.textContent = text
    this.actions.notify(text, error)
  }
  private openResource(path: string): void {
    if (this.busy || (this.selected === path && this.selectedRevision === this.project.revision) || !this.confirmDiscard()) return
    try { this.select(path) } catch (error) { this.notify(errorText(error), true) }
  }
  private async perform(button: HTMLButtonElement, path: string): Promise<void> {
    const revision = this.selectedRevision
    const text = this.query<HTMLTextAreaElement>('#resource-text')
    this.busy = true
    text.readOnly = true
    try {
      if (button.hasAttribute('data-replace')) {
        const [file] = await pickFiles(path.endsWith('.png') ? '.png' : '')
        if (!file || !this.confirmDiscard()) return
        const bytes = await readFile(file)
        if (path.endsWith('.png')) decodePng(bytes)
        await this.project.apply([{ path, content: bytes }], revision)
        this.actions.changed()
        this.select(path)
        this.notify(uiText("browser.resources.localFileReplacedPleaseExportZip"))
      } else if (button.hasAttribute('data-download')) {
        const bytes = this.project.read(path)
        if (!bytes) throw new Error(uiText("browser.resources.thisResourceNoLongerExists"))
        download(bytes, fileName(path))
      } else if (button.hasAttribute('data-use')) {
        const role = this.query<HTMLSelectElement>('#resource-role').value
        await this.actions.use(role, path)
        this.close()
        this.actions.notify(uiText("browser.resources.alreadyApplyToWorkbench", path))
      } else if (button.hasAttribute('data-undo') && this.image) {
        const previous = this.undo.pop()
        if (previous) { this.image.data = previous; this.draw() }
      } else if (button.hasAttribute('data-save-pixels') && this.image) {
        const { width, height, data } = this.image
        await this.project.apply([{ path, content: encodePng(width, height, data) }], revision)
        this.image.savedPixels = data.slice()
        this.selectedRevision = this.project.revision
        this.actions.changed()
        this.notify(uiText("browser.resources.pixelsSavedToTheProjectExportA"))
      } else if (button.hasAttribute('data-save-text')) {
        const content = text.value
        if (path.endsWith('.json') || path.endsWith('.mcmeta')) JSON.parse(content)
        await this.project.apply([{ path, content }], revision)
        this.savedText = content
        this.selectedRevision = this.project.revision
        this.actions.changed()
        this.notify(uiText("browser.resources.textSavedToTheProjectExportA"))
      }
    } finally {
      this.busy = false
      text.readOnly = false
    }
  }
  close(): void { this.references.suspend(); this.dialog.close() }
  dispose(): void { this.references.dispose(); this.dialog.remove() }
  reset(): void {
    this.references.clear(); this.references.element.hidden = true
    this.selected = undefined; this.image = undefined; this.savedText = undefined; this.undo = []
    this.close()
    this.query('#resource-path').textContent = uiText("browser.resources.selectAFileToPreviewReplaceOr")
    for (const selector of ['#resource-tools', '#resource-text', '[data-save-text]', '.pixel-stage', '#resource-status']) this.query(selector).hidden = true
  }
  refresh(): void { if (this.dialog.open) this.renderList() }
  private renderList(): void {
    const filter = this.query<HTMLInputElement>('#resource-search').value.toLowerCase(), paths = this.project.paths().filter(path => path.toLowerCase().includes(filter)), count = paths.length
    const pageCount = Math.max(1, Math.ceil(count / 120)); this.page = Math.min(this.page, pageCount - 1)
    this.query('#resource-count').textContent = count + uiText("browser.resources.files"); this.query('#resource-page').textContent = (this.page + 1) + ' / ' + pageCount
    this.query<HTMLButtonElement>('[data-page=prev]').disabled = this.page === 0; this.query<HTMLButtonElement>('[data-page=next]').disabled = this.page + 1 >= pageCount
    const list = this.query('#resource-list'); list.replaceChildren()
    for (const path of paths.slice(this.page * 120, (this.page + 1) * 120)) { const button = document.createElement('button'); button.type = 'button'; button.dataset.resource = path; button.textContent = path; button.classList.toggle('selected', path === this.selected); list.append(button) }
    if (!count) list.textContent = uiText("browser.resources.noMatchingResourcePleaseImportZipOr")
  }
  private select(path: string): void {
    const bytes = this.project.read(path); if (!bytes) throw new Error(uiText("browser.resources.thisResourceNoLongerExists"))
    const decoded = path.endsWith('.png') ? decodePng(bytes) : undefined
    this.selected = path; this.selectedRevision = this.project.revision; this.image = undefined; this.savedText = undefined; this.undo = []
    this.query('#resource-status').hidden = true
    this.query('#resource-path').textContent = path; this.query('#resource-tools').hidden = false
    this.references.suspend(); this.references.element.hidden = true
    this.query('#pixel-tools').hidden = true; this.query('.pixel-stage').hidden = true; this.query('#resource-text').hidden = true; this.query('[data-save-text]').hidden = true
    this.query('#resource-info').textContent = bytes.length.toLocaleString() + uiText("browser.resources.bytes")
    if (decoded) {
      this.image = { width: decoded.width, height: decoded.height, data: new Uint8Array(decoded.data), savedPixels: decoded.data }
      this.references.element.hidden = false; this.references.resume()
      this.query('#pixel-tools').hidden = false; this.query('.pixel-stage').hidden = false
      this.query('#pixel-info').textContent = decoded.width + ' × ' + decoded.height; this.draw()
    } else if (/\.(json|mcmeta|glsl|vsh|fsh|txt|md|properties|lang|toml)$/i.test(path) && bytes.length <= 2 * 1024 * 1024) {
      this.savedText = textDecoder.decode(bytes)
      this.query<HTMLTextAreaElement>('#resource-text').value = this.savedText; this.query('#resource-text').hidden = false; this.query('[data-save-text]').hidden = false
    }
    this.renderList()
  }
  private draw(): void {
    if (!this.image) return
    const canvas = this.query<HTMLCanvasElement>('#resource-canvas'), { width, height, data } = this.image
    canvas.width = width; canvas.height = height; canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0)
    canvas.style.width = Math.max(128, Math.min(640, width * Math.max(1, Math.floor(512 / Math.max(width, height))))) + 'px'
  }
}

