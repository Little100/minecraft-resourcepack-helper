import { uiText } from '../../i18n/messages'
export interface ResourceSnippet { name: string; detail: string; snippet: string }
export const ITEM_DEFINITION_FIELDS: ResourceSnippet[] = [
  { name: 'model', detail: uiText("core.advanced.resourceSyntax.definiteEntryForItemsGeometricsOfThe"), snippet: '"model": {\n\t"type": "minecraft:model",\n\t"model": "${1:minecraft:item/totem_of_undying}"\n}' },
  { name: 'type', detail: uiText("core.advanced.resourceSyntax.renderModelNodeTypeNotEqualTo"), snippet: '"type": "${1|minecraft:model,minecraft:composite,minecraft:condition,minecraft:select,minecraft:range_dispatch,minecraft:empty|}"' },
  { name: 'models', detail: uiText("core.advanced.resourceSyntax.composteNodeSuperimposeMultipleModels"), snippet: '"models": [\n\t{"type": "minecraft:model", "model": "${1:minecraft:item/diamond_sword}"}\n]' },
  { name: 'tints', detail: uiText("core.advanced.resourceSyntax.aListOfColourSourcesForModel"), snippet: '"tints": [{"type": "minecraft:constant", "value": ${1:16777215}}]' },
  { name: 'property', detail: uiText("core.advanced.resourceSyntax.propertiesToMatchNodeType"), snippet: '"property": "${1:minecraft:using_item}"' },
  { name: 'on_true', detail: uiText("core.advanced.resourceSyntax.conditionPropertyIsTheModelUsedWhen"), snippet: '"on_true": {"type": "minecraft:model", "model": "${1:minecraft:item/diamond_sword}"}' },
  { name: 'on_false', detail: uiText("core.advanced.resourceSyntax.conditionPropertyIsTheModelUsedFor"), snippet: '"on_false": {"type": "minecraft:empty"}' },
  { name: 'fallback', detail: uiText("core.advanced.resourceSyntax.modelInCaseOfFailureToMatch"), snippet: '"fallback": {"type": "minecraft:empty"}' },
  { name: 'entries', detail: uiText("core.advanced.resourceSyntax.rangeDispatchPressPresent"), snippet: '"entries": [{"threshold": ${1:1}, "model": {"type": "minecraft:model", "model": "${2:minecraft:item/diamond_sword}"}}]' }
]
export const ATLAS_FIELDS: ResourceSnippet[] = [
  { name: 'sources', detail: uiText("core.advanced.resourceSyntax.listOfAtlasSourcesSpecificTypesTo"), snippet: '"sources": [{"type": "minecraft:directory", "source": "${1:block}", "prefix": "${2:block/}"}]' },
  { name: 'type', detail: uiText("core.advanced.resourceSyntax.atlasSourceNodeType"), snippet: '"type": "${1|minecraft:directory,minecraft:single,minecraft:filter,minecraft:unstitch,minecraft:paletted_permutations|}"' },
  { name: 'source', detail: uiText("core.advanced.resourceSyntax.texturesRelativeDirectoryOfDirectorySources"), snippet: '"source": "${1:block}"' },
  { name: 'prefix', detail: uiText("core.advanced.resourceSyntax.aPrefixToTheSpriteIdGenerated"), snippet: '"prefix": "${1:block/}"' },
  { name: 'resource', detail: uiText("core.advanced.resourceSyntax.singleSourceTextureResourceIdExcludingPng"), snippet: '"resource": "${1:minecraft:block/stone}"' },
  { name: 'sprite', detail: uiText("core.advanced.resourceSyntax.singleSourceSpriteId"), snippet: '"sprite": "${1:minecraft:block/stone}"' }
]
export const FONT_FIELDS: ResourceSnippet[] = [
  { name: 'providers', detail: uiText("core.advanced.resourceSyntax.modernJsonFontProgramrListNot"), snippet: '"providers": [{"type": "bitmap", "file": "${1:minecraft:font/ascii.png}", "height": ${2:8}, "ascent": ${3:7}, "chars": ["${4:ABC}"]}]' },
  { name: 'type', detail: uiText("core.advanced.resourceSyntax.fontProjecterTypeUsabilityForAccessNeeds"), snippet: '"type": "${1|bitmap,ttf,space|}"' },
  { name: 'file', detail: uiText("core.advanced.resourceSyntax.bitmapTtfResourcePath"), snippet: '"file": "${1:minecraft:font/custom.png}"' },
  { name: 'height', detail: uiText("core.advanced.resourceSyntax.bitmapCharacterRenderHeight"), snippet: '"height": ${1:8}' },
  { name: 'ascent', detail: uiText("core.advanced.resourceSyntax.bitmapHeightRelativeToBaseline"), snippet: '"ascent": ${1:7}' },
  { name: 'chars', detail: uiText("core.advanced.resourceSyntax.characterGridEmptyPositionWithUnicodeEmpty"), snippet: '"chars": ["${1:ABC}", "${2:DEF}"]' },
  { name: 'advances', detail: uiText("core.advanced.resourceSyntax.spaceProjecterCharacterForwardDistance"), snippet: '"advances": {" ": ${1:4}}' }
]
