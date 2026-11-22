import { uiText } from '../i18n/messages'
import { MOD_TEXTURE_LIMITS, ModTextureRequest, readModTextures, resolveModDuplicates, planModTextures, modFiles, type ModConflictChoice, type ModTexturePack } from '../core/advanced/modTextures'
import { pickFiles, readFile, errorText } from './files'
import type { ProjectPort } from './projectPort'

export function confirmModTextures(paths: string[], title: string, signal: AbortSignal): Promise<ModConflictChoice> {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog'); dialog.className = 'web-dialog mod-texture-confirm'
    const heading = document.createElement('h2'); heading.textContent = title
    const detail = document.createElement('p'); detail.textContent = uiText("browser.modTexturesBridge.pasteAndCarryMcmetaByGroupNew")
    const list = document.createElement('pre'); list.textContent = paths.join('\n')
    const actions = document.createElement('div'); actions.className = 'web-inline'
    const finish = (choice: ModConflictChoice) => { signal.removeEventListener('abort', abort); dialog.remove(); resolve(choice) }
    const abort = () => finish('cancel')
    for (const [label, choice] of [[uiText("browser.modTexturesBridge.replaceMatchingPaths"), 'replace'], [uiText("browser.modTexturesBridge.keepExistingFiles"), 'keep'], [uiText("browser.modTexturesBridge.cancelImport"), 'cancel']] as const) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.dataset.modChoice = choice; button.addEventListener('click', () => finish(choice)); actions.append(button)
    }
    dialog.append(heading, detail, list, actions); document.body.append(dialog)
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish('cancel') })
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) { abort(); return }; dialog.showModal()
    actions.querySelector<HTMLButtonElement>('[data-mod-choice="keep"]')!.focus()
  })
}

export class BrowserModTexturesBridge {
  private controller?: AbortController
  private committing = false
  get busy(): boolean { return Boolean(this.controller) }
  constructor(private readonly project: ProjectPort, private readonly available: () => boolean, private readonly changed: () => void) {}
  async handle(raw: unknown): Promise<boolean> {
    if (!raw || typeof raw !== 'object' || !('command' in raw) || typeof raw.command !== 'string' || !raw.command.startsWith('modTextures')) return false
    const request = ModTextureRequest.safeParse(raw), requestId = 'requestId' in raw && typeof raw.requestId === 'string' ? raw.requestId.slice(0, 128) : 'invalid'
    const done = (ok: boolean, text: string, canceled = false) => window.postMessage({ type: 'modTexturesResult', requestId, ok, text, canceled }, location.origin)
    if (!request.success) { done(false, uiText("browser.modTexturesBridge.modularImportRequestInvalid")); return true }
    if (request.data.command === 'modTexturesCancel') { if (!this.committing) this.controller?.abort(); return true }
    if (this.busy || !this.available()) { done(false, uiText("browser.modTexturesBridge.otherFilesAreNotFinishedPleaseTry")); return true }
    const controller = this.controller = new AbortController(), signal = controller.signal, revision = this.project.revision
    const check = () => { signal.throwIfAborted(); if (revision !== this.project.revision) throw new Error(uiText("browser.modTexturesBridge.itemHasChangedThisImportIsNot")) }
    const notes: string[] = []
    try {
      const selected = await pickFiles('.jar', true); check()
      if (!selected.length) { done(true, uiText("browser.modTexturesBridge.canceled"), true); return true }
      if (selected.reduce((size, file) => size + file.size, 0) > MOD_TEXTURE_LIMITS.archiveBytes) throw new Error(uiText("browser.modTexturesBridge.selectedJarTotalsMoreThanMibImport"))
      const packs: ModTexturePack[] = []
      for (const file of selected) {
        check()
        if (!/\.jar$/i.test(file.name)) { notes.push(file.name + uiText("browser.modTexturesBridge.pleaseSelectJarFile")); continue }
        try {
          const pack = await readModTextures(await readFile(file, MOD_TEXTURE_LIMITS.archiveBytes), file.name, check)
          modFiles([...packs.flatMap(value => value.groups), ...pack.groups]); packs.push(pack)
          notes.push(file.name + uiText("browser.modTexturesBridge.modular") + pack.ids.join(', ') + uiText("browser.modTexturesBridge.namespace") + pack.namespaces.join(', ') + '; ' + pack.groups.length + uiText("browser.modTexturesBridge.poster"), ...pack.warnings)
        } catch (error) { check(); notes.push(file.name + uiText("browser.modTexturesBridge.discarded") + errorText(error) + ')') }
      }
      const groups = await resolveModDuplicates(packs, paths => confirmModTextures(paths, uiText("browser.modTexturesBridge.pasteConflictBetweenModulesZhangReplaceWith", paths.length), signal)); check()
      if (!groups) { done(true, uiText("browser.modTexturesBridge.canceled"), true); return true }
      modFiles(groups)
      if (!groups.length) { done(false, uiText("browser.modTexturesBridge.noValidModTexturesToImport", notes.join('\n'))); return true }
      const plan = await planModTextures(groups, async path => this.project.read(path)); check()
      const choice = plan.conflicts.length ? await confirmModTextures(plan.conflicts.map(group => group.path), uiText("browser.modTexturesBridge.theProjectHasTheSamePathSticker", plan.conflicts.length), signal) : 'keep'; check()
      if (choice === 'cancel') { done(true, uiText("browser.modTexturesBridge.canceled"), true); return true }
      const files = modFiles([...plan.additions, ...(choice === 'replace' ? plan.conflicts : [])]); check()
      if (files.length) { this.committing = true; window.postMessage({ type: 'modTexturesProgress', requestId, committing: true, text: uiText("browser.modTexturesBridge.presentingProjectPleaseWaitForCompletion") }, location.origin); await this.project.apply(files, revision); this.changed() }
      done(true, (files.length ? uiText("browser.modTexturesBridge.importedToCurrentItemAResourceFile", files.length) : uiText("browser.modTexturesBridge.noFileToWrite")) + '\n' + notes.join('\n') + '\n' + plan.warnings.join('\n') + '\n' + files.map(file => file.path).join('\n'))
    } catch (error) { done(false, signal.aborted ? uiText("browser.modTexturesBridge.canceled") : errorText(error), signal.aborted) }
    finally { if (this.controller === controller) { this.controller = undefined; this.committing = false } }
    return true
  }
}
