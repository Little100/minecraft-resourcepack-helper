import { uiText } from '../i18n/messages'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { listTemplates, type TemplateBundle } from '../core/exampleTemplates'
import { configuredScanSettings } from './scanSettings'
import { RESOURCE_DIRECTORIES } from '../core/packDetector'
import { loadScan, saveScan, scanForPacks, type ScannedPack } from '../core/packScanner'
import { structureSpecs, type StructureSpec } from '../core/structures'
import {
  buildPackTree,
  collectStructurePresence,
  createDebounced,
  packIconSource,
  type PackFolderEntry,
  type PackTreeEntry,
  type StructurePresence
} from './sidebarModel'

export const VIEW_ID = 'mcrh.sidebar'

export interface SidebarState {
  packs: ScannedPack[]
  roots: string[]
  scanning: boolean
  message?: string
}

export type TreeNode = PackNode | FolderNode | StructureNode | BundleNode | GroupNode | SectionNode | InfoNode

function kindLabel(kind: ScannedPack['kind']): string {
  if (kind === 'resourcepack') return uiText("ui.sidebarTree.resourcePack")
  if (kind === 'datapack') return uiText("ui.sidebarTree.packages")
  return uiText("ui.sidebarTree.notRecognized")
}

// 制作入口直接显示，帮助内容单独折叠
class SectionNode extends vscode.TreeItem {
  constructor(label: string, public readonly section: 'tutorial' | 'templates' | 'packs', expanded: boolean, icon: string) {
    super(label, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
    this.contextValue = `mcrhSection-${section}`
    this.iconPath = new vscode.ThemeIcon(icon)
  }
}

// 仅用于按父目录分组的文件夹节点, 不绑定命令, 避免误触
class FolderNode extends vscode.TreeItem {
  constructor(public readonly entry: PackFolderEntry) {
    super(entry.label, vscode.TreeItemCollapsibleState.Expanded)
    this.description = uiText("ui.sidebarTree.aPackageOfMaterial", entry.packCount)
    this.tooltip = entry.path
    this.iconPath = new vscode.ThemeIcon('folder')
    this.contextValue = 'mcrhFolder'
  }
}

class PackNode extends vscode.TreeItem {
  constructor(public readonly pack: ScannedPack, formatLabel: string, defaultIcon: vscode.Uri) {
    super(pack.name, vscode.TreeItemCollapsibleState.Collapsed)
    this.description = formatLabel
    const diagnostics = pack.metadataIssue ? uiText("ui.sidebarTree.diagnostic", pack.metadataIssue) : ''
    this.tooltip = uiText("ui.sidebarTree.type", pack.root, kindLabel(pack.kind), diagnostics)
    // pack.png 修改后刷新图标，缺少时用草方块
    const source = packIconSource(pack)
    this.iconPath = source
      ? vscode.Uri.file(source.path).with({ query: source.version === undefined ? '' : `v=${source.version}` })
      : defaultIcon
    this.contextValue = 'mcrhPack'
    this.resourceUri = vscode.Uri.file(pack.root)
  }
}

class GroupNode extends vscode.TreeItem {
  constructor(label: string, public readonly group: 'structure' | 'templates', public readonly root: string) {
    super(label, vscode.TreeItemCollapsibleState.Expanded)
    this.contextValue = 'mcrhGroup'
    this.iconPath = new vscode.ThemeIcon(group === 'structure' ? 'list-tree' : 'file-add')
  }
}

class StructureNode extends vscode.TreeItem {
  constructor(public readonly root: string, public readonly spec: StructureSpec, public readonly exists: boolean) {
    super(spec.label, vscode.TreeItemCollapsibleState.None)
    this.description = exists ? spec.relative : uiText("ui.sidebarTree.missing", spec.relative)
    this.tooltip = exists
      ? `${path.join(root, spec.relative)}\n${spec.hint}`
      : uiText("ui.sidebarTree.clickToCreate", spec.hint, spec.relative)
    this.iconPath = new vscode.ThemeIcon(exists ? (spec.kind === 'dir' ? 'folder' : 'file') : 'new-folder')
    this.contextValue = exists ? 'mcrhStructure' : 'mcrhStructureMissing'
    const target = vscode.Uri.file(path.join(root, spec.relative))
    this.resourceUri = target
    this.command = exists
      ? { command: spec.kind === 'dir' ? 'revealInExplorer' : 'vscode.open', title: uiText("browser.shell.open"), arguments: [target] }
      : { command: 'mcrh.createStructure', title: uiText("ui.sidebarTree.createStructure"), arguments: [root, spec] }
  }
}

class BundleNode extends vscode.TreeItem {
  constructor(public readonly bundle: TemplateBundle, public readonly root?: string) {
    super(bundle.label, vscode.TreeItemCollapsibleState.None)
    this.description = uiText("ui.sidebarTree.file", bundle.files.length)
    this.tooltip = uiText("ui.sidebarTree.namespace", bundle.description, bundle.namespace, root ? uiText("ui.sidebarTree.objectives", root) : '')
    this.iconPath = new vscode.ThemeIcon('file-add')
    this.contextValue = 'mcrhTemplate'
    this.command = {
      command: 'mcrh.createExample',
      title: uiText("ui.sidebarTree.generateExample"),
      arguments: [bundle, root ? vscode.Uri.file(root) : undefined]
    }
  }
}

class InfoNode extends vscode.TreeItem {
  constructor(label: string, description?: string, command?: vscode.Command, icon = 'info') {
    super(label, vscode.TreeItemCollapsibleState.None)
    this.description = description
    this.tooltip = description
    this.iconPath = new vscode.ThemeIcon(icon)
    this.contextValue = 'mcrhInfo'
    if (command) this.command = command
  }
}

const SCAN_DEBOUNCE_MS = 300

function configuredRoots(): string[] { return configuredScanSettings().roots }

export class SidebarTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>()
  readonly onDidChangeTreeData = this.emitter.event

  private externalWatchers: vscode.Disposable[] = []
  private readonly bundles = listTemplates()

  // 默认图标
  private readonly defaultPackIcon: vscode.Uri

  private scanListener?: (packs: ScannedPack[]) => void

  // 当前扫描结束后再处理排队的刷新
  private inFlight?: Promise<void>
  private rescanQueued = false

  private structurePresence: StructurePresence

  private constructor(private readonly context: vscode.ExtensionContext, private readonly state: SidebarState) {
    this.defaultPackIcon = vscode.Uri.joinPath(context.extensionUri, 'images', 'pack-default.png')
    this.structurePresence = this.collectPresence()
  }

  onScanned(listener: (packs: ScannedPack[]) => void): void {
    this.scanListener = listener
    // 用缓存立即显示标记
    listener(this.state.packs)
  }

  static register(context: vscode.ExtensionContext): SidebarTreeProvider {
    const provider = new SidebarTreeProvider(context, { packs: loadScan(context), roots: configuredRoots(), scanning: false })
    const view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: true })
    context.subscriptions.push(provider, view)
    provider.watchForChanges()
    void provider.scan()
    return provider
  }

  static createForTest(context: vscode.ExtensionContext, packs: ScannedPack[] = [], roots: string[] = []): SidebarTreeProvider {
    return new SidebarTreeProvider(context, { packs, roots, scanning: false })
  }

  private watchForChanges(): void {
    const debounced = createDebounced(() => { void this.scan() }, SCAN_DEBOUNCE_MS)
    const onChange = (): void => debounced.trigger()
    for (const glob of ['**/pack.png', '**/pack.mcmeta']) {
      const watcher = vscode.workspace.createFileSystemWatcher(glob)
      this.context.subscriptions.push(
        watcher,
        watcher.onDidCreate(onChange),
        watcher.onDidChange(onChange),
        watcher.onDidDelete(onChange)
      )
    }
    this.context.subscriptions.push(
      debounced,
      vscode.workspace.onDidChangeWorkspaceFolders(() => { this.refreshExternalWatchers(onChange); onChange() }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('mcrh.scanExtraPaths')) this.refreshExternalWatchers(onChange)
        if (event.affectsConfiguration('mcrh.scanDepth') || event.affectsConfiguration('mcrh.scanExtraPaths') || event.affectsConfiguration('mcrh.defaultNamespace')) onChange()
      })
    )
    this.refreshExternalWatchers(onChange)
    const presence = createDebounced(() => this.refresh(), SCAN_DEBOUNCE_MS)
    const onPresenceChange = (): void => presence.trigger()
    for (const spec of structureSpecs().filter(item => item.kind === 'dir')) {
      const watcher = vscode.workspace.createFileSystemWatcher(`**/${spec.relative}`)
      this.context.subscriptions.push(watcher, watcher.onDidCreate(onPresenceChange), watcher.onDidDelete(onPresenceChange))
    }
    this.context.subscriptions.push(presence)
  }

  private refreshExternalWatchers(onChange: () => void): void {
    for (const watcher of this.externalWatchers) watcher.dispose()
    this.externalWatchers = []
    const patterns = ['**/pack.mcmeta', '**/pack.png', '**/assets/*/sounds.json', ...RESOURCE_DIRECTORIES.flatMap(directory => [`**/assets/*/${directory}`, `**/assets/*/${directory}/**`])]
    for (const root of configuredRoots()) for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, pattern))
      this.externalWatchers.push(watcher, watcher.onDidCreate(onChange), watcher.onDidChange(onChange), watcher.onDidDelete(onChange))
    }
  }

  scan(): Promise<void> {
    if (this.inFlight) {
      this.rescanQueued = true
      return this.inFlight
    }
    this.inFlight = this.runScan().finally(() => {
      this.inFlight = undefined
      if (this.rescanQueued) {
        this.rescanQueued = false
        void this.scan()
      }
    })
    return this.inFlight
  }

  private async runScan(): Promise<void> {
    const settings = configuredScanSettings()
    const { depth, roots } = settings
    this.state.scanning = true
    this.refresh()
    try {
      const result = await scanForPacks({ roots, depth })
      this.state.packs = result.packs
      this.state.roots = roots
      const warnings = [...settings.warnings, ...(result.warnings ?? [])]
      this.state.message = roots.length === 0
        ? uiText("ui.sidebarTree.unopenedWorkspaceYouCanFillTheMcrh")
        : uiText("ui.sidebarTree.scanningRootDirectoryDepthHitABag", result.scannedRoots, depth, result.packs.length, warnings.length ? ' · ' + warnings.join('；') : '')
      saveScan(this.context, result.packs)
    } catch (error) {
      this.state.message = uiText("ui.sidebarTree.scanFailed", error instanceof Error ? error.message : String(error))
    } finally {
      this.state.scanning = false
      this.refresh()
      this.scanListener?.(this.state.packs)
    }
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (element instanceof SectionNode) {
      if (element.section === 'tutorial') {
        return [
          new InfoNode(uiText("ui.sidebarTree.openTutorPage"), uiText("ui.sidebarTree.independentPageLikeWelcomePage"), { command: 'mcrh.showTutorial', title: uiText("extension.openTutorial") }, 'book'),
          new InfoNode(uiText("ui.sidebarTree.generateOptifineTutorialDocuments"), uiText("ui.sidebarTree.writeOptifineSubsidiaryNotesInTheWorkspace"), { command: 'mcrh.writeOptiFineTutorial', title: uiText("ui.sidebarTree.generateDocument") }, 'note')
        ]
      }
      if (element.section === 'templates') {
        return this.bundles.map(bundle => new BundleNode(bundle))
      }
      return this.packNodes()
    }
    if (element instanceof FolderNode) return element.entry.children.map(entry => this.entryNode(entry))
    if (element instanceof PackNode) {
      // 包操作就近展示，示例生成保留在顶层板块
      return [
        new InfoNode(uiText("pack.diagnose"), uiText("ui.sidebarTree.checkTheRootDirectoryVersionResourceReference"), { command: 'mcrh.diagnosePack', title: uiText("ui.sidebarTree.diagnosisCurrentPackage"), arguments: [vscode.Uri.file(element.pack.root)] }, 'pulse'),
        new InfoNode(uiText("ui.sidebarTree.versionConversion"), uiText("ui.sidebarTree.readTheCurrentPackageAndAnalyzeTarget"), { command: 'mcrh.convertPackVersion', title: uiText("ui.sidebarTree.convertTheCurrentPackage"), arguments: [vscode.Uri.file(element.pack.root)] }, 'versions'),
        new GroupNode(uiText("ui.sidebarTree.contentsStructure"), 'structure', element.pack.root)
      ]
    }
    if (element instanceof GroupNode) {
      if (element.group === 'structure') {
        const present = this.structurePresence.get(element.root)
        return structureSpecs().map(spec => new StructureNode(element.root, spec, present?.has(spec.relative) === true))
      }
      return this.bundles.map(bundle => new BundleNode(bundle, element.root))
    }
    if (element) return []

    // 工作台可直接打开，不依赖教程或资源扫描状态
    return [
      new InfoNode(uiText("ui.sidebarTree.advancedMaterialsWorkbench"), uiText("ui.sidebarTree.sceneMaterialBlocksPbrAndResourceProduction"), { command: 'mcrh.openAdvancedWorkbench', title: uiText("ui.sidebarTree.openAdvancedMaterialWorkbench") }, 'beaker'),
      new InfoNode(uiText("ui.collaborationPanel.collaborationAndReview"), uiText("ui.sidebarTree.localEditingVoluntarySubmissionDocumentByDocument"), { command: 'mcrh.openCollaboration', title: uiText("ui.sidebarTree.openCollaborationAndReview") }, 'source-control'),
      new InfoNode(uiText("pack.diagnosePack"), uiText("ui.sidebarTree.checkGamesNotShownVersionsAreIncompatible"), { command: 'mcrh.diagnosePack', title: uiText("pack.diagnosePack") }, 'pulse'),
      new InfoNode(uiText("ui.sidebarTree.versionConversion"), uiText("ui.sidebarTree.directlyOpenTheActualSourceVersionTarget"), { command: 'mcrh.convertPackVersion', title: uiText("ui.sidebarTree.versionConversion") }, 'versions'),
      new SectionNode(uiText("ui.sidebarTree.generateExampleFiles"), 'templates', true, 'file-add'),
      new SectionNode(uiText("ui.sidebarTree.resourcePack"), 'packs', true, 'package'),
      new SectionNode(uiText("ui.sidebarTree.curriculum"), 'tutorial', false, 'book')
    ]
  }

  private packNodes(): TreeNode[] {
    const nodes: TreeNode[] = []
    nodes.push(new InfoNode(uiText("ui.sidebarTree.addCustomScanDirectory"), uiText("ui.sidebarTree.selectAnyLocalFolderScanTheDefault"), { command: 'mcrh.addScanFolder', title: uiText("ui.sidebarTree.addScanDirectory") }, 'folder-opened'))
    nodes.push(new InfoNode(uiText("ui.sidebarTree.setScanRange"), uiText("ui.sidebarTree.configureRecursiveDepthAndCustomDirectory"), { command: 'mcrh.configureScan', title: uiText("ui.sidebarTree.scanSettings") }, 'settings-gear'))
    nodes.push(new InfoNode(uiText("ui.sidebarTree.packingOfMaterialsResources"), uiText("ui.sidebarTree.downloadAndReleaseTheOriginalClientAnsets"), { command: 'mcrh.extractClientAssets', title: uiText("ui.sidebarTree.getOriginalResources") }, 'cloud-download'))
    nodes.push(new InfoNode(uiText("ui.sidebarTree.guiHudPreview"), uiText("ui.sidebarTree.combiningPreviewGameInterfacesContainersAndHud"), { command: 'mcrh.previewGui', title: uiText("ui.sidebarTree.guiHudPreview") }, 'layout'))
    nodes.push(...buildPackTree(this.state.roots, this.state.packs).map(entry => this.entryNode(entry)))
    const summary = this.state.message ?? uiText("ui.sidebarTree.clickToReScanTheMaterialPackage")
    if (this.state.packs.length === 0) {
      nodes.push(new InfoNode(
        this.state.scanning ? uiText("ui.sidebarTree.scaning") : uiText("ui.sidebarTree.noMaterialPackageFound"),
        summary,
        { command: 'mcrh.scanPacks', title: uiText("ui.sidebarTree.rescan") }
      ))
    } else {
      nodes.push(new InfoNode(uiText("ui.sidebarTree.rescan"), summary, { command: 'mcrh.scanPacks', title: uiText("ui.sidebarTree.rescan") }))
    }
    return nodes
  }

  private entryNode(entry: PackTreeEntry): TreeNode {
    if (entry.kind === 'folder') return new FolderNode(entry)
    const format = entry.pack.metadataIssue
      ? entry.pack.hasMetadata ? entry.pack.metadataIssue : entry.pack.metadataIssue.replace(uiText("ui.sidebarTree.resourcePackWorkIsNotCompleted"), '')
      : entry.pack.packFormat ? `format ${entry.pack.packFormat}` : uiText("ui.sidebarTree.missingPackFormat")
    const label = entry.pack.metadataIssue && !entry.pack.hasMetadata
      ? uiText("ui.sidebarTree.engineering", kindLabel(entry.pack.kind), format)
      : `${kindLabel(entry.pack.kind)} · ${format}`
    return new PackNode(entry.pack, label, this.defaultPackIcon)
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element
  }

  refresh(): void {
    this.structurePresence = this.collectPresence()
    this.emitter.fire(undefined)
  }

  private collectPresence(): StructurePresence {
    return collectStructurePresence(this.state.packs.map(pack => pack.root), structureSpecs().map(spec => spec.relative))
  }

  get packs(): ScannedPack[] {
    return this.state.packs
  }

  dispose(): void {
    for (const watcher of this.externalWatchers) watcher.dispose()
    this.externalWatchers = []
    this.emitter.dispose()
  }
}
