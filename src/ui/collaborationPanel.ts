import { uiText } from '../i18n/messages'
import { automaticP2PNetwork, OPL_PRESET_URL } from '../collaboration/p2pNetwork'
import { extensionLog, showExtensionLog } from './extensionLog'
import { verifyCollaborationConnection } from '../collaboration/connection'
import { PixelEditorProvider } from './pixelEditor'
import { operationSchemas } from '../mcp/toolSchemas'
import { onWebviewMessage } from './webviewDiagnostics'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as net from 'node:net'
import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'
import { getHtml } from './htmlShell'
import { CollaborationConnectionError, decodeInvitation, RemoteClient } from '../collaboration/client'
import { atomic, exists, hash, resourcePath, writeResource } from '../collaboration/files'
import { githubIdentity, identityPolicySchema } from '../collaboration/identity'
import { requireGit } from '../collaboration/history'
import { OpenP2P } from '../collaboration/openp2p'
import { selectOpenP2PExecutable } from './openp2pInstall'
import { selectCollaborationHostRoot } from './collaborationHostRoot'
import { copyCollaborationInvitation } from './collaborationInvitation'
import { CollaborationService } from '../collaboration/service'
import { CollaborationServer } from '../collaboration/server'
import { LocalWorkspace } from '../collaboration/workspace'
import { WorkspaceCollection, type RemotePack } from '../collaboration/workspaces'
import { configSchema, fail, type Manifest, type Member, type Proposal } from '../collaboration/types'

class CollaborationStateRefreshError extends Error {}

type OperationLane = 'session' | 'preview' | 'model' | 'local'
const OPERATIONS = {
  ready: [uiText("ui.collaborationPanel.loadCollaborationStatus"), 'session'], refresh: [uiText("ui.collaborationPanel.refreshCollaborationStatus"), 'session'], sync: [uiText("ui.collaborationPanel.autosyncUpstream"), 'session'],
  host: [uiText("ui.collaborationPanel.startService"), 'session'], connect: [uiText("ui.collaborationPanel.connectService"), 'session'], disconnect: [uiText("ui.collaborationPanel.disconnect"), 'session'],
  pack: [uiText("ui.collaborationPanel.toggleResourcePack"), 'session'], pull: [uiText("ui.collaborationPanel.selectRipResourcePacks"), 'session'], syncAll: [uiText("ui.collaborationPanel.synchronizeResourcePacks"), 'session'], submit: [uiText("ui.collaborationPanel.submitsTheSelectedChanges"), 'session'],
  review: [uiText("ui.collaborationPanel.reviewOfSelectedDocuments"), 'session'], resolve: [uiText("ui.collaborationPanel.dealingWithDocumentConflicts"), 'session'], discover: [uiText("ui.collaborationPanel.identificationResourcePack"), 'session'],
  members: [uiText("ui.collaborationPanel.managingMembershipAndCompetencies"), 'session'], settings: [uiText("ui.collaborationPanel.modifyServiceEndSettings"), 'session'], p2p: [uiText("ui.collaborationPanel.configureP2p"), 'session'],
  share: [uiText("ui.collaborationPanel.canNotOpenMessage"), 'session'], rotate: [uiText("ui.collaborationPanel.resetConnectionDocuments"), 'session'], audit: [uiText("ui.collaborationPanel.readOperationsRecords"), 'session'],
  preview: [uiText("ui.collaborationPanel.loadingFileDifferences"), 'preview'], model: [uiText("ui.collaborationPanel.prepareDPreview"), 'model'],
  follow: [uiText("ui.collaborationPanel.updateAutoFollowSettings"), 'local'], openLocal: [uiText("ui.collaborationPanel.canNotOpenMessage_56d75a"), 'local'], logs: [uiText("ui.collaborationPanel.viewExtensionLog"), 'local']
} as const satisfies Record<string, readonly [string, OperationLane]>
type CollaborationCommand = keyof typeof OPERATIONS
type Operation = { id: string; command: CollaborationCommand; label: string; lane: OperationLane; status: 'queued' | 'running' }
const MAX_PENDING_OPERATIONS = 32

export class CollaborationPanel {
  private static current?: CollaborationPanel
  private client?: RemoteClient
  private server?: CollaborationServer
  private service?: CollaborationService
  private workspace?: LocalWorkspace
  private workspaces?: WorkspaceCollection
  private syncAbort?: AbortController
  private tunnel?: OpenP2P
  private connectedP2PNode?: string
  private proposals: Proposal[] = []
  private packs: { id: string; name: string; revision: string }[] = []
  private packId?: string
  private timer?: ReturnType<typeof setInterval>
  private refreshAbort?: AbortController
  private pendingDisconnects = 0
  private readonly queues: Record<Exclude<OperationLane, 'local'>, Promise<void>> = { session: Promise.resolve(), preview: Promise.resolve(), model: Promise.resolve() }
  private readonly operations = new Map<string, Operation>()
  private operationSequence = 0
  private closing?: Promise<void>
  private closed = false
  private autoFollow = true
  private readonly disposables: vscode.Disposable[] = []
  static show(context: vscode.ExtensionContext): void {
    if (this.current) { this.current.panel.reveal(); return }
    const panel = vscode.window.createWebviewPanel('mcrh.collaboration', uiText("ui.collaborationPanel.collaborationAndReview"), vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')] })
    this.current = new CollaborationPanel(context, panel)
  }
  static async invokeMcp(root: string, operation: 'collaboration_status' | 'collaboration_submit', input: unknown, enabled: () => boolean): Promise<unknown> {
    const panel = this.current
    const args = operationSchemas[operation].parse(input)
    const authorize = (): void => { if (!enabled() || !vscode.workspace.isTrusted) fail(uiText("ui.collaborationPanel.projectMcpClosedOrUntrusted")) }
    authorize()
    if (!panel || panel.closed || !panel.workspace || !panel.client) {
      if (operation === 'collaboration_submit') fail(uiText("ui.collaborationPanel.pleaseConnectTheServiceToTheCollaboration"))
      return { connected: false, editable_locally: true, hint: uiText("ui.collaborationPanel.connectTheServiceEndToTheSelected"), untrusted_content: true }
    }
    const workspace = panel.workspace, client = panel.client, packId = panel.packId
    const relative = path.relative(path.resolve(root), path.resolve(workspace.root))
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) fail(uiText("ui.collaborationPanel.aCopyOfTheCurrentCollaborativeWork"))
    const previous = panel.queues.session
    const task = previous.catch(() => undefined).then(async () => {
      authorize(); panel.ensureOpen()
      if (panel.workspace !== workspace || panel.client !== client || panel.packId !== packId) fail(uiText("ui.collaborationPanel.collaborationConnectionOrWorkingCopyChangedRead"))
      const me = await client.request<{ role: string; status: string; identity: { id: string; login: string } }>('/v1/me')
      authorize(); panel.ensureOpen()
      if (me.status !== 'active') fail(uiText("ui.collaborationPanel.currentMembersHaveNotBeenAdmittedOr"))
      if (operation === 'collaboration_status') {
        const value = operationSchemas.collaboration_status.parse(args), status = await workspace.submission()
        return { connected: true, workspace_prefix: relative.replace(/\\/g, '/'), pack_id: packId, member: me, revision: status.revision, changes: status.paths.slice(value.offset, value.offset + value.limit), total_changes: status.paths.length, next_offset: value.offset + value.limit < status.paths.length ? value.offset + value.limit : null, conflicts: status.conflicts.slice(0, 200).map(conflict => ({ path: conflict.path })), total_conflicts: status.conflicts.length, submission: 'explicit', untrusted_content: true }
      }
      const value = operationSchemas.collaboration_submit.parse(args)
      const proposal = await workspace.submit(value.title, value.paths, value.expected_revision, async () => {
        authorize(); panel.ensureOpen()
        for (const relative of value.paths) {
          resourcePath(relative)
          const uri = vscode.Uri.file(path.join(workspace.root, relative))
          if ((vscode.workspace.textDocuments ?? []).some(document => document.isDirty && document.uri.toString() === uri.toString()) || (vscode.window.tabGroups?.all ?? []).some(group => group.tabs.some(tab => tab.isDirty && tab.input && typeof tab.input === 'object' && 'uri' in tab.input && (tab.input as vscode.TabInputCustom).uri?.toString() === uri.toString()))) fail(uiText("ui.collaborationPanel.saveTheSelectedResourceForUnsavedEditing", relative))
          if (PixelEditorProvider.findOpenModel(uri)?.hasLivePreview) fail(uiText("ui.collaborationPanel.thereAreStillUncompletedDrawingsOfSelected", relative))
        }
        authorize(); panel.ensureOpen()
      })
      const counts = { pending: 0, approved: 0, rejected: 0 }
      for (const change of proposal.changes) counts[change.decision]++
      panel.post({ type: 'notice', text: uiText("ui.collaborationPanel.mcpSubmittedOnItsOwnInitiativeThe", proposal.changes.length) })
      await panel.refresh().catch(() => undefined)
      return { proposal_id: proposal.id, pack_id: proposal.packId, title: proposal.title, decisions: counts, paths: proposal.changes.map(change => ({ path: change.path, decision: change.decision })), updated_upstream: counts.approved > 0, untrusted_content: true }
    })
    panel.queues.session = task.then(() => undefined, () => undefined)
    return task
  }
  private constructor(private readonly context: vscode.ExtensionContext, private readonly panel: vscode.WebviewPanel) {
    panel.webview.html = getHtml(panel.webview, context.extensionUri, 'collaboration', panel)
    onWebviewMessage(panel.webview, (message: unknown) => { void this.receive(message) }, undefined, this.disposables)
    panel.onDidDispose(() => { void this.close().catch(error => console.error(uiText("ui.collaborationPanel.collaborativeResourcesShutDownFailed"), error)) }, undefined, this.disposables)
    context.subscriptions.push({ dispose: () => { void this.close().catch(error => console.error(uiText("ui.collaborationPanel.collaborativeResourcesShutDownFailed"), error)) } })
  }
  private post(value: unknown): void {
    if (this.closed) return
    try { void Promise.resolve(this.panel.webview.postMessage(value)).catch(() => {}) } catch {}
  }
  private close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.refreshAbort?.abort(); this.syncAbort?.abort()
    if (CollaborationPanel.current === this) CollaborationPanel.current = undefined
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.disposables.forEach(disposable => disposable.dispose())
    this.closing = this.queues.session.then(() => this.disconnect())
    return this.closing
  }
  private ensureOpen(): void { if (this.closed) fail(uiText("ui.collaborationPanel.panelClosedOperationCanceled")) }
  private activity(operation: Operation, status: Operation['status'] | 'done', error?: string, warning?: string): void {
    this.post({ type: 'operation', id: operation.id, command: operation.command, label: operation.label, status, error, warning })
  }
  private enqueue(command: CollaborationCommand, message: Record<string, unknown>): Promise<void> {
    const [label, lane] = OPERATIONS[command]
    const id = typeof message.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(message.requestId) ? message.requestId : 'host-' + ++this.operationSequence
    const operation: Operation = { id, command, label, lane, status: 'queued' }
    if (this.operations.has(id)) { this.post({ type: 'notice', text: uiText("ui.collaborationPanel.theRequestIsAlreadyBeingProcessedPlease") }); return Promise.resolve() }
    if (this.operations.size >= MAX_PENDING_OPERATIONS) {
      const error = uiText("ui.collaborationPanel.pleaseTryAgainLater")
      this.post({ type: 'notice', error: true, text: error }); this.activity(operation, 'done', error)
      return Promise.resolve()
    }
    const client = this.client, workspace = this.workspace, packId = this.packId
    if (command === 'disconnect') { this.pendingDisconnects++; this.refreshAbort?.abort(); this.syncAbort?.abort() }
    this.operations.set(id, operation); this.activity(operation, 'queued')
    const run = async (): Promise<void> => {
      let failure: string | undefined, warning: string | undefined
      const started = Date.now()
      try {
        if (this.closed) return
        operation.status = 'running'; this.activity(operation, 'running')
        if (!['ready', 'refresh', 'sync'].includes(command)) extensionLog('info', uiText("ui.collaborationPanel.coordinationStart", label))
        if (!['ready', 'refresh', 'sync', 'host', 'connect', 'disconnect', 'follow'].includes(command) && client !== this.client) fail(uiText("ui.collaborationPanel.connectionHasChangedPleaseRedoThisIn"))
        if (['pull', 'submit', 'resolve'].includes(command) && packId !== this.packId) fail(uiText("ui.collaborationPanel.resourcePackChangedPleaseReSelectThe"))
        if (['submit', 'resolve'].includes(command) && workspace !== this.workspace) fail(uiText("ui.collaborationPanel.theWorkingCopyHasBeenChangedPlease"))
        await this.perform(command, message)
      } catch (error) {
        const detail = error instanceof Error ? error.message : uiText("ui.collaborationPanel.collaborationFailed")
        if (error instanceof CollaborationStateRefreshError && !['ready', 'refresh', 'sync'].includes(command)) warning = detail
        else failure = detail
        extensionLog(warning ? 'warn' : 'error', uiText("ui.collaborationPanel.collaborativeFailedSeeDetailsBySelectingMrch", (error instanceof CollaborationStateRefreshError ? uiText("ui.collaborationPanel.collaborativeStatusRefresh") : label), detail))
        this.post({ type: 'notice', error: !warning, warning: !!warning, text: detail })
      } finally {
        try { if (this.closed && lane === 'session') await this.disconnect() }
        catch (error) { failure ??= error instanceof Error ? error.message : uiText("ui.collaborationPanel.collaborativeResourcesShutDownFailed") }
        finally { if (!failure && !['ready', 'refresh', 'sync'].includes(command)) extensionLog('info', uiText("ui.collaborationPanel.coordinationCompleteTimeConsumingMs", label, (Date.now() - started))); if (command === 'disconnect') this.pendingDisconnects--; this.operations.delete(id); this.activity(operation, 'done', failure, warning) }
      }
    }
    const task = (lane === 'local' ? Promise.resolve() : this.queues[lane]).then(run)
    if (lane !== 'local') this.queues[lane] = task.catch(() => {})
    return task
  }
  private async trust(): Promise<void> {
    if (!vscode.workspace.isTrusted) fail(uiText("ui.collaborationPanel.pleaseTrustTheCurrentWorkingAreaCollaboration"))
    try { await requireGit() } catch (error) { const answer = await vscode.window.showErrorMessage(uiText("ui.collaborationPanel.collaborationRequiresTheInstallationOfGitAnd"), uiText("ui.collaborationPanel.openGitInstallPage")); if (answer) await vscode.env.openExternal(vscode.Uri.parse('https://git-scm.com/install/')); throw error }
  }
  private async folder(title: string): Promise<string | undefined> { return (await vscode.window.showOpenDialog({ title, canSelectFolders: true, canSelectFiles: false, canSelectMany: false }))?.[0]?.fsPath }
  private async startHost(customDirectory = false): Promise<void> {
    await this.trust(); const root = await selectCollaborationHostRoot(customDirectory); if (!root) return
    this.ensureOpen()
    const directory = path.join(this.context.globalStorageUri.fsPath, 'collaboration', 'servers', hash(await fs.realpath(root)).slice(0, 24))
    const previousConfig = await exists(path.join(directory, 'config.json')) ? configSchema.parse(JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'))) : { queryMode: 'github' as const, queryProxy: configSchema.shape.queryProxy.parse(undefined) }
    const query = await this.chooseIdentityPolicy(previousConfig); if (!query) return
    if (!await exists(path.join(directory, 'config.json'))) {
      const session = await vscode.authentication.getSession('github', ['read:user'], { createIfNone: true })
      const identity = await githubIdentity(session.accessToken, query)
      this.ensureOpen()
      await CollaborationService.initialize(directory, { root, ownerId: identity.id, ownerLogin: identity.login, ...query })
    }
    const config = configSchema.parse(JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8')))
    const connection = await vscode.window.showQuickPick([{ label: uiText("ui.collaborationPanel.onlyOnSite"), description: uiText("ui.collaborationPanel.p2pIsOnlyAvailableOnSiteNot"), host: '127.0.0.1', localOnly: true, useP2P: false }, { label: uiText("ui.collaborationPanel.p2pUuidCollaboration"), description: uiText("ui.collaborationPanel.automaticallyUseEmbeddedSinglePortOpenp2pTo"), host: '127.0.0.1', localOnly: false, useP2P: true }, { label: uiText("collaboration.connection.openPort"), description: uiText("ui.collaborationPanel.listenToAllIpv4InterfacesAndStill"), host: '0.0.0.0', localOnly: false, useP2P: false }], { title: uiText("ui.collaborationPanel.serviceEndListeningMode") }); if (!connection) return
    const portText = await vscode.window.showInputBox({ title: uiText("ui.collaborationPanel.servicePort"), value: String(config.port), prompt: uiText("ui.collaborationPanel.forDynamicDistributionFixedPortIsRecommended"), validateInput: value => /^\d+$/.test(value) && Number(value) <= 65535 ? undefined : uiText("ui.collaborationPanel.pleaseEnterTo") }); if (portText === undefined) return
    let p2p = connection.localOnly ? undefined : config.p2p
    if (connection.useP2P) {
      const executable = await selectOpenP2PExecutable(this.context); if (!executable) return
      const network = config.p2p ?? await this.acquireP2PNetwork(directory)
      this.ensureOpen()
      p2p = { ...network, executable, node: config.p2p?.node ?? 'mcrh-' + randomBytes(16).toString('base64url'), shareBandwidth: 0 }
    }
    await this.disconnect()
    this.ensureOpen()
    const service = new CollaborationService(directory)
    let server: CollaborationServer | undefined
    try {
      await service.open(); this.ensureOpen(); service.config.host = connection.host; service.config.port = Number(portText); service.config.p2p = p2p; service.config.queryMode = query.queryMode; service.config.queryProxy = query.queryProxy
      await atomic(path.join(directory, 'config.json'), JSON.stringify(service.config, null, 2)); this.ensureOpen()
      server = new CollaborationServer(service, undefined, extensionLog); await server.start(); this.ensureOpen()
      const client = new RemoteClient(server.invitation(), extensionLog); client.localKey = service.config.localControlKey
      extensionLog('info', uiText("ui.collaborationPanel.coordinationServiceEndValidationOfHttpsPortal"))
      await client.connect({ onProgress: message => extensionLog('info', uiText("ui.collaborationPanel.collaborationInHouseValidation", message)) }); this.ensureOpen(); this.service = service; this.server = server; this.client = client; await this.restoreWorkspaces(client)
    } catch (error) {
      try { await server?.stop() } catch (cleanup) { extensionLog('error', uiText("ui.collaborationPanel.coordinationCleanUpStoppingServiceFailure", (cleanup instanceof Error ? cleanup.message : uiText("collaboration.server.unknownError")))) }
      try { await service.close() } catch (cleanup) { extensionLog('error', uiText("ui.collaborationPanel.coordinationCleaningClosedStorageFailed", (cleanup instanceof Error ? cleanup.message : uiText("collaboration.server.unknownError")))) }
      throw error
    }
    this.packs = service.state.packs.map(({ files: _files, relative: _relative, ...pack }) => pack)
    this.post({ type: 'state', connected: true, hosted: true, me: { role: 'owner', status: 'active', identity: { id: service.config.ownerId, login: service.config.ownerLogin } }, packs: this.packs, proposals: [], members: [], changes: [], conflicts: [], autoFollow: this.autoFollow, port: server!.port, p2p: server!.p2p.status, p2pUuid: server!.p2p.node })
    this.beginPolling(); this.post({ type: 'notice', text: uiText("ui.collaborationPanel.theServiceHasStartedToCloseThis") })
  }
  private async connect(): Promise<void> {
    await this.trust()
    this.ensureOpen()
    const previous = await this.context.secrets.get('mcrh.collaboration.invitation'), text = await vscode.window.showInputBox({ title: uiText("ui.collaborationPanel.connectToACollaborativeServiceProvider"), prompt: uiText("ui.collaborationPanel.pasteFullMcrhConnectInformationProvidedPrivately"), password: true, value: previous ?? '', ignoreFocusOut: true }); if (!text) return
    const invitation = decodeInvitation(text), mode = invitation.p2p ? uiText("ui.collaborationPanel.p2pTunnel") : await vscode.window.showQuickPick(invitation.node ? [uiText("ui.collaborationPanel.p2pTunnel"), uiText("collaboration.connection.openPort")] : [uiText("collaboration.connection.openPort")], { title: uiText("core.optifine.schema.connection") }); if (!mode) return
    await this.disconnect()
    if (mode === uiText("ui.collaborationPanel.p2pTunnel")) {
      const executable = await selectOpenP2PExecutable(this.context); if (!executable) return
      const network = invitation.p2p ?? await this.acquireP2PNetwork()
      const localPort = await new Promise<number>((resolve, reject) => { const socket = net.createServer(); socket.once('error', reject); socket.listen(0, '127.0.0.1', () => { const address = socket.address(); const port = typeof address === 'object' && address ? address.port : 0; socket.close(() => resolve(port)) }) })
      this.ensureOpen()
      const tunnel = new OpenP2P(path.join(this.context.globalStorageUri.fsPath, 'collaboration', 'client-p2p'), extensionLog)
      try { await tunnel.start({ ...network, executable, node: 'mcrh-' + randomBytes(16).toString('base64url'), shareBandwidth: 0 }, localPort, { node: invitation.node!, port: invitation.p2p?.port ?? Number(new URL(invitation.url).port || 443) }); this.ensureOpen(); this.tunnel = tunnel }
      catch (error) { await tunnel.stop(); throw error }
      invitation.url = 'https://127.0.0.1:' + localPort
    }
    const client = new RemoteClient(invitation, extensionLog)
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: uiText("ui.collaborationPanel.mrchValidateCollaborativeConnections"), cancellable: true }, async (progress, token) => {
        const controller = new AbortController()
        const cancel = token.onCancellationRequested?.(() => controller.abort())
        try {
          if (token.isCancellationRequested) controller.abort()
          await verifyCollaborationConnection(client, { signal: controller.signal, p2p: mode === uiText("ui.collaborationPanel.p2pTunnel"), assertActive: () => { this.ensureOpen(); this.tunnel?.assertRunning() }, progress: message => progress.report({ message }), log: extensionLog })
        } finally { cancel?.dispose() }
      })
      const hello = await client.request<{ queryProxy: string | null; queryMode: string; serverControlledIdentity?: boolean }>('/v1/hello')
      if (!hello.serverControlledIdentity) fail(uiText("ui.collaborationPanel.thisServerHasNotYetSupportedThe"))
      const policy = identityPolicySchema.parse({ queryMode: hello.queryMode, queryProxy: hello.queryProxy })
      const channel = policy.queryMode === 'github' ? uiText("collaboration.identity.githubOfficial") : policy.queryMode === 'proxy' ? uiText("ui.collaborationPanel.mirror", policy.queryProxy) : uiText("ui.collaborationPanel.githubOfficialUsingMirrorImageAfterFailure", policy.queryProxy)
      const consent = await vscode.window.showWarningMessage(uiText("ui.collaborationPanel.githubAccessTokenWillBrieflyHandOver", channel, invitation.url, invitation.fingerprint), { modal: true }, uiText("ui.collaborationPanel.trustAndLogin")); if (!consent) { await this.disconnect(); return }
      this.ensureOpen(); const session = await vscode.authentication.getSession('github', ['read:user'], { createIfNone: true }); this.ensureOpen(); const result = await client.login(session.accessToken, policy)
      this.ensureOpen(); await this.context.secrets.store('mcrh.collaboration.invitation', text); this.ensureOpen()
      this.client = client; await this.restoreWorkspaces(client); this.connectedP2PNode = invitation.p2p ? invitation.node : undefined; this.beginPolling(); this.post({ type: 'notice', text: result.status === 'pending' ? uiText("ui.collaborationPanel.theApplicationForMembershipHasBeenSubmitted") : uiText("ui.collaborationPanel.authenticationCompletedConnected") })
    } catch (error) { await this.tunnel?.stop(); this.tunnel = undefined; throw error }
  }
  private beginPolling(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.closed) return
    const seconds = this.service?.config.pollSeconds ?? 30
    this.timer = setInterval(() => { void this.poll() }, seconds * 1000)
  }
  private poll(): Promise<void> {
    if (this.closed || !this.client || [...this.operations.values()].some(operation => operation.lane === 'session')) return Promise.resolve()
    return this.enqueue('sync', {})
  }
  private async disconnect(): Promise<void> {
    this.refreshAbort?.abort(); this.syncAbort?.abort()
    if (this.timer) clearInterval(this.timer)
    const tunnel = this.tunnel, server = this.server, service = this.service
    this.timer = undefined; this.connectedP2PNode = undefined; this.workspace = undefined; this.workspaces = undefined; this.client = undefined; this.tunnel = undefined; this.server = undefined; this.service = undefined; this.proposals = []; this.packs = []; this.packId = undefined
    this.post({ type: 'state', connected: false, packs: [], proposals: [], changes: [], conflicts: [], autoFollow: this.autoFollow })
    try { await tunnel?.stop() } finally { try { await server?.stop() } finally { await service?.close() } }
  }
  private async refresh(): Promise<void> {
    if (this.closed || this.pendingDisconnects > 0) return
    if (!this.client) { this.post({ type: 'state', connected: false, packs: [], proposals: [], changes: [], conflicts: [], autoFollow: this.autoFollow }); return }
    this.refreshAbort?.abort()
    const client = this.client, controller = new AbortController(), options = { signal: controller.signal }
    this.refreshAbort = controller
    const assertActive = (): void => { if (this.closed || this.client !== client || controller.signal.aborted) throw new CollaborationConnectionError(uiText("ui.collaborationPanel.statusRefreshedCancelled"), 'ABORT_ERR') }
    try {
      let me: { role: string; status: string; identity: { id: string; login: string } }
      try { me = await client.request('/v1/me', 'GET', undefined, options) } catch (error) { if (!this.server && error instanceof Error && 'statusCode' in error && [401, 403].includes(Number(error.statusCode))) { await this.disconnect(); await this.refresh() } throw error }
      assertActive()
      let members: Member[] = []
      const packs = me.status === 'active' ? await client.request<typeof this.packs>('/v1/packs', 'GET', undefined, options) : []
      assertActive()
      const proposals = me.status === 'active' ? await client.request<Proposal[]>('/v1/proposals', 'GET', undefined, options) : []
      assertActive()
      if (me.status === 'active' && me.role === 'owner') members = await client.request('/v1/members', 'GET', undefined, options)
      assertActive()
      this.packs = packs; this.proposals = proposals
      if (!this.packId || !packs.some(pack => pack.id === this.packId)) this.packId = packs[0]?.id
      this.workspace = this.workspaces?.get(this.packId) ?? (this.workspace?.info()?.packId === this.packId ? this.workspace : undefined)
      const local = await this.workspace?.changes(controller.signal)
      assertActive()
      this.post({ type: 'state', connected: true, hosted: !!this.server, me, packs: this.packs, proposals: this.proposals, members, packId: this.packId, workspace: this.workspace?.root, workspaces: this.workspaces?.entries() ?? [], checkoutRoot: this.workspaces?.parent, changes: local?.paths ?? [], conflicts: local?.conflicts ?? [], autoFollow: this.autoFollow, port: this.server?.port, p2p: this.server?.p2p.status ?? this.tunnel?.status, p2pUuid: this.server?.p2p.node ?? this.connectedP2PNode })
    } catch (error) { if (controller.signal.aborted && !(error instanceof Error && 'statusCode' in error)) throw new CollaborationConnectionError(uiText("ui.collaborationPanel.statusRefreshedCancelled"), 'ABORT_ERR'); throw error }
    finally { if (this.refreshAbort === controller) this.refreshAbort = undefined }
  }
  private async restoreWorkspaces(client: RemoteClient): Promise<void> {
    const collection = new WorkspaceCollection(path.join(this.context.globalStorageUri.fsPath, 'collaboration'), client)
    try { for (const warning of await collection.load()) this.post({ type: 'notice', text: warning, warning: true }) }
    catch { this.post({ type: 'notice', text: uiText("ui.collaborationPanel.couldNotCloseTemporaryFolderS"), warning: true }) }
    this.ensureOpen(); this.workspaces = collection
  }
  private async chooseIdentityPolicy(current: { queryMode: 'github' | 'proxy' | 'auto'; queryProxy: string }) {
    const choices = [{ label: uiText("collaboration.identity.githubOfficial"), queryMode: 'github' as const }, { label: uiText("ui.collaborationPanel.identityCheckMirror"), queryMode: 'proxy' as const }, { label: uiText("ui.collaborationPanel.officialPriorityUseMirrorsAfterFailure"), queryMode: 'auto' as const }]
    choices.sort((a, b) => Number(b.queryMode === current.queryMode) - Number(a.queryMode === current.queryMode))
    const choice = await vscode.window.showQuickPick(choices, { title: uiText("ui.collaborationPanel.serviceSideHarmonizationOfIdentificationMethods"), placeHolder: uiText("ui.collaborationPanel.theServiceUsesThisToVerifyAll") }); if (!choice) return
    let queryProxy = current.queryProxy
    if (choice.queryMode !== 'github') {
      const endpoint = await vscode.window.showInputBox({ title: uiText("ui.collaborationPanel.serviceIdQueryMirrorCompleteHttpsEndpoint"), value: queryProxy, prompt: uiText("ui.collaborationPanel.tokenYouMustTrustAndReturnGithub"), validateInput: value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash ? undefined : uiText("ui.collaborationPanel.pleaseEnterTheFullHttpsEndpointFor") } catch { return uiText("ui.collaborationPanel.pleaseEnterAValidHttpsFullEndpoint") } } }); if (endpoint === undefined) return
      queryProxy = endpoint
    }
    return { queryMode: choice.queryMode, queryProxy }
  }
  private async pull(): Promise<void> {
    if (!this.client) fail(uiText("ui.collaborationPanel.pleaseConnectToTheServiceFirst"))
    if (this.pendingDisconnects) return
    const me = await this.client.request<{ status: string }>('/v1/me')
    if (me.status !== 'active') fail(uiText("ui.collaborationPanel.applicationsForMembershipAreNotYetApproved"))
    this.packs = await this.client.request<RemotePack[]>('/v1/packs')
    if (!this.packs.length) fail(uiText("ui.collaborationPanel.noResourcePacksAvailableCheckServiceEnd"))
    const selected = await vscode.window.showQuickPick(this.packs.map(pack => ({ label: pack.name, description: this.workspaces?.get(pack.id) ? uiText("ui.collaborationPanel.rippedSyncable") : uiText("ui.collaborationPanel.notYetDrawn"), picked: true, pack })), { title: uiText("ui.collaborationPanel.selectTheResourcePackToDraw"), placeHolder: uiText("ui.collaborationPanel.multipleOrAllSelectableUsingASeparate"), canPickMany: true })
    if (!selected?.length) return
    this.ensureOpen()
    this.workspaces ??= new WorkspaceCollection(path.join(this.context.globalStorageUri.fsPath, 'collaboration'), this.client)
    const fresh = selected.filter(item => !this.workspaces!.get(item.pack.id))
    let existingRoot: string | undefined
    if (fresh.length) {
      if (selected.length === 1) {
        const layout = await vscode.window.showQuickPick([{ label: uiText("ui.collaborationPanel.createASeparateResourcePackDirectoryUnder"), existing: false }, { label: uiText("ui.collaborationPanel.useTheExistingPackageWorkingCopyDirectory"), description: uiText("ui.collaborationPanel.compatibleCopiesOfOldVersionsThatHave"), existing: true }], { title: uiText("ui.collaborationPanel.localWorkingCopyLayout") }); if (!layout) return
        if (layout.existing) { existingRoot = await this.folder(uiText("ui.collaborationPanel.selectTheCurrentWorkingCopyDirectoryOf")); if (!existingRoot) return }
      }
      if (!existingRoot) {
        const reuse = this.workspaces.parent ? await vscode.window.showQuickPick([{ label: uiText("ui.collaborationPanel.useLastParentDirectory"), description: this.workspaces.parent, reuse: true }, { label: uiText("ui.collaborationPanel.selectAnotherParentDirectory"), reuse: false }], { title: uiText("ui.collaborationPanel.resourcePackLocation") }) : undefined
        if (this.workspaces.parent && !reuse) return
        if (!reuse?.reuse) { const root = await this.folder(uiText("ui.collaborationPanel.selectAResourcePackParentDirectoryEach")); if (!root) return; await this.workspaces.selectParent(root) }
      }
    }
    await this.transfer(selected.map(item => item.pack), existingRoot)
  }
  private async transfer(packs: RemotePack[], existingRoot?: string): Promise<void> {
    const collection = this.workspaces; if (!collection || !packs.length || this.pendingDisconnects) return
    const controller = new AbortController(); this.syncAbort = controller
    let updated = 0, conflicts = 0, completed = 0, transferFailed = false
    const errors: string[] = [], successes: { pack: RemotePack; workspace: LocalWorkspace }[] = []
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: uiText("ui.collaborationPanel.mcrhPullingResourcePacks"), cancellable: true }, async (progress, token) => {
        const cancel = token.onCancellationRequested?.(() => controller.abort())
        try {
          if (token.isCancellationRequested) controller.abort()
          for (const pack of packs) {
            this.ensureOpen(); if (this.pendingDisconnects) controller.abort(); controller.signal.throwIfAborted()
            progress.report({ message: pack.name + uiText("ui.collaborationPanel.readingListOfResources") })
            extensionLog('info', uiText("ui.collaborationPanel.coordinationRaiseStartResourcePack", pack.id))
            try {
              const workspace = await collection.prepare(pack, existingRoot)
              const result = await workspace.sync(pack.id, { signal: controller.signal, onProgress: (count, total) => progress.report({ message: pack.name + uiText("ui.collaborationPanel.file") + count + '/' + total }) })
              await collection.register(pack.id, workspace)
              successes.push({ pack, workspace })
              updated += result.updated; conflicts += result.conflicts.length; completed++
              extensionLog('info', uiText("ui.collaborationPanel.coordinationRaiseResourcePackCompletedUpdatedA", pack.id, result.updated, result.conflicts.length))
            } catch (error) {
              if (controller.signal.aborted || this.closed) throw error
              const detail = error instanceof Error ? error.message : uiText("ui.collaborationPanel.pullFailed")
              errors.push(pack.name + '：' + detail); extensionLog('error', uiText("ui.collaborationPanel.coordinationRaiseResourcePackFailed", pack.id, detail))
            }
          }
        } finally { cancel?.dispose() }
      })
      const selected = collection.get(this.packId) ? undefined : successes[0]
      if (selected) this.packId = selected.pack.id
      this.workspace = collection.get(this.packId)
      this.post({ type: 'notice', error: !!errors.length, text: uiText("ui.collaborationPanel.completedResourcePackUpdateDocumentsReservationsConflict", completed, packs.length, updated, conflicts, (errors.length ? uiText("ui.collaborationPanel.pullTheFailedPackageToReSelect", errors.join('；')) : '')) })
      if (errors.length) throw new CollaborationStateRefreshError(uiText("ui.collaborationPanel.partialResourcePullFailedAndASuccessful", errors.join('；')))
    } catch (error) {
      transferFailed = true
      if (controller.signal.aborted) throw new CollaborationStateRefreshError(uiText("ui.collaborationPanel.rewriteCancelledAndACopyOfThe"))
      throw error
    } finally {
      if (this.syncAbort === controller) this.syncAbort = undefined
      if (!this.closed && !this.pendingDisconnects) {
        try { await this.refresh() }
        catch (error) {
          const detail = error instanceof Error ? error.message : uiText("ui.collaborationPanel.stateLoadingFailed")
          if (!transferFailed) throw new CollaborationStateRefreshError(uiText("ui.collaborationPanel.thePullOperationWasCompletedButThe", detail))
          extensionLog('warn', uiText("ui.collaborationPanel.coordinationRunUpOperationAfterUpdateFailed", detail))
        }
      }
    }
  }
  private selectedProposal(id: unknown): Proposal { return this.proposals.find(proposal => proposal.id === id) ?? fail(uiText("ui.collaborationPanel.pleaseSelectAValidSubmissionFirst")) }
  private async preview(id: unknown, relative: unknown): Promise<void> {
    if (!this.client || typeof relative !== 'string') fail(uiText("ui.collaborationPanel.previewRequestInvalid"))
    const client = this.client, proposal = this.selectedProposal(id), change = proposal.changes.find(value => value.path === relative) ?? fail(uiText("cli.collaboration.fileNotSubmitted"))
    const before = change.base ? await client.file(proposal.packId, proposal.baseRevision, relative) : null
    if (this.closed || this.client !== client) return
    const after = change.next ? await client.file(proposal.packId, proposal.commit, relative) : null
    if (this.closed || this.client !== client) return
    const image = /\.png$/i.test(relative) && [before, after].every(data => !data || data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    const text = /\.(?:json|mcmeta|properties|txt|lang|vsh|fsh|glsl|md|toml|yaml)$/i.test(relative)
    this.post({ type: 'preview', proposalId: proposal.id, path: relative, kind: image ? 'image' : text ? 'text' : 'binary', before: image ? before ? 'data:image/png;base64,' + before.toString('base64') : null : text ? before?.subarray(0, 2 * 1024 ** 2).toString('utf8') ?? null : null, after: image ? after ? 'data:image/png;base64,' + after.toString('base64') : null : text ? after?.subarray(0, 2 * 1024 ** 2).toString('utf8') ?? null : null, beforeSize: before?.length ?? 0, afterSize: after?.length ?? 0, truncated: text && Math.max(before?.length ?? 0, after?.length ?? 0) > 2 * 1024 ** 2 })
  }
  private async model(id: unknown, relative: unknown, side: unknown): Promise<void> {
    if (!this.client || typeof relative !== 'string' || !['before', 'after'].includes(String(side))) fail(uiText("ui.collaborationPanel.modelPreviewRequestInvalid"))
    const client = this.client, proposal = this.selectedProposal(id); if (!proposal.changes.some(change => change.path === relative)) fail(uiText("cli.collaboration.fileNotSubmitted"))
    const revision = side === 'before' ? proposal.baseRevision : proposal.commit, files = await client.request<Manifest>('/v1/versions', 'POST', { packId: proposal.packId, revision })
    if (!files[relative]) fail(uiText("ui.collaborationPanel.theFileOnThisSideDoesnT"))
    const root = path.join(this.context.globalStorageUri.fsPath, 'collaboration', 'previews', client.invitation.serverId, proposal.packId, revision)
    const check = (): void => { this.ensureOpen(); if (this.client !== client) fail(uiText("ui.collaborationPanel.connectionChangedModelPreviewCanceled")) }
    check()
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: uiText("ui.collaborationPanel.mcrhPreparationOfModelAndLinkageMaps"), cancellable: true }, async (_progress, token) => {
      await fs.mkdir(root, { recursive: true })
      for (const [name, entry] of Object.entries(files)) {
        check(); resourcePath(name); if (token.isCancellationRequested) fail(uiText("ui.collaborationPanel.modelPreviewPrepCancelled"))
        const target = path.join(root, name)
        if (await exists(target) && hash(await fs.readFile(target)) === entry.hash) continue
        const data = await client.file(proposal.packId, revision, name)
        check(); if (token.isCancellationRequested) fail(uiText("ui.collaborationPanel.modelPreviewPrepCancelled"))
        await writeResource(root, name, data)
      }
    })
    check()
    await vscode.commands.executeCommand('mcrh.previewVanillaModel', vscode.Uri.file(path.join(root, relative)))
  }
  private async manage(): Promise<void> {
    if (!this.client) return
    const members = await this.client.request<Member[]>('/v1/members'), selected = await vscode.window.showQuickPick(members.map(member => ({ label: member.login, description: member.id + ' · ' + member.status + ' · ' + member.role, member })), { title: uiText("ui.collaborationPanel.membershipAndApplicationForMembership") }); if (!selected) return
    const action = await vscode.window.showQuickPick([{ label: uiText("ui.collaborationPanel.ratificationUndo"), body: { status: 'active' } }, { label: uiText("ui.collaborationPanel.removeMembersAndAllowReapplications"), body: { status: 'removed' } }, { label: uiText("ui.collaborationPanel.banNoReEntry"), body: { status: 'banned' } }, { label: uiText("ui.collaborationPanel.grantToReviewAdministrator"), body: { role: 'reviewer' } }, { label: uiText("ui.collaborationPanel.undoAdministrator"), body: { role: 'member' } }, { label: uiText("ui.collaborationPanel.thisUserMustApprove"), body: { review: true } }, { label: uiText("ui.collaborationPanel.thisUserIsNotReviewed"), body: { review: false } }, { label: uiText("ui.collaborationPanel.thisUserFollowsTheDefaultApprovalRule"), body: { review: null } }], { title: selected.member.login }); if (!action) return
    if ((action.body as { status?: string }).status === 'banned' && !await vscode.window.showWarningMessage(uiText("ui.collaborationPanel.banReIncorporate", selected.member.login), { modal: true }, uiText("ui.collaborationPanel.confirmBan"))) return
    this.ensureOpen(); await this.client.request('/v1/members/' + selected.member.id, 'PATCH', action.body)
  }
  private async settings(): Promise<void> {
    if (!this.client) return
    const current = await this.client.request<Record<string, unknown>>('/v1/settings'), action = await vscode.window.showQuickPick([uiText("ui.collaborationPanel.accessionAndApproval"), uiText("ui.collaborationPanel.defaultApprovalRules"), uiText("ui.collaborationPanel.identityQueryChannelAndDomainName"), uiText("ui.collaborationPanel.resourceBudget")], { title: uiText("ui.collaborationPanel.serviceEndSettings") }); if (!action) return
    let body: Record<string, unknown> = {}
    if (action === uiText("ui.collaborationPanel.accessionAndApproval")) { const selected = await vscode.window.showQuickPick([uiText("ui.collaborationPanel.weNeedASuperBarrel"), uiText("ui.collaborationPanel.autoAccedenceWhenSupportedByCorrectDocumentation")]); if (!selected) return; body.autoJoin = selected !== uiText("ui.collaborationPanel.weNeedASuperBarrel") }
    if (action === uiText("ui.collaborationPanel.defaultApprovalRules")) { const selected = await vscode.window.showQuickPick([uiText("ui.collaborationPanel.defaultRequiresApproval"), uiText("ui.collaborationPanel.defaultReleaseFromReviewTheSpecifiedUser")]); if (!selected) return; body.reviewDefault = selected === uiText("ui.collaborationPanel.defaultRequiresApproval") }
    if (action === uiText("ui.collaborationPanel.identityQueryChannelAndDomainName")) { const policy = await this.chooseIdentityPolicy({ queryMode: current.queryMode as 'github' | 'proxy' | 'auto', queryProxy: String(current.queryProxy ?? '') }); if (!policy) return; body = policy }
    if (action === uiText("ui.collaborationPanel.resourceBudget")) { const text = await vscode.window.showInputBox({ title: uiText("ui.collaborationPanel.resourceBudgetJsonBytes"), value: JSON.stringify(current.limits), prompt: uiText("ui.collaborationPanel.suggestsThatTheServiceBeRestartedWith") }); if (!text) return; body.limits = JSON.parse(text) }
    this.ensureOpen(); await this.client.request('/v1/settings', 'PATCH', body)
  }
  private async acquireP2PNetwork(directory = path.join(this.context.globalStorageUri.fsPath, 'collaboration')) {
    const source = vscode.workspace.getConfiguration('mcrh').get<string>('collaboration.openp2pPresetUrl', OPL_PRESET_URL)
    extensionLog('info', uiText("ui.collaborationPanel.coordinationP2pReadCoordinationNodesPresetOr"))
    const network = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: uiText("ui.collaborationPanel.automaticallyAccessOpenp2pCoordinationNodes"), cancellable: false }, () => automaticP2PNetwork(directory, source))
    extensionLog('info', uiText("ui.collaborationPanel.coordinationP2pCoordinationNodesAreReadyTo", network.serverHost, network.serverPort))
    return network
  }
  private async configureP2P(): Promise<void> {
    if (!this.server || !this.client) fail(uiText("ui.collaborationPanel.p2pProgramConfigurationRequiresPluginServiceOwner"))
    const mode = await vscode.window.showQuickPick([uiText("ui.collaborationPanel.enableEmbeddedSinglePortOpenp2p"), ...(this.service?.config.p2p ? [uiText("ui.collaborationPanel.switchToAutomaticCoordinateNode")] : []), uiText("ui.collaborationPanel.closeP2p")]); if (!mode) return
    if (mode === uiText("ui.collaborationPanel.closeP2p")) { this.ensureOpen(); await this.client.request('/v1/local/p2p', 'POST', { p2p: null }); return }
    const executable = await selectOpenP2PExecutable(this.context); if (!executable) return
    const network = mode !== uiText("ui.collaborationPanel.switchToAutomaticCoordinateNode") && this.service?.config.p2p ? this.service.config.p2p : await this.acquireP2PNetwork(this.service?.directory)
    this.ensureOpen(); await this.client.request('/v1/local/p2p', 'POST', { p2p: { ...network, executable, node: this.service?.config.p2p?.node ?? 'mcrh-' + randomBytes(16).toString('base64url'), shareBandwidth: 0 } })
  }
  private async receive(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object' || this.closed) return
    const message = raw as Record<string, unknown>, command = message.command
    if (command === 'logs') { showExtensionLog(); return }
    if (typeof command !== 'string' || !Object.hasOwn(OPERATIONS, command)) {
      const error = uiText("ui.collaborationPanel.unsupportedCollaboration")
      this.post({ type: 'notice', error: true, text: error })
      if (typeof message.requestId === 'string') this.post({ type: 'operation', id: message.requestId, command, status: 'done', error })
      return
    }
    if (command === 'ready') for (const operation of this.operations.values()) this.activity(operation, operation.status)
    await this.enqueue(command as CollaborationCommand, message)
  }
  private async perform(command: CollaborationCommand, message: Record<string, unknown>): Promise<void> {
      if (this.pendingDisconnects > 0 && ['ready', 'refresh', 'sync', 'pull', 'syncAll'].includes(command)) return
      if (command === 'host') await this.startHost(message.customDirectory === true)
      else if (command === 'connect') await this.connect()
      else if (command === 'disconnect') await this.disconnect()
      else if (command === 'pack') { if (typeof message.id !== 'string' || !this.packs.some(pack => pack.id === message.id)) fail(uiText("ui.collaborationPanel.pleaseSelectAValidResourcePackFor")); this.packId = message.id; this.workspace = this.workspaces?.get(message.id) }
      else if (command === 'pull') await this.pull()
       else if (command === 'syncAll') await this.transfer(this.packs.filter(pack => this.workspaces?.get(pack.id)))
      else if (command === 'submit') { if (!this.workspace) fail(uiText("ui.collaborationPanel.pleaseRemoveACopyOfTheLocal")); const paths = message.paths; if (!Array.isArray(paths) || !paths.length || !paths.every(value => typeof value === 'string')) fail(uiText("ui.collaborationPanel.selectFileToSubmit")); const title = await vscode.window.showInputBox({ title: uiText("ui.collaborationPanel.proactiveSubmissionToTheAwaitingTrial"), prompt: uiText("ui.collaborationPanel.onlyTheSelectedFileIsSubmittedAnd"), validateInput: value => value.trim() ? undefined : uiText("ui.collaborationPanel.pleaseFillInTheChangeNote") }); if (title) { this.ensureOpen(); const result = await this.workspace.submit(title, paths); this.post({ type: 'notice', text: uiText("ui.collaborationPanel.submittedFileApprovalStatusCanBeViewed", result.id) }) } }
      else if (command === 'preview') await this.preview(message.id, message.path)
      else if (command === 'model') await this.model(message.id, message.path, message.side)
      else if (command === 'review') { const proposal = this.selectedProposal(message.id); if (!this.client) fail(uiText("ui.collaborationPanel.notConnected")); await this.client.request('/v1/proposals/' + proposal.id + '/review', 'POST', { paths: message.paths, decision: message.decision, comment: message.comment }) }
      else if (command === 'members') await this.manage()
      else if (command === 'settings') await this.settings()
      else if (command === 'p2p') await this.configureP2P()
      else if (command === 'share') { if (!this.server) fail(uiText("ui.collaborationPanel.couldNotCloseTemporaryFolderS_273fb2")); this.ensureOpen(); const notice = await copyCollaborationInvitation(this.server.invitation()); if (notice) this.post({ type: 'notice', text: notice }) }
      else if (command === 'rotate') { if (!this.client || !this.server) fail(uiText("ui.collaborationPanel.pleaseResetTheConnectionCertificateOnThe")); if (await vscode.window.showWarningMessage(uiText("ui.collaborationPanel.allRemoteSessionsAfterResetAreInvalid"), { modal: true }, uiText("core.mcText.reset"))) { this.ensureOpen(); await this.client.request('/v1/local/rotate', 'POST'); this.ensureOpen(); this.client = new RemoteClient(this.server.invitation(), extensionLog); this.client.localKey = this.service!.config.localControlKey; await this.client.connect(); this.workspace = undefined; await this.restoreWorkspaces(this.client); this.post({ type: 'notice', text: uiText("ui.collaborationPanel.connectionCertificateHasBeenResetPleaseCopy") }) } }
      else if (command === 'resolve') { if (!this.workspace || typeof message.path !== 'string' || !['local', 'remote'].includes(String(message.keep))) fail(uiText("ui.collaborationPanel.conflictOperationInvalid")); if (message.keep === 'remote' && !await vscode.window.showWarningMessage(uiText("ui.collaborationPanel.upstreamCurrentLocalContentWillBeStored"), { modal: true }, uiText("ui.collaborationPanel.useUpstream"))) return; this.ensureOpen(); await this.workspace.resolve(message.path, message.keep as 'local' | 'remote') }
      else if (command === 'follow') { if (typeof message.value !== 'boolean') fail(uiText("ui.collaborationPanel.automaticFollowSettingsInvalid")); this.autoFollow = message.value; this.post({ type: 'follow', value: this.autoFollow }) }
      else if (command === 'openLocal') { if (!this.workspace) fail(uiText("ui.collaborationPanel.pleaseRemoveACopyOfTheLocal")); await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(this.workspace.root), { forceNewWindow: true }) }
      else if (command === 'discover') { if (!this.client) fail(uiText("ui.collaborationPanel.pleaseConnectToTheServiceFirst")); await this.client.request('/v1/discover', 'POST') }
      else if (command === 'audit') { if (!this.client) fail(uiText("ui.collaborationPanel.pleaseConnectToTheServiceFirst")); const data = await this.client.request('/v1/audit'); this.ensureOpen(); await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(data, null, 2) })) }
      else if (command === 'sync' && this.autoFollow) {
         const controller = new AbortController(), errors: string[] = []; this.syncAbort = controller
         try {
           for (const pack of this.packs) {
             if (this.closed || this.pendingDisconnects) break
             const workspace = this.workspaces?.get(pack.id); if (!workspace) continue
             try { const result = await workspace.sync(pack.id, { signal: controller.signal }); if (result.conflicts.length) this.post({ type: 'notice', text: pack.name + uiText("ui.collaborationPanel.upstreamUpdatesConflictWithLocalChangesLocal") }) }
             catch (error) { if (controller.signal.aborted) throw error; errors.push(pack.name + '：' + (error instanceof Error ? error.message : uiText("ui.collaborationPanel.synchronisingFailed"))) }
           }
           if (errors.length) throw new CollaborationStateRefreshError(uiText("ui.collaborationPanel.couldNotCloseTemporaryFolderS_e6e000", errors.join('；')))
         } finally { if (this.syncAbort === controller) this.syncAbort = undefined }
       }
      if (OPERATIONS[command][1] === 'session' && !['pull', 'syncAll'].includes(command) && !this.closed) {
        try { await this.refresh() }
        catch (error) {
          if (error instanceof CollaborationConnectionError && error.code === 'ABORT_ERR') return
          const context = command === 'host' && this.server ? uiText("ui.collaborationPanel.serviceEndStartedButCollaborativeStatusLoaded") : !['ready', 'refresh', 'sync'].includes(command) ? uiText("ui.collaborationPanel.collaborationStatusRefreshingFailedAndCurrentOperation") : ''
          throw new CollaborationStateRefreshError(context + (error instanceof Error ? error.message : uiText("ui.collaborationPanel.collaborationLoadFailed")))
        }
      }
  }
}
export function registerCollaborationCommands(context: vscode.ExtensionContext): vscode.Disposable[] { return [vscode.commands.registerCommand('mcrh.openCollaboration', () => { extensionLog('info', uiText("ui.collaborationPanel.coordinationOpensTheCollaborationPanelRunningLog")); CollaborationPanel.show(context) })] }
