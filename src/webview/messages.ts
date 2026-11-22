import type { ResourceDisplayName } from '../core/resourceNames'
import type { ReferenceRequest } from '../core/referenceImages'
import type { RandomVariant, VariantEdit } from '../core/randomVariants'

// 同步更新

export interface RgbaRect {
  x: number
  y: number
  width: number
  height: number
}

// 像素画笔

export interface LayerInfo {
  randomVariant?: RandomVariant
  id: string
  name: string
  visible: boolean
  opacity: number
}

export interface LayerPixels extends LayerInfo {
  // 画布上每个像素占四个 RGBA 值
  pixels: ArrayBuffer
}

export interface SnapshotMessage {
  command: 'snapshot'
  width: number
  height: number
  // 静态图按单帧处理
  frameCount: number
  frameHeight?: number
  activeLayerId?: string
  // 图层从上到下排列
  layers: LayerPixels[]
}

// 面板给新图层补空白像素，删除旧图层的像素
export interface LayersMessage {
  command: 'layers'
  activeLayerId?: string
  layers: LayerInfo[]
}

export interface PatchMessage {
  command: 'patch'
  layerId: string
  rect: RgbaRect
  // 矩形里的像素按行存放
  pixels: ArrayBuffer
}

export interface NoticeMessage {
  command: 'notice'
  level: 'info' | 'warn' | 'error'
  text: string
}

export interface PaintSettingsMessage { command: 'paintSettings'; keybindings: Record<string, string> }

export interface PaintHistoryMessage { command: 'paintHistory'; entries: { id: number; label: string; at: string }[]; current: number }
export type PixelHostMessage = PaintHistoryMessage | PaintSettingsMessage | SnapshotMessage | LayersMessage | PatchMessage | NoticeMessage

export type PixelCommand =
  | { command: 'open3dPreview' | 'openGuiPreview' | 'openTextureInBlockbench' }
  | VariantEdit
  | { command: 'randomVariants'; action: 'addImages' }
  | { command: 'randomVariants'; action: 'export'; includeMcrh: boolean; mode: 'vanilla' | 'optifine'; block: string; symmetry: 'none' | 'opposite' | 'all'; linked: boolean }
  | ReferenceRequest
  | { command: 'todo'; action: string; [key: string]: unknown }
  | { command: 'pixelTools'; action: string; [key: string]: unknown }
  | { command: 'gitWorkbench'; action: string; [key: string]: unknown }
  | { command: 'restoreHistory'; id: number }
  | { command: 'ready' }
  | { command: 'setKeybindings'; bindings: Record<string, string> }
  // 笔画结束时，扩展记录原像素以便撤销
  | { command: 'commit'; layerId: string; rect: RgbaRect; pixels: ArrayBuffer }
  | { command: 'addLayer' }
  | { command: 'removeLayer'; layerId: string }
  | { command: 'renameLayer'; layerId: string; name: string }
  | { command: 'moveLayer'; layerId: string; toIndex: number }
  | { command: 'setLayerVisible'; layerId: string; visible: boolean }
  | { command: 'setLayerOpacity'; layerId: string; opacity: number }
  // 切换图层不记入撤销历史
  | { command: 'setActiveLayer'; layerId: string }
  // 按当前画布坐标裁剪，舍弃超出的部分
  | { command: 'crop'; rect: RgbaRect }
  | { command: 'undo' }
  | { command: 'redo' }

export const LIVE_PREVIEW_INTERVAL = 80
export const MAX_LIVE_PREVIEW_BYTES = 4 * 1024 * 1024
export type PixelLiveCommand =
  | { command: 'previewStroke'; sequence: number; layerId: string; rect: RgbaRect; pixels: ArrayBuffer }
  | { command: 'previewStrokeEnd'; sequence: number }

// 贴图预览

export type PreviewMode = 'flat' | 'block' | 'hand-first' | 'hand-third' | 'hotbar' | 'frame'

export interface SpriteImage {
  width: number
  height: number
  data: ArrayBuffer
}

export interface PreviewAnimation {
  // 每帧时长，单位为游戏刻
  frametime: number
  interpolate: boolean
  // 可指定帧顺序和时长，留空按图片上的顺序播放
  frames?: Array<number | { index: number; time: number }>
}

export interface PreviewMessage extends Partial<ResourceDisplayName> {
  command: 'preview'
  sourceUri?: string
  name: string
  // 单帧宽度
  width: number
  // 整张贴图的高度，包括所有帧
  height: number
  frameCount: number
  packLabel: string
  // 整张贴图的像素
  data?: ArrayBuffer
  animation?: PreviewAnimation
  // 缺少原版界面贴图时由面板绘制占位图
  sprites?: Partial<Record<'hotbar' | 'hotbarSelection' | 'slot' | 'frame', SpriteImage>>
}

export interface PreviewClearMessage { command: 'previewClear'; sourceUri?: string; notice: string }
export interface PreviewErrorMessage { command: 'previewError'; sourceUri?: string; error: string }
export interface PreviewFollowMessage { command: 'previewFollow'; following: boolean }
export type PreviewCommand = { command: 'previewReady' | 'openTextureInBlockbench' } | { command: 'setPreviewFollow'; following: boolean }

// 版本格式表

export type VersionCommand = { command: 'requestPackFormats' }

// 语法预览

export interface SyntaxField {
  name: string
  detail: string
  example?: string
}

export interface SyntaxImage {
  label: string
  width: number
  height: number
  data: ArrayBuffer
}

export interface SyntaxTextRun {
  font?: string
  text: string
  color?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  obfuscated?: boolean
}

export interface SyntaxText {
  label: string
  lines: SyntaxTextRun[][]
  // 用等宽像素字预览游戏文本
  pixelSize: number
}

export interface SyntaxPackEntry {
  title: string
  icon?: SyntaxImage
  description: SyntaxTextRun[][]
}

export interface SyntaxPreviewMessage {
  canApplyFamily?: boolean
  glyphs?: import('../core/fontGlyphs').FontGlyph[]
  command: 'syntax'
  fileName: string
  kind: string
  title: string
  packEntry?: SyntaxPackEntry
  effectTitle?: string
  effectLines: string[]
  images: SyntaxImage[]
  text?: SyntaxText[]
  fieldsTitle: string
  fields: SyntaxField[]
  notes: string[]
}

export type SyntaxCommand = { command: 'copyFontGlyph'; char: string; font: string } | { command: 'syntaxReady' } | { command: 'openInBlockbench' | 'pickFontGlyph' | 'createFontTemplate' | 'applyJsonFamily' }

// ---------- 教程页 ----------

export type TutorialCommand =
  | { command: 'dismissForever' }
  | { command: 'close' }
  | { command: 'run'; id: string }

export type HostCommand = PixelLiveCommand | PixelCommand | TutorialCommand | PreviewCommand | VersionCommand | SyntaxCommand

