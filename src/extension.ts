import { watchInterfaceLanguage } from './ui/uiLanguage'
import { uiText } from './i18n/messages'
import { registerResourceTemplates } from './ui/resourceTemplates'
import { registerPreviewRestoration } from './ui/previewRestoration'
import { previewGuiFromCommand } from './ui/guiPreviewPanel'
import { registerGeneratedModelFolding } from './ui/generatedModelFolding'
import { registerMcpHost } from './ui/mcpHost'
import { initializeExtensionLog } from './ui/extensionLog'
import { registerWebviewDiagnostics } from './ui/webviewDiagnostics'
import { TodoHost } from './ui/todoHost'
import { GitWorkbenchHost } from './ui/gitWorkbench'
import { registerCollaborationCommands } from './ui/collaborationPanel'
import { registerPackDiagnosisCommands } from './ui/packDiagnosisCommand'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { scanForPacks, type ScannedPack } from './core/packScanner'
import { configuredScanSettings, registerScanCommands } from './ui/scanSettings'
import { openTextureInBlockbench, previewVanillaFromCommand } from './ui/vanillaPreviewPanel'
import { createStructure, findSpec, scaffoldPack, structureSpecs, type StructureSpec } from './core/structures'
import { needsRefresh, refreshTable } from './core/packFormatTable'
import { TutorialPanel } from './ui/tutorialPanel'
import { AdvancedPanel } from './ui/advancedPanel'
import { SidebarTreeProvider } from './ui/sidebarTree'
import { PackDecorationProvider } from './ui/packDecoration'
import { LANGUAGE_ID, OptiFineDiagnostics, OptiFineHoverProvider } from './ui/optifineLanguage'
import { register as registerOptiFineCompletion } from './ui/optifineCompletion'
import { register as registerResourceCompletion } from './ui/resourceCompletion'
import { register as registerPackMetaCompletion } from './ui/packMetaCompletion'
import { registerColorCodes } from './ui/colorCodes'
import { LangDiagnostics } from './ui/langDiagnostics'
import { extractVanillaAssets } from './ui/clientAssetsCommand'
import { previewFromCommand } from './ui/previewPanel'
import { SyntaxPreviewPanel } from './ui/syntaxPreview'
import { PixelEditorProvider } from './ui/pixelEditor'
import { CONTEXT_KEYS, initContextKeys, setContext } from './ui/contextKeys'
import { registerExampleCommand } from './ui/exampleCommand'
import { registerConvertCommand } from './ui/convertCommand'
import { registerExportPackCommand } from './ui/exportPackCommand'
import { registerFfmpegCommands } from './ui/ffmpegCommands'
import { registerBlockbenchCommands } from './ui/blockbenchCommand'
import { pickWorkspaceRoot } from './ui/workspacePicker'
import { runtimeConfig } from './core/config'
import { writeTutorial as writeOptiFineTutorial } from './core/optifine/tutorial'

let sidebar: SidebarTreeProvider | undefined

export function activate(context: vscode.ExtensionContext): void {
  watchInterfaceLanguage(context)
  initializeExtensionLog(context)
  registerWebviewDiagnostics(context)
  registerPreviewRestoration(context)
  registerResourceTemplates(context)
  registerGeneratedModelFolding(context)
  void initContextKeys()
  GitWorkbenchHost.register(context)
  TodoHost.register(context)
  registerMcpHost(context)

  const showTutorial = vscode.commands.registerCommand('mcrh.showTutorial', () => {
    TutorialPanel.show(context)
  })

  const refreshPack = vscode.commands.registerCommand('mcrh.refreshPack', () => refreshDetections())

  const scanPacks = vscode.commands.registerCommand('mcrh.scanPacks', async () => {
    if (!sidebar) {
      void vscode.window.showWarningMessage(uiText("extension.theMrchSidebarIsNotReadyPlease"))
      return
    }
    await sidebar.scan()
  })

  const createExample = registerExampleCommand(() => sidebar?.refresh())

  const createStructureCommand = vscode.commands.registerCommand('mcrh.createStructure', async (root?: string, spec?: StructureSpec) => {
    const target = root ?? await pickWorkspaceRoot()
    if (!target) return
    const resolved = spec ?? findSpec(await pickStructureId() ?? '')
    if (!resolved) return

    const result = await createStructure(target, resolved, context)
    sidebar?.refresh()
    if (result.created.length === 0) {
      void vscode.window.showInformationMessage(uiText("extension.existingUnchanged", resolved.label))
      return
    }
    if (resolved.kind === 'file') {
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(target, resolved.relative)))
    }
  })

  const scaffoldCommand = vscode.commands.registerCommand('mcrh.scaffoldPack', async (uri?: vscode.Uri) => {
    const root = uri?.fsPath ?? await pickWorkspaceRoot()
    if (!root) return
    const result = await scaffoldPack(root, context)
    sidebar?.refresh()
    void vscode.window.showInformationMessage(
      result.created.length > 0
        ? uiText("extension.completeTablesAndFiles", result.created.length)
        : uiText("extension.resourcePackStructureIsCompleteAndUnchanged")
    )
  })

  const extractAssets = vscode.commands.registerCommand('mcrh.extractClientAssets', () => extractVanillaAssets(context))

  const previewTexture = vscode.commands.registerCommand('mcrh.previewTexture', (uri?: vscode.Uri) => previewFromCommand(context, uri))

  const refreshFormats = vscode.commands.registerCommand('mcrh.refreshPackFormats', async () => {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: uiText("command.refreshPackFormats") },
      () => refreshTable(context)
    )
    if (result.ok) {
      void vscode.window.showInformationMessage(uiText("extension.theVersionFormatTableHasBeenUpdated", result.message))
    } else {
      void vscode.window.showWarningMessage(uiText("extension.updateFailedSavedLocalCacheVersionTable", result.message))
    }
  })

  const writeOptiFineDoc = vscode.commands.registerCommand('mcrh.writeOptiFineTutorial', async () => {
    const root = await pickWorkspaceRoot()
    if (!root) return
    const written = await writeOptiFineTutorial(runtimeConfig().defaultNamespace, root)
    const doc = await vscode.workspace.openTextDocument(written)
    await vscode.window.showTextDocument(doc)
  })

  sidebar = SidebarTreeProvider.register(context)
  const decoration = PackDecorationProvider.register(context)
  sidebar.onScanned(packs => { decoration.setPacks(packs); void refreshDetections(packs) })

  context.subscriptions.push(
    showTutorial,
    refreshPack,
    scanPacks,
    ...registerScanCommands(() => sidebar?.scan() ?? Promise.resolve()),
    createExample,
    createStructureCommand,
    scaffoldCommand,
    extractAssets,
    previewTexture,
    vscode.commands.registerCommand('mcrh.previewGui', (uri?: vscode.Uri | { resourceUri?: vscode.Uri }) => previewGuiFromCommand(context, uri)),
    vscode.commands.registerCommand('mcrh.openTextureInBlockbench', (uri?: vscode.Uri) => uri ? openTextureInBlockbench(context, uri) : vscode.window.showWarningMessage(uiText("extension.openTheAssociationModelFromThePoster"))),
    vscode.commands.registerCommand('mcrh.previewVanillaModel', (uri?: vscode.Uri) => previewVanillaFromCommand(context, uri)),
    refreshFormats,
    writeOptiFineDoc,
    registerConvertCommand(context),
    registerExportPackCommand(),
    ...registerPackDiagnosisCommands(context),
    ...registerCollaborationCommands(context),
    vscode.commands.registerCommand('mcrh.openAdvancedWorkbench', () => AdvancedPanel.show(context)),
    registerFfmpegCommands(),
    ...registerBlockbenchCommands(),
    PixelEditorProvider.register(context),
    LangDiagnostics.register(context),
    SyntaxPreviewPanel.register(context),
    OptiFineDiagnostics.register(context),
    vscode.languages.registerHoverProvider({ language: LANGUAGE_ID, scheme: 'file' }, new OptiFineHoverProvider()),
    registerOptiFineCompletion(context),
    registerResourceCompletion(context),
    registerPackMetaCompletion(context),
    registerColorCodes(context)
  )

  const watcher = vscode.workspace.createFileSystemWatcher('**/pack.mcmeta')
  for (const event of [watcher.onDidChange, watcher.onDidCreate, watcher.onDidDelete]) {
    context.subscriptions.push(event(() => {
      void refreshDetections()
      sidebar?.refresh()
    }))
  }
  context.subscriptions.push(watcher)

  void bootstrapPackFormats(context)
  refreshDetections()
}

async function bootstrapPackFormats(context: vscode.ExtensionContext): Promise<void> {
  if (!needsRefresh(context)) return
  const config = vscode.workspace.getConfiguration('mcrh')
  if (config.get<boolean>('autoRefreshPackFormats', true) === false) return
  const result = await refreshTable(context)
  if (!result.ok) {
    void vscode.window.setStatusBarMessage(uiText("extension.mrchVersionFormatTableUpdateFailedUsing"), 5000)
  }
}

async function pickStructureId(): Promise<string | undefined> {
  const picked = await vscode.window.showQuickPick(
    structureSpecs().map(spec => ({ label: spec.label, description: spec.relative, detail: spec.hint, id: spec.id })),
    { placeHolder: uiText("extension.selectTheStructureToCreate") }
  )
  return picked?.id
}

async function refreshDetections(scanned?: ScannedPack[]): Promise<void> {
  const settings = configuredScanSettings()
  const packs = scanned ?? (await scanForPacks({ roots: settings.roots, depth: settings.depth })).packs
  const detected = packs.filter(pack => pack.kind === 'resourcepack')
  await setContext(CONTEXT_KEYS.packCount, detected.length)
  await setContext(CONTEXT_KEYS.hasResourcepack, detected.length > 0)

  if (detected.length === 0 || hasAcknowledged) return
  hasAcknowledged = true
  if (runtimeConfig().hideTutorialOnStart) return
  const open = await vscode.window.showInformationMessage(
    uiText("extension.mcrhTheCurrentDirectoryAppearsToBe"),
    uiText("extension.openTutorial"), uiText("extension.neverHintAgain")
  )
  if (open === uiText("extension.openTutorial")) {
    await vscode.commands.executeCommand('mcrh.showTutorial')
  } else if (open === uiText("extension.neverHintAgain")) {
    await vscode.workspace.getConfiguration('mcrh').update('hideTutorialOnStart', true, vscode.ConfigurationTarget.Global)
  }
}

// 同一会话内只提示一次, 避免反复打扰
let hasAcknowledged = false

export function deactivate(): void {
  // VS Code 会关闭已登记的资源
  sidebar = undefined
}
