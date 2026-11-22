import { uiText } from '../i18n/messages'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { addSoundEvent, jsonObject, templatePathProblem, VANILLA_TEMPLATES } from '../core/vanillaTemplates'
import { runtimeConfig } from '../core/config'
import { namespaceProblem } from '../core/namespace'
import { CYAN } from '../core/exampleAssets'
import { sourceOf } from './previewResourceContext'
import { pickWorkspaceRoot } from './workspacePicker'
import { applyResourceChanges, savedResource, type ResourceChange } from './resourceAuthoringFiles'
import { assertEditableResourceRoot } from './modelPreviewDocuments'

export async function authoringRoot(uri?: vscode.Uri): Promise<string | undefined> {
  const active = uri ?? vscode.window.activeTextEditor?.document.uri
  if (active?.scheme === 'file') {
    if (path.basename(active.fsPath) === 'pack.mcmeta') return path.dirname(active.fsPath)
    const source = sourceOf(active.fsPath)
    if (source) return source.root
  }
  return pickWorkspaceRoot()
}

async function pickNamespace(root: string): Promise<string | undefined> {
  let names: string[] = []
  try { names = (await vscode.workspace.fs.readDirectory(vscode.Uri.file(path.join(root, 'assets')))).filter(([name, type]) => type === vscode.FileType.Directory && !namespaceProblem(name) && name !== '.' && name !== '..').map(([name]) => name) } catch {}
  const fallback = runtimeConfig().defaultNamespace
  const choices = [...new Set([fallback, 'minecraft', ...names])].map(name => ({ label: name, description: name === 'minecraft' ? uiText("ui.vanillaTemplates.replaceOriginalResource") : uiText("ui.vanillaTemplates.resourceNamingSpace"), value: name }))
  const picked = await vscode.window.showQuickPick([...choices, { label: uiText("ui.vanillaTemplates.addNamingSpace"), description: uiText("ui.vanillaTemplates.enterACustomNamingSpace"), value: '' }], { title: uiText("ui.vanillaTemplates.originalResourceTemplateNamingSpace"), ignoreFocusOut: true })
  if (!picked) return undefined
  if (picked.value) return picked.value
  return vscode.window.showInputBox({ title: uiText("ui.vanillaTemplates.addNamespace"), value: fallback, ignoreFocusOut: true, validateInput: value => namespaceProblem(value) ?? (value === '.' || value === '..' ? uiText("ui.vanillaTemplates.namespaceCannotBeARelativeDirectory") : undefined) })
}

export async function createVanillaTemplate(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  const root = await authoringRoot(uri); if (!root) return
  await assertEditableResourceRoot(context, root)
  const template = await vscode.window.showQuickPick(VANILLA_TEMPLATES, { title: uiText("ui.vanillaTemplates.originalResourceTemplateResourceType"), matchOnDescription: true, ignoreFocusOut: true }); if (!template) return
  const namespace = await pickNamespace(root); if (!namespace) return
  if (namespaceProblem(namespace) || namespace === '.' || namespace === '..') throw new Error(uiText("ui.vanillaTemplates.namespaceInvalid"))
  const files: ResourceChange[] = [], directories: string[] = []
  if (template.id === 'sounds') {
    const mode = await vscode.window.showQuickPick([{ label: uiText("ui.vanillaTemplates.importOggAndCreateSoundEvents"), import: true }, { label: uiText("ui.vanillaTemplates.onlyCreateDirectoriesAndSoundDefinitions"), import: false }], { title: uiText("ui.vanillaTemplates.soundsCreateBy"), ignoreFocusOut: true }); if (!mode) return
    const event = await vscode.window.showInputBox({ title: uiText("ui.vanillaTemplates.soundsSoundEventName"), value: template.defaultName, prompt: uiText("ui.vanillaTemplates.eGCustomIdleUsePlaysearchEvent", namespace), ignoreFocusOut: true, validateInput: value => /^[a-z0-9_.-]+$/.test(value) && value !== '.' && value !== '..' ? undefined : uiText("ui.vanillaTemplates.useLowercaseLettersNumbersUnderlinedsDotsOr") }); if (!event) return
    const name = await vscode.window.showInputBox({ title: uiText("ui.vanillaTemplates.soundsOggResourcePath"), value: event.replaceAll('.', '/'), prompt: uiText("ui.vanillaTemplates.notContainingOggForExampleCustomIdle"), ignoreFocusOut: true, validateInput: templatePathProblem }); if (!name) return
    const relative = 'assets/' + namespace + '/sounds.json', expected = await savedResource(root, relative)
    const content = addSoundEvent(expected && new TextDecoder().decode(expected), event, namespace + ':' + name)
    if (mode.import) {
      const picked = await vscode.window.showOpenDialog({ title: uiText("ui.vanillaTemplates.selectOggSoundFile"), canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { [uiText("ui.vanillaTemplates.oggSound")]: ['ogg'] } }); if (!picked?.[0]) return
      const source = picked[0], stat = await vscode.workspace.fs.stat(source)
      if (source.scheme !== 'file' || !source.fsPath.toLowerCase().endsWith('.ogg') || stat.size > 8 * 1024 * 1024) throw new Error(uiText("ui.vanillaTemplates.pleaseSelectALocalOggFileNot"))
      const bytes = await vscode.workspace.fs.readFile(source)
      if (bytes.length > 8 * 1024 * 1024 || Buffer.from(bytes.subarray(0, 4)).toString('ascii') !== 'OggS') throw new Error(uiText("ui.vanillaTemplates.theSelectedFileIsNotAValid"))
      const sound = 'assets/' + namespace + '/sounds/' + name + '.ogg'
      const previous = await savedResource(root, sound)
      if (previous) throw new Error(uiText("ui.vanillaTemplates.theSameSoundFileAlreadyExistsPlease", sound))
      files.push({ relative: sound, content: bytes, expected: undefined })
    }
    files.push({ relative, content, expected }); directories.push(path.posix.join('assets', namespace, 'sounds', path.posix.dirname(name)))
  } else {
    const name = await vscode.window.showInputBox({ title: template.label + uiText("ui.vanillaTemplates.nameOfTheResource"), value: template.defaultName, ignoreFocusOut: true, validateInput: templatePathProblem }); if (!name) return
    const relative = 'assets/' + namespace + '/' + template.directory + '/' + name + '.json', expected = await savedResource(root, relative)
    if (expected) { jsonObject(new TextDecoder().decode(expected)); throw new Error(uiText("ui.vanillaTemplates.theSameNameResourceExistsAndIs")) }
    files.push({ relative, content: JSON.stringify(template.build(namespace, name), null, 2) + '\n', expected })
    if (template.id === 'block' || template.id === 'item') {
      const texture = 'assets/' + namespace + '/textures/' + template.id + '/' + name + '.png', previous = await savedResource(root, texture)
      if (!previous) files.push({ relative: texture, content: CYAN, expected: undefined })
    }
  }
  const confirmed = await vscode.window.showQuickPick([{ label: uiText("ui.vanillaTemplates.createTemplate"), description: files.length + uiText("browser.resources.files"), accept: true }, { label: uiText("browser.shell.cancel"), accept: false }], { title: uiText("ui.vanillaTemplates.confirmToCreate", namespace), placeHolder: files.map(file => file.relative).join(' · '), ignoreFocusOut: true }); if (!confirmed?.accept) return
  await assertEditableResourceRoot(context, root)
  await applyResourceChanges(root, files, directories)
  const first = files.find(file => file.relative.endsWith('.json'))!
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, first.relative)))
  void vscode.window.showInformationMessage(uiText("ui.vanillaTemplates.theOriginalResourceTemplateHasBeenApplied", (template.id === 'sounds' ? uiText("ui.vanillaTemplates.pleaseConfirmThatTheActualOggIs") : uiText("ui.vanillaTemplates.theCustomNamespaceModelDoesNotAutomatically"))))
}
