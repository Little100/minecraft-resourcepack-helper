import { uiText } from '../i18n/messages'
import { ZodError } from 'zod'
export interface McpFailure { code: string; message: string; retryable: boolean; hint?: string; current_revision?: string; issues?: Array<{ path: string; message: string }> }
export class McpOperationError extends Error {
  constructor(readonly details: McpFailure) { super(details.message); this.name = 'McpOperationError' }
}
export function mcpFailure(error: unknown): McpFailure {
  if (error instanceof McpOperationError) return error.details
  if (error instanceof ZodError) return { code: 'invalid_arguments', message: uiText("mcp.errors.toolParametersAreInvalid"), retryable: false, issues: error.issues.slice(0, 8).map(issue => ({ path: issue.path.join('.'), message: issue.message })) }
  return { code: 'operation_failed', message: error instanceof Error ? error.message : uiText("mcp.errors.mcrhOperationFailed"), retryable: false }
}
export function assertMcpRevision(actual: string, expected: string): void {
  if (actual !== expected) throw new McpOperationError({ code: 'revision_conflict', message: uiText("mcp.errors.resourcesHaveBeenModifiedPleaseReadThe"), current_revision: actual, hint: uiText("mcp.errors.readTargetResourcesAgainCheckUserChanges"), retryable: true })
}
