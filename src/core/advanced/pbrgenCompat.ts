import { uiText } from '../../i18n/messages'
import { inflateSync } from 'node:zlib'
import { PNG } from 'pngjs'

export interface PbrgenImageData {
  width: number
  height: number
  data: Uint8Array
}

export interface PbrgenGenerateOptions {
  texturePath: string
  albedoPng: Uint8Array
  includeAlbedo?: boolean
}

export interface PbrgenGeneratedFile {
  path: string
  content: Uint8Array
}

export interface PbrgenGenerationResult {
  files: PbrgenGeneratedFile[]
  width: number
  height: number
  format: 'pbrgen-mer'
  requiresShader: true
  warnings: string[]
}

export interface PbrgenMaterial {
  metallic: boolean
  emissive: boolean
  smooth: boolean
}

export const PBRGEN_COMPAT_PROFILE = Object.freeze({
  heightmapContrast: 1.5,
  normalStrength: 2,
  normalZ: 255,
  normalSobel: false,
  edgeMode: 'clamp' as const,
  normalSuffix: '_n' as const,
  merSuffix: '_s' as const,
  includeAlbedo: true
})

const MAX_PNG_BYTES = 32 * 1024 * 1024
const MAX_PIXELS = 4 * 1024 * 1024
const MAX_DIMENSION = 4096
const MAX_PNG_CHUNKS = 4096
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const METAL_NAMES = ['iron_', 'gold_', 'netherite_', 'copper_']
const EMISSIVE_NAMES = ['redstone_lamp_on', 'furnace_front_on', 'lantern', 'torch', 'magma', 'glowstone', 'lava', 'amethyst_']
const SMOOTH_NAMES = ['glass', 'ice']
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  return value >>> 0
})

function validateDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
    || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    throw new Error(uiText("core.advanced.pbrgenCompat.imageSizeMustBePositiveIntegerWith"))
  }
}

function validateImage(image: PbrgenImageData): void {
  if (!image || typeof image !== 'object') throw new Error(uiText("core.advanced.pbrgenCompat.imageMustBeRgbaImageData"))
  validateDimensions(image.width, image.height)
  if (!(image.data instanceof Uint8Array) || image.data.byteLength !== image.width * image.height * 4) {
    throw new Error(uiText("core.advanced.pbrgenCompat.imageDataMustBeEqualToWidth"))
  }
}

function validateTexturePath(texturePath: string): void {
  if (typeof texturePath !== 'string' || !texturePath.endsWith('.png') || !/^assets\/[a-z0-9_.-]+\/textures\/(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.png$/.test(texturePath)
    || texturePath.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error(uiText("core.advanced.pbr.texturepathMustBeSafeAssetsNamespaceTextures"))
  }
}

export function inferPbrgenMaterial(texturePath: string): PbrgenMaterial {
  if (typeof texturePath !== 'string' || !texturePath) throw new Error(uiText("core.advanced.pbrgenCompat.texturepathMustBeANonEmptyFilename"))
  const name = texturePath.split(/[\\/]/).at(-1)!.toLowerCase()
  return {
    metallic: METAL_NAMES.some(pattern => name.includes(pattern)),
    emissive: EMISSIVE_NAMES.some(pattern => name.includes(pattern)),
    smooth: SMOOTH_NAMES.some(pattern => name.includes(pattern))
  }
}

function luminance(data: Uint8Array, offset: number): number {
  return Math.trunc(0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2])
}

function heightValues(image: PbrgenImageData): Uint8Array {
  const heights = new Uint8Array(image.width * image.height)
  for (let pixel = 0; pixel < heights.length; pixel++) {
    const adjusted = Math.trunc(128 + (luminance(image.data, pixel * 4) - 128) * PBRGEN_COMPAT_PROFILE.heightmapContrast)
    heights[pixel] = Math.max(0, Math.min(255, adjusted))
  }
  return heights
}

export function generatePbrgenHeightImageData(image: PbrgenImageData): PbrgenImageData {
  validateImage(image)
  const heights = heightValues(image)
  const data = new Uint8Array(heights.length * 4)
  for (let pixel = 0; pixel < heights.length; pixel++) {
    const offset = pixel * 4
    data[offset] = data[offset + 1] = data[offset + 2] = heights[pixel]
    data[offset + 3] = 255
  }
  return { width: image.width, height: image.height, data }
}

// fround保留Java单精度算术和截断编码
function normalChannel(component: number, length: number): number {
  const normalized = Math.fround(component / length)
  const mapped = Math.fround(Math.fround(normalized * 0.5) + 0.5)
  return Math.trunc(Math.fround(mapped * 255))
}

export function generatePbrgenNormalImageData(image: PbrgenImageData): PbrgenImageData {
  validateImage(image)
  const { width, height } = image
  const heights = heightValues(image)
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = (heights[y * width + Math.max(0, x - 1)] - heights[y * width + Math.min(width - 1, x + 1)]) * PBRGEN_COMPAT_PROFILE.normalStrength
      const ny = (heights[Math.max(0, y - 1) * width + x] - heights[Math.min(height - 1, y + 1) * width + x]) * PBRGEN_COMPAT_PROFILE.normalStrength
      const nz = PBRGEN_COMPAT_PROFILE.normalZ
      const square = Math.fround(Math.fround(Math.fround(nx * nx) + Math.fround(ny * ny)) + Math.fround(nz * nz))
      const length = Math.fround(Math.sqrt(square))
      const offset = (y * width + x) * 4
      data[offset] = normalChannel(nx, length)
      data[offset + 1] = normalChannel(ny, length)
      data[offset + 2] = normalChannel(nz, length)
      data[offset + 3] = 255
    }
  }
  return { width, height, data }
}

// 原版map按输入端点夹取，反向映射会恒为outMin，兼容模式保留此行为
function javaMap(value: number, outMin: number, outMax: number): number {
  const mapped = Math.trunc(value * (outMax - outMin) / 255) + outMin
  return Math.max(Math.min(mapped, outMax), outMin)
}

export function generatePbrgenMerImageData(image: PbrgenImageData, texturePath: string): PbrgenImageData {
  validateImage(image)
  const material = inferPbrgenMaterial(texturePath)
  const data = new Uint8Array(image.data.length)
  for (let offset = 0; offset < data.length; offset += 4) {
    const brightness = luminance(image.data, offset)
    const peak = Math.max(image.data[offset], image.data[offset + 1], image.data[offset + 2])
    data[offset] = material.metallic ? javaMap(brightness, 200, 255) : javaMap(brightness, 100, 200)
    data[offset + 1] = material.emissive && peak > 180 ? peak : 0
    data[offset + 2] = material.smooth ? 0 : material.metallic ? javaMap(brightness, 50, 0) : javaMap(brightness, 100, 10)
    data[offset + 3] = 255
  }
  return { width: image.width, height: image.height, data }
}

function chunkCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function scanlineLength(width: number, height: number, depth: number, channels: number, interlace: number): number {
  if (!interlace) return (Math.ceil(width * channels * depth / 8) + 1) * height
  const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
  let size = 0
  for (const [startX, startY, stepX, stepY] of passes) {
    const passWidth = Math.max(0, Math.ceil((width - startX) / stepX))
    const passHeight = Math.max(0, Math.ceil((height - startY) / stepY))
    if (passWidth && passHeight) size += (Math.ceil(passWidth * channels * depth / 8) + 1) * passHeight
  }
  return size
}

function grayToSrgb(sample: number): number {
  return Math.round(255 * (sample <= 0.0031308 ? sample * 12.92 : 1.055 * Math.pow(sample, 1 / 2.4) - 0.055))
}

function decodePng(input: Uint8Array): PbrgenImageData {
  if (!(input instanceof Uint8Array) || input.byteLength < 33 || input.byteLength > MAX_PNG_BYTES) {
    throw new Error(uiText("core.advanced.pbrgenCompat.albedopngMustBeAValidPngFile"))
  }
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error(uiText("core.advanced.pbrgenCompat.albedopngIsNotAValidPng"))
  }
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  validateDimensions(width, height)
  const depth = bytes[24], colorType = bytes[25], interlace = bytes[28]
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType]
  const depths = colorType === 0 ? [1, 2, 4, 8, 16] : colorType === 3 ? [1, 2, 4, 8] : [8, 16]
  if (!channels || !depths.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || interlace > 1) {
    throw new Error(uiText("core.advanced.pbrgenCompat.invalidityOfBitsColourTypeCompressionFiltering"))
  }
  const idat: Buffer[] = []
  const kept: Buffer[] = [bytes.subarray(0, 8)]
  let transparency: Buffer | undefined
  let paletteEntries = 0, transparencySeen = false
  let offset = 8, chunks = 0, ended = false, dataEnded = false
  while (offset + 12 <= bytes.length) {
    if (++chunks > MAX_PNG_CHUNKS) throw new Error(uiText("core.advanced.pbrgenCompat.albedopngPngBlockExceeding"))
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if (length > bytes.length - offset - 12) throw new Error(uiText("core.advanced.pbrgenCompat.albedopngPngBlockCutOff"))
    const end = offset + length + 12
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) || chunkCrc(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) {
      throw new Error(uiText("core.advanced.pbrgenCompat.albedopngPngBlockTypeOrCrcNot"))
    }
    if (type === 'IHDR' && offset !== 8) throw new Error(uiText("core.advanced.pbrgenCompat.albedopngContainsRepeatIhdr"))
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') throw new Error(uiText("core.advanced.pbrgenCompat.albedopngDoesNotSupportApngPleaseProvide"))
    if (type === 'PLTE') {
      if (paletteEntries || idat.length || colorType === 0 || colorType === 4 || !length || length > 768 || length % 3 !== 0) {
        throw new Error(uiText("core.advanced.pbrgenCompat.albedopngPlteIsInvalidPalettesHaveA"))
      }
      paletteEntries = length / 3
      if (colorType === 3 && paletteEntries > 2 ** depth) throw new Error(uiText("core.advanced.pbrgenCompat.albedopngSPaletteItemsExceedTheDigit"))
    }
    if (type === 'tRNS') {
      if (transparencySeen || idat.length || (colorType !== 0 && colorType !== 2 && colorType !== 3)
        || (colorType === 3 && (!paletteEntries || !length || length > paletteEntries))) {
        throw new Error(uiText("core.advanced.pbrgenCompat.albedopngSTrnsInvalid"))
      }
      transparencySeen = true
    }
    if (type === 'IDAT') {
      if (colorType === 3 && !paletteEntries) throw new Error(uiText("core.advanced.pbrgenCompat.albedopngSPalettePngMissingPlte"))
      if (dataEnded) throw new Error(uiText("core.advanced.pbrgenCompat.albedopngSIdtMustBeContinuous"))
      idat.push(bytes.subarray(offset + 8, end - 4))
    } else if (idat.length) dataEnded = true
    if (type === 'tRNS' && (colorType === 0 || colorType === 2)) {
      if (transparency || idat.length || length !== (colorType === 0 ? 2 : 6)) throw new Error(uiText("core.advanced.pbrgenCompat.albedopngSTrnsInvalid"))
      transparency = bytes.subarray(offset + 8, end - 4)
    } else kept.push(bytes.subarray(offset, end))
    offset = end
    if (type === 'IEND') {
      if (length !== 0) throw new Error(uiText("core.advanced.pbrgenCompat.albedopngSIendIsInvalid"))
      ended = true
      break
    }
  }
  if (!ended || offset !== bytes.length || !idat.length) throw new Error(uiText("core.advanced.pbrgenCompat.albedopngLacksCompleteIdatIendOrContains"))
  try {
    const expectedLength = scanlineLength(width, height, depth, channels, interlace)
    const inflated = inflateSync(Buffer.concat(idat), { maxOutputLength: expectedLength })
    if (inflated.length !== expectedLength) throw new Error(uiText("core.advanced.pbrgenCompat.thePngScanLineDoesNotMatch"))
    // 去除非调色板tRNS避免pngjs清零隐藏RGB；Java生成器会读取这些颜色
    const decoded = PNG.sync.read(transparency ? Buffer.concat(kept) : bytes, { checkCRC: true, skipRescale: true })
    const samples: ArrayLike<number> = decoded.data
    const maxSample = colorType === 3 ? 255 : 2 ** depth - 1
    const data = new Uint8Array(width * height * 4)
    for (let pixel = 0; pixel < width * height; pixel++) {
      const index = pixel * 4
      const gray = colorType === 0 || colorType === 4
      const hidden = transparency && (colorType === 0
        ? samples[index] === transparency.readUInt16BE(0)
        : samples[index] === transparency.readUInt16BE(0) && samples[index + 1] === transparency.readUInt16BE(2) && samples[index + 2] === transparency.readUInt16BE(4))
      for (let channel = 0; channel < 3; channel++) {
        const sample = samples[index + channel] / maxSample
        data[index + channel] = gray && depth >= 8 ? grayToSrgb(sample) : Math.round(sample * 255)
      }
      data[index + 3] = hidden ? 0 : Math.round(samples[index + 3] / maxSample * 255)
    }
    return { width, height, data }
  } catch (error) {
    throw new Error(uiText("core.advanced.pbrgenCompat.albedopngDecodedFailed", (error instanceof Error ? error.message : String(error))))
  }
}

function encodePng(image: PbrgenImageData): Uint8Array {
  const png = new PNG({ width: image.width, height: image.height })
  png.data = Buffer.from(image.data)
  return PNG.sync.write(png, { colorType: 2, inputColorType: 6 })
}

export function generatePbrgenFiles(options: PbrgenGenerateOptions): PbrgenGenerationResult {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error(uiText("core.advanced.pbrgenCompat.optionsMustBeAPbrgenGeneratedParameter"))
  for (const key of Object.keys(options)) {
    if (!['texturePath', 'albedoPng', 'includeAlbedo'].includes(key)) throw new Error(uiText("core.advanced.pbrgenCompat.pbrgenFixedAlgorithmsDoNotSupportParameters", key))
  }
  validateTexturePath(options.texturePath)
  const includeAlbedo = options.includeAlbedo === undefined ? PBRGEN_COMPAT_PROFILE.includeAlbedo : options.includeAlbedo
  if (typeof includeAlbedo !== 'boolean') throw new Error(uiText("core.advanced.pbrgenCompat.includeAlbedoMustBeBoolean"))
  const albedo = decodePng(options.albedoPng)
  const stem = options.texturePath.slice(0, -4)
  const warnings = [
    uiText("core.advanced.pbrgenCompat.pbrgenSIsRgbMerInsteadOf"),
    uiText("core.advanced.pbrgenCompat.compatibleRetentionOfOriginalReverseMapPicking"),
    uiText("core.advanced.pbrgenCompat.theHeightOfTheMethodLineIs")
  ]
  for (let index = 3; index < albedo.data.length; index += 4) {
    if (albedo.data[index] !== 255) {
      warnings.push(uiText("core.advanced.pbrgenCompat.formerPbrgenIgnoresBottomChartalphaTransparentPixel"))
      break
    }
  }
  if (/_(?:n|s)\.png$/.test(options.texturePath)) warnings.push(uiText("core.advanced.pbrgenCompat.inputNamesLikeDerivativesBatchCallsShould"))
  const files: PbrgenGeneratedFile[] = []
  if (includeAlbedo) files.push({ path: options.texturePath, content: Uint8Array.from(options.albedoPng) })
  files.push({ path: stem + PBRGEN_COMPAT_PROFILE.normalSuffix + '.png', content: encodePng(generatePbrgenNormalImageData(albedo)) })
  files.push({ path: stem + PBRGEN_COMPAT_PROFILE.merSuffix + '.png', content: encodePng(generatePbrgenMerImageData(albedo, options.texturePath)) })
  return { files, width: albedo.width, height: albedo.height, format: 'pbrgen-mer', requiresShader: true, warnings }
}
