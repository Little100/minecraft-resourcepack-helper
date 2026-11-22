import { uiText } from '../../i18n/messages'
import { PNG } from 'pngjs'
import { z } from 'zod'
import { generateColormapFiles, parseTintColor, type GeneratedFile } from './colormap'
import { getVersionCapabilities } from './versionCapabilities'

export const TINT_PRESETS = [
  { id: 'grass', label: uiText("core.advanced.tintPresets.grasslandAndHerbs"), path: 'textures/colormap/grass.png', blocks: ['grass_block', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'sugar_cane'], color: '#76b852', note: uiText("core.advanced.tintPresets.theOriginalSavannahSquareAffectsOnlyThe") },
  { id: 'foliage', label: uiText("core.advanced.tintPresets.normalLeavesAndVines"), path: 'textures/colormap/foliage.png', blocks: ['oak_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'vine'], color: '#64a34b', note: uiText("core.advanced.tintPresets.theOriginalLeafColourMapDoesNot") },
  { id: 'dry_foliage', label: uiText("core.advanced.tintPresets.dryVegetationColourMap"), path: 'textures/colormap/dry_foliage.png', blocks: ['leaf_litter'], color: '#b08a54', note: uiText("core.advanced.tintPresets.theOriginalVersionOfTheDryVegetation") },
  { id: 'water', label: uiText("core.advanced.tintPresets.theColorOfTheWater"), path: 'optifine/colormap/water.png', blocks: ['water'], color: '#3caac4', note: uiText("core.advanced.tintPresets.optifineCustomColorsWaterColourMapWhich") },
  { id: 'birch', label: uiText("core.advanced.tintPresets.whiteSapLeaves"), path: 'optifine/colormap/birch.png', blocks: ['birch_leaves'], color: '#a7bd67', note: uiText("core.advanced.tintPresets.optifineCustomColorsOverrideOriginalFixedWhitet") },
  { id: 'pine', label: uiText("core.advanced.tintPresets.theLeavesOfTheForest"), path: 'optifine/colormap/pine.png', blocks: ['spruce_leaves'], color: '#619961', note: uiText("core.advanced.tintPresets.optifineCustomColorsCoveringOriginalFixedClouds") },
  { id: 'swampgrass', label: uiText("core.advanced.tintPresets.swampGrass"), path: 'optifine/colormap/swampgrass.png', blocks: ['grass_block', 'short_grass', 'tall_grass', 'fern'], color: '#6a7039', note: uiText("core.advanced.tintPresets.optifineCustomColorsWeedCoverRangeControlled") },
  { id: 'swampfoliage', label: uiText("core.advanced.tintPresets.swampLeaves"), path: 'optifine/colormap/swampfoliage.png', blocks: ['oak_leaves', 'vine'], color: '#6a7039', note: uiText("core.advanced.tintPresets.optifineCustomColorsSwampedLeafColourCover") },
  { id: 'redstone', label: uiText("core.advanced.tintPresets.redstoneLineBySignalStrength"), path: 'optifine/colormap/redstone.png', blocks: ['redstone_wire'], color: '#dd3b32', width: 16, note: uiText("core.advanced.tintPresets.x1StatusBandForOptifineCustomColors") },
  { id: 'pumpkinstem', label: uiText("core.advanced.tintPresets.pumpkinTubersByGrowthPhase"), path: 'optifine/colormap/pumpkinstem.png', blocks: ['pumpkin_stem', 'attached_pumpkin_stem'], color: '#79a83b', width: 8, note: uiText("core.advanced.tintPresets.x1OfOptifineCustomColorsGrowthBand") },
  { id: 'melonstem', label: uiText("core.advanced.tintPresets.watermelonsByGrowthPhase"), path: 'optifine/colormap/melonstem.png', blocks: ['melon_stem', 'attached_melon_stem'], color: '#79a83b', width: 8, note: uiText("core.advanced.tintPresets.x1OfOptifineCustomColorsGrowthBand_f30728") },
  { id: 'custom', label: uiText("core.advanced.tintPresets.chromosomeOfTheSelectedBlocks"), path: 'optifine/colormap/blocks', blocks: ['stone'], color: '#b4c4d0', note: uiText("core.advanced.tintPresets.optifineCustomColorsCustomizeSquareRulesTo") }
] as const
const schema = z.object({ preset: z.string().max(64), mode: z.enum(['flat', 'gradient']).default('flat'), color: z.string().default('#76b852'), cold: z.string().default('#8fabc1'), dry: z.string().default('#c4b66d'), wet: z.string().default('#33834c'), blocks: z.string().max(8192).default('minecraft:stone'), ruleName: z.string().max(128).regex(/^[a-z0-9_-]+$/).default('custom_tint'), targetVersion: z.string().max(64) })
export function generateTintPreset(input: unknown): GeneratedFile[] {
  const options = schema.parse(input), preset = TINT_PRESETS.find(entry => entry.id === options.preset)
  if (!preset) throw new Error(uiText("core.advanced.tintPresets.unknownDyePreset"))
  const version = getVersionCapabilities(options.targetVersion)
  if (!version || version.status !== 'release') throw new Error(uiText("core.advanced.tintPresets.colourPresetRequiresAConfirmedOfficialTarget"))
  if (preset.id === 'dry_foliage' && (version.resourcePackFormat?.major ?? 0) < 55) throw new Error(uiText("core.advanced.tintPresets.dryVegetationColourChartRequiresOrUpdate"))
  const color = parseTintColor(options.color), gradient = { cold: options.cold, dry: options.dry, wet: options.wet }
  if (options.mode === 'gradient') for (const value of Object.values(gradient)) parseTintColor(value)
  if (preset.id === 'grass' || preset.id === 'foliage' || preset.id === 'dry_foliage') return generateColormapFiles(preset.id, options.mode === 'flat' ? { color } : gradient)
  let image: Uint8Array
  if ('width' in preset) {
    const png = new PNG({ width: preset.width, height: 1 }), colors = options.mode === 'flat' ? [color, color, color] : Object.values(gradient).map(parseTintColor)
    for (let x = 0; x < preset.width; x++) {
      const position = x / (preset.width - 1) * 2, start = Math.min(1, Math.floor(position)), factor = position - start
      for (let channel = 0; channel < 3; channel++) { const shift = (2 - channel) * 8, a = colors[start] >>> shift & 255, b = colors[start + 1] >>> shift & 255; png.data[x * 4 + channel] = Math.round(a + (b - a) * factor) }
      png.data[x * 4 + 3] = 255
    }
    image = PNG.sync.write(png)
  } else image = generateColormapFiles('grass', options.mode === 'flat' ? { color } : gradient)[0].content as Uint8Array
  if (preset.id !== 'custom') return [{ path: 'assets/minecraft/' + preset.path, content: image }]
  const blocks = [...new Set(options.blocks.trim().split(/\s+/))]
  if (!blocks.length || blocks.length > 256 || blocks.some(id => !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id) || id.split(/[:/]/).some(part => part === '.' || part === '..'))) throw new Error(uiText("core.advanced.tintPresets.blockListFormat"))
  const base = 'assets/minecraft/optifine/colormap/blocks/' + options.ruleName
  return [{ path: base + '.png', content: image }, { path: base + '.properties', content: 'format=vanilla\nblocks=' + blocks.join(' ') + '\nsource=' + options.ruleName + '.png\ncolor=' + color.toString(16).padStart(6, '0') + '\n' }]
}
