import { uiText } from '../i18n/messages'
import { z } from 'zod'

export const MCP_BODY_BYTES = 2 * 1024 * 1024
export const projectSchema = z.object({ id: z.string().max(128), name: z.string().max(512), root: z.string().max(8192), editable: z.boolean() }).strict()
export type McpProject = z.infer<typeof projectSchema>
export const instanceSchema = z.object({ schema: z.literal(1), instanceId: z.string().uuid(), endpoint: z.string().url(), token: z.string().min(32).max(256), expiresAt: z.number(), projects: z.array(projectSchema).max(64) }).strict()
export type McpInstance = z.infer<typeof instanceSchema>
export const resourcePath = z.string().min(1).max(2048).refine(value => !value.includes('\\') && !value.startsWith('/') && !value.includes(':') && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.') && !/[\x00-\x1f]/.test(part)), uiText("mcp.contracts.requiresRelativeResourcePathsInTheWorkspace"))
export const rgbaSchema = z.tuple([z.number().int().min(0).max(255),z.number().int().min(0).max(255),z.number().int().min(0).max(255),z.number().int().min(0).max(255)])
export const rectSchema = z.object({x:z.number().int().min(0),y:z.number().int().min(0),width:z.number().int().min(1).max(8192),height:z.number().int().min(1).max(8192)}).strict()
export const operations = ['collaboration_status','collaboration_submit','describe','list_resources','read_text','get_texture','get_textures','context','references','create_texture','batch_texture','resize_texture','texture_frames','open_editor','edit_pixels','paint_texture','texture_history','edit_layers','transform_layers','recolor_edges','write_json','save_resource','diagnose','git_status'] as const
export type McpOperation = typeof operations[number]
export const bridgeCallSchema = z.object({projectId:z.string().max(128),operation:z.enum(operations),args:z.record(z.string(),z.unknown()).default({})}).strict()
export const editOperations = new Set<McpOperation>(['collaboration_submit','create_texture','batch_texture','resize_texture','texture_frames','edit_pixels','paint_texture','texture_history','edit_layers','transform_layers','recolor_edges','write_json','save_resource'])
