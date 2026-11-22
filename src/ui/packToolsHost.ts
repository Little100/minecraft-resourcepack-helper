import { uiText } from '../i18n/messages'
import { canExportPackFile, shouldExportPackPath } from '../core/advanced/editorDataExportPolicy'
import * as vscode from 'vscode'
import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { randomUUID } from 'node:crypto'
import { assertExportPathWithoutLinks, isInsideExportDirectory, readSafeExportFile, readVanillaExportBase } from '../core/advanced/exportPolicy'
import { PackToolsRequestSchema, PACK_TOOLS_LIMITS, assertPackToolsPath, encodePackToolsBytes, decodePackToolsBytes, sanitizePackToolsArchive, type PackToolsResponse, type PackToolsWireFile } from '../core/advanced/packToolsProtocol'

export class PackToolsHost implements vscode.Disposable {
  private readonly authorizedProjects = new Map<string, string>()
  authorizeProject(root: string): string {
    const token = randomUUID()
    this.authorizedProjects.set(token, root)
    while (this.authorizedProjects.size > 16) this.authorizedProjects.delete(this.authorizedProjects.keys().next().value!)
    return token
  }
  private busy = false
  private disposed = false
  private generation = 0
  private readonly sourceFiles = new Set<string>()
  private readonly sourceRoots = new Set<string>()
  get isBusy(): boolean { return this.busy }
  constructor(private readonly webview: vscode.Webview, private readonly available: () => boolean = () => true) {}
  dispose(): void { this.disposed = true; this.generation++; this.authorizedProjects.clear() }
  private post(response: PackToolsResponse): void { if (!this.disposed) void this.webview.postMessage(response) }
  async handle(raw: unknown): Promise<boolean> {
    if (!raw || typeof raw !== 'object' || !('command' in raw) || typeof raw.command !== 'string' || !raw.command.startsWith('packTools')) return false
    const parsed = PackToolsRequestSchema.safeParse(raw)
    if (!parsed.success) { const id = 'requestId' in raw && typeof raw.requestId === 'string' ? raw.requestId.slice(0, 128) : 'invalid'; this.post({ type: 'packToolsResponse', requestId: id, ok: false, error: uiText("browser.packToolsBridge.theMaterialPackageManagementRequestIsInvalid") }); return true }
    const request = parsed.data
    if (request.command === 'packToolsCancel') { this.generation++; return true }
    if (this.busy || !this.available()) { this.post({ type: 'packToolsResponse', requestId: request.requestId, ok: false, error: uiText("ui.packToolsHost.fileOperationIsOngoingPleaseTryAgain") }); return true }
    this.busy = true
    const generation = this.generation, check = () => { if (this.disposed || generation !== this.generation) throw new Error(uiText("browser.packToolsBridge.operationCanceled")) }
    let result: Partial<PackToolsResponse> = {}
    try {
      if (request.command === 'packToolsImport') {
        const selected = await vscode.window.showOpenDialog({ title: uiText("ui.packToolsHost.importMultipleResourcePacksZip"), canSelectMany: true, canSelectFiles: true, canSelectFolders: false, filters: { ZIP: ['zip'] } }); check()
        if (!selected?.length) result = { canceled: true }
        else {
          if (selected.length > PACK_TOOLS_LIMITS.packs) throw new Error(uiText("ui.packToolsHost.importPackagesExceeding"))
          let total = 0
          const archives: NonNullable<PackToolsResponse['archives']> = []
          for (const uri of selected) {
            check(); if (uri.scheme !== 'file') throw new Error(uiText("ui.packToolsHost.resourcePackImportOnlySupportsLocalFiles"))
            await assertExportPathWithoutLinks(uri.fsPath)
            const stat = await fs.lstat(uri.fsPath)
            if (!stat.isFile() || !stat.size || stat.size > PACK_TOOLS_LIMITS.bytes) throw new Error(uiText("ui.packToolsHost.zipIsNotANormalFileOr"))
            total += stat.size; if (total > PACK_TOOLS_LIMITS.bytes) throw new Error(uiText("ui.packToolsHost.selectedZipTotalVolumeInExcessOf"))
            const handle = await fs.open(uri.fsPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
            let bytes: Uint8Array
            try {
              const buffer = new Uint8Array(stat.size + 1); let offset = 0
              while (offset < buffer.length) { const read = await handle.read(buffer, offset, buffer.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead }
              bytes = buffer.subarray(0, offset)
            } finally { await handle.close() }
            check(); if (bytes.length !== stat.size) throw new Error(uiText("ui.packToolsHost.fileChangedWhenReadReImport"))
            this.sourceFiles.add(path.resolve(uri.fsPath).toLowerCase())
            archives.push({ name: path.basename(uri.fsPath), base64: encodePackToolsBytes(bytes) })
          }
          result = { archives }
        }
      }
      if (request.command === 'packToolsImages') {
        const selected = await vscode.window.showOpenDialog({ title: uiText("ui.packToolsHost.selectBatchPngMultipleSelectionSupported"), canSelectFiles: true, canSelectFolders: false, canSelectMany: true, filters: { PNG: ['png'] } }); check()
        if (!selected?.length) result = { canceled: true }
        else {
          if (selected.length > 4096) throw new Error(uiText("ui.packToolsHost.moreThanImagesSelected"))
          let total = 0
          const files: PackToolsWireFile[] = [], used = new Set<string>()
          for (const uri of selected) {
            check(); if (uri.scheme !== 'file' || !/\.png$/i.test(uri.fsPath)) throw new Error(uiText("ui.packToolsHost.onlyLocalPngFilesAccepted"))
            const name = path.basename(uri.fsPath).toLowerCase().replace(/[^a-z0-9_.-]/g, '_'), relative = 'assets/minecraft/textures/block/' + name
            assertPackToolsPath(relative)
            if (used.has(relative)) throw new Error(uiText("ui.packToolsHost.theSelectedPictureHasAnOutputWith", name))
            used.add(relative)
            const content = await readSafeExportFile(path.dirname(uri.fsPath), path.basename(uri.fsPath))
            if (content.length > 32 * 1024 * 1024 || (total += content.length) > PACK_TOOLS_LIMITS.bytes) throw new Error(uiText("ui.packToolsHost.picturesOrTotalsInExcessOfBatch"))
            files.push({ path: relative, base64: encodePackToolsBytes(content), origin: 'user' }); this.sourceFiles.add(path.resolve(uri.fsPath).toLowerCase())
              try {
                const metadata = await readSafeExportFile(path.dirname(uri.fsPath), path.basename(uri.fsPath) + '.mcmeta')
                check()
                if (metadata.length > 1024 * 1024 || (total += metadata.length) > PACK_TOOLS_LIMITS.bytes) throw new Error(uiText("ui.packToolsHost.animatedMetadataOrTotalsInExcessOf"))
                files.push({ path: relative + '.mcmeta', base64: encodePackToolsBytes(metadata), origin: 'user' })
                this.sourceFiles.add(path.resolve(uri.fsPath + '.mcmeta').toLowerCase())
              } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          }
          result = { files, name: 'selected-images' }
        }
      }
      if (request.command === 'packToolsProject') {
        const authorizedRoot = request.projectToken ? this.authorizedProjects.get(request.projectToken) : undefined
        if (request.projectToken && !authorizedRoot) throw new Error(uiText("ui.packToolsHost.theCurrentPackageConversionRequestIsInvalid"))
        if (request.projectToken) this.authorizedProjects.delete(request.projectToken)
        const selected = authorizedRoot ? [vscode.Uri.file(authorizedRoot)] : await vscode.window.showOpenDialog({ title: uiText("ui.packToolsHost.readResourcePackProjectFolders"), canSelectMany: false, canSelectFiles: false, canSelectFolders: true, defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri }); check()
        if (!selected?.length) result = { canceled: true }
        else {
          const uri = selected[0]!; if (uri.scheme !== 'file') throw new Error(uiText("ui.packToolsHost.supportOnlyLocalResourcePackProjects"))
          const root = uri.fsPath; await assertExportPathWithoutLinks(root)
          const files: PackToolsWireFile[] = []; let total = 0, entries = 0
          const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
            if (depth > PACK_TOOLS_LIMITS.depth) throw new Error(uiText("ui.packToolsHost.theLevelOfTheDirectoryIsAbove"))
            for (const item of await fs.readdir(directory, { withFileTypes: true })) {
              check(); if (++entries > PACK_TOOLS_LIMITS.entries) throw new Error(uiText("ui.packToolsHost.tableOfContentsOverBudget"))
              const relative = prefix + item.name; assertPackToolsPath(relative)
              if (item.isSymbolicLink()) throw new Error(uiText("ui.packToolsHost.resourcePackItemsCannotContainLinks"))
              if (!shouldExportPackPath(relative, { includeMcrhEditorData: true })) continue
              if (item.isDirectory()) await walk(path.join(directory, item.name), relative + '/', depth + 1)
              else if (item.isFile()) {
                if (files.length >= PACK_TOOLS_LIMITS.files) throw new Error(uiText("ui.packToolsHost.projectDocumentsExceededBudget"))
                const bytes = await readSafeExportFile(root, relative); total += bytes.length
                if (total > PACK_TOOLS_LIMITS.bytes) throw new Error(uiText("ui.packToolsHost.totalProjectDocumentationInExcessOfMib"))
                if (!canExportPackFile({ path: relative, content: bytes }, { includeMcrhEditorData: true })) continue
                const stat = await fs.lstat(path.join(directory, item.name))
                files.push({ path: relative, base64: encodePackToolsBytes(bytes), origin: 'user', modifiedAt: stat.mtimeMs })
              } else throw new Error(uiText("ui.packToolsHost.resourcePackItemsIncludeSpecialFiles"))
            }
          }
          await walk(root, '', 0); check()
          if (!files.some(file => file.path === 'pack.mcmeta')) throw new Error(uiText("ui.packToolsHost.projectRootDirectoryMissingPackMcmeta"))
          this.sourceRoots.add(root); result = { files, name: path.basename(root) }
        }
      }
      if (request.command === 'packToolsBaseline') {
        for (const relative of request.paths) assertPackToolsPath(relative)
        const base = vscode.workspace.getConfiguration('mcrh').get<string>('previewBaseAssetsPath', '').trim()
        const originals = await readVanillaExportBase(base || undefined, request.paths.map(relative => ({ path: relative, content: new Uint8Array() })), { scope: 'resources' }); check()
        let total = 0
        result = { files: [...originals].map(([relative, bytes]) => { total += bytes.length; if (total > PACK_TOOLS_LIMITS.bytes) throw new Error(uiText("ui.packToolsHost.originalSourceReferenceExceededBudget")); return { path: relative, base64: encodePackToolsBytes(bytes), origin: 'vanilla' as const } }) }
      }
      if (request.command === 'packToolsSave') {
        const bytes = sanitizePackToolsArchive(decodePackToolsBytes(request.base64, PACK_TOOLS_LIMITS.bytes), request.includeMcrhEditorData)
        if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error(uiText("ui.packToolsHost.saveContentIsNotAValidZip"))
        const filename = request.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\.zip$/i, '') + '.zip'
        const output = await vscode.window.showSaveDialog({ title: uiText("ui.packToolsHost.saveGeneratedMaterialPackageZip"), defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0] ? path.dirname(vscode.workspace.workspaceFolders[0].uri.fsPath) : os.homedir(), filename)), filters: { ZIP: ['zip'] }, saveLabel: uiText("ui.packToolsHost.saveZip") }); check()
        if (!output) result = { canceled: true }
        else {
          if (output.scheme !== 'file') throw new Error(uiText("ui.packToolsHost.zipCanOnlySaveAsALocal"))
          if (this.sourceFiles.has(path.resolve(output.fsPath).toLowerCase()) || [...this.sourceRoots].some(root => isInsideExportDirectory(root, output.fsPath))) throw new Error(uiText("ui.packToolsHost.selectTheZipSavingPositionOutsideThe"))
          await assertExportPathWithoutLinks(output.fsPath, true); check()
          const temporary = path.join(path.dirname(output.fsPath), '.mcrh-pack-' + randomUUID() + '.zip.tmp')
          try {
            const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
            try { await handle.writeFile(bytes) } finally { await handle.close() }
            check(); await assertExportPathWithoutLinks(output.fsPath, true); check(); await fs.rename(temporary, output.fsPath)
          } finally { await fs.rm(temporary, { force: true }) }
          result = { saved: true, name: path.basename(output.fsPath) }
        }
      }
      check(); this.post({ type: 'packToolsResponse', requestId: request.requestId, ok: true, ...result })
    } catch (error) { this.post({ type: 'packToolsResponse', requestId: request.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }) }
    finally { this.busy = false }
    return true
  }
}
