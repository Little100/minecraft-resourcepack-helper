import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as vscode from 'vscode'
import { languageGlobals, resolveLocale, type UiLocale } from '../i18n/locale'
import { selectLanguage, uiText } from '../i18n/messages'

function load(locale: UiLocale): unknown {
  try { return JSON.parse(readFileSync(join(__dirname, '..', 'locales', locale + '.json'), 'utf8')) }
  catch { return undefined }
}

const configured = vscode.workspace.getConfiguration('mcrh').get<string>('interfaceLanguage', 'zh_cn')
const locale = resolveLocale(configured === 'auto' ? vscode.env.language : configured)
languageGlobals.__MCRH_LANGUAGE__ = selectLanguage(locale, load(locale), locale === 'zh_cn' ? undefined : load('zh_cn'))

export function watchInterfaceLanguage(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async event => {
    if (!event.affectsConfiguration('mcrh.interfaceLanguage')) return
    const reload = uiText('language.reload')
    if (await vscode.window.showInformationMessage(uiText('language.changed'), reload) === reload) await vscode.commands.executeCommand('workbench.action.reloadWindow')
  }))
}
