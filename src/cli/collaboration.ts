import { uiText } from '../i18n/messages'
import { automaticP2PNetwork, refreshAutomaticP2P } from '../collaboration/p2pNetwork'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { Command } from 'commander'
import { configSchema, fail, type Invitation, type Manifest, type Proposal } from '../collaboration/types'
import { atomic, exists, writeResource } from '../collaboration/files'
import { CollaborationService } from '../collaboration/service'
import { CollaborationServer } from '../collaboration/server'
import { decodeInvitation, encodeInvitation, RemoteClient } from '../collaboration/client'
import { installOpenP2P, installedOpenP2PPath } from '../collaboration/p2pInstall'
import { ensureBundledOpenP2P } from '../collaboration/p2pBundle'
import { collaborationLog } from '../collaboration/diagnostics'

const program = new Command().name('mcrh-server').description(uiText("cli.collaboration.mcrhResourcePackCollaborativeServicePurposeDoes")).option('--data <directory>', uiText("cli.collaboration.servicePrivateStatusDirectory"), path.join(os.homedir(), '.mcrh', 'server')).showHelpAfterError()
const output = (value: unknown): void => console.log('(' + (typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + ')')
const directory = (): string => path.resolve(program.opts<{ data: string }>().data)
const log = collaborationLog((level, message) => { process.stderr.write(new Date().toISOString() + ' ' + level.toUpperCase() + ' ' + message + '\n') })
async function bundledP2P(): Promise<string> {
  const candidates = [path.join(__dirname, 'data', 'openp2p'), path.join(__dirname, 'openp2p'), path.join(path.dirname(process.execPath), 'openp2p')]
  for (const candidate of candidates) if (await exists(path.join(candidate, 'manifest.json'))) return ensureBundledOpenP2P(directory(), candidate)
  throw new Error(uiText("cli.collaboration.releasePackageMissingOpenp2pClientRepressurizeComplete"))
}
async function control<T>(task: (client: RemoteClient) => Promise<T>): Promise<T> {
  const folder = directory(), config = configSchema.parse(JSON.parse(await fs.readFile(path.join(folder, 'config.json'), 'utf8')))
  if (await exists(path.join(folder, 'runtime.json'))) {
    const runtime = JSON.parse(await fs.readFile(path.join(folder, 'runtime.json'), 'utf8')) as { port: number; fingerprint: string; url?: string }
    const client = new RemoteClient({ version: 1, serverId: config.serverId, key: config.connectionKey, url: runtime.url ?? 'https://127.0.0.1:' + runtime.port, fingerprint: runtime.fingerprint }); client.localKey = config.localControlKey; let connected = false; try { await client.connect(); connected = true } catch {} if (connected) return task(client)
  }
  const service = new CollaborationService(folder); await service.open()
  const server = new CollaborationServer(service, undefined, log)
  try { await server.start({ localControlOnly: true }); const client = new RemoteClient(server.invitation()); client.localKey = config.localControlKey; await client.connect(); return await task(client) } finally { await server.stop(); await service.close() }
}
program.command('init').description(uiText("cli.collaboration.initializeServiceEndAndClearlySpecifyGithub")).requiredOption('--root <directory>', uiText("cli.collaboration.resourcePackDirectoryOrParentDirectoryContaining")).requiredOption('--owner <github-id>', uiText("cli.collaboration.githubDigitalUserIdNotUsername")).option('--owner-login <name>', uiText("cli.collaboration.superadministratorDisplayName"), 'owner').option('--host <address>', uiText("cli.collaboration.theAddressOfTheListeningWhichIs"), '127.0.0.1').option('--port <number>', uiText("cli.collaboration.listenPortAllocatedDynamically"), '38470').action(async options => {
  await CollaborationService.initialize(directory(), { root: path.resolve(options.root), ownerId: options.owner, ownerLogin: options.ownerLogin, host: options.host, port: Number(options.port) })
  const service = new CollaborationService(directory()); try { await service.open(); output({ message: uiText("cli.collaboration.initializationComplete"), packs: service.state.packs.map(pack => ({ id: pack.id, name: pack.name })), data: directory() }) } finally { await service.close() }
})
program.command('serve').description(uiText("cli.collaboration.runsHttpsCollaborationServiceAtTheFront")).option('--host <address>', uiText("cli.collaboration.overwriteThisListeningAddress")).option('--port <number>', uiText("cli.collaboration.overwriteThisListeningPort")).action(async options => {
  const service = new CollaborationService(directory()); await service.open()
  if (options.host) service.config.host = options.host
  if (options.port !== undefined) service.config.port = Number(options.port)
  service.config = configSchema.parse(service.config)
  const server = new CollaborationServer(service, undefined, log)
  try {
    if (service.config.p2p && path.resolve(service.config.p2p.executable) === path.resolve(installedOpenP2PPath(directory()))) service.config.p2p.executable = await bundledP2P()
    await server.start()
  } catch (error) { try { await server.stop() } finally { await service.close() }; throw error }
  output({ message: uiText("cli.collaboration.theServiceHasBeenStartedAndThe"), port: server.port, packs: service.state.packs.length, p2p: server.p2p.status })
  let closing = false
  const stop = (): void => { if (closing) return; closing = true; void server.stop().then(() => service.close()).then(() => { process.exitCode = 0 }).catch(() => { process.exitCode = 1 }) }
  server.onStop = stop
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
})
program.command('stop').description(uiText("cli.collaboration.stopIndependentFrontOfficeServicesAndRelease")).action(async () => { await control(client => client.request('/v1/local/stop', 'POST')); output(uiText("cli.collaboration.requestedToStopService")) })
program.command('status').description(uiText("cli.collaboration.viewRunningIdentitiesResourcePacksAndSettings")).action(async () => output(await control(async client => ({ me: await client.request('/v1/me'), packs: await client.request('/v1/packs'), settings: await client.request('/v1/settings') }))))
program.command('invitation').description(uiText("cli.collaboration.activelyExportSensitiveConnectionInformationPleaseShare")).option('--url <https-url>', uiText("cli.collaboration.publicWebHttpsAddressGeneratingOpenPort")).action(async options => {
  const invitation = await control(client => options.url ? client.request<Invitation>('/v1/local/invitation', 'POST', { url: options.url }) : client.request<Invitation>('/v1/local/invitation'))
  decodeInvitation(JSON.stringify(invitation)); output(encodeInvitation(invitation))
})
program.command('rotate').description(uiText("cli.collaboration.resetConnectionCertificatesRotateP2pNodesAnd")).action(async () => { await control(client => client.request('/v1/local/rotate', 'POST')); output(uiText("cli.collaboration.connectionCertificateHasBeenResetPleaseRerun")) })
program.command('members').description(uiText("cli.collaboration.viewMembershipAndPendingApplications")).action(async () => output(await control(client => client.request('/v1/members'))))
program.command('member <github-id>').description(uiText("cli.collaboration.managementOnlySuperAdministratorsCanDoIt")).option('--status <status>', 'pending / active / removed / banned').option('--role <role>', 'member / reviewer').option('--review <policy>', 'required / exempt / inherit').action(async (id, options) => {
  const body: { status?: string; role?: string; review?: boolean | null } = {}
  if (options.status) body.status = options.status
  if (options.role) body.role = options.role
  if (options.review) { if (!['required', 'exempt', 'inherit'].includes(options.review)) fail(uiText("cli.collaboration.reviewMustBeRequiredExemmptInherit")); body.review = options.review === 'inherit' ? null : options.review === 'required' }
  if (!Object.keys(body).length) fail(uiText("cli.collaboration.needForAClearDesignationOfChange"))
  await control(client => client.request('/v1/members/' + id, 'PATCH', body)); output(uiText("cli.collaboration.memberSettingsUpdated"))
})
program.command('proposals').description(uiText("cli.collaboration.viewAllUserSubmissionsAndDocumentBy")).option('--user <github-id>', uiText("cli.collaboration.filterByAuthor")).action(async options => { const proposals = await control(client => client.request<Proposal[]>('/v1/proposals')); output(options.user ? proposals.filter(proposal => proposal.author.id === options.user) : proposals) })
program.command('review <proposal-id>').description(uiText("cli.collaboration.documentByDocumentOrSingleListApproval")).option('--approve', uiText("cli.collaboration.approval")).option('--reject', uiText("cli.collaboration.reject")).option('--all', uiText("cli.collaboration.selectAllDocumentsPending")).option('--paths <paths...>', uiText("cli.collaboration.clearSelectionOfRelativePaths")).option('--comment <text>', uiText("cli.collaboration.reviewObservations"), '').action(async (id, options) => {
  if (!!options.approve === !!options.reject) fail(uiText("cli.collaboration.selectOnlyApproveOrReject"))
  await control(async client => { const proposals = await client.request<Proposal[]>('/v1/proposals'), proposal = proposals.find(value => value.id === id) ?? fail(uiText("cli.collaboration.submissionDoesNotExist")); const paths = options.all ? proposal.changes.filter(change => change.decision === 'pending').map(change => change.path) : options.paths; if (!paths?.length) fail(uiText("cli.collaboration.needAllOrPaths")); await client.request('/v1/proposals/' + id + '/review', 'POST', { paths, decision: options.approve ? 'approved' : 'rejected', comment: options.comment }) }); output(uiText("cli.collaboration.theResultsOfTheReviewWereSaved"))
})
program.command('preview <proposal-id> <relative-path>').description(uiText("cli.collaboration.exportPreAndPostChangeResourceOpen")).requiredOption('--out <directory>', uiText("cli.collaboration.newPreviewDirectoryDoNotOverwriteExisting")).option('--model-context', uiText("cli.collaboration.exportCompleteVersionsOfBothSidesFor")).action(async (id, relative, options) => {
  const destination = path.resolve(options.out); if (await exists(destination)) fail(uiText("cli.collaboration.previewDirectoryAlreadyExistsPleaseChooseA"))
  await control(async client => { const proposals = await client.request<Proposal[]>('/v1/proposals'), proposal = proposals.find(value => value.id === id) ?? fail(uiText("cli.collaboration.submissionDoesNotExist")); if (!proposal.changes.some(change => change.path === relative)) fail(uiText("cli.collaboration.fileNotSubmitted")); for (const [label, revision] of [['before', proposal.baseRevision], ['after', proposal.commit]]) { const files = await client.request<Manifest>('/v1/versions', 'POST', { packId: proposal.packId, revision }); const root = path.join(destination, label); await fs.mkdir(root, { recursive: true }); const selected = options.modelContext ? Object.keys(files) : [relative]; for (const name of selected) if (files[name]) await writeResource(root, name, await client.file(proposal.packId, revision, name)) } await atomic(path.join(destination, 'review.json'), JSON.stringify(proposal, null, 2)) }); output(destination)
})
program.command('settings').description(uiText("cli.collaboration.setUpAccessionWaiverAndIdentitySearch")).option('--auto-join <on|off>', uiText("cli.collaboration.automaticallyApprovingNewMembers")).option('--review-default <required|exempt>', uiText("cli.collaboration.defaultApprovalStrategyMemberRulesCanBe")).option('--query-mode <github|proxy|auto>', uiText("cli.collaboration.identityQueryChannelDoNotChangeOauth")).option('--query-proxy <https-url>', uiText("cli.collaboration.fullIdentityQueryPeerReturnGithubUser")).option('--poll-seconds <number>', uiText("cli.collaboration.clientFollowsUpstreamInterval")).option('--limits <json-file>', uiText("cli.collaboration.readResourceAndRequestBudgetJsonFiles")).action(async options => {
  const body: Record<string, unknown> = {}
  if (options.autoJoin !== undefined) { if (!['on', 'off'].includes(options.autoJoin)) fail(uiText("cli.collaboration.autoJoinMustBeOnOrOff")); body.autoJoin = options.autoJoin === 'on' }
  if (options.reviewDefault !== undefined) { if (!['required', 'exempt'].includes(options.reviewDefault)) fail(uiText("cli.collaboration.reviewDefaultMustBeRequiredOrExempt")); body.reviewDefault = options.reviewDefault === 'required' }
  if (options.queryMode) body.queryMode = options.queryMode
  if (options.queryProxy) body.queryProxy = options.queryProxy
  if (options.pollSeconds) body.pollSeconds = Number(options.pollSeconds)
  if (options.limits) body.limits = JSON.parse(await fs.readFile(path.resolve(options.limits), 'utf8'))
  output(await control(client => Object.keys(body).length ? client.request('/v1/settings', 'PATCH', body) : client.request('/v1/settings')))
})
program.command('p2p').description(uiText("cli.collaboration.configureEmbeddedSinglePortOpenp2pAutoRetrieving")).option('--executable <path>', uiText("cli.collaboration.mcrhSinglePortOpenp2pExecutableFileLeave")).option('--preset-url <https-url>', uiText("cli.collaboration.presetAddressForCustomHttpsNodeIn")).option('--token-env <name>', uiText("cli.collaboration.advancedOptionsUseTheEnvironmentalVariableName")).option('--server-host <host>', uiText("cli.collaboration.advancedOptionsPrivateCoordinationServiceHost")).option('--server-port <port>', uiText("cli.collaboration.advancedOptionsPrivateCoordinatedServicePort")).option('--node <name>', uiText("cli.collaboration.nodeOfToCharacters")).option('--share-bandwidth <mbps>', uiText("cli.collaboration.publicSharedBandwidthDefaultClose"), '0').action(async options => {
  const token = options.tokenEnv ? process.env[options.tokenEnv] : undefined
  if (options.tokenEnv && !token) fail(uiText("cli.collaboration.theSpecifiedOpenp2pTokenEnvironmentVariableIs"))
  if (!token && (options.serverHost || options.serverPort)) fail(uiText("cli.collaboration.privateCoordinationServicesNeedToBeDesignated"))
  const saved = configSchema.parse(JSON.parse(await fs.readFile(path.join(directory(), 'config.json'), 'utf8'))).p2p
  const network = token ? { token, serverHost: options.serverHost, serverPort: options.serverPort ? Number(options.serverPort) : undefined } : options.presetUrl || !saved ? await automaticP2PNetwork(directory(), options.presetUrl) : await refreshAutomaticP2P(directory(), saved)
  const { randomBytes } = await import('node:crypto'), p2p = { ...network, executable: options.executable ? path.resolve(options.executable) : await bundledP2P(), node: options.node ?? saved?.node ?? 'mcrh-' + randomBytes(16).toString('base64url'), shareBandwidth: Number(options.shareBandwidth) }
  await control(client => client.request('/v1/local/p2p', 'POST', { p2p })); output(uiText("cli.collaboration.p2pConfigurationSavedProcessRunningDoesNot"))
})
program.command('install-p2p').description(uiText("cli.collaboration.prepareToEmbedOpenp2pAlsoSpecifyAn")).option('--from <path-or-url>', uiText("cli.collaboration.selectTheAbsolutePathOrHttpsDistribution")).option('--sha256 <hex>', uiText("cli.collaboration.networkInstallationMustBeAvailableSha")).action(async options => { output(options.from ? await installOpenP2P(directory(), options.from, options.sha256) : await bundledP2P()) })
program.command('disable-p2p').description(uiText("cli.collaboration.stopP2pKeepHttpsPortConnection")).action(async () => { await control(client => client.request('/v1/local/p2p', 'POST', { p2p: null })); output(uiText("cli.collaboration.p2pClosed")) })
program.command('discover').description(uiText("cli.collaboration.reIdentifyResourcePacksInTheAuthorized")).action(async () => output(await control(client => client.request('/v1/discover', 'POST'))))
program.command('audit').description(uiText("cli.collaboration.viewOperationAuditNotContainingConnectionKeys")).action(async () => output(await control(client => client.request('/v1/audit'))))
void program.parseAsync().catch(error => { output(error instanceof Error ? error.message : uiText("cli.collaboration.commandExecutionFailed")); process.exitCode = 1 })
