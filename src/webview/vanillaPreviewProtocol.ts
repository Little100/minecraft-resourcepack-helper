import type { ResourceDisplayName } from '../core/resourceNames'
import type { PreviewMessage } from './messages'
import type { VehiclePreview } from '../core/previewContexts'

export interface VanillaPreviewTarget extends Partial<ResourceDisplayName> { kind: 'block' | 'model' | 'item' | 'entity'; id: string }

export interface VanillaPreviewInit {
  command: 'vanillaInit'
  sessionId: number
  version?: string
  repairVersion?: string
  target: VanillaPreviewTarget
  targets?: VanillaPreviewTarget[]
  vehicle?: VehiclePreview
  properties: Record<string, string[]>
  initialProperties: Record<string, string>
  supportsTallBlock: boolean
  packLabel: string
  layers: string[]
  warnings: string[]
  modelContext?: string
  modelFiles?: Array<{ path: string; exists: boolean }>
  modelFile?: { path: string; exists: boolean }
  fallbackModel?: Record<string, unknown>
  missingPaths?: string[]
}

export interface VanillaAssetRequest {
  command: 'vanillaAssetRequest'
  sessionId: number
  requestId: number
  operation: 'read' | 'list'
  layer: number
  path: string
}

export interface VanillaAssetResponse {
  command: 'vanillaAssetResponse'
  sessionId: number
  requestId: number
  data?: number[]
  entries?: string[]
  missing?: boolean
  error?: string
}

export interface VanillaTextureUpdate {
  command: 'vanillaTexture'
  sessionId: number
  layer: number
  path: string
  revision: number
}

export interface VanillaFlatPreview { command: 'vanillaFlat'; sessionId: number; preview: PreviewMessage; warnings?: string[]; missingPaths?: string[]; repairVersion?: string }
export interface VanillaPreviewLoading { command: 'vanillaLoading'; sessionId: number; name: string }
export interface VanillaPreviewNames { command: 'vanillaNames'; sessionId: number; name: ResourceDisplayName; targets?: VanillaPreviewTarget[]; warnings: string[] }
export interface VanillaPreviewTargets { command: 'vanillaTargets'; sessionId: number; targets: VanillaPreviewTarget[]; warnings?: string[] }
export interface VanillaSelectTarget { command: 'vanillaSelectTarget'; sessionId: number; target: VanillaPreviewTarget }
export type VanillaPreviewCommand = VanillaAssetRequest | VanillaSelectTarget | { command: 'vanillaRepairClient' | 'vanillaOpenBlockbench'; sessionId: number } | { command: 'vanillaAddGenerated' | 'vanillaCompactGenerated' | 'vanillaOptimizeAlpha'; sessionId: number; path: string } | { command: 'vanillaApplyFamily'; sessionId: number; path: string } | { command: 'vanillaOpenModel'; sessionId: number; path?: string; create?: boolean } | { command: 'vanillaReady' | 'vanillaChooseBase' | 'vanillaCreateCmd' } | { command: 'setPreviewFollow'; following: boolean }
