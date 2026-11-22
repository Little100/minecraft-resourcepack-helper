import { uiText } from '../i18n/messages'
import type { ProjectPort } from './projectPort'
import { download, pickFiles, readFile } from './files'
import type { BrowserPackEntry } from '../core/browserPackProject'
import { PackToolsRequestSchema, PACK_TOOLS_LIMITS, assertPackToolsPath, encodePackToolsBytes, decodePackToolsBytes, sanitizePackToolsArchive, type PackToolsResponse, type PackToolsWireFile } from '../core/advanced/packToolsProtocol'

export class BrowserPackToolsBridge {
  private busyValue = false
  private generation = 0
  get busy(): boolean { return this.busyValue }
  constructor(private readonly project: ProjectPort, private readonly available: () => boolean = () => true) {}
  private post(response: PackToolsResponse): void { window.postMessage(response, location.origin) }
  private entries(): BrowserPackEntry[] {
    if (this.project.packToolsEntries) return this.project.packToolsEntries()
    return this.project.paths().map(path => ({ path, data: this.project.read(path)!, origin: 'user', modified: false }))
  }
  async handle(raw: unknown): Promise<boolean> {
    if (!raw || typeof raw !== 'object' || !('command' in raw) || typeof raw.command !== 'string' || !raw.command.startsWith('packTools')) return false
    const parsed = PackToolsRequestSchema.safeParse(raw)
    if (!parsed.success) { this.post({ type: 'packToolsResponse', requestId: 'requestId' in raw && typeof raw.requestId === 'string' ? raw.requestId.slice(0, 128) : 'invalid', ok: false, error: uiText("browser.packToolsBridge.theMaterialPackageManagementRequestIsInvalid") }); return true }
    const request = parsed.data
    if (request.command === 'packToolsCancel') { this.generation++; return true }
    if (this.busy || !this.available()) { this.post({ type: 'packToolsResponse', requestId: request.requestId, ok: false, error: uiText("browser.packToolsBridge.theProjectIsBeingProcessedPleaseTry") }); return true }
    const generation = this.generation, revision = this.project.revision
    const check = () => { if (generation !== this.generation) throw new Error(uiText("browser.packToolsBridge.operationCanceled")); if (revision !== this.project.revision) throw new Error(uiText("browser.packToolsBridge.theProjectHasChangedPleaseReadThe")) }
    this.busyValue = true
    let result: Partial<PackToolsResponse> = {}
    try {
      if (request.command === 'packToolsImport') {
        const selected = await pickFiles('.zip', true); check()
        if (selected.length > PACK_TOOLS_LIMITS.packs || selected.reduce((total, file) => total + file.size, 0) > PACK_TOOLS_LIMITS.bytes) throw new Error(uiText("browser.packToolsBridge.selectedZipNumbersOrTotalAccumulatedOver"))
        const archives: NonNullable<PackToolsResponse['archives']> = []
        for (const file of selected) { const bytes = await readFile(file, PACK_TOOLS_LIMITS.bytes); check(); archives.push({ name: file.name, base64: encodePackToolsBytes(bytes) }) }
        result = archives.length ? { archives } : { canceled: true }
      }
      if (request.command === 'packToolsImages') {
        const selected = await pickFiles('.png,.mcmeta', true); check()
        if (selected.length > 8192 || selected.reduce((sum, file) => sum + file.size, 0) > PACK_TOOLS_LIMITS.bytes) throw new Error(uiText("browser.packToolsBridge.numberOrTotalOfSelectedPicturesExceeded"))
        const files: PackToolsWireFile[] = [], used = new Set<string>()
        for (const file of selected) {
          if (!/\.png(?:\.mcmeta)?$/i.test(file.name)) throw new Error(uiText("browser.packToolsBridge.onlyAcceptPngAndTheSameName"))
          const path = 'assets/minecraft/textures/block/' + file.name.toLowerCase().replace(/[^a-z0-9_.-]/g, '_'); assertPackToolsPath(path)
          if (used.has(path)) throw new Error(uiText("browser.packToolsBridge.picturesHaveTheSameNameOutputRead", file.name))
          used.add(path); const bytes = await readFile(file, /\.mcmeta$/i.test(file.name) ? 1024 * 1024 : 32 * 1024 * 1024); check(); files.push({ path, base64: encodePackToolsBytes(bytes), origin: 'user' })
        }
        const images = files.filter(file => file.path.endsWith('.png'))
        if (images.length > 4096 || files.some(file => file.path.endsWith('.mcmeta') && !used.has(file.path.slice(0, -7)))) throw new Error(uiText("browser.packToolsBridge.selectAMaximumOfPngsAnimatedMcmeta"))
        result = images.length ? { files, name: 'selected-images' } : { canceled: true }
      }
      if (request.command === 'packToolsProject' || request.command === 'packToolsBaseline') {
        const wanted = request.command === 'packToolsBaseline' ? new Set(request.paths) : undefined
        for (const relative of wanted ?? []) assertPackToolsPath(relative)
        let total = 0
        const files: PackToolsWireFile[] = []
        for (const entry of this.entries()) {
          if (wanted && (!wanted.has(entry.path) || entry.origin !== 'vanilla' || entry.modified)) continue
          total += entry.data.length
          if (total > PACK_TOOLS_LIMITS.bytes || files.length >= PACK_TOOLS_LIMITS.entries) throw new Error(uiText("browser.packToolsBridge.projectSnapshotsExceedTheManagementToolBudget"))
          files.push({ path: entry.path, base64: encodePackToolsBytes(entry.data), origin: entry.modified ? 'modified' : entry.origin })
        }
        check(); result = { files, name: this.project.info().name }
      }
      if (request.command === 'packToolsSave') {
        const bytes = sanitizePackToolsArchive(decodePackToolsBytes(request.base64, PACK_TOOLS_LIMITS.bytes), request.includeMcrhEditorData)
        if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error(uiText("browser.packToolsBridge.exportContentIsNotZip"))
        check(); download(bytes, request.name.replace(/\.zip$/i, '') + '.zip', 'application/zip')
        result = { saved: true, name: request.name }
      }
      this.post({ type: 'packToolsResponse', requestId: request.requestId, ok: true, ...result })
    } catch (error) { this.post({ type: 'packToolsResponse', requestId: request.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }) }
    finally { this.busyValue = false }
    return true
  }
}
