import { uiText } from '../i18n/messages'
import { z } from 'zod'
import { LAYER_NAME_MAX } from '../core/pixelCodec'
import { resourcePath, rectSchema, rgbaSchema } from './contracts'
import { paintOperationsSchema, paintPaletteSchema } from './texturePainting'

const revision = z.string().regex(/^[a-f0-9]{64}$/)
const file = { path: resourcePath }
const edit = { ...file, expected_revision: revision }
const layerId = z.string().min(1).max(128)
const layerName = z.string().trim().min(1).max(LAYER_NAME_MAX)
export const operationSchemas = {
  collaboration_status: z.object({ offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(200).default(100) }).strict(),
  collaboration_submit: z.object({ title: z.string().trim().min(1).max(240), paths: z.array(resourcePath).min(1).max(2000).refine(values => new Set(values).size === values.length, uiText("mcp.toolSchemas.submitPathCannotBeRepeated")), expected_revision: revision }).strict(),
  list_resources: z.object({ prefix: z.string().max(2048).default(''), query: z.string().trim().max(512).optional().describe(uiText("mcp.toolSchemas.searchByPathEmptySeparatedKeywordsMatch")), offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(200).default(50) }).strict(),
  read_text: z.object({ ...file, offset: z.number().int().min(0).max(1024*1024).default(0), limit: z.number().int().min(256).max(48000).default(24000) }).strict(),
  get_texture: z.object({ ...file, layer_id: layerId.optional(), view: z.enum(['editor','game']).default('editor'), frame: z.number().int().min(0).optional(), crop: rectSchema.optional(), max_size: z.number().int().min(16).max(2048).default(1024), scale: z.number().int().min(1).max(16).default(8), include_pixels: z.boolean().optional().describe(uiText("mcp.toolSchemas.alsoReturnExactRgbaPaletteAndCharacter")) }).strict(),
  get_textures: z.object({ paths: z.array(resourcePath).min(1).max(12), view: z.enum(['editor','game']).default('editor'), max_size: z.number().int().min(16).max(512).default(256) }).strict(),
  context: z.object({}).strict(),
  references: z.object({ ...file, action: z.enum(['list','view']).default('list'), id: z.string().uuid().optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20), max_size: z.number().int().min(16).max(1024).default(512) }).strict(),
  create_texture: z.object({ ...file, width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192), frame_height: z.number().int().min(1).max(8192).optional(), dry_run: z.boolean().default(true) }).strict(),
  batch_texture: z.object({ targets: z.array(z.object({ ...edit, layer_id: layerId.optional() }).strict()).min(1).max(12), layer_name: layerName.optional(), clear: z.boolean().default(false), palette: paintPaletteSchema, operations: paintOperationsSchema, dry_run: z.boolean().default(true) }).strict(),
  resize_texture: z.object({ ...edit, width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192), mode: z.enum(['scale','canvas']).default('scale'), per_frame: z.boolean().default(true) }).strict(),
  texture_frames: z.object({ ...edit, frame_height: z.number().int().min(1).max(8192), order: z.array(z.number().int().min(-1).max(8191)).min(1).max(8192) }).strict(),
  open_editor: z.object(file).strict(),
  edit_pixels: z.object({ ...edit, layer_id: layerId, pixels: z.array(z.object({ x: z.number().int().min(0), y: z.number().int().min(0), rgba: rgbaSchema }).strict()).max(16384).default([]), fills: z.array(rectSchema.extend({ rgba: rgbaSchema })).max(128).default([]) }).strict(),
  paint_texture: z.object({ ...edit, layer_id: layerId.optional(), layer_name: layerName.optional(), clear: z.boolean().default(false).describe(uiText("mcp.toolSchemas.defaultToKeepOriginalPixelsOnlyExplicitly")), palette: paintPaletteSchema, operations: paintOperationsSchema }).strict(),
  texture_history: z.object({ ...file, action: z.enum(['list','restore']).default('list'), entry_id: z.number().int().min(1).optional(), expected_revision: revision.optional() }).strict(),
  edit_layers: z.object({ ...edit, action: z.enum(['add','delete','rename','visibility','opacity','move']), layer_id: layerId.optional(), name: layerName.optional(), visible: z.boolean().optional(), opacity: z.number().min(0).max(1).optional(), index: z.number().int().min(0).max(127).optional() }).strict(),
  transform_layers: z.object({ ...edit, layer_ids: z.array(layerId).min(1).max(128), x: z.number().int().min(-8192).max(8192), y: z.number().int().min(-8192).max(8192), width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192), rotation: z.number().min(-360000).max(360000).default(0) }).strict(),
  recolor_edges: z.object({ ...edit, layer_ids: z.array(layerId).min(1).max(128), mode: z.enum(['darken','lighten','bevel','transition']).default('transition'), radius: z.number().int().min(1).max(8).default(1), strength: z.number().min(0).max(1).default(.35), selection: rectSchema.optional(), selection_expansion: z.number().int().min(0).max(8).default(0), sample_outside: z.boolean().default(true), sample_margin: z.number().int().min(1).max(4).default(1) }).strict(),
  write_json: z.object({ ...edit, expected_revision: z.union([revision,z.literal('missing')]), text: z.string().max(1024*1024) }).strict(),
  save_resource: z.object(edit).strict(),
  diagnose: z.object({ pack_root: z.string().max(2048).default(''), target_version: z.string().trim().min(1).max(64).optional(), max_issues: z.number().int().min(1).max(200).default(100) }).strict(),
  git_status: z.object({}).strict()
} as const
export type ToolOperation = keyof typeof operationSchemas
