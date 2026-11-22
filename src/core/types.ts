export type PackKind = 'resourcepack' | 'datapack' | 'unknown'

export interface PackInfo {
  root: string
  kind: PackKind
  packFormat?: number
  packFormatMinor?: number
  packVersion?: string
  name?: string
  hasAssets: boolean
  hasMetadata?: boolean
  metadataIssue?: string
  reasons: string[]
}

export interface AnimationMeta {
  frametime?: number
  interpolate?: boolean
  frames?: Array<number | { index: number; time: number }>
}

