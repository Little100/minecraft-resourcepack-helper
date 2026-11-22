import { uiText } from '../../i18n/messages'
import type { GeneratedFile } from './safeExport'

export interface PackRequirement { id: string; feature: string; runtime: string; files: string[] }
export const REQUIREMENTS_PATH = 'MCRH-REQUIREMENTS.txt'
const HEADER = uiText("core.advanced.packRequirements.mcrhResourcePackOperatingDependence")
// 仅检查实际导出的功能文件，普通模型、底图和原版 core shader 不生成模组提示
export function detectPackRequirements(files: readonly GeneratedFile[], availableBasePaths: Iterable<string> = []): PackRequirement[] {
  const paths = new Set([...availableBasePaths, ...files.map(file => file.path)]), found = new Map<string, PackRequirement>()
  const add = (id: string, feature: string, runtime: string, path: string) => { const value = found.get(id) ?? { id, feature, runtime, files: [] }; value.files.push(path); found.set(id, value) }
  for (const file of files) {
    const path = file.path
    if (/^assets\/[^/]+\/optifine\/ctm\/.+\.properties$/i.test(path)) add('ctm', uiText("core.advanced.packRequirements.connectOrRandomSquareTextureOptifineCtm"), uiText("core.advanced.packRequirements.optifineOpeningConnectionTextureOrCtmWhich"), path)
    else if (/^assets\/[^/]+\/optifine\/cit\/.+\.properties$/i.test(path)) add('cit', uiText("core.advanced.packRequirements.customTextureRulesForItems"), uiText("core.advanced.packRequirements.optifineCitOrCitResearchnToAchieve"), path)
    else if (/^assets\/[^/]+\/optifine\/random\/.+\.(?:properties|png)$/i.test(path)) add('random-entity', uiText("core.advanced.packRequirements.randomPhysicalTexture"), uiText("core.advanced.packRequirements.optifineRandomEntityOrEntityTextureFeatures"), path)
    else if (/^assets\/[^/]+\/optifine\/cem\/.+\.(?:jem|jpm)$/i.test(path)) add('cem', uiText("core.advanced.packRequirements.customEntityModel"), uiText("core.advanced.packRequirements.optifineCemOrEntityModelFeaturesSupporting"), path)
    else if (/^assets\/[^/]+\/optifine\/natural\.properties$/i.test(path)) add('natural', uiText("core.advanced.packRequirements.naturalTextureRotatingOrFlipping"), uiText("core.advanced.packRequirements.optifineNaturalTextureOrCompatibleModulesFor"), path)
    else if (/^assets\/[^/]+\/optifine\/(?:emissive\.properties|sky\/.+\.properties)$/i.test(path)) add('optifine-extra', uiText("core.advanced.packRequirements.lightTextureOrCustomSkyRules"), uiText("core.advanced.packRequirements.optifineMatchingFunctionOrCompatibleModuleThat"), path)
    if (/^assets\/[^/]+\/optifine\/(?:color\.properties|colormap\/.+\.(?:properties|png))$/i.test(path)) add('custom-colors', uiText("core.advanced.packRequirements.customWaterColourVegetationOrSquareColours"), uiText("core.advanced.packRequirements.optifineCustomColorsOrCompatibleModulesSupporting"), path)
    if (/^shaders\/(?:shaders\.properties|(?:.+\/)?[^/]+\.(?:fsh|vsh|gsh|csh))$/i.test(path)) add('shaderpack', uiText("core.advanced.packRequirements.photopackage"), uiText("core.advanced.packRequirements.irisOrOptifineLightAndThePhoto"), path)
    const pbr = /^(assets\/[^/]+\/textures\/.+)_(?:n|s|normal)\.png$/i.exec(path)
    if (pbr && paths.has(pbr[1] + '.png')) add('pbr', uiText("core.advanced.packRequirements.pbrMaterialChannel"), uiText("core.advanced.packRequirements.supportsPhotoEncodingCorrespondingToLabpbrOldpbr"), path)
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id))
}
export function withPackRequirements(input: readonly GeneratedFile[], availableBasePaths: Iterable<string> = []): { files: GeneratedFile[]; warnings: string[]; requirements: PackRequirement[] } {
  const files = [...input], requirements = detectPackRequirements(files, availableBasePaths)
  const oldIndex = files.findIndex(file => file.path === REQUIREMENTS_PATH)
  if (oldIndex >= 0) {
    const content = files[oldIndex].content, text = typeof content === 'string' ? content : new TextDecoder().decode(content)
    if (text.startsWith(HEADER + '\n')) files.splice(oldIndex, 1)
    else if (requirements.length) throw new Error(uiText("core.advanced.packRequirements.retainTheNameOfTheUserFile", REQUIREMENTS_PATH))
  }
  const warnings = requirements.map(value => value.feature + ': ' + value.runtime)
  if (requirements.length) files.push({ path: REQUIREMENTS_PATH, content: HEADER + '\n\n' + requirements.map(value => value.feature + uiText("core.advanced.packRequirements.needFor") + value.runtime + uiText("core.advanced.packRequirements.basedOn") + value.files.slice(0, 12).join(', ') + (value.files.length > 12 ? uiText("core.advanced.packRequirements.waitFile", value.files.length) : '')).join('\n\n') + '\n' })
  return { files, warnings, requirements }
}
