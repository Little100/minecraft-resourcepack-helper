import { uiText } from '../i18n/messages'
import { BrowserPackProject, readBrowserArchiveFile, type BrowserPackFormat, type BrowserPackOrigin } from '../core/browserPackProject'
import { getVersionCapabilities, listVersionCapabilities } from '../core/advanced/versionCapabilities'
import type { ProjectWorkerRequest, ProjectWorkerResponse } from './projectProtocol'

const limits = { maxArchiveBytes: 384 * 1024 * 1024, maxCompressedBytes: 384 * 1024 * 1024, maxUncompressedBytes: 512 * 1024 * 1024 }
let project = new BrowserPackProject({ name: uiText("browser.project.untitledResourcePack"), limits })
const origins = new Map<string, BrowserPackOrigin>()
const decoder = new TextDecoder('utf-8', { fatal: true })
function resourceFormat(value: unknown): BrowserPackFormat | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (Array.isArray(value) && value.length === 2 && value.every(part => Number.isSafeInteger(part) && part >= 0)) return [value[0], value[1]]
  if (value && typeof value === 'object' && 'major' in value && 'minor' in value && Number.isSafeInteger(value.major) && Number.isSafeInteger(value.minor) && Number(value.major) >= 0 && Number(value.minor) >= 0) return { major: Number(value.major), minor: Number(value.minor) }
  return undefined
}
function blank(version: string, name = uiText("browser.project.untitledResourcePack")): void {
  const capability = getVersionCapabilities(version)
  if (!capability?.resourcePackFormat) throw new Error(uiText("browser.projectWorker.thisVersionDoesNotHaveAReliable"))
  const next = new BrowserPackProject({ name, version, packFormat: capability.resourcePackFormat, description: 'MCRH 浏览器资源包', limits })
  next.setMetadata({ description: 'MCRH 浏览器资源包' }); project = next
}
function importArchive(request: ProjectWorkerRequest): void {
  const { bytes, vanilla, version } = request
  if (!bytes) throw new Error(uiText("browser.projectWorker.archiveDataMissing"))
  const next = new BrowserPackProject({ name: (request.name || uiText("browser.projectWorker.importResourcePack")).replace(/\.(zip|jar)$/i, '') || uiText("browser.projectWorker.importResourcePack"), limits })
  next.importZip(bytes, vanilla ? 'vanilla' : 'user')
  if (vanilla) {
    const versionBytes = readBrowserArchiveFile(bytes, 'version.json', limits)
    if (versionBytes && versionBytes.length > 1024 * 1024) throw new Error(uiText("browser.projectWorker.clientVersionJsonMoreThanMibNot"))
    let format: BrowserPackFormat | undefined, actualVersion: string | undefined
    if (versionBytes) {
      const value = JSON.parse(decoder.decode(versionBytes)) as { id?: unknown; pack_version?: { resource_major?: unknown; resource_minor?: unknown; resource?: unknown }; resource_pack_version?: unknown }
      const pack = value.pack_version
      format = resourceFormat({ major: pack?.resource_major, minor: pack?.resource_minor }) ?? resourceFormat(pack?.resource ?? value.resource_pack_version)
      actualVersion = typeof value.id === 'string' ? value.id : undefined
    }
    const target = actualVersion || version
    if (!format && target) format = getVersionCapabilities(target)?.resourcePackFormat ?? undefined
    if (!format) throw new Error(uiText("browser.projectWorker.theClientLacksAVerifiableResourcePack"))
    next.setMetadata({ ...(target ? { version: target } : {}), packFormat: format, description: 'MCRH ' + (target || '原版') + ' 资源包' })
  }
  if (!next.read('pack.mcmeta')) throw new Error(uiText("browser.projectWorker.resourceZipMissingPackMcmetaPleaseFill"))
  project = next
}
self.addEventListener('message', (event: MessageEvent<ProjectWorkerRequest>) => {
  const request = event.data, response: ProjectWorkerResponse = { id: request.id, ok: true }
  try {
    if (request.operation === 'initialize') { const version = listVersionCapabilities().filter(entry => entry.status === 'release' && entry.resourcePackFormat).at(-1); if (version) blank(version.id) }
    if (request.operation === 'blank') blank(request.version || '', request.name)
    if (request.operation === 'import') importArchive(request)
    if (request.operation === 'apply') {
      const files = request.files ?? [], byPath = origins
      project.writeBatch(files)
      response.changed = files.map(file => ({ path: file.path, data: project.read(file.path)!, origin: byPath.get(file.path) ?? 'user', modified: true }))
      for (const entry of response.changed) origins.set(entry.path, entry.origin)
    } else if (request.operation === 'export') response.bytes = project.exportZip({ includeMcrhEditorData: request.includeMcrhEditorData, includeVanillaTextures: request.includeVanillaTextures })
    else { response.entries = project.entries(); origins.clear(); for (const entry of response.entries) origins.set(entry.path, entry.origin) }
    response.metadata = project.metadata
    const transfers = [...(response.entries ?? []), ...(response.changed ?? [])].map(entry => entry.data.buffer as ArrayBuffer)
    if (response.bytes) transfers.push(response.bytes.buffer as ArrayBuffer)
    self.postMessage(response, { transfer: transfers })
  } catch (error) { self.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies ProjectWorkerResponse) }
})
