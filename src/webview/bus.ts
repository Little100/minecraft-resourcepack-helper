import { uiText } from '../i18n/messages'
import type { HostCommand } from './messages'

export interface Bus {
  post: (command: HostCommand) => void
  /** 记录 webview 状态, 重新加载后仍可恢复 */
  setState: (state: unknown) => void
  getState: () => unknown
}

export interface WebviewAssets {
  /** 扩展图标 svg 的 webview 地址 */
  logo: string
}

export function createBus(): Bus {
  const acquired = (globalThis as unknown as { acquireVsCodeApi?: () => { postMessage: (m: unknown) => void } }).acquireVsCodeApi
  if (typeof acquired !== 'function') {
    throw new Error(uiText("webview.bus.theCurrentEnvironmentIsNotVscodeWebview"))
  }
  const api = acquired() as { postMessage: (m: unknown) => void; getState?: () => unknown; setState?: (s: unknown) => void }
  return {
    post: command => api.postMessage(command),
    setState: state => api.setState?.(state),
    getState: () => api.getState?.()
  }
}

export function onHostMessage(handler: (message: unknown) => void): void {
  // 扩展消息的 source 为空，不能按窗口过滤
  window.addEventListener('message', event => handler(event.data))
}

export function webviewAssets(): WebviewAssets {
  const injected = (globalThis as unknown as { __MCRH__?: Partial<WebviewAssets> }).__MCRH__
  return { logo: injected?.logo ?? '' }
}
