import { uiText } from '../i18n/messages'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { familyPatternProblem, familySource, familyVariant, retargetFamilyJson, suggestFamilyPattern, type ReferenceChange } from '../core/jsonFamily'
import { templatePathProblem } from '../core/vanillaTemplates'
import { previewResourceContext } from './previewResourceContext'
import { applyResourceChanges, savedResource, type ResourceChange } from './resourceAuthoringFiles'
import { showResourceDiff } from './resourceAuthoringPreview'
import { assertEditableResourceRoot } from './modelPreviewDocuments'

interface FamilyPlan extends ResourceChange { changes: ReferenceChange[]; stem: string }
export async function applyJsonFamily(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri
  if (target?.scheme !== 'file') throw new Error(uiText("ui.jsonFamily.pleaseOpenTheModelBlockStateOr"))
  const resources = await previewResourceContext(target, context), source = resources && familySource(resources.source.relative)
  if (!resources || !source) throw new Error(uiText("ui.jsonFamily.batchMatchingOnlySupportsModelsBlockstatesAnd"))
  const root = resources.source.root
  await assertEditableResourceRoot(context, root)
  const document = await vscode.workspace.openTextDocument(target), text = document.getText(), version = document.version
  const candidates = new Set<string>()
  for (const file of await resources.assets.list(source.directory)) {
    if (path.posix.dirname(file) === source.directory && file.endsWith('.json')) candidates.add(path.posix.basename(file, '.json'))
  }
  if (source.category === 'models') {
    const directory = source.directory.replace('/models/', '/textures/')
    for (const file of await resources.assets.list(directory)) if (path.posix.dirname(file) === directory && file.endsWith('.png')) candidates.add(path.posix.basename(file, '.png'))
  }
  const pattern = await vscode.window.showInputBox({ title: uiText("ui.jsonFamily.batchMatchFilenameRules"), value: suggestFamilyPattern(source.stem, [...candidates]), prompt: uiText("ui.jsonFamily.useAMatchingPartOfTheChange"), ignoreFocusOut: true, validateInput: value => familyPatternProblem(value, source.stem) }); if (!pattern) return
  const problem = familyPatternProblem(pattern, source.stem); if (problem) throw new Error(problem)
  const matches = [...candidates].filter(stem => stem !== source.stem && familyVariant(pattern, stem) !== undefined).sort()
  const choices = matches.map(stem => ({ label: stem, description: source.directory + '/' + stem + '.json', stem }))
  const selected = await vscode.window.showQuickPick([...choices, { label: uiText("ui.jsonFamily.enterAnotherTargetName"), description: uiText("ui.jsonFamily.ifNoOriginalResourceIsExtractedThe"), stem: '' }], { title: uiText("ui.jsonFamily.batchMatchingSelectTheTargetToApply"), placeHolder: uiText("ui.jsonFamily.willCurrentFullJsonAppliedToThe", source.stem), canPickMany: true, matchOnDescription: true, ignoreFocusOut: true }); if (!selected?.length) return
  const targets = new Set(selected.filter(item => item.stem).map(item => item.stem))
  if (selected.some(item => !item.stem)) {
    const names = await vscode.window.showInputBox({ title: uiText("ui.jsonFamily.batchMatchNewTarget"), prompt: uiText("ui.jsonFamily.enterAFilenameThatDoesNotContain"), ignoreFocusOut: true, validateInput: value => targetNamesProblem(value, source.stem, pattern) }); if (!names) return
    const error = targetNamesProblem(names, source.stem, pattern); if (error) throw new Error(error)
    names.split(/[\s,，]+/).filter(Boolean).forEach(stem => targets.add(stem))
  }
  if (!targets.size || targets.size > 256) throw new Error(uiText("ui.jsonFamily.pleaseSelectToGoalsAtATime"))
  const plans: FamilyPlan[] = []
  for (const stem of targets) {
    const relative = source.directory + '/' + stem + '.json', transformed = retargetFamilyJson(text, source.stem, stem, pattern)
    const expected = await savedResource(root, relative)
    if (expected && new TextDecoder().decode(expected) === transformed.content) continue
    plans.push({ relative, stem, expected, content: transformed.content, changes: transformed.changes })
  }
  if (!plans.length) { void vscode.window.showInformationMessage(uiText("ui.jsonFamily.theSelectedTargetIsAlignedWithThe")); return }
  while (true) {
    const existing = plans.filter(plan => plan.expected).length, referenceCount = plans.reduce((sum, plan) => sum + plan.changes.length, 0)
    const action = await vscode.window.showQuickPick([
      { label: uiText("ui.jsonFamily.applyToObjectives", plans.length), description: uiText("ui.jsonFamily.newOtherOrganiserIndividualAdjustmentsGroupResource", (plans.length - existing), existing, referenceCount), value: 'apply' },
      { label: uiText("ui.jsonFamily.viewTargetDifferencesAndReferenceReplacements"), description: uiText("ui.jsonFamily.checkTheOriginalTargetContentAndApply"), value: 'diff' },
      { label: uiText("browser.shell.cancel"), value: 'cancel' }
    ], { title: uiText("ui.jsonFamily.confirmBatchApplication", source.stem, pattern), placeHolder: uiText("ui.jsonFamily.replacesTheSelectedJsonOnlyWithA"), ignoreFocusOut: true })
    if (!action || action.value === 'cancel') return
    if (action.value === 'apply') break
    const plan = await vscode.window.showQuickPick(plans.map(plan => ({ label: plan.stem, description: plan.expected ? uiText("ui.jsonFamily.replaceExistingFiles") : uiText("ui.jsonFamily.newFile"), detail: plan.changes.map(change => change.from + ' → ' + change.to).join(' · ') || uiText("ui.jsonFamily.quotingRemainsUnchanged"), plan })), { title: uiText("ui.jsonFamily.selectTheVariancePreviewTarget"), matchOnDetail: true, ignoreFocusOut: true })
    if (plan) await showResourceDiff(context, plan.plan.stem, plan.plan.expected ? new TextDecoder().decode(plan.plan.expected) : '', String(plan.plan.content))
  }
  const validateSource = (): void => { if (document.isClosed || document.version !== version || document.getText() !== text) throw new Error(uiText("ui.jsonFamily.sourceJsonChangedDuringConfirmationReEnforce")) }
  validateSource()
  await assertEditableResourceRoot(context, root)
  await applyResourceChanges(root, plans, [], validateSource)
  void vscode.window.showInformationMessage(uiText("ui.jsonFamily.usedAJsonCanCheckAndUndo", plans.length))
}

function targetNamesProblem(value: string, source: string, pattern: string): string | undefined {
  const names = value.split(/[\s,，]+/).filter(Boolean)
  if (!names.length || names.length > 256) return uiText("ui.jsonFamily.enterToTargetNames")
  return names.some(name => name === source || name.includes('/') || templatePathProblem(name) || familyVariant(pattern, name) === undefined) ? uiText("ui.jsonFamily.theTargetMustBeAMatchingFile") : undefined
}
