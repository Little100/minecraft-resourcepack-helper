import { uiText } from '../i18n/messages'
export interface TutorialCard {
  title: string
  body: string
  icon: string
  command?: string
  hint?: string
}

export interface TutorialGroup {
  title: string
  cards: TutorialCard[]
}

export const TUTORIAL_GROUPS: TutorialGroup[] = [
  { title: uiText("ui.tutorialCards.templateCreate"), cards: [
    { title: uiText("ui.tutorialCards.originalResourceTemplate"), body: uiText("ui.tutorialCards.selectResourceTypeAndNamespaceWithThe"), icon: 'new-file', command: 'mcrh.createVanillaTemplate', hint: uiText("ui.tutorialCards.nativeSelectionAndInputBox") },
    { title: uiText("ui.tutorialCards.jsonSimilarMatchingApply"), body: uiText("ui.tutorialCards.applyTheCurrentConfigurationToAMatching"), icon: 'replace-all', command: 'mcrh.applyJsonFamily', hint: uiText("ui.tutorialCards.useJsonAfterOpeningTheModel") },
    { title: uiText("ui.tutorialCards.unicodePasteCharacter"), body: uiText("ui.tutorialCards.selectTheTextComponentThatAlreadyHas"), icon: 'symbol-string', command: 'mcrh.createFontTemplate', hint: uiText("ui.tutorialCards.createFontsAndPaste") },
    { title: uiText("ui.tutorialCards.custommodeldataItems"), body: uiText("ui.tutorialCards.createModelEntryTabAndCmdBranch"), icon: 'symbol-numeric', command: 'mcrh.createCustomModelData', hint: uiText("ui.tutorialCards.createByVersion") },
    { title: uiText("ui.tutorialCards.selectAndInsertAPosterCharacter"), body: uiText("ui.tutorialCards.searchForFontMapsCopyOriginalCharacters"), icon: 'symbol-key', command: 'mcrh.insertFontGlyph', hint: uiText("ui.tutorialCards.useAfterOpeningPackMcmeta") }
  ] },
  { title: uiText("ui.tutorialCards.aiAndMcp"), cards: [
    { title: uiText("ui.tutorialCards.startCloseMcp"), body: uiText("ui.tutorialCards.defaultStartOfMcpInATrusted"), icon: 'plug', command: 'mcrh.configureMcp', hint: uiText("ui.tutorialCards.projectAccess") },
    { title: uiText("ui.tutorialCards.copyMcpInstallPhrasing"), body: uiText("ui.tutorialCards.handingTheInstalledHintToTheAi"), icon: 'copy', command: 'mcrh.copyMcpSetup', hint: uiText("ui.tutorialCards.copyToClipboard") }
  ] },
  {
    title: uiText("ui.tutorialCards.startUse"),
    cards: [
      {
        title: uiText("ui.tutorialCards.completeMaterialPackageStructure"),
        body: uiText("ui.tutorialCards.oneClickToGenerateGeneralDirectoriesSuch"),
        icon: 'folder',
        command: 'mcrh.scaffoldPack',
        hint: uiText("ui.tutorialCards.sidebarMaterialPackage")
      },
      {
        title: uiText("ui.sidebarTree.generateExampleFiles"),
        body: uiText("ui.tutorialCards.templatesForSquarePasteAndModelsArticles"),
        icon: 'new-file',
        command: 'mcrh.createExample',
        hint: uiText("ui.tutorialCards.sidebarGenerateExampleFiles")
      },
      {
        title: uiText("ui.sidebarTree.packingOfMaterialsResources"),
        body: uiText("ui.tutorialCards.downloadTheSelectedVersionWithTheOfficial"),
        icon: 'cloud-download',
        command: 'mcrh.extractClientAssets',
        hint: uiText("ui.tutorialCards.sidebarMaterialPackage")
      }
    ]
  },
  {
    title: uiText("ui.tutorialCards.viewCheck"),
    cards: [
      { title: uiText("ui.sidebarTree.guiHudPreview"), body: uiText("ui.tutorialCards.liveWithTheCurrentPackagePreviewOf"), icon: 'layout', command: 'mcrh.previewGui', hint: uiText("ui.tutorialCards.sidebarGuiHudPreview") },
      {
        title: uiText("ui.tutorialCards.syntaxPreview"),
        body: uiText("ui.tutorialCards.showsActualEffectsAndSyllablesOnThe"),
        icon: 'symbol-property',
        command: 'mcrh.openSyntaxPreview',
        hint: uiText("ui.tutorialCards.rightPanel")
      },
      {
        title: uiText("ui.tutorialCards.pasteEffectsPreview"),
        body: uiText("ui.tutorialCards.seeWhatYouReDoingBySquares"),
        icon: 'preview',
        command: 'mcrh.previewTexture',
        hint: uiText("ui.tutorialCards.rightPng")
      },
      {
        title: uiText("ui.tutorialCards.movetextMinecraftPaste"),
        body: uiText("ui.tutorialCards.convertGifAprngAndVideoIntoVertical"),
        icon: 'file-media',
        command: 'mcrh.convertAnimation',
        hint: uiText("ui.tutorialCards.rightKeyview")
      }
    ]
  },
  {
    title: uiText("ui.tutorialCards.production"),
    cards: [
      {
        title: uiText("ui.tutorialCards.pixelEditor"),
        body: uiText("ui.tutorialCards.doubleClickedGraphsIEOpenWith"),
        icon: 'paintcan',
        hint: uiText("ui.tutorialCards.doubleClickPng")
      },
      {
        title: uiText("ui.tutorialCards.optifineAuxiliaryTutor"),
        body: uiText("ui.tutorialCards.writeOptifineAuxiliaryDescriptionDocumentInThe"),
        icon: 'note',
        command: 'mcrh.writeOptiFineTutorial',
        hint: uiText("ui.tutorialCards.generateMarkdown")
      },
      {
        title: uiText("ui.tutorialCards.checkFfmpegConfiguration"),
        body: uiText("ui.tutorialCards.ffmpegForConversionOfVideoFormatsSuch"),
        icon: 'terminal',
        command: 'mcrh.checkFfmpeg',
        hint: uiText("ui.tutorialCards.optionalDependencies")
      }
    ]
  }
]

export interface ShortcutItem {
  label: string
  keys: string
}

export interface ShortcutGroup {
  title: string
  items: ShortcutItem[]
}

export const PAINT_ACTION_SHORTCUTS: ShortcutGroup[] = [
  {
    title: uiText("ui.tutorialCards.edit"),
    items: [
      { label: uiText("ui.tutorialCards.undo"), keys: 'Ctrl+Z' },
      { label: uiText("ui.tutorialCards.redo"), keys: 'Ctrl+Y' },
      { label: uiText("ui.tutorialCards.cancelSelection"), keys: 'Ctrl+D' },
      { label: uiText("ui.tutorialCards.deleteSelection"), keys: 'Delete' },
      { label: uiText("ui.tutorialCards.confirmCroppingOrClosingPens"), keys: 'Enter' },
      { label: uiText("browser.shell.cancel"), keys: 'Esc' },
      { label: uiText("ui.tutorialCards.scrubbedAndIncreased"), keys: '[ ]' }
    ]
  },
  {
    title: uiText("ui.tutorialCards.view"),
    items: [
      { label: uiText("ui.tutorialCards.zoomIn"), keys: 'Ctrl+=' },
      { label: uiText("ui.tutorialCards.zoomOut"), keys: 'Ctrl+-' },
      { label: uiText("ui.tutorialCards.fitToWindow"), keys: 'Ctrl+0' }
    ]
  }
]

export function buildShortcutGroups(tools: ReadonlyArray<{ label: string; key: string }>): ShortcutGroup[] {
  return [{ title: uiText("ui.tutorialCards.tools"), items: tools.map(tool => ({ label: tool.label, keys: tool.key })) }, ...PAINT_ACTION_SHORTCUTS]
}

export const TUTORIAL_COMMANDS: ReadonlySet<string> = new Set(
  TUTORIAL_GROUPS.flatMap(group => group.cards.map(card => card.command)).filter((id): id is string => Boolean(id))
)

export function isAllowedTutorialCommand(id: unknown): id is string {
  return typeof id === 'string' && TUTORIAL_COMMANDS.has(id)
}
