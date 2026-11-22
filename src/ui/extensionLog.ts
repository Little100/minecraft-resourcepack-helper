import { uiText } from '../i18n/messages'
import * as vscode from 'vscode'
import { redactDiagnosticText } from '../core/diagnosticText'
export { redactDiagnosticText } from '../core/diagnosticText'

type LogLevel = 'info' | 'warn' | 'error'
const MAX_LOG_LINES = 160
let channel: vscode.LogOutputChannel | undefined
const recent: string[] = []

export function initializeExtensionLog(context: vscode.ExtensionContext): void {
  if (channel) return
  recent.length = 0
  const created = vscode.window.createOutputChannel('MCRH', { log: true })
  channel = created
  context.subscriptions.push({ dispose() { if (channel === created) channel = undefined; created.dispose() } })
  const version: unknown = context.extension.packageJSON.version
  extensionLog('info', uiText("ui.extensionLog.extensionActivationMcrhVsCode", typeof version === 'string' ? version : uiText("ui.extensionLog.unknownVersion"), vscode.version, process.platform, process.arch))
}

export function extensionLog(level: LogLevel, message: string): void {
  const safe = redactDiagnosticText(message)
  recent.push(`${new Date().toISOString()} ${level.toUpperCase()} ${safe}`)
  if (recent.length > MAX_LOG_LINES) recent.shift()
  channel?.[level](safe)
}

export function showExtensionLog(): void {
  channel?.show(true)
}

export function recentExtensionLog(): string {
  return recent.join('\n')
}
