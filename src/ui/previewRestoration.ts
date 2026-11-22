import { activeLanguage } from '../i18n/messages'
import { localeTags } from '../i18n/locale'
import { uiHtml, uiText } from '../i18n/messages'
import * as path from 'node:path'
import * as vscode from 'vscode'
import type { PreviewSession } from '../core/previewSession'
import { PreviewPanel } from './previewPanel'
import { SyntaxPreviewPanel } from './syntaxPreview'
import { VanillaPreviewPanel } from './vanillaPreviewPanel'
import { GuiPreviewPanel } from './guiPreviewPanel'
import { extensionLog } from './extensionLog'

export function readPreviewSession(value: unknown, kind: PreviewSession['kind']): PreviewSession | undefined {
  if (!value || typeof value !== 'object') return undefined
  const session = (value as { mcrhPreview?: PreviewSession }).mcrhPreview
  if (!session || session.kind !== kind || typeof session.source !== 'string' || session.source.length > 4096 || session.source.includes('\0') || !path.isAbsolute(session.source)) return undefined
  if (session.following !== undefined && typeof session.following !== 'boolean') return undefined
  if (session.selected !== undefined && (typeof session.selected !== 'string' || session.selected.length > 1024 || !/^assets\/[a-z0-9_.-]+\/textures\/.+\.png$/.test(session.selected) || session.selected.split('/').some(part => part === '..' || part === '.') || session.selected.includes('\\') || session.selected.includes('\0'))) return undefined
  if (session.scene !== undefined && typeof session.scene !== 'string') return undefined
  if (kind !== 'gui' && !/\.(?:png|json|mcmeta)$/i.test(session.source)) return undefined
  return session
}

export function registerPreviewRestoration(context: vscode.ExtensionContext): void {
  const entries: Array<[string, PreviewSession['kind'], (panel: vscode.WebviewPanel, session: PreviewSession) => void | Promise<void>]> = [
    [PreviewPanel.viewType, 'texture', (panel, session) => PreviewPanel.restore(context, panel, session)],
    [SyntaxPreviewPanel.viewType, 'syntax', (panel, session) => SyntaxPreviewPanel.restore(context, panel, session)],
    ['mcrh.vanillaPreview', 'model', (panel, session) => VanillaPreviewPanel.restore(context, panel, session)],
    ['mcrh.guiPreview', 'gui', (panel, session) => GuiPreviewPanel.restore(context, panel, session)]
  ]
  for (const [viewType, kind, restore] of entries) context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(viewType, {
    async deserializeWebviewPanel(panel, value: unknown): Promise<void> {
      try {
        const session = readPreviewSession(value, kind)
        if (!session) throw new Error(uiText("ui.previewRestoration.thisPreviewDoesNotHaveAResource"))
        await restore(panel, session)
      } catch (error) {
        extensionLog('warn', uiText("ui.previewRestoration.synchronisingS", String(error)))
        panel.webview.html = `<!doctype html><html lang="${localeTags[activeLanguage().locale]}"><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;"><h2>${uiHtml("ui.previewRestoration.previewFailed")}</h2><p>${uiHtml("ui.previewRestoration.resourceMayHaveBeenMovedOrDeleted")}</p></html>`
      }
    }
  }))
}
