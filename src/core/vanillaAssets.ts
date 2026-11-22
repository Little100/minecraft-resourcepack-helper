import * as path from 'node:path'
import * as vscode from 'vscode'
import { PNG } from 'pngjs'
import type { SpriteImage } from '../webview/messages'
import { assertPngDimensionsWithinLimit } from './document'

export type VanillaSpriteKey = 'hotbar' | 'hotbarSelection' | 'slot' | 'frame'
export type VanillaSprites = Partial<Record<VanillaSpriteKey, SpriteImage>>
export type ManifestLocator = () => Thenable<vscode.Uri[]>

const MANIFEST_NAME = '.mcrh-vanilla.json'
const DEFAULT_ASSETS_ROOT = 'assets'

// 按原版目录结构查找界面贴图
const SPRITE_CANDIDATES: Record<VanillaSpriteKey, readonly string[]> = {
  hotbar: ['gui/sprites/hud/hotbar.png'],
  hotbarSelection: ['gui/sprites/hud/hotbar_selection.png'],
  slot: ['gui/sprites/container/slot.png'],
  frame: []
}

const cache = new Map<string, { stamp: number; sprites: VanillaSprites }>()

const findManifests: ManifestLocator = () => vscode.workspace.findFiles(`**/${MANIFEST_NAME}`, '**/node_modules/**', 8)

export async function loadVanillaSprites(locate: ManifestLocator = findManifests): Promise<VanillaSprites> {
  const manifests = await locate()
  const stamped = await Promise.all(manifests.map(async uri => {
    try {
      return { uri, mtime: Number((await vscode.workspace.fs.stat(uri)).mtime) }
    } catch {
      return undefined
    }
  }))
  const newest = stamped
    .filter((item): item is { uri: vscode.Uri; mtime: number } => item !== undefined)
    .sort((a, b) => b.mtime - a.mtime)[0]
  if (!newest) return {}
  return loadFromManifest(newest.uri, newest.mtime)
}

async function loadFromManifest(manifest: vscode.Uri, mtime: number): Promise<VanillaSprites> {
  const cached = cache.get(manifest.fsPath)
  if (cached && cached.stamp === mtime) return cached.sprites
  const assetsRoot = resolveAssetsRoot(path.dirname(manifest.fsPath), await readDeclaredRoot(manifest))
  const textures = path.join(assetsRoot, 'minecraft', 'textures')
  const sprites: VanillaSprites = {}
  for (const key of Object.keys(SPRITE_CANDIDATES) as VanillaSpriteKey[]) {
    const sprite = await readFirstExisting(textures, SPRITE_CANDIDATES[key])
    if (sprite) sprites[key] = sprite
  }
  cache.set(manifest.fsPath, { stamp: mtime, sprites })
  return sprites
}

// 只允许解包目录内的相对路径，否则用默认目录
export function resolveAssetsRoot(releaseDir: string, declared: unknown): string {
  const fallback = path.join(releaseDir, DEFAULT_ASSETS_ROOT)
  if (typeof declared !== 'string' || declared.trim() === '') return fallback
  const candidate = path.resolve(releaseDir, declared)
  return isInside(releaseDir, candidate) ? candidate : fallback
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative)
}

async function readDeclaredRoot(manifest: vscode.Uri): Promise<unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(manifest)).toString('utf8')) as { assetsRoot?: unknown }
    return parsed.assetsRoot
  } catch {
    return undefined
  }
}

async function readFirstExisting(textures: string, candidates: readonly string[]): Promise<SpriteImage | undefined> {
  for (const candidate of candidates) {
    const sprite = await tryDecode(path.join(textures, candidate))
    if (sprite) return sprite
  }
  return undefined
}

async function tryDecode(file: string): Promise<SpriteImage | undefined> {
  try {
    return decodeSprite(await vscode.workspace.fs.readFile(vscode.Uri.file(file)))
  } catch {
    return undefined
  }
}

// 单独复制像素，不把共享缓冲区的其他数据带出去
function decodeSprite(bytes: Uint8Array): SpriteImage {
  assertPngDimensionsWithinLimit(bytes)
  const png = PNG.sync.read(Buffer.from(bytes))
  const copy = new Uint8Array(png.data.byteLength)
  copy.set(png.data)
  return { width: png.width, height: png.height, data: copy.buffer }
}
