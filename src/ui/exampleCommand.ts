import { uiText } from '../i18n/messages'
import * as vscode from 'vscode'
import { listTemplates, planTemplate, selectTargets, writeTemplate, type TemplateBundle } from '../core/exampleTemplates'
import { runtimeConfig } from '../core/config'
import { namespaceProblem } from '../core/namespace'
import { pickWorkspaceRoot } from './workspacePicker'
import { askOverwrite, findExisting } from './overwriteDialog'

let cachedTemplates: TemplateBundle[] | undefined

function templates(): TemplateBundle[] {
  cachedTemplates ??= listTemplates()
  return cachedTemplates
}

export function registerExampleCommand(onWritten: () => void): vscode.Disposable {
  return vscode.commands.registerCommand('mcrh.createExample', async (target?: TemplateBundle | vscode.Uri, rootUri?: vscode.Uri) => {
    const root = await resolveTargetRoot(target, rootUri)
    if (!root) return

    const bundle = isBundle(target) ? target : await pickBundle()
    if (!bundle) return

    const input = await vscode.window.showInputBox({
      prompt: uiText("ui.exampleCommand.namespaceLeaveEmptyWithDefault"),
      value: runtimeConfig().defaultNamespace,
      validateInput: value => (value === '' ? undefined : namespaceProblem(value))
    })
    if (input === undefined) return
    const namespace = input === '' ? runtimeConfig().defaultNamespace : input

    const plan = planTemplate(bundle, root, namespace)
    const existing = await findExisting(plan.map(file => file.target))
    const policy = await askOverwrite(existing)
    if (policy === 'cancel') return

    const written = await writeTemplate(plan, selectTargets(plan, existing, policy))
    const skipped = plan.length - written.length
    if (written.length === 0) {
      void vscode.window.showInformationMessage(uiText("ui.exampleCommand.noFilesWrittenSkippedExistingFile", skipped))
      return
    }
    onWritten()

    const summary = skipped > 0
      ? uiText("ui.exampleCommand.generatedFileSkipExistingFile", written.length, skipped)
      : uiText("ui.exampleCommand.generatedFile", written.length)
    const choice = await vscode.window.showInformationMessage(summary, uiText("ui.exampleCommand.openFirstFile"), uiText("ui.exampleCommand.showInResourceManager"))
    if (choice === uiText("ui.exampleCommand.openFirstFile")) {
      await vscode.window.showTextDocument(vscode.Uri.file(written[0]))
    } else if (choice === uiText("ui.exampleCommand.showInResourceManager")) {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(written[0]))
    }
  })
}

async function resolveTargetRoot(target?: TemplateBundle | vscode.Uri, rootUri?: vscode.Uri): Promise<string | undefined> {
  if (rootUri) return rootUri.fsPath
  if (isUri(target)) return target.fsPath
  return pickWorkspaceRoot()
}

function isUri(value: unknown): value is vscode.Uri {
  return value instanceof vscode.Uri
}

function isBundle(value: unknown): value is TemplateBundle {
  return typeof value === 'object' && value !== null && !(value instanceof vscode.Uri) && 'files' in value
}

async function pickBundle(): Promise<TemplateBundle | undefined> {
  const options = templates().map(bundle => ({
    label: bundle.label,
    description: bundle.description,
    bundle
  }))
  const picked = await vscode.window.showQuickPick(options, { placeHolder: uiText("ui.exampleCommand.selectTheExampleStructureToGenerate") })
  return picked?.bundle
}
