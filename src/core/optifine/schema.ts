import { uiText } from '../../i18n/messages'
export type PropType = 'string' | 'int' | 'float' | 'bool' | 'enum' | 'list' | 'tile-list'

export interface PropSpec {
  name: string
  type: PropType
  required: boolean
  doc: string
  values?: readonly string[]
  default?: string
}

export interface FileSchema {
  id: string
  label: string
  description: string
  /** 相对于 assets/minecraft/optifine 的目录 */
  folder: string
  /** 固定文件名, 省略时由用户命名 */
  fileName?: string
  props: readonly PropSpec[]
}

const BLOCKS: PropSpec = { name: 'matchBlocks', type: 'list', required: false, doc: uiText("core.optifine.schema.listOfEffectiveBlocksSupportNamespaceName") }
const TILES: PropSpec = { name: 'matchTiles', type: 'tile-list', required: false, doc: uiText("core.optifine.schema.aListOfValidStickersOmittedWhen") }

export const SCHEMAS: readonly FileSchema[] = [
  {
    id: 'ctm',
    label: uiText("core.optifine.schema.ctmConnectionTexture"),
    description: uiText("core.optifine.schema.automaticallyConnectAdjacentTextureBlocksToGlass"),
    folder: 'ctm/myblock',
    props: [
      TILES,
      BLOCKS,
      {
        name: 'method', type: 'enum', required: true, doc: uiText("core.optifine.schema.connection"),
        values: ['ctm', 'ctm_compact', 'horizontal', 'vertical', 'horizontal+vertical', 'vertical+horizontal', 'top', 'random', 'repeat', 'fixed', 'overlay', 'overlay_ctm', 'overlay_random', 'overlay_repeat', 'overlay_fixed']
      },
      { name: 'tiles', type: 'list', required: true, doc: uiText("core.optifine.schema.replaceThePosterListSupportingAndName") },
      { name: 'faces', type: 'enum', required: false, doc: uiText("core.optifine.schema.limitationsOnEntryIntoForce"), values: ['bottom', 'top', 'north', 'south', 'east', 'west', 'sides', 'all'] },
      { name: 'weight', type: 'int', required: false, default: '0', doc: uiText("core.optifine.schema.whenTheRulesAreInConflictThose") },
      { name: 'biomes', type: 'list', required: false, doc: uiText("core.optifine.schema.delineatingBiota") },
      { name: 'heights', type: 'list', required: false, doc: uiText("core.optifine.schema.limitHeightRangeNegativeNumbersToBrackets") },
      { name: 'innerSeams', type: 'bool', required: false, doc: uiText("core.optifine.schema.whetherOrNotTheConnectionIsWrong") },
      { name: 'width', type: 'int', required: false, doc: uiText("core.optifine.schema.repeatMethodWidth") },
      { name: 'height', type: 'int', required: false, doc: uiText("core.optifine.schema.highPattern") },
      { name: 'weights', type: 'list', required: false, doc: uiText("core.optifine.schema.theTileWeightOfTheRandallMethod") },
      { name: 'linked', type: 'bool', required: false, doc: uiText("core.optifine.schema.randomTextureForAssociatedSquares") },
      { name: 'connect', type: 'enum', required: false, doc: uiText("core.optifine.schema.ctmNeighbourhoodMatchingBasis"), values: ['block', 'tile', 'material'] },
      { name: 'symmetry', type: 'enum', required: false, doc: uiText("core.optifine.schema.theSymmetricalGroupingOfTheTermRandom"), values: ['none', 'opposite', 'all'] }
    ]
  },
  {
    id: 'cit-single',
    label: uiText("core.optifine.schema.citCustomItems"),
    description: uiText("core.optifine.schema.replacementOfPostersAndModelsForArticles"),
    folder: 'cit/mysword',
    props: [
      { name: 'type', type: 'enum', required: false, default: 'item', doc: uiText("core.optifine.schema.replaceType"), values: ['item', 'enchantment', 'armor', 'elytra'] },
      { name: 'items', type: 'list', required: false, doc: uiText("core.optifine.schema.listOfActiveItemsEnchantmentTypeOmitted") },
      { name: 'texture', type: 'string', required: false, doc: uiText("core.optifine.schema.replaceThePasteWithTheSamePng") },
      { name: 'model', type: 'string', required: false, doc: uiText("core.optifine.schema.replaceModelOriginalJsonFormat") },
      { name: 'damage', type: 'list', required: false, doc: uiText("core.optifine.schema.durableValuesOrRanges") },
      { name: 'damageMask', type: 'int', required: false, doc: uiText("core.optifine.schema.longerPositionMaskComparison") },
      { name: 'stackSize', type: 'int', required: false, doc: uiText("core.optifine.schema.matchStackNumber") },
      { name: 'enchantmentIds', type: 'list', required: false, doc: uiText("core.optifine.schema.aListOfIdsWithDemons") },
      { name: 'enchantmentLevels', type: 'list', required: false, doc: uiText("core.optifine.schema.demonLeveledRange") },
      { name: 'weight', type: 'int', required: false, default: '0', doc: uiText("core.optifine.schema.ruleWeights") },
      { name: 'nbt.display.name', type: 'string', required: false, doc: uiText("core.optifine.schema.matchItemDisplayName") },
      { name: 'nbt.Lore', type: 'string', required: false, doc: uiText("core.optifine.schema.matchItemLoreRegular") }
    ]
  },
  {
    id: 'cit-global',
    label: uiText("core.optifine.schema.citGlobalConfiguration"),
    description: uiText("core.optifine.schema.controlMultiMagicStackingAndGlintLight"),
    folder: 'cit',
    fileName: 'cit_global.properties',
    props: [
      { name: 'method', type: 'enum', required: false, doc: uiText("core.optifine.schema.overlayMethod"), values: ['average', 'layered', 'cycle'] },
      { name: 'cap', type: 'int', required: false, doc: uiText("core.optifine.schema.averageAndPlayederedUpperLimit") },
      { name: 'fade', type: 'float', required: false, default: '0.5', doc: uiText("core.optifine.schema.cycleToggleTransitionSeconds") },
      { name: 'useGlint', type: 'bool', required: false, default: 'true', doc: uiText("core.optifine.schema.whetherOrNotToRetainTheDefault") }
    ]
  },
  {
    id: 'ctm-global',
    label: uiText("core.optifine.schema.ctmGlobalConfiguration"),
    description: uiText("core.optifine.schema.unifiedControlCtmSwitchesAndDebugOutput"),
    folder: 'ctm',
    fileName: 'ctm_global.properties',
    props: [
      { name: 'verbose', type: 'bool', required: false, doc: uiText("core.optifine.schema.outputDetailedMatchDebugLog") },
      { name: 'disabled', type: 'bool', required: false, doc: uiText("core.optifine.schema.closeCtmFully") }
    ]
  },
  {
    id: 'emissive',
    label: uiText("core.optifine.schema.shiningTexture"),
    description: uiText("core.optifine.schema.addASpontaneousOpticLayerToSquares"),
    folder: 'emissive/concrete',
    props: [
      TILES,
      BLOCKS,
      { name: 'suffix.emissive', type: 'string', required: false, default: '_e', doc: uiText("core.optifine.schema.suffixOfTheFileNameForThe") },
      { name: 'items', type: 'list', required: false, doc: uiText("core.optifine.schema.effectiveListOfItems") },
      { name: 'texture.emissive', type: 'string', required: false, doc: uiText("core.optifine.schema.lightmarkPath") },
      {
        name: 'blend', type: 'enum', required: false, doc: uiText("core.optifine.schema.mixedMode"),
        values: ['replace', 'alpha', 'overlay', 'color', 'add', 'subtract', 'multiply', 'dodge', 'burn', 'screen']
      }
    ]
  },
  {
    id: 'anim',
    label: uiText("core.optifine.schema.frameSequenceAnimation"),
    description: uiText("core.optifine.schema.customCycleOfSerialNumbersMoreFlexible"),
    folder: 'anim/water',
    props: [
      { name: 'from', type: 'string', required: true, doc: uiText("core.optifine.schema.startFramePasteName") },
      { name: 'to', type: 'string', required: true, doc: uiText("core.optifine.schema.endFramePasteName") },
      { name: 'duration', type: 'int', required: true, doc: uiText("core.optifine.schema.wholeCycleMilliseconds") },
      { name: 'tileWidth', type: 'int', required: false, doc: uiText("core.optifine.schema.loopWidthDefaultIsAsWideAs") },
      { name: 'tileHeight', type: 'int', required: false, doc: uiText("core.optifine.schema.loopHeightDefaultAsHighAsInitial") },
      { name: 'interpolate', type: 'bool', required: false, default: 'false', doc: uiText("core.optifine.schema.whetherTheFrameShouldBeSmooth") }
    ]
  },
  {
    id: 'block',
    label: uiText("core.optifine.schema.blockConnectionControl"),
    description: uiText("core.optifine.schema.controllingTheCorrelationBetweenGrassAndSnow"),
    folder: 'block',
    fileName: 'block.properties',
    props: [
      { name: 'grass.multilayer', type: 'bool', required: false, default: 'false', doc: uiText("core.optifine.schema.grassBlockLayers") },
      { name: 'grass.paths', type: 'bool', required: false, doc: uiText("core.optifine.schema.theGrassSideIsConnectedToThe") },
      { name: 'connectedGrass', type: 'bool', required: false, doc: uiText("core.optifine.schema.grasssideFullConnection") }
    ]
  },
  {
    id: 'bettergrass',
    label: uiText("core.optifine.schema.betterGrass"),
    description: uiText("core.optifine.schema.letGrassAndSnowCoverTheSurface"),
    folder: 'bettergrass',
    fileName: 'bettergrass.properties',
    props: [
      { name: 'grass', type: 'bool', required: false, default: 'true', doc: uiText("core.optifine.schema.enableTheDLayerOfGrass") },
      { name: 'grass.snow', type: 'bool', required: false, default: 'true', doc: uiText("core.optifine.schema.snowCoversTheGrass") },
      { name: 'mycelium', type: 'bool', required: false, default: 'false', doc: uiText("core.optifine.schema.enableDLayerOfMycelium") },
      { name: 'path', type: 'bool', required: false, doc: uiText("core.optifine.schema.dLayerOfPathBlock") },
      { name: 'texture.grass', type: 'string', required: false, doc: uiText("core.optifine.schema.pathToTheGrassDPaste") }
    ]
  },
  {
    id: 'cem-model',
    label: uiText("core.optifine.schema.cemEntityModel"),
    description: uiText("core.optifine.schema.replaceTheDefaultPhysicalGeometryWithA"),
    folder: 'cem/mobs/pig',
    props: [
      { name: 'model', type: 'string', required: true, doc: uiText("core.optifine.schema.jpmOrJavaModelPath") },
      { name: 'texture', type: 'string', required: false, doc: uiText("core.optifine.schema.entityPasteUseOriginalPathWhenOmitted") },
      { name: 'biomes', type: 'list', required: false, doc: uiText("core.optifine.schema.delineatingBiota") },
      { name: 'weights', type: 'list', required: false, doc: uiText("core.optifine.schema.modelWeight") }
    ]
  },
  {
    id: 'cem-animation',
    label: uiText("core.optifine.schema.cemEntityAnimation"),
    description: uiText("core.optifine.schema.mountAnimationSequencesForCustomEntityModels"),
    folder: 'cem/anim/pig',
    fileName: 'pig.animation.txt',
    props: [
      { name: 'script', type: 'string', required: false, doc: uiText("core.optifine.schema.customScriptPath") },
      { name: 'speed', type: 'float', required: false, default: '1', doc: uiText("core.optifine.schema.animationSpeedMultiplier") }
    ]
  },
  {
    id: 'random-entities',
    label: uiText("core.advanced.packRequirements.randomPhysicalTexture"),
    description: uiText("core.optifine.schema.configureMultipleTexturesByWeightRandomlyFor"),
    folder: 'random_entities/mobs/creeper',
    props: [
      { name: 'textures', type: 'list', required: true, doc: uiText("core.optifine.schema.textureListWithTheUseOfIslogo") },
      { name: 'weights', type: 'list', required: false, default: '1', doc: uiText("core.optifine.schema.weightsInTextures") },
      { name: 'biomes', type: 'list', required: false, doc: uiText("core.optifine.schema.delineatingBiota") },
      { name: 'heights', type: 'list', required: false, doc: uiText("core.optifine.schema.limitHeightRange") }
    ]
  },
  {
    id: 'dynamic-lights',
    label: uiText("core.optifine.schema.dynamicLightSource"),
    description: uiText("core.optifine.schema.letsTheHandheldAndPlacedObjectLight"),
    folder: 'dynamiclights',
    fileName: 'dynamiclights.properties',
    props: [
      { name: 'items', type: 'list', required: false, doc: uiText("core.optifine.schema.listOfLuminousItems") },
      { name: 'blocks', type: 'list', required: false, doc: uiText("core.optifine.schema.emissiveBlocks") },
      { name: 'entities', type: 'list', required: false, doc: uiText("core.optifine.schema.listOfEntitiesThatGlow") }
    ]
  },
  {
    id: 'color',
    label: uiText("core.optifine.schema.colourProperties"),
    description: uiText("core.optifine.schema.coloursByObjectAndSquareAndCan"),
    folder: 'color',
    fileName: 'color.properties',
    props: [
      { name: 'color.*', type: 'string', required: false, doc: uiText("core.optifine.schema.colourOverwriteHexadecimalDoesNotContainWell") },
      { name: 'color.*.speed', type: 'float', required: false, doc: uiText("core.optifine.schema.colourGradientSpeed") }
    ]
  },
  {
    id: 'texture-size',
    label: uiText("core.optifine.schema.hdDimensionStatement"),
    description: uiText("core.optifine.schema.declaresTheOriginalSizeOfAHigh"),
    folder: 'texture',
    fileName: 'texture.properties',
    props: [
      { name: 'size', type: 'tile-list', required: false, doc: uiText("core.optifine.schema.hdSizeLikeX32OrX128") },
      { name: 'texture.*', type: 'string', required: false, doc: uiText("core.optifine.schema.individuallySpecifyTheHdDimensionsOfA") }
    ]
  }
]

