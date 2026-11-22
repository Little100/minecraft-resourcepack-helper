import { uiText } from '../../i18n/messages'
import table from '../data/packFormats.json'

export type VersionStatus = 'release' | 'pre-release' | 'snapshot' | 'unreleased' | 'unverified'
export type PackKind = 'resource' | 'data'
export interface PackFormat { readonly major: number; readonly minor: number }
export type MetadataSchema = 'legacy' | 'range'
export interface CapabilitySource {
  readonly url: string
  readonly description: string
  readonly primary: boolean
}
export interface VersionCapabilities {
  readonly id: string
  readonly status: VersionStatus
  readonly summary: string
  readonly releaseDate: string
  readonly verifiedAt: string
  readonly resourcePackFormat: PackFormat | null
  readonly dataPackFormat: PackFormat | null
  readonly metadataSchema: MetadataSchema
  readonly formatEvidence: 'official-release-notes' | 'bundled-table' | 'legacy-reference'
  readonly features: {
    readonly itemDefinitions: boolean
    readonly atlases: boolean
    readonly fonts: 'legacy-bitmap' | 'json-providers'
    readonly coreShaders: boolean
    readonly postShaders: boolean
    readonly optifine: 'requires-separate-installation'
    readonly modernDetails: 'verified-baseline' | 'needs-target-review'
    readonly coreShaderSupport: 'absent' | 'unsupported-overrides'
    readonly postEffectActivation: 'hardcoded' | 'posteffect-command'
  }
  readonly limitations: readonly string[]
  readonly sources: readonly CapabilitySource[]
}

const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const FORMAT_SOURCE = { url: table.source, description: uiText("core.advanced.versionCapabilities.tableOfInternalFormatInlineItemNot", table.generated), primary: false }
const RELEASE_NOTES: Readonly<Record<string, { path: string; resourceMajor: number; resourceMinor: number; dataMajor: number; dataMinor: number }>> = Object.freeze({
  '1.21.11': { path: '3c26594cfd60698ea120e64efd1ea9d6fdea35a96328b7236626f058d34de885', resourceMajor: 75, resourceMinor: 0, dataMajor: 94, dataMinor: 1 },
  '26.1': { path: '4ace2852c44a19e2849d481ba3d816ca5f0b4c97f13aa91641e41398d2ba03bf', resourceMajor: 84, resourceMinor: 0, dataMajor: 101, dataMinor: 1 },
  '26.2': { path: '28a6efbe05d3b3218794c99361246dfbc0f476a7e2d58fb85759c3e865e25a75', resourceMajor: 88, resourceMinor: 0, dataMajor: 107, dataMinor: 1 },
  '26.3': { path: '26-3', resourceMajor: 97, resourceMinor: 1, dataMajor: 121, dataMinor: 0 }
})
export const MODERN_METADATA_MINIMUM = Object.freeze({ resource: 65, data: 82 })
export function metadataSchemaForFormat(kind: PackKind, packFormat: PackFormat): MetadataSchema {
  format(packFormat.major, packFormat.minor)
  if (kind !== 'resource' && kind !== 'data') throw new Error(uiText("core.advanced.versionCapabilities.unknownPackageType"))
  return packFormat.major >= MODERN_METADATA_MINIMUM[kind] ? 'range' : 'legacy'
}
const BASELINES = {
  legacy: { itemDefinitions: false, atlases: false, fonts: 'legacy-bitmap', coreShaders: false, postShaders: true, optifine: 'requires-separate-installation', modernDetails: 'verified-baseline' },
  programmable: { itemDefinitions: false, atlases: false, fonts: 'json-providers', coreShaders: true, postShaders: true, optifine: 'requires-separate-installation', modernDetails: 'verified-baseline' },
  atlases: { itemDefinitions: false, atlases: true, fonts: 'json-providers', coreShaders: true, postShaders: true, optifine: 'requires-separate-installation', modernDetails: 'verified-baseline' },
  definitions: { itemDefinitions: true, atlases: true, fonts: 'json-providers', coreShaders: true, postShaders: true, optifine: 'requires-separate-installation', modernDetails: 'needs-target-review' }
} as const
const TARGETS = [
  ['1.12.2', '2017-09-18', 'legacy', 'legacy'],
  ['1.17', '2021-06-08', 'programmable', 'legacy'],
  ['1.18.2', '2022-02-28', 'programmable', 'legacy'],
  ['1.19.4', '2023-03-14', 'atlases', 'legacy'],
  ['1.20.4', '2023-12-07', 'atlases', 'legacy'],
  ['1.21.11', '2025-12-09', 'definitions', 'range'],
  ['26.1', '2026-03-24', 'definitions', 'range'],
  ['26.2', '2026-06-16', 'definitions', 'range'],
  ['26.3', '2026-09-15', 'definitions', 'range']
] as const

function format(major: number, minor = 0): PackFormat {
  if (!Number.isSafeInteger(major) || major < 0 || !Number.isSafeInteger(minor) || minor < 0) throw new Error(uiText("core.advanced.versionCapabilities.packageFormatMustBeANonNegative"))
  return Object.freeze({ major, minor })
}
const registry: readonly VersionCapabilities[] = Object.freeze(TARGETS.map(([id, releaseDate, profile, schema]) => {
  const entry = table.versions.find(version => version.id === id)
  const reviewed = RELEASE_NOTES[id]
  const resourcePackFormat = reviewed ? format(reviewed.resourceMajor, reviewed.resourceMinor) : entry ? format(entry.rpk, entry.rpkMinor) : id === '1.12.2' ? format(3) : null
  const dataPackFormat = reviewed ? format(reviewed.dataMajor, reviewed.dataMinor) : entry ? format(entry.dpk, 'dpkMinor' in entry ? Number(entry.dpkMinor) : 0) : null
  const features = Object.freeze({ ...BASELINES[profile], coreShaderSupport: profile === 'legacy' ? 'absent' as const : 'unsupported-overrides' as const, postEffectActivation: id === '26.3' ? 'posteffect-command' as const : 'hardcoded' as const })
  const limitations = Object.freeze([
    uiText("core.advanced.versionCapabilities.capacityIndicatesOnlyThatTheFileMechanism"),
    uiText("core.advanced.versionCapabilities.optifineShadowpackCtmCitCemPbrNon"),
    uiText("core.advanced.versionCapabilities.mojangExpresslyDoesNotFormallySupportCore"),
    ...(id === '26.3' ? [uiText("core.advanced.versionCapabilities.providePosteffectCustomAfterTreatmentButThe")] : []),
    ...(profile === 'definitions' ? [uiText("core.advanced.versionCapabilities.newFontsForModernTargetsAtlasShadow")] : []),
    ...(id === '1.12.2' ? [uiText("core.advanced.versionCapabilities.doNotSupportDataPackagesUseLang")] : [])
  ])
  const sources = Object.freeze([
    Object.freeze({ url: MANIFEST, description: uiText("core.advanced.versionCapabilities.verificationIdTypeReleaseReleasetime", id), primary: true }),
    Object.freeze(FORMAT_SOURCE),
    ...(reviewed ? [Object.freeze({ url: 'https://launchercontent.mojang.com/v2/javaPatchNotes/' + reviewed.path + '.json', description: uiText("core.advanced.versionCapabilities.officiallyPublishedStatementCompleteMajorMinorOver"), primary: true })] : []),
    Object.freeze({ url: 'https://launchercontent.mojang.com/v2/javaPatchNotes/f2e5863d7623764aba9599869a18f67023f3da86033df6eb62c206404e3de825.json', description: uiText("core.advanced.versionCapabilities.w31aMetadataTransportThresholdAndMinFormat"), primary: true }),
    Object.freeze({ url: 'https://optifine.net/downloads', description: uiText("core.advanced.versionCapabilities.optifineSSupportedVersionIsBasedOn"), primary: true })
  ])
  return Object.freeze({ id, releaseDate, verifiedAt: '2026-10-13', status: 'release' as const, summary: uiText("core.advanced.versionCapabilities.officialVersionResourceFormatDataFormats", resourcePackFormat ? `${resourcePackFormat.major}.${resourcePackFormat.minor}` : uiText("core.advanced.versionCapabilities.notVerified"), dataPackFormat ? `${dataPackFormat.major}.${dataPackFormat.minor}` : uiText("core.advanced.versionCapabilities.notSupported")), resourcePackFormat, dataPackFormat, metadataSchema: schema, formatEvidence: reviewed ? 'official-release-notes' as const : entry ? 'bundled-table' as const : 'legacy-reference' as const, features, limitations, sources })
}))

export function listVersionCapabilities(): readonly VersionCapabilities[] { return registry }
export function getVersionCapabilities(id: string): VersionCapabilities | undefined { return registry.find(entry => entry.id === id) }

// schema 由已知目标决定，不根据浮点格式或年份猜测
export function createPackMetadata(packFormat: PackFormat, schema: MetadataSchema, description: string): { pack: Record<string, unknown> } {
  const checked = format(packFormat.major, packFormat.minor)
  if (typeof description !== 'string' || description.length > 32768) throw new Error(uiText("core.advanced.versionCapabilities.descriptionMustBeATextOfReasonable"))
  if (schema === 'range') return { pack: { description, min_format: [checked.major, checked.minor], max_format: [checked.major, checked.minor] } }
  if (schema !== 'legacy' || checked.minor !== 0) throw new Error(uiText("core.advanced.versionCapabilities.oldMetadaSchemaCannotExpressSubformCan"))
  return { pack: { pack_format: checked.major, description } }
}
export function createPackMcmeta(id: string, kind: PackKind, description: string): { pack: Record<string, unknown> } {
  const version = getVersionCapabilities(id)
  if (!version || version.status !== 'release') throw new Error(uiText("core.advanced.versionCapabilities.unknownOrUnconfirmedOfficiallyPublishedTargetVersion"))
  if (kind !== 'resource' && kind !== 'data') throw new Error(uiText("core.advanced.versionCapabilities.unknownPackageType"))
  const target = kind === 'resource' ? version.resourcePackFormat : version.dataPackFormat
  if (!target) throw new Error(uiText("core.advanced.versionCapabilities.theTargetDoesNotHaveAReliable"))
  return createPackMetadata(target, version.metadataSchema, description)
}

