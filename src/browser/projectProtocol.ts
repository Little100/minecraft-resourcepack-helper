import type { BrowserPackEntry, BrowserPackMetadata } from '../core/browserPackProject'

export interface ProjectWorkerRequest {
  id: number
  operation: 'initialize' | 'blank' | 'import' | 'apply' | 'export'
  bytes?: Uint8Array
  name?: string
  version?: string
  vanilla?: boolean
  files?: Array<{ path: string; data: Uint8Array }>
  includeMcrhEditorData?: boolean
  includeVanillaTextures?: boolean
}
export interface ProjectWorkerResponse {
  id: number
  ok: boolean
  error?: string
  metadata?: BrowserPackMetadata
  entries?: BrowserPackEntry[]
  changed?: BrowserPackEntry[]
  bytes?: Uint8Array
}
