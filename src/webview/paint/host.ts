import { LIVE_PREVIEW_INTERVAL, MAX_LIVE_PREVIEW_BYTES, type RgbaRect } from '../messages'
import { extractRect } from './ops'
import { validateBindings } from './bindings'
import { createBus, onHostMessage } from '../bus'
import type { NoticeMessage, PixelCommand, PixelHostMessage } from '../messages'
import { applyLayers, applyPatch, applySnapshot, RECENT_COLOR_LIMIT, unionRect, type PaintState } from './state'

export interface HostListener {
  onSnapshot(sizeChanged: boolean): void
  onLayers(): void
  onPatch(): void
  onSettings?(): void
  onNotice(notice: NoticeMessage): void
}

export interface Host {
  post(command: PixelCommand): void
  previewStroke?(layerId: string, rect: RgbaRect): void
  cancelPreviewStroke?(): void
  saveRecentColors(colors: string[]): void
  loadRecentColors(): string[]
  savePreferences?(preferences: Record<string, unknown>): void
  loadPreferences?(): Record<string, unknown>
}

export function createHost(state: PaintState, listener: HostListener): Host {
  const bus = createBus()
  let sequence = 0, live = false
  let coverage: { layerId: string; rect: RgbaRect } | undefined
  let tiles: Array<{ layerId: string; rect: RgbaRect }> = []
  let tiled = false
  let pending: { layerId: string; rect: RgbaRect } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancelPreviewStroke = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (pending || live) bus.post({ command: 'previewStrokeEnd', sequence: ++sequence })
    pending = undefined; coverage = undefined; tiles = []; tiled = false; live = false
  }
  const enqueueTiles = (patch: { layerId: string; rect: RgbaRect }): void => {
    const side = Math.max(1, Math.floor(Math.sqrt(MAX_LIVE_PREVIEW_BYTES / 4)))
    const left = Math.floor(patch.rect.x / side) * side, top = Math.floor(patch.rect.y / side) * side
    for (let y = top; y < patch.rect.y + patch.rect.height; y += side) {
      for (let x = left; x < patch.rect.x + patch.rect.width; x += side) {
        const rect = { x, y, width: Math.min(side, state.width - x), height: Math.min(side, state.height - y) }
        if (!tiles.some(tile => tile.layerId === patch.layerId && tile.rect.x === x && tile.rect.y === y)) tiles.push({ layerId: patch.layerId, rect })
      }
    }
  }
  const flushPreview = (): void => {
    timer = undefined
    const patch = pending
    pending = undefined
    if (patch) {
      if (tiled || patch.rect.width * patch.rect.height * 4 > MAX_LIVE_PREVIEW_BYTES) {
        tiled = true; coverage = undefined; enqueueTiles(patch)
      } else coverage = patch
    }
    const next = tiled ? tiles.shift() : patch
    if (next) {
      const layer = state.layers.find(value => value.id === next.layerId)
      if (!layer) { cancelPreviewStroke(); return }
      live = true
      bus.post({ command: 'previewStroke', sequence: ++sequence, layerId: next.layerId, rect: next.rect, pixels: extractRect(layer.pixels, state.width, next.rect) })
    }
    if (tiles.length || pending) timer = setTimeout(flushPreview, LIVE_PREVIEW_INTERVAL)
  }
  const previewStroke = (layerId: string, rect: RgbaRect): void => {
    if (rect.width <= 0 || rect.height <= 0) return
    if (pending && pending.layerId !== layerId || coverage && coverage.layerId !== layerId || tiles.some(tile => tile.layerId !== layerId)) cancelPreviewStroke()
    const previous = pending ?? coverage
    pending = { layerId, rect: previous ? unionRect(previous.rect, rect) : { ...rect } }
    if (!timer) timer = setTimeout(flushPreview, LIVE_PREVIEW_INTERVAL)
  }
  window.addEventListener('pagehide', cancelPreviewStroke)
  onHostMessage(data => {
    if (typeof data !== 'object' || data === null) return
    const message = data as PixelHostMessage
    switch (message.command) {
      case 'paintSettings':
        state.keybindings = validateBindings(message.keybindings).bindings
        listener.onSettings?.()
        window.dispatchEvent(new Event('mcrh-paint-settings'))
        return
      case 'snapshot':
        cancelPreviewStroke()
        listener.onSnapshot(applySnapshot(state, message))
        return
      case 'layers':
        cancelPreviewStroke()
        applyLayers(state, message)
        listener.onLayers()
        return
      case 'patch':
        cancelPreviewStroke()
        applyPatch(state, message)
        listener.onPatch()
        return
      case 'notice':
        listener.onNotice(message)
        return
      default:
        return
    }
  })
  return {
    post: command => { cancelPreviewStroke(); bus.post(command) },
    previewStroke,
    cancelPreviewStroke,
    saveRecentColors: colors => bus.setState({ ...record(bus.getState()), recentColors: colors.slice(0, RECENT_COLOR_LIMIT) }),
    savePreferences: preferences => bus.setState({ ...record(bus.getState()), preferences: { ...record(record(bus.getState()).preferences), ...preferences } }),
    loadPreferences: () => record(record(bus.getState()).preferences),
    loadRecentColors: () => readRecentColors(bus.getState())
  }
}

function readRecentColors(saved: unknown): string[] {
  if (typeof saved !== 'object' || saved === null) return []
  const list = (saved as { recentColors?: unknown }).recentColors
  if (!Array.isArray(list)) return []
  return list.filter((item): item is string => typeof item === 'string').slice(0, RECENT_COLOR_LIMIT)
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
