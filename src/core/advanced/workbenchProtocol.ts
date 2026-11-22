import { z } from 'zod'

const finite = z.number().finite()
export const WorkbenchMessage = z.discriminatedUnion('command', [
  z.object({ command: z.literal('ready') }),
  z.object({ command: z.literal('pick'), role: z.enum(['colormap', 'model', 'biome', 'pbr', 'skin', 'optimizer', 'samples', 'tiles', 'randomBase', 'pbrFolder']) }),
  z.object({ command: z.literal('cancel') }),
  z.object({ command: z.literal('editSkin') }),
  z.object({ command: z.literal('exportPackZip'), params: z.record(z.string(), z.unknown()) }),
  z.object({ command: z.literal('generate'), kind: z.enum(['tintPreset', 'colormap', 'biome', 'untint', 'ctm', 'natural', 'randomEntity', 'pbr', 'totem', 'shader', 'optimize', 'sample']), params: z.record(z.string(), z.unknown()) }),
  z.object({ command: z.literal('sampleColor'), temperature: finite, downfall: finite }),
  z.object({ command: z.literal('shaderPreview'), params: z.record(z.string(), z.unknown()), requestId: z.string().max(128).optional() }),
  z.strictObject({ command: z.literal('copyShaderCode'), requestId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/), text: z.string().min(1).max(256 * 1024) })
])
export type WorkbenchRequest = z.infer<typeof WorkbenchMessage>
export const textValue = (params: Record<string, unknown>, key: string, fallback?: string): string => z.string().max(1024).parse(params[key] ?? fallback)
export const numberValue = (params: Record<string, unknown>, key: string, fallback: number): number => finite.parse(params[key] ?? fallback)
