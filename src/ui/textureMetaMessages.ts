import { uiText } from '../i18n/messages'
export type TextureMetaProblem =
  | { kind: 'missing-png'; pngName: string }
  | { kind: 'decode-failed'; pngName: string; reason: string }
  | { kind: 'invalid-json'; reason: string }
  | { kind: 'missing-animation' }

export function describeTextureProblem(problem: TextureMetaProblem): string {
  switch (problem.kind) {
    case 'missing-png':
      return uiText("ui.textureMetaMessages.noPngStickerFoundMcmetaShouldShare", problem.pngName)
    case 'decode-failed':
      return uiText("ui.textureMetaMessages.couldNotReadOrDecodePngPaste", problem.pngName, problem.reason)
    case 'invalid-json':
      return uiText("ui.textureMetaMessages.mcmetaIsNotAValidJsonCan", problem.reason)
    case 'missing-animation':
      return uiText("ui.textureMetaMessages.mcmetaLacksAnimationObjectsNoFramesTo")
  }
}

export function mcmetaJsonProblem(text: string): string | undefined {
  try {
    JSON.parse(text)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
