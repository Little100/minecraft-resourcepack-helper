import type { NoticeMessage } from '../messages'
import type { Rgba } from '../painting'
import type { Host } from './host'
import { pushRecentColor, type PaintState } from './state'

export interface Hover {
  pointerType?: string
  pressure?: number
  buttons?: number
  altKey?: boolean
  point?: [number, number]
  client?: [number, number]
}

export interface Modifiers {
  space: boolean
}

export interface App {
  readonly state: PaintState
  readonly host: Host
  readonly scroller: HTMLElement
  readonly hover: Hover
  readonly modifiers: Modifiers
  requestRender(): void
  requestChrome(): void
  notify(text: string, level: NoticeMessage['level']): void
  zoomTo(zoom: number, anchor?: [number, number]): void
  openShortcuts?(): void
  openEdgeRecolor?(): void
  openScatter?(): void
  hasPendingTransform?(): boolean
  openImageEditing?(): void
  togglePanels?(): void
  fitWindow(): void
}

// 同一帧内的多次重绘请求合并为一次, 避免指针移动时反复布局
export function createScheduler(render: () => void): () => void {
  let pending = false
  return () => {
    if (pending) return
    pending = true
    requestAnimationFrame(() => {
      pending = false
      render()
    })
  }
}

export function rememberColor(app: App, color: Rgba): void {
  app.state.recentColors = pushRecentColor(app.state.recentColors, color)
  app.host.saveRecentColors(app.state.recentColors)
}
