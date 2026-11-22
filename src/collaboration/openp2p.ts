import { uiText } from '../i18n/messages'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { StringDecoder } from 'node:string_decoder'
import { atomic } from './files'
import { fail, p2pSchema, type ServerConfig } from './types'
import { collaborationDiagnosticText, collaborationLog, type CollaborationLog } from './diagnostics'

export async function verifyOpenP2PExecutable(executable: string): Promise<void> {
  const stat = await fs.lstat(executable).catch(() => undefined)
  if (!path.isAbsolute(executable) || !stat?.isFile() || stat.isSymbolicLink()) fail(uiText("collaboration.openp2p.pleaseSelectTheInstalledMrchSinglePort"))
  try {
    const { stdout } = await promisify(execFile)(executable, ['--mcrh-capabilities'], { windowsHide: true, timeout: 5000, maxBuffer: 4096 })
    const capabilities = JSON.parse(stdout)
    if (capabilities.protocol !== 1 || capabilities.ingress !== 'tcp-loopback-single-port' || capabilities.clientIngress !== 'deny' || capabilities.configDirectory !== 'cwd' || capabilities.transportPort !== 'uuid-suffix-tcp-udp-v1') throw new Error('capabilities')
  } catch { fail(uiText("collaboration.openp2p.currentOpenp2pApplicationDoesNotHaveA")) }
}

export class OpenP2P {
  private child?: ChildProcess
  private failure?: Error
  private generation = 0
  private log: CollaborationLog
  node?: string
  transportPort?: number
  private cancelStart?: () => void
  private stopping: Promise<void> = Promise.resolve()
  status = uiText("collaboration.openp2p.notEnabled")
  constructor(private readonly directory: string, private readonly sink?: CollaborationLog) { this.log = collaborationLog(sink) }
  assertRunning(): void {
    if (this.failure) throw this.failure
    if (!this.child) throw new Error(uiText("collaboration.openp2p.openp2pProcessIsNotRunningSeeThe"))
  }
  async start(input: NonNullable<ServerConfig['p2p']>, port: number, remote?: { node: string; port: number; peerUser?: string }): Promise<void> {
    const generation = ++this.generation
    const active = (): void => { if (generation !== this.generation) throw new Error(uiText("collaboration.openp2p.openp2pStartupCanceled")) }
    const config = p2pSchema.parse(input)
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || remote && (!Number.isSafeInteger(remote.port) || remote.port < 1 || remote.port > 65535 || !p2pSchema.shape.node.safeParse(remote.node).success)) fail(uiText("collaboration.openp2p.p2pOnlyAllowsValidCollaborationPortsAnd"))
    await verifyOpenP2PExecutable(config.executable)
    active()
    await this.stopChild()
    active()
    this.failure = undefined
    this.node = undefined; this.transportPort = undefined
    this.log = collaborationLog(this.sink, [config.token])
    const applications = remote ? [{ AppName: 'mcrh-client', Protocol: 'tcp', Whitelist: '127.0.0.1', SrcPort: port, PeerNode: remote.node, PeerUser: remote.peerUser ?? '', DstHost: '127.0.0.1', DstPort: remote.port, Enabled: 1 }] : []
    const data = JSON.stringify({ Network: { Node: config.node, Token: '__TOKEN__', ServerHost: config.serverHost, ServerPort: config.serverPort, ShareBandwidth: 0, PublicIPPort: 0 }, apps: applications, LogLevel: 1, MaxLogSize: 1024 * 1024 }).replace('"__TOKEN__"', config.token)
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 }); await atomic(path.join(this.directory, 'config.json'), data)
    active()
    this.status = uiText("collaboration.openp2p.startingTheReceivingSideOnlyAllowsSpecified")
    this.log('info', uiText("collaboration.openp2p.coordinationP2pStartProgramUuidCoordinateNodes", (remote ? uiText("collaboration.openp2p.client") : uiText("collaboration.openp2p.service")), config.executable, config.node, (config.serverHost ?? uiText("collaboration.openp2p.default")), (config.serverPort ?? 27183), port, (remote ? uiText("collaboration.openp2p.targetUuidTargetCollaborationPortDenyAll", remote.node, remote.port) : uiText("collaboration.openp2p.onlySpecifiedTcpReturnsTarget"))))
    const child = spawn(config.executable, ['--sharebandwidth', '0', '--loglevel', '1'], { cwd: this.directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: { ...process.env, OPENP2P_NODE: config.node, OPENP2P_TOKEN: config.token, MCRH_P2P_ALLOWED_PORT: remote ? '0' : String(port) } })
    this.child = child
    const log = this.log
    let reason = '', lastError = '', lines = 0, window = Date.now(), suppressed = false
    let ready: (() => void) | undefined, failed: ((error: Error) => void) | undefined
    const startup = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject })
    const startupTimer = setTimeout(() => failed?.(new Error(uiText("collaboration.openp2p.openp2pDidNotCompleteTcpUdpPort"))), 12000)
    this.cancelStart = () => failed?.(new Error(uiText("collaboration.openp2p.openp2pStartupCanceled")))
    const output = (line: string, stderr: boolean): void => {
      const binding = /^MCRH_TRANSPORT_READY ([A-Za-z0-9_-]{8,31}) (\d{1,5}) (\d{1,5})$/.exec(line)
      if (binding && this.child === child && generation === this.generation) {
        const selected = Number(binding[2])
        if (selected < 49152 || selected > 65535 || !binding[1].endsWith('-' + selected)) { failed?.(new Error(uiText("collaboration.openp2p.openp2pReturnedInvalidUuidPortSuffix"))); return }
        this.node = binding[1]; this.transportPort = selected
        this.status = uiText("collaboration.openp2p.p2pTransferPortWeReTiedWaiting", selected)
        log('info', uiText("collaboration.openp2p.coordinationP2pActualUuidTcpUdpTransfer", this.node, selected, binding[3], port))
        ready?.()
      }
      const fatal = /MCRH_TRANSPORT_ERROR:|panic:|fatal error:|runtime error:|invalid value|flag provided but not defined|MCRH_P2P_ALLOWED_PORT/.test(line)
      const level = fatal || /\bERROR\b/.test(line) ? 'error' : stderr || /\bWARN\b/.test(line) ? 'warn' : 'info'
      const firstFatal = fatal && !reason
      if (firstFatal) reason = collaborationDiagnosticText(line, [config.token])
      if (level === 'error' && !fatal) lastError = collaborationDiagnosticText(line, [config.token])
      if (Date.now() - window >= 1000) { lines = 0; window = Date.now(); suppressed = false }
      if (++lines > 80 && !firstFatal) {
        if (!suppressed) log('warn', uiText("collaboration.openp2p.coordinationP2pSubProcessOutputIsToo"))
        suppressed = true
        return
      }
      log(level, uiText("collaboration.openp2p.coordinationP2p", (stderr ? 'stderr' : 'stdout'), line))
    }
    for (const [stream, stderr] of [[child.stdout, false], [child.stderr, true]] as const) {
      if (!stream) continue
      const decoder = new StringDecoder('utf8')
      let buffer = '', dropping = false
      const consume = (text: string): void => {
        for (const part of text.split(/(?<=\n)/)) {
          if (!dropping) buffer += part
          if (buffer.length > 8192) { buffer = ''; dropping = true }
          if (part.endsWith('\n')) {
            if (dropping) output(uiText("collaboration.openp2p.skippedTheSuperPrematureProcessOutputLine"), true)
            else if (buffer.trim()) output(buffer.trim(), stderr)
            buffer = ''; dropping = false
          }
        }
      }
      stream.on('data', (bytes: Buffer) => consume(decoder.write(bytes)))
      stream.once('end', () => { consume(decoder.end()); if (buffer.trim() && !dropping) output(buffer.trim(), stderr) })
      stream.on('error', error => log('warn', uiText("collaboration.openp2p.coordinationP2pOutputStreamReadingFailed", error.message)))
    }
    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = undefined
      const detail = uiText("collaboration.openp2p.openp2pExitedExitCode", String(code), (signal ? uiText("collaboration.openp2p.signal", signal) : ''), (reason || lastError ? '：' + (reason || lastError) : ''))
      const safe = collaborationDiagnosticText(detail, [config.token])
      this.status = safe
      this.failure = new Error(safe + uiText("collaboration.openp2p.pleaseSeeTheMcrhExtensionLog"))
      this.node = undefined; this.transportPort = undefined
      failed?.(this.failure)
      log('error', uiText("collaboration.openp2p.coordinationP2p_b87920", detail))
    })
    child.once('spawn', () => log('info', uiText("collaboration.openp2p.coordinationP2pSubProcessInitiatedPidWaiting", String(child.pid ?? uiText("collaboration.openp2p.unknown")))))
    child.on('error', error => {
      if (this.child === child) { this.status = uiText("collaboration.openp2p.openp2pStartupFailed"); this.failure = new Error(this.status + '：' + error.message) }
      log('error', uiText("collaboration.openp2p.coordinationP2pProcessError", error.message))
      failed?.(error)
    })
    try { await startup; active(); this.assertRunning() }
    catch (error) { if (this.child === child) await this.stopChild(); if (generation === this.generation) { this.failure = error instanceof Error ? error : new Error(uiText("collaboration.openp2p.openp2pStartupFailed")); this.status = this.failure.message }; throw error }
    finally { clearTimeout(startupTimer); ready = undefined; failed = undefined; if (this.child === child) this.cancelStart = undefined }
  }
  async stop(): Promise<void> {
    this.generation++
    await this.stopChild()
  }
  private async stopChild(): Promise<void> {
    this.cancelStart?.(); this.cancelStart = undefined
    const child = this.child; this.child = undefined
    this.node = undefined; this.transportPort = undefined
    if (!child) { await this.stopping; return }
    this.log('info', uiText("collaboration.openp2p.coordinationP2pStoppingSubprocessPid", String(child.pid ?? uiText("collaboration.openp2p.unknown"))))
    const stopped = new Promise<void>(resolve => {
      if (child.exitCode !== null && child.exitCode !== undefined || child.signalCode) { resolve(); return }
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 5000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      child.kill()
    })
    this.stopping = Promise.all([this.stopping, stopped]).then(() => {})
    await this.stopping
    if (!this.child) { this.status = uiText("collaboration.openp2p.stopped"); this.failure = undefined }
    this.log('info', uiText("collaboration.openp2p.coordinationP2pSubprocessHasStopped"))
  }
}
