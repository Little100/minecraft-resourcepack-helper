import { uiText } from '../i18n/messages'
import { z } from 'zod'

export const tokenPrefix = 'mcrh_bylittle100_'
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const idSchema = z.string().regex(/^[a-f0-9-]{8,64}$/)
export const githubIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/)
export const limitsSchema = z.object({ requestsPerMinute: z.number().int().min(60).max(1000000).default(20000), loginRequestsPerMinute: z.number().int().min(1).max(1000).default(10), fileBytes: z.number().int().min(1024).max(512 * 1024 * 1024).default(64 * 1024 * 1024), packBytes: z.number().int().min(1024).max(8 * 1024 ** 3).default(1024 ** 3), files: z.number().int().min(1).max(200000).default(50000), submissionBytes: z.number().int().min(1024).max(512 * 1024 * 1024).default(64 * 1024 * 1024) })
export const p2pNetworkSchema = z.object({ token: z.string().regex(/^[1-9][0-9]{0,19}$/).refine(value => /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n, uiText("collaboration.types.nativeTokenExceedsUint64")), serverHost: z.string().max(253).regex(/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/).optional(), serverPort: z.number().int().min(1).max(65535).optional() })
export const p2pPresetUrlSchema = z.url().max(2048).refine(value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search } catch { return false } }, uiText("collaboration.types.presetNodeRequiresUnsupportedHttpsAddress"))
export const p2pSchema = p2pNetworkSchema.extend({ presetUrl: p2pPresetUrlSchema.optional(), executable: z.string().min(1), node: z.string().regex(/^[a-zA-Z0-9_-]{8,31}$/), shareBandwidth: z.literal(0).default(0) })
export const configSchema = z.object({ version: z.literal(1), root: z.string().min(1), ownerId: githubIdSchema, ownerLogin: z.string().default('owner'), host: z.string().default('127.0.0.1'), port: z.number().int().min(0).max(65535).default(38470), serverId: z.string().uuid(), connectionKey: z.string().regex(/^mcrh_bylittle100_[A-Za-z]{64}$/), localControlKey: hashSchema, epoch: z.number().int().min(1), autoJoin: z.boolean().default(false), reviewDefault: z.boolean().default(true), queryMode: z.enum(['github', 'proxy', 'auto']).default('github'), queryProxy: z.url().default('https://gho.little100.cn/gh/user'), sessionMinutes: z.number().int().min(1).max(1440).default(60), pollSeconds: z.number().int().min(5).max(3600).default(30), scanDepth: z.number().int().min(0).max(8).default(4), limits: limitsSchema, p2p: p2pSchema.optional() })
export type ServerConfig = z.infer<typeof configSchema>
export type Identity = { id: string; login: string }
export type Member = Identity & { role: 'member' | 'reviewer'; status: 'pending' | 'active' | 'removed' | 'banned'; review?: boolean; joinedAt: string }
export type FileEntry = { hash: string; size: number }
export type Manifest = Record<string, FileEntry>
export type Pack = { id: string; name: string; relative: string; revision: string; files: Manifest }
export type Change = { path: string; base: string | null; next: FileEntry | null; decision: 'pending' | 'approved' | 'rejected'; reviewer?: Identity; decidedAt?: string; comment?: string }
export type Proposal = { id: string; packId: string; author: Identity; title: string; createdAt: string; baseRevision: string; commit: string; changes: Change[] }
export type Audit = { at: string; actor: Identity; action: string; subject: string }
export type ServerState = { version: 1; packs: Pack[]; members: Member[]; proposals: Proposal[]; audit: Audit[] }
export type Actor = Identity & { local?: boolean }
export type Invitation = { version: 1; serverId: string; url: string; fingerprint: string; key: string; node?: string; p2p?: { token: string; port: number; serverHost?: string; serverPort?: number } }
export class CollaborationError extends Error { constructor(message: string, readonly statusCode = 400) { super(message) } }
export function fail(message: string, status = 400): never { throw new CollaborationError(message, status) }
export const submitSchema = z.object({ packId: idSchema, baseRevision: z.string().regex(/^[a-f0-9]{40,64}$/), title: z.string().trim().min(1).max(240), changes: z.array(z.object({ path: z.string().min(1).max(1024), base: hashSchema.nullable(), data: z.string().max(720 * 1024 * 1024).nullable() }).strict()).min(1).max(50000) }).strict()
export const reviewSchema = z.object({ paths: z.array(z.string().min(1).max(1024)).min(1).max(50000), decision: z.enum(['approved', 'rejected']), comment: z.string().max(4000).default('') }).strict()
export const invitationSchema = z.object({ version: z.literal(1), serverId: z.string().uuid(), url: z.url(), fingerprint: hashSchema, key: z.string().regex(/^mcrh_bylittle100_[A-Za-z]{64}$/), node: p2pSchema.shape.node.optional(), p2p: p2pNetworkSchema.extend({ port: z.number().int().min(1).max(65535) }).strict().optional() }).strict().refine(value => !value.p2p || !!value.node, uiText("collaboration.types.p2pInvitationMissingNodeUuid"))