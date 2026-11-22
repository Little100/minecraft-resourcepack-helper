import { uiText } from '../i18n/messages'
export interface AssetFolder {
  path: string
  zh: string
  en: string
  detail: string
}

export const ASSET_FOLDERS: AssetFolder[] = [
  { path: 'assets/<namespace>/textures/block', zh: uiText("ui.resourceDocs.blockPaste"), en: 'block textures', detail: uiText("ui.resourceDocs.blockFaceTextures") },
  { path: 'assets/<namespace>/textures/item', zh: uiText("ui.resourceDocs.itemsPoster"), en: 'item textures', detail: uiText("ui.resourceDocs.articlesBarAndHandheldStickers") },
  { path: 'assets/<namespace>/textures/entity', zh: uiText("ui.resourceDocs.entityPaste"), en: 'entity textures', detail: uiText("ui.resourceDocs.bioAndArmorBasedEntities") },
  { path: 'assets/<namespace>/textures/gui', zh: uiText("ui.resourceDocs.interfacePaste"), en: 'gui textures', detail: uiText("ui.resourceDocs.containerInterfaceAndHudAtlas") },
  { path: 'assets/<namespace>/textures/painting', zh: uiText("ui.resourceDocs.paste"), en: 'painting textures', detail: uiText("ui.resourceDocs.paintedCanvass") },
  { path: 'assets/<namespace>/textures/particle', zh: uiText("ui.resourceDocs.particlePaste"), en: 'particle textures', detail: uiText("ui.resourceDocs.particleAtlasIndexDeterminedByParticleJson") },
  { path: 'assets/<namespace>/textures/font', zh: uiText("ui.resourceDocs.fontPaste"), en: 'font textures', detail: uiText("ui.resourceDocs.pixmapFontAtlas") },
  { path: 'assets/<namespace>/textures/environment', zh: uiText("ui.resourceDocs.environmentStickers"), en: 'environment textures', detail: uiText("ui.resourceDocs.theSkyTheSunTheMoonClouds") },
  { path: 'assets/<namespace>/textures/effect', zh: uiText("ui.resourceDocs.statusEffectsPaste"), en: 'effect textures', detail: uiText("ui.resourceDocs.iconForPharmacologicalEffects") },
  { path: 'assets/<namespace>/textures/colormap', zh: uiText("ui.resourceDocs.colourMap"), en: 'colormap textures', detail: uiText("ui.resourceDocs.theHerbsOfGrassAndLeavesAre") },
  { path: 'assets/<namespace>/textures/misc', zh: uiText("ui.resourceDocs.miscellaneous"), en: 'misc textures', detail: uiText("ui.resourceDocs.demonicLightPortalsShadowsAndOtherMiscellaneous") },
  { path: 'assets/<namespace>/textures/models', zh: uiText("ui.resourceDocs.entityModelPaste"), en: 'model textures', detail: uiText("ui.resourceDocs.armourAndPhysicalModelRollOut") },
  { path: 'assets/<namespace>/models/block', zh: uiText("ui.resourceDocs.blockModel"), en: 'block models', detail: uiText("ui.resourceDocs.decidingTheGeometryOfSquaresAndClip") },
  { path: 'assets/<namespace>/items', zh: uiText("ui.resourceDocs.newVersionOfTheDefinitionOfItems"), en: 'item definitions', detail: uiText("ui.resourceDocs.itemsSelectAndRenderEntrancesWhichDo") },
  { path: 'assets/<namespace>/atlases', zh: uiText("ui.resourceDocs.textureAtlasDefinitions"), en: 'atlas sources', detail: uiText("ui.resourceDocs.atlasSourceSourceJsonNeedsToMatch") },
  { path: 'assets/<namespace>/models/item', zh: uiText("ui.resourceDocs.itemModel"), en: 'item models', detail: uiText("ui.resourceDocs.geometryOfObjectsInHand") },
  { path: 'assets/<namespace>/blockstates', zh: uiText("ui.resourceDocs.blockState"), en: 'blockstates', detail: uiText("ui.resourceDocs.mapTheCubeStatePropertiesToThe") },
  { path: 'assets/<namespace>/lang', zh: uiText("ui.resourceDocs.languageFiles"), en: 'language files', detail: uiText("ui.resourceDocs.showTranslationOfNameAndHintText") },
  { path: 'assets/<namespace>/font', zh: uiText("ui.resourceDocs.fontDefinition"), en: 'font definitions', detail: uiText("ui.resourceDocs.fontProviderJsonQuoteCustomAtlas") },
  { path: 'assets/<namespace>/atlases', zh: uiText("ui.resourceDocs.atlasDefinitions"), en: 'atlases', detail: uiText("ui.resourceDocs.controlsHowTheStickersEnterTheAtlas") },
  { path: 'assets/<namespace>/particles', zh: uiText("ui.resourceDocs.particleDefinition"), en: 'particle definitions', detail: uiText("ui.resourceDocs.customParticleJson") },
  { path: 'assets/<namespace>/sounds.json', zh: uiText("ui.resourceDocs.soundDefinition"), en: 'sounds.json', detail: uiText("ui.resourceDocs.mapOfSoundEventsToAudioFiles") },
  { path: 'assets/<namespace>/shaders', zh: uiText("ui.resourceDocs.colourColourer"), en: 'shaders', detail: uiText("ui.resourceDocs.coreColoursAndReprocessing") },
  { path: 'assets/<namespace>/optifine', zh: uiText("ui.resourceDocs.optifineAuxiliary"), en: 'optifine', detail: uiText("ui.resourceDocs.ctmCitAttachmentRootDirectory") },
  { path: 'assets/minecraft', zh: uiText("ui.resourceDocs.originalNamingSpace"), en: 'minecraft namespace', detail: uiText("ui.resourceDocs.overwriteOriginalResourceMustUseTheNamespace") },
  { path: 'pack.mcmeta', zh: uiText("ui.resourceDocs.packageDescriptionFile"), en: 'pack.mcmeta', detail: uiText("ui.resourceDocs.oldPackFormatNewVersionMinFormat") },
  { path: 'pack.png', zh: uiText("ui.resourceDocs.packageIcon"), en: 'pack icon', detail: uiText("ui.resourceDocs.iconInTheResourcePackListRecommendation") }
]

export const MCMETA_FIELDS: Array<{ name: string; detail: string; snippet: string }> = [
  { name: 'animation', detail: uiText("ui.resourceDocs.declareTheStickerAsAFrameAnimation"), snippet: '"animation": {\n\t"frametime": ${1:4},\n\t"interpolate": ${2:false}\n}' },
  { name: 'frametime', detail: uiText("ui.resourceDocs.everyFrameOfContinuousGameEngravingTimes"), snippet: '"frametime": ${1:4}' },
  { name: 'interpolate', detail: uiText("ui.resourceDocs.whetherOrNotToInterpolateBetweenFrames"), snippet: '"interpolate": ${1|true,false|}' },
  { name: 'frames', detail: uiText("ui.resourceDocs.framePlayOrderRepeatIndexToStop"), snippet: '"frames": [${1:0}, ${2:1}, ${3:2}]' },
  { name: 'width', detail: uiText("ui.resourceDocs.frameWidthDefaultToTakeTheWidth"), snippet: '"width": ${1:16}' },
  { name: 'height', detail: uiText("ui.resourceDocs.frameHeightWhichMustBeAbleTo"), snippet: '"height": ${1:16}' },
  { name: 'texture', detail: uiText("ui.resourceDocs.pasteGenericSettings"), snippet: '"texture": {\n\t"blur": ${1:false},\n\t"clamp": ${2:false}\n}' },
  { name: 'blur', detail: uiText("ui.resourceDocs.whetherTheZoomingIsBlurryAndPixels"), snippet: '"blur": ${1:false}' },
  { name: 'clamp', detail: uiText("ui.resourceDocs.whetherOrNotToClampTheEdges"), snippet: '"clamp": ${1:true}' },
  { name: 'mipmaps', detail: uiText("ui.resourceDocs.specifyTheGeneratedMiipmapLevel"), snippet: '"mipmaps": [${1:0}, ${2:1}, ${3:2}, ${4:3}]' }
]

export const MODEL_FIELDS: Array<{ name: string; detail: string; snippet: string }> = [
  { name: 'parent', detail: uiText("ui.resourceDocs.inheritedParentModelReuseOriginalGeometry"), snippet: '"parent": "${1|minecraft:block/cube_all,minecraft:block/cube_column,minecraft:block/cube_bottom_top,minecraft:item/generated,minecraft:item/handheld|}"' },
  { name: 'textures', detail: uiText("ui.resourceDocs.pasteVariableTableKeynameCorrespondsToParent"), snippet: '"textures": {\n\t"${1:all}": "${2:mcrh:block/example}"\n}' },
  { name: 'elements', detail: uiText("ui.resourceDocs.customGeometricElementsCoordinatesTo"), snippet: '"elements": [\n\t{\n\t\t"from": [${1:0}, ${2:0}, ${3:0}],\n\t\t"to": [${4:16}, ${5:16}, ${6:16}],\n\t\t"faces": {}\n\t}\n]' },
  { name: 'display', detail: uiText("ui.resourceDocs.zoomZoomZoomUnderDifferentPerspectives"), snippet: '"display": {\n\t"thirdperson_righthand": {\n\t\t"rotation": [${1:0}, ${2:0}, ${3:0}],\n\t\t"translation": [${4:0}, ${5:0}, ${6:0}],\n\t\t"scale": [${7:1}, ${8:1}, ${9:1}]\n\t}\n}' },
  { name: 'gui_light', detail: uiText("ui.resourceDocs.internalLightApproachFrontOrSide"), snippet: '"gui_light": "${1|front,side|}"' },
  { name: 'ambientocclusion', detail: uiText("ui.resourceDocs.whetherToEnableEnvironmentalLightMasking"), snippet: '"ambientocclusion": ${1|true,false|}' },
  { name: 'variants', detail: uiText("ui.resourceDocs.mapOfSquaresToTheModel"), snippet: '"variants": {\n\t"": { "model": "${1:mcrh:block/example}" }\n}' },
  { name: 'multipart', detail: uiText("ui.resourceDocs.addMultipleModelsOnCondition"), snippet: '"multipart": [\n\t{\n\t\t"when": { "${1:state}": "${2:value}" },\n\t\t"apply": { "model": "${3:mcrh:block/example}" }\n\t}\n]' },
  { name: 'model', detail: uiText("ui.resourceDocs.referenceModelFile"), snippet: '"model": "${1:mcrh:block/example}"' },
  { name: 'x', detail: uiText("ui.resourceDocs.modelRotationAngleAroundXAxis"), snippet: '"x": ${1|0,90,180,270|}' },
  { name: 'y', detail: uiText("ui.resourceDocs.modelAroundYAxisRotationAngle"), snippet: '"y": ${1|0,90,180,270|}' },
  { name: 'uvlock', detail: uiText("ui.resourceDocs.lockUvDuringRotation"), snippet: '"uvlock": ${1:true}' },
  { name: 'weight', detail: uiText("ui.resourceDocs.theWeightOfRandomVariants"), snippet: '"weight": ${1:1}' }
]

