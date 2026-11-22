import { listBindingActions, normalizeBinding, isReservedBinding } from '../webview/paint/bindings'
import type { PixelCommand } from '../webview/messages'
import { isArrayBuffer } from './pixelCodec'

// 只校验字段的类型与结构, 越界与长度等语义校验留给文档模型
function isRect(value: unknown): value is { x: number; y: number; width: number; height: number } {
  if (!value || typeof value !== 'object') return false
  const rect = value as Record<string, unknown>
  return typeof rect.x === 'number' && typeof rect.y === 'number' &&
    typeof rect.width === 'number' && typeof rect.height === 'number'
}

export function parsePixelCommand(raw: unknown): PixelCommand | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const msg = raw as Record<string, unknown>
  const layerId = typeof msg.layerId === 'string' ? msg.layerId : undefined
  switch (msg.command) {
    case 'setKeybindings': {
      const input = msg.bindings
      if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return undefined
      const allowed = new Set(listBindingActions().map(action => action.id))
      const entries = Object.getOwnPropertyDescriptors(input)
      if (Object.keys(entries).length > allowed.size) return undefined
      const bindings: Record<string, string> = {}
      for (const [id, value] of Object.entries(entries)) {
        if (!allowed.has(id as never) || value.get || value.set || typeof value.value !== 'string') return undefined
        const normalized = normalizeBinding(value.value)
        if (normalized === undefined || isReservedBinding(normalized)) return undefined
        bindings[id] = normalized
      }
      return { command: 'setKeybindings', bindings }
    }
    case 'restoreHistory':
      return Number.isSafeInteger(msg.id) ? { command: 'restoreHistory', id: Number(msg.id) } : undefined
    case 'editRandomVariant':
      return layerId !== undefined && ['enable', 'disable', 'duplicate', 'default', 'weight'].includes(String(msg.action)) && (msg.action !== 'weight' || Number.isSafeInteger(msg.weight) && Number(msg.weight) >= 0 && Number(msg.weight) <= 1_000_000)
        ? { command: 'editRandomVariant', layerId, action: msg.action as 'enable' | 'disable' | 'duplicate' | 'default' | 'weight', weight: msg.weight as number | undefined } : undefined
    case 'ready':
      return { command: 'ready' }
    case 'addLayer':
      return { command: 'addLayer' }
    case 'undo':
      return { command: 'undo' }
    case 'redo':
      return { command: 'redo' }
    case 'commit': {
      const { rect, pixels } = msg
      return layerId !== undefined && isRect(rect) && isArrayBuffer(pixels)
        ? { command: 'commit', layerId, rect, pixels }
        : undefined
    }
    case 'removeLayer':
      return layerId !== undefined ? { command: 'removeLayer', layerId } : undefined
    case 'setActiveLayer':
      return layerId !== undefined ? { command: 'setActiveLayer', layerId } : undefined
    case 'renameLayer':
      return layerId !== undefined && typeof msg.name === 'string'
        ? { command: 'renameLayer', layerId, name: msg.name }
        : undefined
    case 'moveLayer':
      return layerId !== undefined && typeof msg.toIndex === 'number'
        ? { command: 'moveLayer', layerId, toIndex: msg.toIndex }
        : undefined
    case 'setLayerVisible':
      return layerId !== undefined && typeof msg.visible === 'boolean'
        ? { command: 'setLayerVisible', layerId, visible: msg.visible }
        : undefined
    case 'setLayerOpacity':
      return layerId !== undefined && typeof msg.opacity === 'number'
        ? { command: 'setLayerOpacity', layerId, opacity: msg.opacity }
        : undefined
    case 'crop': {
      const { rect } = msg
      return isRect(rect) ? { command: 'crop', rect } : undefined
    }
    default:
      return undefined
  }
}
