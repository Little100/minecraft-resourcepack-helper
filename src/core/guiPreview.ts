import { uiText } from '../i18n/messages'
export const GUI_SCENES = [
  { id: 'hud', label: uiText("core.guiPreview.survivalHud"), note: uiText("core.guiPreview.shortcutsStarfliesLifeHungerArmourAndExperience") },
  { id: 'inventory', label: uiText("core.guiPreview.playerInventory"), note: uiText("core.guiPreview.playerItemBarBackgroundSlotLayout") },
  { id: 'chest', label: uiText("core.guiPreview.largeChest"), note: uiText("core.guiPreview.sixLineBoxAndPlayerItemBar") },
  { id: 'crafting', label: uiText("core.guiPreview.craftingTable"), note: uiText("core.guiPreview.syntheticAreaPlayerItemBarBackground") },
  { id: 'furnace', label: uiText("core.guiPreview.furnace"), note: uiText("core.guiPreview.statusOfFurnaceBackgroundCombustionAndRefining") },
  { id: 'widgets', label: uiText("core.guiPreview.menuButtons"), note: uiText("core.guiPreview.normalSuspendedAndDisabledButtonsToSupport") },
  { id: 'texture', label: uiText("core.guiPreview.currentGuiTexture"), note: uiText("core.guiPreview.guiSpriteDescription") }
] as const
export type GuiScene = typeof GUI_SCENES[number]['id']
export const isGuiScene = (value: unknown): value is GuiScene => GUI_SCENES.some(scene => scene.id === value)
export interface GuiRect { x: number; y: number; w: number; h: number }
export type GuiScaling = { type: 'stretch' } | { type: 'tile'; width: number; height: number } | { type: 'nine_slice'; width: number; height: number; border: { left: number; right: number; top: number; bottom: number }; innerStretch: boolean }
export interface GuiSpriteSpec { id: string; label: string; modern: string; legacy?: { path: string; rect: GuiRect; width: number; height: number; scaling?: GuiScaling }; region?: { rect: GuiRect; width: number; height: number } }
export interface GuiSprite { id: string; texture: string; rect: GuiRect; scaling: GuiScaling }
export interface GuiTexture { key: string; path: string; source: string; sourceLabel: string; dirty: boolean; width: number; height: number; png: string }
export interface GuiPreviewData { scene: GuiScene; name: string; version?: string; revision: number; textures: GuiTexture[]; sprites: GuiSprite[]; warnings: string[]; selected?: string }
export interface GuiSettings { width: number; height: number; health: number; food: number; armor: number; experience: number; slot: number; progress: number; widgetWidth: number; widgetHeight: number; hungerEffect: boolean }
export type GuiNumberSetting = keyof Omit<GuiSettings, 'hungerEffect'>
export const DEFAULT_GUI_SETTINGS: GuiSettings = { width: 320, height: 240, health: 20, food: 20, armor: 0, experience: 0.65, slot: 0, progress: 0.6, widgetWidth: 200, widgetHeight: 20, hungerEffect: false }
export interface GuiDraw extends GuiRect { id: string; clip?: GuiRect }
export interface GuiPatch { source: GuiRect; target: GuiRect }
const gui = 'assets/minecraft/textures/gui/'
const rect = (x: number, y: number, w: number, h: number): GuiRect => ({ x, y, w, h })
const legacy = (file: string, x: number, y: number, w: number, h: number): NonNullable<GuiSpriteSpec['legacy']> => ({ path: gui + file + '.png', rect: rect(x, y, w, h), width: 256, height: 256 })
const hud = (id: string, label: string, file = id, old?: NonNullable<GuiSpriteSpec['legacy']>): GuiSpriteSpec => ({ id, label, modern: gui + 'sprites/hud/' + file + '.png', legacy: old })
const HUD: GuiSpriteSpec[] = [
  hud('hotbar', uiText("core.guiPreview.shortcutBar"), 'hotbar', legacy('widgets', 0, 0, 182, 22)),
  hud('selection', uiText("core.guiPreview.selectedSlot"), 'hotbar_selection', legacy('widgets', 0, 22, 24, 23)),
  hud('crosshair', uiText("core.guiPreview.stars"), 'crosshair', legacy('icons', 0, 0, 15, 15)),
  hud('heartEmpty', uiText("core.guiPreview.bottomFrameOfLife"), 'heart/container', legacy('icons', 16, 0, 9, 9)),
  hud('heartFull', uiText("core.guiPreview.theWholeLife"), 'heart/full', legacy('icons', 52, 0, 9, 9)),
  hud('heartHalf', uiText("core.guiPreview.halfALife"), 'heart/half', legacy('icons', 61, 0, 9, 9)),
  hud('foodEmpty', uiText("core.guiPreview.hungerBottomBox"), 'food_empty', legacy('icons', 16, 27, 9, 9)),
  hud('foodFull', uiText("core.guiPreview.iMStarving"), 'food_full', legacy('icons', 52, 27, 9, 9)),
  hud('foodHalf', uiText("core.guiPreview.halfHungry"), 'food_half', legacy('icons', 61, 27, 9, 9)),
  hud('foodEmptyHunger', uiText("core.guiPreview.hungerBottomBox_1d6922"), 'food_empty_hunger', legacy('icons', 133, 27, 9, 9)),
  hud('foodFullHunger', uiText("core.guiPreview.theWholeEffectOfHunger"), 'food_full_hunger', legacy('icons', 88, 27, 9, 9)),
  hud('foodHalfHunger', uiText("core.guiPreview.halfEffectHunger"), 'food_half_hunger', legacy('icons', 97, 27, 9, 9)),
  hud('armorEmpty', uiText("core.guiPreview.armorBottomFrame"), 'armor_empty', legacy('icons', 16, 9, 9, 9)),
  hud('armorFull', uiText("core.guiPreview.fullArmor"), 'armor_full', legacy('icons', 34, 9, 9, 9)),
  hud('armorHalf', uiText("core.guiPreview.halfAArmor"), 'armor_half', legacy('icons', 25, 9, 9, 9)),
  hud('xpEmpty', uiText("core.guiPreview.empiricalBackground"), 'experience_bar_background', legacy('icons', 0, 64, 182, 5)),
  hud('xpFull', uiText("core.guiPreview.progressOfTheExperience"), 'experience_bar_progress', legacy('icons', 0, 69, 182, 5))
]
const CONTAINERS = { inventory: ['inventory', 166], chest: ['generic_54', 222], crafting: ['crafting_table', 166], furnace: ['furnace', 166] } as const
export function guiSpriteSpecs(scene: GuiScene, selected?: string): GuiSpriteSpec[] {
  if (scene === 'hud') return HUD
  if (scene === 'texture') return selected && isGuiTexturePath(selected) ? [{ id: 'texture', label: uiText("core.guiPreview.currentGuiTexture"), modern: selected }] : []
  if (scene === 'widgets') return ['button', 'button_highlighted', 'button_disabled'].map((id, index) => ({ id, label: [uiText("core.guiPreview.normalButton"), uiText("core.guiPreview.suspendedButton"), uiText("core.guiPreview.disableButton")][index], modern: gui + 'sprites/widget/' + id + '.png', legacy: { ...legacy('widgets', 0, [66, 86, 46][index], 200, 20), scaling: { type: 'nine_slice', width: 200, height: 20, border: { left: 2, right: 2, top: 2, bottom: 2 }, innerStretch: false } } }))
  const [file, height] = CONTAINERS[scene]
  const background: GuiSpriteSpec = { id: 'background', label: uiText("core.guiPreview.containerBackground"), modern: gui + 'container/' + file + '.png', region: { rect: rect(0, 0, 176, height), width: 256, height: 256 } }
  if (scene !== 'furnace') return [background]
  return [background,
    { id: 'fire', label: uiText("core.guiPreview.burnProgress"), modern: gui + 'sprites/container/furnace/lit_progress.png', legacy: legacy('container/furnace', 176, 0, 14, 14) },
    { id: 'arrow', label: uiText("core.guiPreview.refiningProgress"), modern: gui + 'sprites/container/furnace/burn_progress.png', legacy: legacy('container/furnace', 176, 14, 24, 16) }
  ]
}
export function isGuiTexturePath(value: unknown): value is string {
  return typeof value === 'string' && /^assets\/[a-z0-9_.-]+\/textures\/gui\/(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.png$/.test(value) && !value.split('/').some(part => part === '.' || part === '..')
}
export function guiSceneForPath(file?: string): GuiScene {
  if (!file || !isGuiTexturePath(file)) return 'hud'
  for (const scene of ['inventory', 'chest', 'crafting', 'furnace'] as const) if (guiSpriteSpecs(scene).some(spec => spec.modern === file)) return scene
  return file.includes('/hud/') || /\/(?:icons|widgets)\.png$/.test(file) ? 'hud' : 'texture'
}
export function guiSettingsForPath(file?: string): Partial<GuiSettings> {
  if (!file || !isGuiTexturePath(file)) return {}
  const sprite = HUD.find(spec => spec.modern === file)?.id
  switch (sprite) {
    case 'foodEmpty': return { food: 0, hungerEffect: false }
    case 'foodHalf': return { food: 19, hungerEffect: false }
    case 'foodFull': return { food: 20, hungerEffect: false }
    case 'foodEmptyHunger': return { food: 0, hungerEffect: true }
    case 'foodHalfHunger': return { food: 19, hungerEffect: true }
    case 'foodFullHunger': return { food: 20, hungerEffect: true }
    case 'heartEmpty': return { health: 0 }
    case 'heartHalf': return { health: 19 }
    case 'heartFull': return { health: 20 }
    case 'armorEmpty': return { armor: 1 }
    case 'armorHalf': return { armor: 19 }
    case 'armorFull': return { armor: 20 }
    case 'xpEmpty': return { experience: 0 }
    case 'xpFull': return { experience: 0.65 }
    default: return {}
  }
}
export function guiResourceEra(version?: string): 'legacy' | 'modern' | 'unknown' {
  if (!version) return 'unknown'
  const parts = version.split('.').map(Number)
  if (parts.some(part => !Number.isSafeInteger(part))) return 'unknown'
  return parts[0] === 1 && (parts[1] < 20 || parts[1] === 20 && (parts[2] ?? 0) < 2) ? 'legacy' : 'modern'
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const dimension = (value: unknown): number => {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 4096) throw new Error(uiText("core.guiPreview.guiZoomSizesMustBeIntegerNumbers"))
  return Number(value)
}
export function parseGuiScaling(metadata: unknown): GuiScaling {
  if (!object(metadata) || metadata.gui === undefined) return { type: 'stretch' }
  if (!object(metadata.gui)) throw new Error(uiText("core.guiPreview.guiMetadataMustBeObjects"))
  const scaling = metadata.gui.scaling
  if (scaling === undefined) return { type: 'stretch' }
  if (!object(scaling)) throw new Error(uiText("core.guiPreview.youHaveToBeAnObject"))
  if (scaling.type === 'stretch') return { type: 'stretch' }
  const width = dimension(scaling.width), height = dimension(scaling.height)
  if (scaling.type === 'tile') return { type: 'tile', width, height }
  if (scaling.type !== 'nine_slice') throw new Error(uiText("core.guiPreview.unsupportedGuiZoomType"))
  const raw = scaling.border
  const border = typeof raw === 'number' ? { left: raw, right: raw, top: raw, bottom: raw } : object(raw) ? { left: raw.left as number, right: raw.right as number, top: raw.top as number, bottom: raw.bottom as number } : undefined
  if (!border || Object.values(border).some(value => !Number.isInteger(value) || value < 0) || border.left + border.right >= width || border.top + border.bottom >= height) throw new Error(uiText("core.guiPreview.theGaugeBorderShallBeNonNegative"))
  if (scaling.stretch_inner !== undefined && typeof scaling.stretch_inner !== 'boolean') throw new Error(uiText("core.guiPreview.stratchInnerMustBeABooleanValue"))
  return { type: 'nine_slice', width, height, border, innerStretch: scaling.stretch_inner === true }
}
export function firstGuiFrame(metadata: unknown, width: number, height: number): { rect: GuiRect; animated: boolean } {
  if (!object(metadata) || metadata.animation === undefined) return { rect: rect(0, 0, width, height), animated: false }
  const animation = metadata.animation
  if (!object(animation)) throw new Error(uiText("core.guiPreview.animationMetadataMustBeObjects"))
  const w = animation.width === undefined ? animation.height === undefined ? Math.min(width, height) : width : dimension(animation.width)
  const h = animation.height === undefined ? animation.width === undefined ? Math.min(width, height) : height : dimension(animation.height)
  if (width % w || height % h) throw new Error(uiText("core.guiPreview.animatedFrameSizesCannotBeSevered"))
  const frames = animation.frames
  if (frames !== undefined && (!Array.isArray(frames) || !frames.length)) throw new Error(uiText("core.guiPreview.invalidAnimationFrameList"))
  const frame: unknown = Array.isArray(frames) ? frames[0] : 0
  const index = object(frame) ? frame.index : frame
  if (!Number.isInteger(index) || Number(index) < 0 || Number(index) >= width / w * (height / h)) throw new Error(uiText("core.guiPreview.animatedFrameIndexCrossed"))
  return { rect: rect(Number(index) % (width / w) * w, Math.floor(Number(index) / (width / w)) * h, w, h), animated: true }
}
export function normalizeGuiSettings(raw: Partial<GuiSettings>): GuiSettings {
  const ranges: Record<GuiNumberSetting, [number, number]> = { width: [256, 960], height: [240, 540], health: [0, 20], food: [0, 20], armor: [0, 20], experience: [0, 1], slot: [0, 8], progress: [0, 1], widgetWidth: [1, 512], widgetHeight: [1, 320] }
  const numeric = Object.fromEntries(Object.entries(ranges).map(([name, [min, max]]) => {
    const key = name as GuiNumberSetting, value = raw[key]
    return [key, typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, key === 'experience' || key === 'progress' ? value : Math.round(value))) : DEFAULT_GUI_SETTINGS[key]]
  })) as Pick<GuiSettings, GuiNumberSetting>
  return { ...numeric, hungerEffect: typeof raw.hungerEffect === 'boolean' ? raw.hungerEffect : DEFAULT_GUI_SETTINGS.hungerEffect }
}
export function guiSceneDraws(scene: GuiScene, input: Partial<GuiSettings>): GuiDraw[] {
  const s = normalizeGuiSettings(input), center = Math.floor(s.width / 2), bottom = s.height, left = center - 91
  const draws: GuiDraw[] = [], draw = (id: string, x: number, y: number, w: number, h: number, clip?: GuiRect): void => { draws.push({ id, x, y, w, h, clip }) }
  if (scene === 'hud') {
    draw('hotbar', left, bottom - 22, 182, 22); draw('selection', left - 1 + s.slot * 20, bottom - 23, 24, 23)
    draw('crosshair', center - 7, Math.floor(bottom / 2) - 7, 15, 15)
    draw('xpEmpty', left, bottom - 29, 182, 5)
    if (s.experience > 0) draw('xpFull', left, bottom - 29, 182, 5, rect(left, bottom - 29, Math.min(182, Math.floor(s.experience * 183)), 5))
    const foodEmpty = s.hungerEffect ? 'foodEmptyHunger' : 'foodEmpty', foodHalf = s.hungerEffect ? 'foodHalfHunger' : 'foodHalf', foodFull = s.hungerEffect ? 'foodFullHunger' : 'foodFull'
    for (let i = 0; i < 10; i++) {
      const x = left + i * 8, foodX = center + 91 - i * 8 - 9, y = bottom - 39
      draw('heartEmpty', x, y, 9, 9); draw(foodEmpty, foodX, y, 9, 9)
      if (s.health > i * 2) draw(s.health >= i * 2 + 2 ? 'heartFull' : 'heartHalf', x, y, 9, 9)
      if (s.food > i * 2) draw(s.food >= i * 2 + 2 ? foodFull : foodHalf, foodX, y, 9, 9)
      if (s.armor > 0) draw(s.armor >= i * 2 + 2 ? 'armorFull' : s.armor > i * 2 ? 'armorHalf' : 'armorEmpty', x, y - 10, 9, 9)
    }
  } else if (scene === 'widgets') {
    for (const [index, id] of ['button', 'button_highlighted', 'button_disabled'].entries()) draw(id, Math.floor((s.width - s.widgetWidth) / 2), 40 + index * (s.widgetHeight + 12), s.widgetWidth, s.widgetHeight)
  } else if (scene === 'texture') draw('texture', Math.floor((s.width - s.widgetWidth) / 2), Math.floor((s.height - s.widgetHeight) / 2), s.widgetWidth, s.widgetHeight)
  else {
    const height = CONTAINERS[scene][1], x = Math.floor((s.width - 176) / 2), y = Math.floor((s.height - height) / 2)
    draw('background', x, y, 176, height)
    if (scene === 'furnace') {
      const fireHeight = s.progress > 0 ? Math.ceil(13 * s.progress) + 1 : 0
      if (fireHeight) draw('fire', x + 56, y + 36, 14, 14, rect(x + 56, y + 50 - fireHeight, 14, fireHeight))
      if (s.progress) draw('arrow', x + 79, y + 34, 24, 16, rect(x + 79, y + 34, Math.ceil(24 * s.progress), 16))
    }
  }
  return draws
}
export function guiSpritePatches(scaling: GuiScaling, source: GuiRect, target: GuiRect): GuiPatch[] {
  if ([source, target].some(r => ![r.x, r.y, r.w, r.h].every(Number.isFinite) || r.w <= 0 || r.h <= 0 || r.w > 16384 || r.h > 16384)) return []
  if (scaling.type === 'stretch') return [{ source, target }]
  const patches: GuiPatch[] = []
  const add = (s: GuiRect, t: GuiRect): void => {
    if (s.w <= 0 || s.h <= 0 || t.w <= 0 || t.h <= 0) return
    if (patches.length >= 8192) throw new Error(uiText("core.guiPreview.guiFlattensMoreThanThePreviewBudget"))
    patches.push({ source: s, target: t })
  }
  const tile = (s: GuiRect, t: GuiRect, tileW: number, tileH: number): void => {
    for (let y = 0; y < t.h; y += tileH) for (let x = 0; x < t.w; x += tileW) {
      const w = Math.min(tileW, t.w - x), h = Math.min(tileH, t.h - y)
      add(rect(s.x, s.y, s.w * w / tileW, s.h * h / tileH), rect(t.x + x, t.y + y, w, h))
    }
  }
  if (scaling.type === 'tile') { tile(source, target, scaling.width, scaling.height); return patches }
  if (target.w === scaling.width && target.h === scaling.height) return [{ source, target }]
  const b = scaling.border, sx = source.w / scaling.width, sy = source.h / scaling.height
  const left = Math.min(b.left, Math.floor(target.w / 2)), right = Math.min(b.right, Math.floor(target.w / 2)), top = Math.min(b.top, Math.floor(target.h / 2)), bottom = Math.min(b.bottom, Math.floor(target.h / 2))
  const xs = target.w === scaling.width ? [0, scaling.width] : [0, left, scaling.width - right, scaling.width]
  const ys = target.h === scaling.height ? [0, scaling.height] : [0, top, scaling.height - bottom, scaling.height]
  const xt = target.w === scaling.width ? [0, target.w] : [0, left, target.w - right, target.w]
  const yt = target.h === scaling.height ? [0, target.h] : [0, top, target.h - bottom, target.h]
  for (let y = 0; y < ys.length - 1; y++) for (let x = 0; x < xs.length - 1; x++) {
    const s = rect(source.x + xs[x] * sx, source.y + ys[y] * sy, (xs[x + 1] - xs[x]) * sx, (ys[y + 1] - ys[y]) * sy)
    const t = rect(target.x + xt[x], target.y + yt[y], xt[x + 1] - xt[x], yt[y + 1] - yt[y])
    const innerX = xs.length === 4 && x === 1, innerY = ys.length === 4 && y === 1
    if (innerX || innerY) {
      if (scaling.innerStretch) add(s, t)
      else tile(s, t, innerX ? xs[x + 1] - xs[x] : t.w, innerY ? ys[y + 1] - ys[y] : t.h)
    } else add(s, t)
  }
  return patches
}
