import { uiText } from '../i18n/messages'
import * as vscode from 'vscode'
import { extensionLog, recentExtensionLog, redactDiagnosticText, showExtensionLog } from './extensionLog'
import { automaticWebviewRepairAvailable, startAutomaticWebviewRepair } from './webviewRecovery'

export const WEBVIEW_DIAGNOSTIC_COMMAND = '__mcrhWebviewDiagnostic'
export const WEBVIEW_WATCHDOG_MS = 15000
export const WEBVIEW_DIAGNOSTIC_COMMANDS = {
  logs: 'mcrh.showLogs',
  view: 'mcrh.showWebviewDiagnostics',
  export: 'mcrh.exportWebviewDiagnostics',
  reloadAdvice: 'mcrh.webviewReloadAdvice',
  recover: 'mcrh.recoverWebviews'
} as const

// 每个面板各有协议，教程不会发送 ready
const READY_PROTOCOLS = {
  tutorial: null,
  paint: { command: 'ready' },
  preview: { command: 'previewReady' },
  syntax: { command: 'syntaxReady' },
  advanced: { command: 'ready' },
  vanillaPreview: { command: 'vanillaReady' },
  diagnosis: { command: 'diagnosisReady' },
  guiPreview: { command: 'guiReady' },
  collaboration: { command: 'ready' },
  gitWorkbench: { command: 'gitWorkbench', action: 'refresh' },
  todos: { command: 'todo', action: 'refresh' }
} as const
export type WebviewPage = keyof typeof READY_PROTOCOLS
export interface WebviewDiagnosticOwner { readonly onDidDispose: vscode.Event<void> }
type Phase = 'bootstrap' | 'bundleLoaded' | 'documentLoaded' | 'ready' | 'error' | 'unhandledrejection'
interface Session {
  id: string
  page: WebviewPage
  opened: string
  bootstrap: boolean
  bundleLoaded: boolean
  documentLoaded: boolean
  ready: boolean
  closed: boolean
  timedOut: boolean
  errors: string[]
  suppressed: number
  listener?: vscode.Disposable
  ownerListener?: vscode.Disposable
  timer?: ReturnType<typeof setTimeout>
}
const MAX_SESSIONS = 40
const MAX_ERRORS = 8
const phases = new Set<Phase>(['bootstrap', 'bundleLoaded', 'documentLoaded', 'ready', 'error', 'unhandledrejection'])
let sequence = 0
let sessions: Session[] = []
let byWebview = new WeakMap<vscode.Webview, Session>()
let active = false
let recoveryOffered = false
let recoveryRunning = false
let diagnosticContext: vscode.ExtensionContext | undefined

export function isWebviewDiagnosticMessage(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as Record<string, unknown>).command === WEBVIEW_DIAGNOSTIC_COMMAND
}

// 诊断消息和面板请求分开处理
export function onWebviewMessage<T>(webview: vscode.Webview, listener: (message: T) => unknown, thisArgs?: unknown, disposables?: vscode.Disposable[]): vscode.Disposable {
  return webview.onDidReceiveMessage((raw: T) => {
    if (!isWebviewDiagnosticMessage(raw)) listener.call(thisArgs, raw)
  }, undefined, disposables)
}

function stopWaiting(session: Session): void {
  if (session.timer !== undefined) clearTimeout(session.timer)
  session.timer = undefined
}

function release(session: Session): void {
  stopWaiting(session)
  session.listener?.dispose()
  session.ownerListener?.dispose()
  session.listener = undefined
  session.ownerListener = undefined
}

function hasResponded(session: Session): boolean {
  return session.ready || (READY_PROTOCOLS[session.page] === null && session.bundleLoaded && session.documentLoaded)
}

function needsRepair(session: Session): boolean {
  return !session.closed && session.timedOut && !hasResponded(session)
}

function explanation(session: Session): string {
  if (session.closed) return uiText("ui.webviewDiagnostics.pageReleasedStopWaiting")
  if (session.ready) return uiText("ui.webviewDiagnostics.aPageStartupProtocolHasBeenReceived")
  if (session.errors.length) return uiText("ui.webviewDiagnostics.frontendErrorReceivedForSpecificReasonsAs")
  if (READY_PROTOCOLS[session.page] === null && session.bundleLoaded && session.documentLoaded) return uiText("ui.webviewDiagnostics.scriptAndDocumentLoadedNoBusinessReady")
  if (!session.bootstrap) return uiText("ui.webviewDiagnostics.noBootstreamReceivedToConfirmWhetherThe")
  if (!session.bundleLoaded) return uiText("ui.webviewDiagnostics.bootstreamIsRunningPageScriptLoadingHas")
  return uiText("ui.webviewDiagnostics.pageScriptIsLoadedButNoStartup")
}

function receive(session: Session, raw: unknown): void {
  if (!isWebviewDiagnosticMessage(raw) || session.closed) return
  const data = raw as Record<string, unknown>
  if (data.sessionId !== session.id || typeof data.phase !== 'string' || !phases.has(data.phase as Phase)) return
  const phase = data.phase as Phase
  if (phase === 'error' || phase === 'unhandledrejection') {
    if (typeof data.message !== 'string' || data.message.length > 4096) return
    const location = Number.isSafeInteger(data.line) && Number.isSafeInteger(data.column) ? `; line=${data.line}; column=${data.column}` : ''
    const detail = redactDiagnosticText(`${phase}: ${data.message}${location}${typeof data.stack === 'string' ? ' ' + data.stack.slice(0, 3072) : ''}`)
    if (session.errors.includes(detail)) return
    if (session.errors.length >= MAX_ERRORS) {
      if (++session.suppressed === 1) extensionLog('warn', uiText("ui.webviewDiagnostics.webviewFollowUpErrorRestricted", session.page, session.id))
      return
    }
    session.errors.push(detail)
    extensionLog('error', `(Webview ${session.page}/${session.id} ${detail})`)
    return
  }
  if (phase === 'ready') {
    if (session.ready || !session.bootstrap || READY_PROTOCOLS[session.page] === null) return
    session.ready = true
    stopWaiting(session)
    extensionLog('info', `(Webview ready ${session.page}/${session.id}${session.timedOut ? uiText("ui.webviewDiagnostics.timeoutAfterArrival") : ''})`)
    return
  }
  if (session[phase]) return
  session[phase] = true
  if (READY_PROTOCOLS[session.page] === null && session.bundleLoaded && session.documentLoaded) {
    stopWaiting(session)
    extensionLog('info', uiText("ui.webviewDiagnostics.webviewLoadedNoBusinessReadyProtocolOn", session.page, session.id))
  }
}

export function trackWebviewDiagnostics(webview: vscode.Webview, page: WebviewPage, owner?: WebviewDiagnosticOwner): string {
  const id = String(++sequence)
  if (!active) return id
  const previous = byWebview.get(webview)
  if (previous) { previous.closed = true; release(previous) }
  const session: Session = { id, page, opened: new Date().toISOString(), bootstrap: false, bundleLoaded: false, documentLoaded: false, ready: false, closed: false, timedOut: false, errors: [], suppressed: 0 }
  byWebview.set(webview, session)
  sessions.push(session)
  if (sessions.length > MAX_SESSIONS) { const removed = sessions.shift()!; removed.closed = true; release(removed) }
  session.listener = webview.onDidReceiveMessage(raw => receive(session, raw))
  if (owner) session.ownerListener = owner.onDidDispose(() => { session.closed = true; release(session) })
  session.timer = setTimeout(() => {
    session.timer = undefined
    session.timedOut = true
    extensionLog('warn', uiText("ui.webviewDiagnostics.webviewWaitingForStartupTimeoutUseView", page, id, explanation(session), WEBVIEW_DIAGNOSTIC_COMMANDS.view))
    if (!session.closed && !recoveryOffered) {
      recoveryOffered = true
      void Promise.resolve(vscode.window.showInformationMessage(uiText("ui.webviewDiagnostics.mcrhPageDidNotRespondDuringThe"), uiText("ui.webviewDiagnostics.tryAutofixing"), uiText("ui.webviewDiagnostics.viewDiagnosis"))).then(async choice => {
        if (choice === uiText("ui.webviewDiagnostics.viewDiagnosis")) { await showReport(); return }
        if (choice !== uiText("ui.webviewDiagnostics.tryAutofixing") || !diagnosticContext) return
        if (!needsRepair(session)) { await vscode.window.showInformationMessage(uiText("ui.webviewDiagnostics.thePageHasBeenRespondedOrClosed")); return }
        await recoverWebviews(diagnosticContext, session)
      }).catch(error => extensionLog('warn', uiText("ui.webviewDiagnostics.webviewAutofixingAccessFailed", String(error))))
    }
  }, WEBVIEW_WATCHDOG_MS)
  session.timer.unref?.()
  extensionLog('info', uiText("ui.webviewDiagnostics.webviewOpenWaitingForStartupMs", page, id, WEBVIEW_WATCHDOG_MS))
  return id
}

// 共用同一个面板 API，避免重复获取失败
export function webviewDiagnosticBootstrap(sessionId: string, page: WebviewPage): string {
  const config = JSON.stringify({ sessionId, page, protocol: READY_PROTOCOLS[page], command: WEBVIEW_DIAGNOSTIC_COMMAND }).replace(/</g, '\\u003c')
  return `(() => {
  'use strict';
  const config = ${config};
  const acquire = window.acquireVsCodeApi;
  if (typeof acquire !== 'function') return;
  let api, shared, readySent = false, errors = 0, bundleLoaded = false;
  const scrub = ${redactDiagnosticText.toString()};
  const text = value => typeof value === 'string' ? scrub(value, 3072) : '(非文本错误原因)';
  const send = (phase, detail) => {
    try { getApi(); api.postMessage(Object.assign({ command: config.command, sessionId: config.sessionId, phase }, detail)); } catch {}
  };
  function getApi() {
    if (!api) api = acquire();
    if (!shared) shared = Object.freeze({
      postMessage(...args) {
        const result = api.postMessage(...args);
        const message = args[0], protocol = config.protocol;
        if (!readySent && protocol && message && typeof message === 'object' && message.command === protocol.command && (!protocol.action || message.action === protocol.action)) {
          readySent = true;
          send('ready');
        }
        return result;
      },
      getState(...args) { return api.getState(...args); },
      setState(...args) { return api.setState(...args); }
    });
    return shared;
  }
  try { window.acquireVsCodeApi = getApi; } catch { return; }
  if (window.acquireVsCodeApi !== getApi) return;
  window.addEventListener('error', event => {
    if (errors++ >= ${MAX_ERRORS + 1}) return;
    const target = event.target;
    if (target && target !== window && (target.src || target.href)) {
      send('error', { message: '资源加载失败: ' + text(target.src || target.href) });
    } else {
      send('error', { message: text(event.message), stack: event.error && typeof event.error.stack === 'string' ? text(event.error.stack) : '', source: text(event.filename), line: event.lineno, column: event.colno });
    }
  }, true);
  window.addEventListener('unhandledrejection', event => {
    if (errors++ >= ${MAX_ERRORS + 1}) return;
    try {
      const reason = event.reason;
      send('unhandledrejection', { message: typeof reason === 'string' ? text(reason) : reason && typeof reason.message === 'string' ? text(reason.message) : '(非文本拒绝原因)', stack: reason && typeof reason.stack === 'string' ? text(reason.stack) : '' });
    } catch { send('unhandledrejection', { message: '(拒绝原因无法读取)' }); }
  });
  document.addEventListener('load', event => {
    const target = event.target;
    if (!bundleLoaded && target && target.tagName === 'SCRIPT' && typeof target.src === 'string' && target.src.split(/[?#]/)[0].endsWith('/' + config.page + '.js')) {
      bundleLoaded = true;
      send('bundleLoaded');
    }
  }, true);
  document.addEventListener('DOMContentLoaded', () => send('documentLoaded'), { once: true });
  send('bootstrap');
})();`
}

export function webviewDiagnosticsReport(): string {
  const notes = [
    uiText("ui.webviewDiagnostics.mcrhWebviewDiagnostic"),
    uiText("ui.webviewDiagnostics.generatingTimeVsCode", new Date().toISOString(), vscode.version, process.platform, process.arch),
    uiText("ui.webviewDiagnostics.thisReportContainsOnlyLimitedDissensitizationRecords"),
    uiText("ui.webviewDiagnostics.couldNotRegisterServiceWorkerInvalidslateerrorDocument"),
    uiText("ui.webviewDiagnostics.noBootstreamOrReadyToProveService"),
    uiText("ui.webviewDiagnostics.afterPageStartupTimeoutTryToFix"),
    uiText("ui.webviewDiagnostics.precisionlySearchForErrorsInDevloperToggle"),
    uiText("ui.webviewDiagnostics.doNotReloadOrExitWithoutUser"),
    uiText("ui.webviewDiagnostics.pageRecord")
  ]
  for (const session of sessions) {
    notes.push(`(${session.page}/${session.id}; open=${session.opened}; bootstrap=${session.bootstrap}; bundleLoaded=${session.bundleLoaded}; documentLoaded=${session.documentLoaded}; ready=${session.ready}; timeout=${session.timedOut}; closed=${session.closed})`)
    notes.push((explanation(session)))
    for (const error of session.errors) notes.push((error))
    if (session.suppressed) notes.push(uiText("ui.webviewDiagnostics.thereSSomethingElseTheErrorIs", session.suppressed))
  }
  if (!sessions.length) notes.push(uiText("ui.webviewDiagnostics.thisSessionHasNotYetSeenThe"))
  notes.push(uiText("ui.webviewDiagnostics.recentMcrhLog"), recentExtensionLog() || uiText("ui.webviewDiagnostics.noRecordAvailable"))
  return notes.join('\n')
}

async function showReport(): Promise<void> {
  const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: webviewDiagnosticsReport() })
  await vscode.window.showTextDocument(document, { preview: false })
}

async function exportReport(): Promise<void> {
  const target = await vscode.window.showSaveDialog({ title: uiText("ui.webviewDiagnostics.exportMcrhWebviewDiagnosis"), saveLabel: uiText("ui.webviewDiagnostics.export"), filters: { [uiText("ui.webviewDiagnostics.diagnosisText")]: ['txt'] } })
  if (!target) return
  await vscode.workspace.fs.writeFile(target, Buffer.from(webviewDiagnosticsReport(), 'utf8'))
  extensionLog('info', uiText("ui.webviewDiagnostics.webviewDiagnosisExported"))
}

async function reloadAdvice(): Promise<void> {
  const choice = await vscode.window.showInformationMessage(uiText("ui.webviewDiagnostics.pleaseSaveAllFilesAndSubmitOr"), uiText("ui.webviewDiagnostics.viewDiagnosis"), uiText("ui.webviewDiagnostics.viewLog"))
  if (choice === uiText("ui.webviewDiagnostics.viewDiagnosis")) await showReport()
  if (choice === uiText("ui.webviewDiagnostics.viewLog")) showExtensionLog()
}

function hasUnsavedEditors(): boolean {
  return (vscode.workspace.textDocuments ?? []).some(document => document.isDirty) ||
    (vscode.window.tabGroups?.all ?? []).some(group => group.tabs.some(tab => tab.isDirty))
}

async function recoverWebviews(context: vscode.ExtensionContext, session?: Session): Promise<void> {
  if (recoveryRunning) { await vscode.window.showInformationMessage(uiText("ui.webviewDiagnostics.autoRepairIsAlreadyUnderWayPlease")); return }
  recoveryRunning = true
  try {
    const automatic = automaticWebviewRepairAvailable(context)
    const actions = automatic ? [uiText("ui.webviewDiagnostics.autofix"), uiText("ui.webviewDiagnostics.backupCacheFix"), uiText("ui.webviewDiagnostics.reloadWindow"), uiText("ui.webviewDiagnostics.viewDiagnosis"), uiText("ui.webviewDiagnostics.viewLog")] : [uiText("ui.webviewDiagnostics.reloadWindow"), uiText("ui.webviewDiagnostics.viewDiagnosis"), uiText("ui.webviewDiagnostics.viewLog")]
    const description = automatic ? uiText("ui.webviewDiagnostics.autofixWillNormallyExitAndRestartThe") : uiText("ui.webviewDiagnostics.theCurrentEnvironmentCannotAutomaticallyRestartThe")
    const choice = await vscode.window.showInformationMessage(description, { modal: true }, ...actions)
    if (choice === uiText("ui.webviewDiagnostics.viewDiagnosis")) { await showReport(); return }
    if (choice === uiText("ui.webviewDiagnostics.viewLog")) { showExtensionLog(); return }
    if (![uiText("ui.webviewDiagnostics.autofix"), uiText("ui.webviewDiagnostics.backupCacheFix"), uiText("ui.webviewDiagnostics.reloadWindow")].includes(choice ?? '')) return
    if (session && !needsRepair(session)) { await vscode.window.showInformationMessage(uiText("ui.webviewDiagnostics.thePageHasBeenRespondedOrClosed")); return }
    if (hasUnsavedEditors()) { await vscode.window.showInformationMessage(uiText("ui.webviewDiagnostics.thereAreStillUnsavedFilesSaveOr")); return }
    if (choice === uiText("ui.webviewDiagnostics.reloadWindow")) {
      extensionLog('info', uiText("ui.webviewDiagnostics.userHasTakenTheInitiativeToReload"))
      await vscode.commands.executeCommand('workbench.action.reloadWindow')
    } else if (automatic) await startAutomaticWebviewRepair(context, choice === uiText("ui.webviewDiagnostics.backupCacheFix"), () => (!session || needsRepair(session)) && !hasUnsavedEditors())
  } finally { recoveryRunning = false }
}

function diagnosticCommand(action: () => unknown): () => Promise<void> {
  return async () => {
    try { await action() } catch (error) {
      extensionLog('error', uiText("ui.webviewDiagnostics.webviewDiagnosticCommandFailed", error instanceof Error ? error.message : uiText("ui.webviewDiagnostics.operationNotCompleted")))
      await vscode.window.showErrorMessage(uiText("ui.webviewDiagnostics.theDiagnosticCommandIsNotCompleteSee"))
    }
  }
}

export function registerWebviewDiagnostics(context: vscode.ExtensionContext): void {
  if (active) return
  active = true
  diagnosticContext = context
  context.subscriptions.push(
    vscode.commands.registerCommand(WEBVIEW_DIAGNOSTIC_COMMANDS.logs, diagnosticCommand(showExtensionLog)),
    vscode.commands.registerCommand(WEBVIEW_DIAGNOSTIC_COMMANDS.view, diagnosticCommand(showReport)),
    vscode.commands.registerCommand(WEBVIEW_DIAGNOSTIC_COMMANDS.export, diagnosticCommand(exportReport)),
    vscode.commands.registerCommand(WEBVIEW_DIAGNOSTIC_COMMANDS.reloadAdvice, diagnosticCommand(reloadAdvice)),
    vscode.commands.registerCommand(WEBVIEW_DIAGNOSTIC_COMMANDS.recover, diagnosticCommand(() => recoverWebviews(context))),
    { dispose() { active = false; recoveryOffered = false; recoveryRunning = false; diagnosticContext = undefined; for (const session of sessions) release(session); sessions = []; byWebview = new WeakMap() } }
  )
}
