import type { ClientReleaseOptions, ClientSourceManifest, ExtractProgress, ExtractResult, ReleasePlan } from './clientAssets'

export interface ClientAssetsWorkerResults { plan: ReleasePlan; extract: ExtractResult }
export type ClientAssetsWorkerOperation = keyof ClientAssetsWorkerResults
export interface ClientAssetsWorkerTask {
  operation: ClientAssetsWorkerOperation
  jarFile: string
  targetDir: string
  version: string
  sourceManifest?: ClientSourceManifest
  options?: ClientReleaseOptions
}
export type ClientAssetsWorkerMessage =
  | { type: 'progress'; progress: ExtractProgress }
  | { type: 'error'; error: { name: string; message: string; code?: string; stack?: string } }
  | { type: 'result'; operation: 'plan'; result: ReleasePlan }
  | { type: 'result'; operation: 'extract'; result: ExtractResult }
