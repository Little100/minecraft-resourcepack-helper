import { uiText } from '../i18n/messages'
import { redactDiagnosticText } from '../core/diagnosticText'

export type CollaborationLog = (level: 'info' | 'warn' | 'error', message: string) => void

export function collaborationDiagnosticText(message: string, secrets: readonly string[] = []): string {
  let safe = message
  for (const secret of secrets) if (secret) safe = safe.split(secret).join(uiText("collaboration.diagnostics.theEvidenceIsHidden"))
  return redactDiagnosticText(safe)
}

export function collaborationLog(sink?: CollaborationLog, secrets: readonly string[] = []): CollaborationLog {
  return (level, message) => {
    try { sink?.(level, collaborationDiagnosticText(message, secrets)) } catch {}
  }
}
