import { uiText } from '../i18n/messages'
import { z } from 'zod'

export interface TextureWatermarkSettings { enabled: boolean; id?: string; keyHex?: string }
const settingsSchema = z.strictObject({ enabled: z.boolean(), id: z.string().regex(/^[0-9a-f]{8}$/i).optional(), keyHex: z.string().regex(/^(?:[0-9a-f]{2}){16,64}$/i).optional() })
export function parseTextureWatermarkSettings(value: unknown): { id: string; key: Uint8Array } | undefined {
  if (value === undefined || value === null) return undefined
  const settings = settingsSchema.parse(value)
  if (!settings.enabled) return undefined
  if (!settings.id || !settings.keyHex) throw new Error(uiText("core.textureWatermarkSettings.eightDigitHexadecimalMarkingsAndAtLeast"))
  return { id: settings.id.toLowerCase(), key: Uint8Array.from(settings.keyHex.match(/../g)!, byte => Number.parseInt(byte, 16)) }
}
