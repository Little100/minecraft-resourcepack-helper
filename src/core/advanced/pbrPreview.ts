import { uiText } from '../../i18n/messages'
export const PBR_PREVIEW_LIMITS = Object.freeze({
  maxDimension: 4096,
  maxPixels: 4 * 1024 * 1024
})

export const PBR_PREVIEW_PROFILES = Object.freeze(['labPBR', 'oldPBR', 'pbrgen-mer'] as const)
export type PbrPreviewProfile = typeof PBR_PREVIEW_PROFILES[number]
export type MaterialPreviewRgbaChannelName = 'albedo' | 'normal' | 'roughness' | 'metallic' | 'emissive' | 'ao'

export interface PbrPreviewImageData {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
}

export interface MaterialPreviewInput {
  readonly albedo: PbrPreviewImageData
  readonly normal?: PbrPreviewImageData
  readonly mer?: PbrPreviewImageData
  readonly profile?: PbrPreviewProfile
}

export interface MaterialPreviewData {
  readonly width: number
  readonly height: number
  readonly profile: PbrPreviewProfile
  // 底图保留原始颜色字节与透明度，不预乘透明度
  readonly albedo: Uint8Array
  // 法线按行存储单位向量，保留来源的切线空间方向
  readonly normalXYZ: Float32Array
  readonly roughness: Float32Array
  readonly metallic: Float32Array
  readonly emissive: Float32Array
  readonly ao: Float32Array
}

export interface MaterialPreviewRgbaChannels {
  readonly width: number
  readonly height: number
  readonly albedo: Uint8Array
  readonly normal: Uint8Array
  readonly roughness: Uint8Array
  readonly metallic: Uint8Array
  readonly emissive: Uint8Array
  readonly ao: Uint8Array
}

export interface MaterialPreviewPixel {
  readonly x: number
  readonly y: number
  readonly albedo: readonly [number, number, number, number]
  readonly normalXYZ: readonly [number, number, number]
  readonly roughness: number
  readonly metallic: number
  readonly emissive: number
  readonly ao: number
}

export interface MaterialPreviewChannelSummary {
  readonly average: number
  readonly min: number
  readonly max: number
}

export interface MaterialPreviewSummary {
  readonly profile: PbrPreviewProfile
  readonly width: number
  readonly height: number
  readonly pixelCount: number
  readonly transparentPixels: number
  readonly translucentPixels: number
  readonly opaquePixels: number
  // 统计包含透明像素，颜色平均值保持底图编码空间
  readonly averageAlbedo: readonly [number, number, number, number]
  readonly averageNormalXYZ: readonly [number, number, number]
  readonly roughness: MaterialPreviewChannelSummary
  readonly metallic: MaterialPreviewChannelSummary
  readonly emissive: MaterialPreviewChannelSummary
  readonly ao: MaterialPreviewChannelSummary
}

function validateDimensions(width: number, height: number, name: string): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
    || width > PBR_PREVIEW_LIMITS.maxDimension || height > PBR_PREVIEW_LIMITS.maxDimension
    || width * height > PBR_PREVIEW_LIMITS.maxPixels) {
    throw new Error(uiText("core.advanced.pbrPreview.theSizeMustBePositiveWithA", name, PBR_PREVIEW_LIMITS.maxDimension, PBR_PREVIEW_LIMITS.maxPixels))
  }
  return width * height
}

function validateImage(image: PbrPreviewImageData, name: string, width?: number, height?: number): number {
  if (!image || typeof image !== 'object' || Array.isArray(image)) throw new Error(uiText("core.advanced.pbrPreview.itMustBeTheRgbaImageData", name))
  const pixelCount = validateDimensions(image.width, image.height, name)
  if (!(image.data instanceof Uint8Array) || image.data.length !== pixelCount * 4) {
    throw new Error(uiText("core.advanced.pbrPreview.dataMustBeUint8arrayRgbaDataEqual", name))
  }
  if (width !== undefined && (image.width !== width || image.height !== height)) {
    throw new Error(uiText("core.advanced.pbrPreview.itMustBeTheSameSizeAs", name))
  }
  return pixelCount
}

function validateProfile(profile: PbrPreviewProfile): void {
  if (!PBR_PREVIEW_PROFILES.includes(profile)) throw new Error(uiText("core.advanced.pbrPreview.profileOnlySupportsLabpbOldPbrOr"))
}

// 法线与标量均按线性数据解码，不做颜色空间转换
export function createMaterialPreviewData(input: MaterialPreviewInput): MaterialPreviewData {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(uiText("core.advanced.pbrPreview.inputMustBePbrPreviewMaterialParameter"))
  const profile = input.profile === undefined ? 'labPBR' : input.profile
  validateProfile(profile)
  const pixelCount = validateImage(input.albedo, 'albedo')
  const { width, height } = input.albedo
  if (input.normal !== undefined) validateImage(input.normal, 'normal', width, height)
  if (input.mer !== undefined) validateImage(input.mer, 'mer', width, height)

  const albedo = Uint8Array.from(input.albedo.data)
  const normal = input.normal?.data
  const mer = input.mer?.data
  const normalXYZ = new Float32Array(pixelCount * 3)
  const roughness = new Float32Array(pixelCount)
  const metallic = new Float32Array(pixelCount)
  const emissive = new Float32Array(pixelCount)
  const ao = new Float32Array(pixelCount)
  const labPbr = profile === 'labPBR'
  const oldPbr = profile === 'oldPBR'

  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * 4
    const normalOffset = pixel * 3
    let nx = 0, ny = 0, nz = 1
    if (normal !== undefined) {
      nx = normal[offset] / 127.5 - 1
      ny = normal[offset + 1] / 127.5 - 1
      // labPBR蓝通道存储AO，越界XY投影到单位圆并重建非负Z
      nz = labPbr ? Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)) : normal[offset + 2] / 127.5 - 1
      const length = Math.hypot(nx, ny, nz)
      nx /= length
      ny /= length
      nz /= length
    }
    normalXYZ[normalOffset] = nx
    normalXYZ[normalOffset + 1] = ny
    normalXYZ[normalOffset + 2] = nz
    ao[pixel] = labPbr && normal !== undefined ? normal[offset + 2] / 255 : 1
    roughness[pixel] = mer === undefined ? 1 : labPbr || oldPbr ? (1 - mer[offset] / 255) ** 2 : mer[offset + 2] / 255
    metallic[pixel] = mer === undefined ? 0 : labPbr ? Number(mer[offset + 1] >= 230) : oldPbr ? mer[offset + 1] / 255 : mer[offset] / 255
    // labPBR的完全不透明alpha是无发光哨兵，法线alpha存储高度
    emissive[pixel] = mer === undefined ? 0 : labPbr
      ? mer[offset + 3] === 255 ? 0 : mer[offset + 3] / 254
      : oldPbr ? mer[offset + 2] / 255 : mer[offset + 1] / 255
  }
  return { width, height, profile, albedo, normalXYZ, roughness, metallic, emissive, ao }
}

function validatePreviewData(data: MaterialPreviewData): number {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(uiText("core.advanced.pbrPreview.dataMustBeMaterialPreviewdata"))
  const pixelCount = validateDimensions(data.width, data.height, 'data')
  validateProfile(data.profile)
  if (!(data.albedo instanceof Uint8Array) || data.albedo.length !== pixelCount * 4
    || !(data.normalXYZ instanceof Float32Array) || data.normalXYZ.length !== pixelCount * 3
    || !(data.roughness instanceof Float32Array) || data.roughness.length !== pixelCount
    || !(data.metallic instanceof Float32Array) || data.metallic.length !== pixelCount
    || !(data.emissive instanceof Float32Array) || data.emissive.length !== pixelCount
    || !(data.ao instanceof Float32Array) || data.ao.length !== pixelCount) {
    throw new Error(uiText("core.advanced.pbrPreview.dataContainsAnInvalidMaterialCorridorBuffer"))
  }
  return pixelCount
}

function validateScalar(value: number, channel: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(uiText("core.advanced.pbrPreview.itHasToBeALimitedUnitization", channel))
  return value
}

function validateNormal(data: Float32Array, offset: number): void {
  const nx = data[offset], ny = data[offset + 1], nz = data[offset + 2]
  const length = Math.hypot(nx, ny, nz)
  if (!Number.isFinite(length) || Math.abs(length - 1) > 0.00001) throw new Error(uiText("core.advanced.pbrPreview.normalxyzMustBeALimitedUnitVector"))
}

function encodeChannel(data: MaterialPreviewData, channel: MaterialPreviewRgbaChannelName, pixelCount: number): Uint8Array {
  if (channel === 'albedo') return Uint8Array.from(data.albedo)
  const result = new Uint8Array(pixelCount * 4)
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * 4
    if (channel === 'normal') {
      const normalOffset = pixel * 3
      validateNormal(data.normalXYZ, normalOffset)
      for (let component = 0; component < 3; component++) {
        result[offset + component] = Math.round((Math.max(-1, Math.min(1, data.normalXYZ[normalOffset + component])) * 0.5 + 0.5) * 255)
      }
    } else {
      const value = Math.round(validateScalar(data[channel][pixel], channel) * 255)
      result[offset] = result[offset + 1] = result[offset + 2] = value
    }
    result[offset + 3] = 255
  }
  return result
}

// 标量复制到RGB以支持不同材质贴图采样通道，材质alpha固定为完全不透明
export function materialPreviewChannelToRgba(data: MaterialPreviewData, channel: MaterialPreviewRgbaChannelName): Uint8Array {
  const pixelCount = validatePreviewData(data)
  if (channel !== 'albedo' && channel !== 'normal' && channel !== 'roughness'
    && channel !== 'metallic' && channel !== 'emissive' && channel !== 'ao') {
    throw new Error(uiText("core.advanced.pbrPreview.channelMustBeAlbedoNormalRoughnessMetallic"))
  }
  return encodeChannel(data, channel, pixelCount)
}

export function materialPreviewToRgbaTextures(data: MaterialPreviewData): MaterialPreviewRgbaChannels {
  const pixelCount = validatePreviewData(data)
  return {
    width: data.width,
    height: data.height,
    albedo: encodeChannel(data, 'albedo', pixelCount),
    normal: encodeChannel(data, 'normal', pixelCount),
    roughness: encodeChannel(data, 'roughness', pixelCount),
    metallic: encodeChannel(data, 'metallic', pixelCount),
    emissive: encodeChannel(data, 'emissive', pixelCount),
    ao: encodeChannel(data, 'ao', pixelCount)
  }
}

export function sampleMaterialPreview(data: MaterialPreviewData, x: number, y: number): MaterialPreviewPixel {
  validatePreviewData(data)
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= data.width || y >= data.height) {
    throw new Error(uiText("core.advanced.pbrPreview.sampCoordinatesMustBeIntegersWithinThe"))
  }
  const pixel = y * data.width + x
  const offset = pixel * 4
  const normalOffset = pixel * 3
  validateNormal(data.normalXYZ, normalOffset)
  return {
    x, y,
    albedo: [data.albedo[offset] / 255, data.albedo[offset + 1] / 255, data.albedo[offset + 2] / 255, data.albedo[offset + 3] / 255],
    normalXYZ: [data.normalXYZ[normalOffset], data.normalXYZ[normalOffset + 1], data.normalXYZ[normalOffset + 2]],
    roughness: validateScalar(data.roughness[pixel], 'roughness'),
    metallic: validateScalar(data.metallic[pixel], 'metallic'),
    emissive: validateScalar(data.emissive[pixel], 'emissive'),
    ao: validateScalar(data.ao[pixel], 'ao')
  }
}

function summarizeChannel(values: Float32Array, channel: string): MaterialPreviewChannelSummary {
  let total = 0, min = 1, max = 0
  for (const value of values) {
    validateScalar(value, channel)
    total += value
    min = Math.min(min, value)
    max = Math.max(max, value)
  }
  return { average: total / values.length, min, max }
}

export function summarizeMaterialPreview(data: MaterialPreviewData): MaterialPreviewSummary {
  const pixelCount = validatePreviewData(data)
  const albedoTotal = [0, 0, 0, 0]
  const normalTotal = [0, 0, 0]
  let transparentPixels = 0, opaquePixels = 0
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * 4
    const normalOffset = pixel * 3
    validateNormal(data.normalXYZ, normalOffset)
    for (let channel = 0; channel < 4; channel++) albedoTotal[channel] += data.albedo[offset + channel]
    for (let channel = 0; channel < 3; channel++) normalTotal[channel] += data.normalXYZ[normalOffset + channel]
    if (data.albedo[offset + 3] === 0) transparentPixels++
    if (data.albedo[offset + 3] === 255) opaquePixels++
  }
  return {
    profile: data.profile,
    width: data.width,
    height: data.height,
    pixelCount,
    transparentPixels,
    translucentPixels: pixelCount - transparentPixels - opaquePixels,
    opaquePixels,
    averageAlbedo: [albedoTotal[0] / (255 * pixelCount), albedoTotal[1] / (255 * pixelCount),
      albedoTotal[2] / (255 * pixelCount), albedoTotal[3] / (255 * pixelCount)],
    averageNormalXYZ: [normalTotal[0] / pixelCount, normalTotal[1] / pixelCount, normalTotal[2] / pixelCount],
    roughness: summarizeChannel(data.roughness, 'roughness'),
    metallic: summarizeChannel(data.metallic, 'metallic'),
    emissive: summarizeChannel(data.emissive, 'emissive'),
    ao: summarizeChannel(data.ao, 'ao')
  }
}
