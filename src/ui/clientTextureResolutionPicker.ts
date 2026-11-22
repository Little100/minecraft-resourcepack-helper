import { uiText } from '../i18n/messages'
import * as vscode from 'vscode'
import { MAX_CLIENT_TEXTURE_RESOLUTION, VANILLA_TEXTURE_RESOLUTION } from '../core/clientTextureResolution'

export interface ClientTextureResolutionChoice { textureResolution?: number }

export async function pickClientTextureResolution(): Promise<ClientTextureResolutionChoice | undefined> {
  const powers = Array.from({ length: Math.log2(MAX_CLIENT_TEXTURE_RESOLUTION) + 1 }, (_, exponent) => 2 ** exponent)
  const choices = [...powers.filter(size => size > VANILLA_TEXTURE_RESOLUTION), ...powers.filter(size => size <= VANILLA_TEXTURE_RESOLUTION).reverse()]
  const picked = await vscode.window.showQuickPick([
    { label: uiText("ui.clientTextureResolutionPicker.keepOriginalResolution"), description: uiText("ui.clientTextureResolutionPicker.recommendedKeepAllOriginalPixels"), detail: uiText("ui.clientTextureResolutionPicker.noRetracesLanguageModelAndPackageMetadata"), textureResolution: undefined },
    ...choices.map(size => ({
      label: size + '×' + size,
      description: size < VANILLA_TEXTURE_RESOLUTION ? uiText("ui.clientTextureResolutionPicker.lowResolutionDownshrink") : size === VANILLA_TEXTURE_RESOLUTION ? uiText("ui.clientTextureResolutionPicker.originalBasicResolution") : '(2^' + Math.log2(size) + ')',
      detail: uiText("ui.clientTextureResolutionPicker.asOriginalKeepLongWidthRatioAnd", VANILLA_TEXTURE_RESOLUTION, VANILLA_TEXTURE_RESOLUTION),
      textureResolution: size
    }))
  ], { placeHolder: uiText("ui.clientTextureResolutionPicker.selectTheFullChartResolutionGreaterThan"), matchOnDescription: true, matchOnDetail: true })
  if (!picked) return undefined
  if (picked.textureResolution !== undefined && picked.textureResolution < VANILLA_TEXTURE_RESOLUTION) {
    const confirmed = await vscode.window.showWarningMessage(uiText("ui.clientTextureResolutionPicker.theLowResolutionWillReduceTheDamage"), { modal: true, detail: uiText("ui.clientTextureResolutionPicker.pressThisTimeBasicResolutionCompletionPre", picked.textureResolution, picked.textureResolution) }, uiText("ui.clientTextureResolutionPicker.continueLowResolution"), uiText("browser.shell.cancel"))
    if (confirmed !== uiText("ui.clientTextureResolutionPicker.continueLowResolution")) return undefined
  }
  return { textureResolution: picked.textureResolution }
}
