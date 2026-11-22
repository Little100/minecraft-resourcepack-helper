import { uiText } from '../i18n/messages'
export interface PreviewFallback { model: Record<string, unknown>; warning: string; missingPaths: string[] }
const itemDisplay = {
  ground: { translation: [0, 2, 0], scale: [0.5, 0.5, 0.5] },
  thirdperson_righthand: { translation: [0, 3, 1], scale: [0.55, 0.55, 0.55] },
  firstperson_righthand: { rotation: [0, -90, 25], translation: [1.13, 3.2, 1.13], scale: [0.68, 0.68, 0.68] },
  fixed: { rotation: [0, 180, 0] }
}
const blockDisplay = {
  gui: { rotation: [30, 225, 0], scale: [0.625, 0.625, 0.625] },
  ground: { translation: [0, 3, 0], scale: [0.25, 0.25, 0.25] },
  thirdperson_righthand: { rotation: [75, 45, 0], translation: [0, 2.5, 0], scale: [0.375, 0.375, 0.375] },
  firstperson_righthand: { rotation: [0, 45, 0], scale: [0.4, 0.4, 0.4] },
  fixed: { scale: [0.5, 0.5, 0.5] }
}
// 缺少基础资源时显式标记临时几何，绝不将其当作已解析的原版模型
export function textureModelFallback(relative: string): PreviewFallback | undefined {
  const match = /^assets\/minecraft\/textures\/(item|block)\/(.+)\.png$/.exec(relative)
  if (!match || /_(?:n|s|normal)$/.test(match[2]!)) return undefined
  const kind = match[1]!, name = match[2]!, texture = 'minecraft:' + kind + '/' + name
  const missingPaths = ['assets/minecraft/models/' + kind + '/' + name + '.json']
  if (kind === 'item') {
    missingPaths.unshift('assets/minecraft/items/' + name + '.json')
    return {
    model: { parent: 'builtin/generated', gui_light: 'front', textures: { layer0: texture }, display: itemDisplay }, missingPaths,
    warning: uiText("core.previewFallback.noSolventableOriginalModelWasFoundAnd")
    }
  }
  const faces = Object.fromEntries(['east', 'west', 'up', 'down', 'south', 'north'].map(face => [face, { texture: '#all' }]))
  return { model: { textures: { all: texture }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces }], display: blockDisplay }, missingPaths,
    warning: uiText("core.previewFallback.noSolventableOriginalModelWasFoundAnd_cbf8c6") }
}
