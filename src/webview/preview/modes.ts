import { uiText } from '../../i18n/messages'
import type { PreviewMode } from '../messages'

export interface ModeEntry {
  id: PreviewMode
  label: string
  hint: string
  icon: string
}

export const MODES: readonly ModeEntry[] = [
  { id: 'block', label: uiText("webview.preview.modes.pasteCubeApproximate"), hint: uiText("webview.preview.modes.singlePosterPresentationNotRepresentingOriginalModels"), icon: 'package' },
  { id: 'hand-first', label: uiText("webview.preview.modes.pasteHandheldApproximateFirstPerson"), hint: uiText("webview.preview.modes.theFirstPersonOnTheBottomRight"), icon: 'person' },
  { id: 'hand-third', label: uiText("webview.preview.modes.pasteHandheldApproxThirdPerson"), hint: uiText("webview.preview.modes.thirdPersonOnTheBottomRightSide"), icon: 'account' },
  { id: 'hotbar', label: uiText("webview.preview.modes.itemsBar"), hint: uiText("webview.preview.modes.showEffectsInTheShortcutBarShow"), icon: 'layout-menubar' },
  { id: 'frame', label: uiText("webview.preview.modes.presentationBox"), hint: uiText("webview.preview.modes.displayEffectsInTheObjectDisplayBox"), icon: 'device-camera' },
  { id: 'flat', label: uiText("webview.preview.modes.plane"), hint: uiText("webview.preview.modes.originalStickerZoomsInOnAvailableSpace"), icon: 'file-media' }
]

export type Background = 'checker' | 'dark' | 'light'

export const BACKGROUNDS: ReadonlyArray<{ id: Background; label: string; icon: string }> = [
  { id: 'checker', label: uiText("webview.preview.modes.chessBoardGrid"), icon: 'table' },
  { id: 'dark', label: uiText("browser.shell.dark"), icon: 'circle-filled' },
  { id: 'light', label: uiText("browser.shell.light"), icon: 'circle' }
]
