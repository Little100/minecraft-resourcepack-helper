import { uiText } from '../i18n/messages'
import * as vscode from 'vscode'
import { resolveNamespace } from './namespace'

export interface RuntimeConfig {
  defaultNamespace: string
  animationFrametime: number
  hideTutorialOnStart: boolean
}

const SECTION = 'mcrh'

let warnedNamespace: string | undefined

export function runtimeConfig(): RuntimeConfig {
  const config = vscode.workspace.getConfiguration(SECTION)
  const frametime = config.get<number>('animationFrametime', 4)
  const configuredNamespace = config.get<string>('defaultNamespace')
  const { namespace, problem } = resolveNamespace(configuredNamespace)
  reportNamespaceProblem(configuredNamespace, problem)
  return {
    defaultNamespace: namespace,
    animationFrametime: Number.isFinite(frametime) && frametime > 0 ? Math.round(frametime) : 4,
    hideTutorialOnStart: config.get<boolean>('hideTutorialOnStart') ?? false
  }
}

// 同一无效设置只提示一次，设置恢复有效后重新计数
function reportNamespaceProblem(configured: string | undefined, problem: string | undefined): void {
  if (problem === undefined) {
    warnedNamespace = undefined
    return
  }
  if (configured === warnedNamespace) return
  warnedNamespace = configured
  void vscode.window.showWarningMessage(uiText("core.config.mcrhDefaultnamespaceValueInvalidReturnedToMincraft", configured, problem))
}
