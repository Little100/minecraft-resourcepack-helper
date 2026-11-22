import * as vscode from 'vscode'

// 集中注册菜单与视图的条件键, 避免字符串散落各处
export const CONTEXT_KEYS = {
  hasResourcepack: 'mcrh.hasResourcepack',
  packCount: 'mcrh.packCount',
  currentIsPng: 'mcrh.currentIsPng',
  currentIsAnimatedTexture: 'mcrh.currentIsAnimatedTexture'
} as const

export async function setContext(key: string, value: unknown): Promise<void> {
  await vscode.commands.executeCommand('setContext', key, value)
}

// 激活时给出键的初值, 防止 when 子句求值为 undefined
export async function initContextKeys(): Promise<void> {
  await setContext(CONTEXT_KEYS.hasResourcepack, false)
  await setContext(CONTEXT_KEYS.packCount, 0)
  await setContext(CONTEXT_KEYS.currentIsPng, false)
  await setContext(CONTEXT_KEYS.currentIsAnimatedTexture, false)
}
