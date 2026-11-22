import { uiText } from '../i18n/messages'
export function animationFrameHeight(metadata: unknown, width: number, height: number): number | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined
  const animation = (metadata as Record<string, unknown>).animation
  if (!animation || typeof animation !== 'object' || Array.isArray(animation)) return undefined
  const input = animation as Record<string, unknown>, small = Math.min(width, height)
  const frameWidth = input.width ?? (input.height === undefined ? small : width)
  const frameHeight = input.height ?? (input.width === undefined ? small : height)
  if (frameWidth !== width || !Number.isSafeInteger(frameHeight) || Number(frameHeight) < 1 || height % Number(frameHeight)) return undefined
  return Number(frameHeight)
}

// 调整尺寸保留播放时长与有效序列，静态 PNG 不凭空生成动画文件
export function updateAnimationMetadata(metadata: unknown, width: number, frameHeight: number, frameCount: number): Record<string, unknown> | undefined {
  if (![width, frameHeight, frameCount].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error(uiText("core.pixelAnimation.invalidAnimationDimensions"))
  if (metadata !== undefined && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))) throw new Error(uiText("core.pixelAnimation.pngMetadataAreNotJsonObjectsUnoverrided"))
  const original = (metadata ?? {}) as Record<string, unknown>
  if (original.animation !== undefined && (!original.animation || typeof original.animation !== 'object' || Array.isArray(original.animation))) throw new Error(uiText("core.pixelAnimation.animatedMetadataAreInvalidNotOverwritten"))
  if (original.animation === undefined && frameCount === 1) return metadata === undefined ? undefined : { ...original }
  const animation = { ...(original.animation as Record<string, unknown> | undefined), width, height: frameHeight } as Record<string, unknown>
  if (Array.isArray(animation.frames)) {
    const frames = animation.frames.filter(frame => {
      const index = typeof frame === 'number' ? frame : frame && typeof frame === 'object' ? frame.index : undefined
      return Number.isSafeInteger(index) && index >= 0 && index < frameCount
    })
    if (frames.length) animation.frames = frames
    else delete animation.frames
  }
  return { ...original, animation }
}
