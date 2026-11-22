import { uiText } from '../i18n/messages'
import { CollaborationConnectionError, type RemoteClient } from './client'
import { collaborationLog, type CollaborationLog } from './diagnostics'

export async function verifyCollaborationConnection(client: Pick<RemoteClient, 'connect'>, options: { signal: AbortSignal; p2p: boolean; assertActive: () => void; progress: (message: string) => void; log?: CollaborationLog; timeoutMs?: number }): Promise<void> {
  const log = collaborationLog(options.log), started = Date.now(), deadline = started + (options.timeoutMs ?? (options.p2p ? 45000 : 10000))
  let attempt = 0, last: unknown
  log('info', uiText("collaboration.connection.coordinationConnectionStartValidationWaitForCeiling", (options.p2p ? uiText("collaboration.connection.p2pTunnel") : uiText("collaboration.connection.openPort")), (deadline - started)))
  while (Date.now() < deadline) {
    options.assertActive()
    if (options.signal.aborted) throw new CollaborationConnectionError(uiText("collaboration.client.connectionCancelled"), 'ABORT_ERR')
    attempt++
    try {
      await client.connect({ signal: options.signal, timeoutMs: Math.min(10000, Math.max(1, deadline - Date.now())) })
      options.assertActive()
      log('info', uiText("collaboration.connection.coordinationConconnectionTlsCertificateFingerprintingPassedTried", attempt, (Date.now() - started)))
      return
    } catch (error) {
      options.assertActive()
      last = error
      if (!options.p2p || !(error instanceof CollaborationConnectionError) || !error.retryable || options.signal.aborted) throw error
      const message = uiText("collaboration.connection.waitingForP2pTunnelReady", error.code)
      options.progress(message)
      if (attempt === 1 || attempt % 5 === 0) log('warn', uiText("collaboration.connection.coordinationConnectionWaitedForMsSubprocessesAre", message, (Date.now() - started)))
      await new Promise<void>(resolve => {
        const done = (): void => { clearTimeout(timer); options.signal.removeEventListener('abort', done); resolve() }
        const timer = setTimeout(done, Math.min(1000, Math.max(0, deadline - Date.now())))
        options.signal.addEventListener('abort', done, { once: true })
        if (options.signal.aborted) done()
      })
    }
  }
  options.assertActive()
  if (options.signal.aborted) throw new CollaborationConnectionError(uiText("collaboration.client.connectionCancelled"), 'ABORT_ERR')
  throw last ?? new CollaborationConnectionError(uiText("collaboration.connection.p2pTunnelsWereNotEstablishedWithinThe"), 'ETIMEDOUT')
}
