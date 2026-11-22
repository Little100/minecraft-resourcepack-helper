import capabilities from './data/previewRendererCapabilities.json'

type Special = Record<string, unknown>
export function legacySpecialModel(id: string): Special | undefined {
  return Object.hasOwn(capabilities.legacySpecialItems, id) ? capabilities.legacySpecialItems[id as keyof typeof capabilities.legacySpecialItems] : undefined
}

// 关联纹理来自固定渲染器版本的模板与特殊模型字段
export function specialModelTexturePaths(special: Special): string[] {
  let type = String(special.type ?? '').replace(/^minecraft:/, '')
  if (type === 'head') { const kind = String(special.kind ?? 'player'); type = kind + (kind.includes('skeleton') ? '_skull' : '_head') }
  let textures: string[] = Object.hasOwn(capabilities.specialTextures, type) ? [...capabilities.specialTextures[type as keyof typeof capabilities.specialTextures]] : []
  const texture = typeof special.texture === 'string' ? special.texture.replace(/^minecraft:/, '') : undefined
  if (type === 'chest') textures = ['entity/chest/' + (texture ?? 'normal') + (special.chest_type && special.chest_type !== 'single' ? '_' + special.chest_type : '')]
  if (type === 'bed' && texture) textures = ['entity/bed/' + texture]
  if (type === 'shulker_box' && texture) textures = ['entity/shulker/' + texture]
  if (type === 'shield' && special.base_color !== undefined) textures = ['entity/shield/base']
  if (Array.isArray(special.patterns)) for (const pattern of special.patterns) {
    if (pattern && typeof pattern === 'object' && 'pattern' in pattern && typeof pattern.pattern === 'string') {
      const id = pattern.pattern.split(':')
      textures.push((id.length === 2 ? id[0] + ':' : '') + 'entity/' + type + '/' + id.at(-1))
    }
  }
  return [...new Set(textures.filter(id => /^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(id) && !id.split('/').includes('..')).map(id => {
    const parts = id.includes(':') ? id.split(':') : ['minecraft', id]
    return 'assets/' + parts[0] + '/textures/' + parts[1] + '.png'
  }))]
}
