export type TexturePreviewKind = 'block' | 'item' | 'entity' | 'other'
export type TexturePreviewMode = 'flat' | 'block' | 'hand-first' | 'hand-third' | 'hotbar' | 'frame'
export interface VehiclePreview { shape: 'boat' | 'raft'; chest: boolean; texturePath: string }

export function texturePreviewKind(source: string): TexturePreviewKind {
  const match = /(?:^|\/)assets\/[^/]+\/textures\/(block|item|entity)\//.exec(source.replace(/\\/g, '/'))
  return match ? match[1] as TexturePreviewKind : 'other'
}

export function texturePreviewModes(source: string): readonly TexturePreviewMode[] {
  const kind = texturePreviewKind(source)
  if (kind === 'block') return ['flat', 'block', 'hand-first', 'hand-third', 'hotbar', 'frame']
  if (kind === 'item') return ['flat', 'hotbar', 'frame']
  if (kind === 'entity') return ['flat']
  return ['flat', 'block', 'hand-first', 'hand-third', 'hotbar', 'frame']
}

// 实体身份来自原版资源路径，物品贴图不会用作实体 UV 图集
export function vehiclePreview(id: string): VehiclePreview | undefined {
  const match = /^minecraft:([a-z0-9_]+?)(_chest)?_(boat|raft)$/.exec(id)
  if (!match || (match[3] === 'raft') !== (match[1] === 'bamboo')) return undefined
  return { shape: match[3] as 'boat' | 'raft', chest: Boolean(match[2]), texturePath: 'assets/minecraft/textures/entity/' + (match[2] ? 'chest_boat/' : 'boat/') + match[1] + '.png' }
}

export function vehicleIdFromTexture(source: string): string | undefined {
  const match = /^assets\/minecraft\/textures\/entity\/(boat|chest_boat)\/([a-z0-9_]+)\.png$/.exec(source)
  if (!match) return undefined
  return 'minecraft:' + match[2] + (match[1] === 'chest_boat' ? '_chest' : '') + (match[2] === 'bamboo' ? '_raft' : '_boat')
}
