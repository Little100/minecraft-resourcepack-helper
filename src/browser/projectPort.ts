import type { BrowserFile } from './files'
import type { BrowserPackEntry } from '../core/browserPackProject'

export interface ProjectInfo { name: string; version?: string; description?: string; fileCount: number; bytes: number; resourceFormat?: string; dirty: boolean }
export interface ProjectPort {
  readonly revision: number
  info(): ProjectInfo
  paths(): readonly string[]
  read(path: string): Uint8Array | undefined
  apply(files: readonly BrowserFile[], expectedRevision?: number): Promise<void>
  importArchive(bytes: Uint8Array, name: string, vanilla: boolean, version?: string, signal?: AbortSignal): Promise<void>
  startBlank(version: string, name?: string): Promise<void>
  packToolsEntries?(): BrowserPackEntry[]
  exportFiles(): readonly BrowserFile[]
  markExported(expectedRevision: number): void
  exportZip(signal?: AbortSignal, expectedRevision?: number): Promise<Uint8Array>
}
export interface BrowserExportContext { kind: string; targetVersion: string; projectName: string }
export type BrowserExportHook = (files: readonly BrowserFile[], context: BrowserExportContext) => Promise<readonly BrowserFile[]> | readonly BrowserFile[]
export interface BrowserBridgeOptions { confirmReplace(): boolean; replaced(): void; beforeExport?: BrowserExportHook; changed(): void; notify(text: string, error?: boolean): void; edit(path: string): void }
