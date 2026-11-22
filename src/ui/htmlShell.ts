import { activeLanguage } from '../i18n/messages'
import { escapeMarkup, localeTags } from '../i18n/locale'
import { uiHtml, uiText } from '../i18n/messages'
import { previewSessionBootstrap } from '../core/previewSession'
import * as vscode from 'vscode'
import { trackWebviewDiagnostics, webviewDiagnosticBootstrap, type WebviewDiagnosticOwner, type WebviewPage } from './webviewDiagnostics'

type Page = WebviewPage

const TITLES: Record<Page, string> = {
  tutorial: uiText("ui.htmlShell.mcrhMaterialPackageAssistant"),
  paint: uiText("editor.mcrh.pixelEditor.name"),
  preview: uiText("ui.htmlShell.mcrhPastePreview"),
  syntax: uiText("ui.htmlShell.mcrhSyntaxPreview"),
  advanced: uiText("ui.advancedPanel.mcrhAdvancedMaterialsWorkbench"),
  vanillaPreview: uiText("ui.htmlShell.mcrhOriginalModelPreview"),
  diagnosis: uiText("ui.htmlShell.mcrhResourcePack"),
  guiPreview: uiText("ui.htmlShell.mcrhGuiHudPreview"),
  collaboration: uiText("ui.htmlShell.mcrhCollaborationAndReview"),
  gitWorkbench: uiText("ui.gitWorkbench.mcrhGitHistoryAndChange"),
  todos: 'MCRH TODO'
}

// CSP 收紧到 nonce 与自身扩展目录, 并禁止内联事件属性; 公共样式与图标字体随每个页面一起加载
export function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri, page: Page, owner?: WebviewDiagnosticOwner): string {
  const nonce = newNonce()
  const diagnosticId = trackWebviewDiagnostics(webview, page, owner)
  const base = vscode.Uri.joinPath(extensionUri, 'out', 'webview')
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(base, `${page}.js`))
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(base, `${page}.css`))
  const baseStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'base.css'))
  const iconStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'codicon.css'))
  const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'logo.png'))
  const csp = [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    `img-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `connect-src ${webview.cspSource}`
  ].join('; ')
  // 资源地址以 JSON 注入, 转义 < 防止地址中出现的字符提前闭合 script 标签
  const assets = JSON.stringify({ logo: logoUri.toString(), modelAssets: webview.asWebviewUri(vscode.Uri.joinPath(base, 'model-assets.zip')).toString(), blocklyMedia: webview.asWebviewUri(vscode.Uri.joinPath(base, 'blockly-media')).toString() }).replace(/</g, '\\u003c')
  return `<!DOCTYPE html>
<html lang="${localeTags[activeLanguage().locale]}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeMarkup(TITLES[page])}</title>
<script nonce="${nonce}">window.__MCRH_LANGUAGE__ = ${JSON.stringify(activeLanguage()).replace(/</g, '\\u003c')};
window.__MCRH__ = ${assets};
${webviewDiagnosticBootstrap(diagnosticId, page)}
${previewSessionBootstrap(page)}</script>
<link rel="stylesheet" href="${iconStyleUri}">
<link rel="stylesheet" href="${baseStyleUri}">
<link rel="stylesheet" href="${styleUri}">
<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(base, 'workspacePanels.css'))}">
${page === 'advanced' ? `<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(base, 'blockly.css'))}"><link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(base, 'sceneWorkbench.css'))}">` : ''}
</head>
<body>
<noscript>${uiHtml("ui.htmlShell.thisPageNeedsToEnableScript")}</noscript>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
}

function newNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
