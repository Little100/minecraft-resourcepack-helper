import { uiText } from '../i18n/messages'
export interface WatermarkImage {
  width: number
  height: number
  data: Uint8Array | Uint8ClampedArray
}

export interface WatermarkPoint { x: number; y: number }
export type WatermarkCorners = readonly [WatermarkPoint, WatermarkPoint, WatermarkPoint, WatermarkPoint]

export interface EmbedTextureWatermarkOptions {
  key: Uint8Array
  id: string
  strength?: number
}

export interface ExtractTextureWatermarkOptions {
  key: Uint8Array
  minimumConfidence?: number
  corners?: WatermarkCorners
}

export interface TextureWatermarkExtraction {
  status: 'verified' | 'not-detected'
  authenticated: boolean
  id?: string
  confidence: number
  correctedCodewords: number
  algorithm: 'mcrh-dct-v1'
}

export interface TextureWatermarkEmbedding {
  image: WatermarkImage
  id: string
  confidence: number
  psnr: number
  warnings: string[]
  algorithm: 'mcrh-dct-v1'
}

export const TEXTURE_WATERMARK_DEFAULTS = Object.freeze({
  enabled: false,
  algorithm: 'mcrh-dct-v1' as const,
  minimumSide: 256,
  canonicalSide: 256,
  strength: 36,
  minimumConfidence: 0.8,
  maximumPixels: 16_777_216,
  minimumKeyBytes: 16
})

const SIDE = TEXTURE_WATERMARK_DEFAULTS.canonicalSide
const BLOCK = 8
const BLOCKS = (SIDE / BLOCK) ** 2
const TAG_BYTES = 12
const HEADER_BYTES = 6
const PAYLOAD_BYTES = HEADER_BYTES + TAG_BYTES
const CODE_BITS = PAYLOAD_BYTES * 2 * 7
const REPEATS = Math.floor(BLOCKS / CODE_BITS)
const MAGIC = [0x4d, 0x01] as const
const BASIS_DIFFERENCE = Float64Array.from({ length: 64 }, (_, index) => {
  const x = index % BLOCK
  const y = Math.floor(index / BLOCK)
  const cosine = (position: number, frequency: number) => Math.cos((2 * position + 1) * frequency * Math.PI / 16)
  return (cosine(x, 1) * cosine(y, 2) - cosine(x, 2) * cosine(y, 1)) / 4
})

function validateImage(image: WatermarkImage, minimumSide: number): void {
  if (!image || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
    || image.width < minimumSide || image.height < minimumSide
    || image.width * image.height > TEXTURE_WATERMARK_DEFAULTS.maximumPixels) {
    throw new Error(uiText("core.textureWatermark.watermarkImageAtLeastEverySidePixels", minimumSide, TEXTURE_WATERMARK_DEFAULTS.maximumPixels))
  }
  if (!(image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray)
    || image.data.length !== image.width * image.height * 4) throw new Error(uiText("core.textureWatermark.watermarkRequiresCompleteRgbaByteData"))
  for (let index = 3; index < image.data.length; index += 4) {
    if (image.data[index] !== 255) throw new Error(uiText("core.textureWatermark.theLubbleWatermarkOnlySupportsCompletelyNon"))
  }
}

function snapshotImage(image: WatermarkImage): WatermarkImage {
  return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) }
}

async function prepareKey(raw: Uint8Array) {
  if (!(raw instanceof Uint8Array) || raw.length < TEXTURE_WATERMARK_DEFAULTS.minimumKeyBytes || raw.length > 64) {
    throw new Error(uiText("core.textureWatermark.waterStampKeysMustBeToBytes"))
  }
  if (!globalThis.crypto?.subtle) throw new Error(uiText("core.textureWatermark.watermarkSignatureRequiresWebCryptoHttpsOr"))
  return globalThis.crypto.subtle.importKey('raw', new Uint8Array(raw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

type SigningKey = Awaited<ReturnType<typeof prepareKey>>

async function mac(key: SigningKey, purpose: string, bytes: Uint8Array = new Uint8Array()): Promise<Uint8Array> {
  const prefix = new TextEncoder().encode(`mcrh-dct-v1:${purpose}:`)
  const message = new Uint8Array(prefix.length + bytes.length)
  message.set(prefix)
  message.set(bytes, prefix.length)
  return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, message))
}

async function layout(key: SigningKey): Promise<{ blocks: Uint16Array; signs: Int8Array }> {
  const seed = await mac(key, 'layout')
  let state = new DataView(seed.buffer).getUint32(0) || 0x6d637268
  const random = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
  }
  const blocks = Uint16Array.from({ length: BLOCKS }, (_, index) => index)
  for (let index = blocks.length - 1; index > 0; index--) {
    const other = random() % (index + 1)
    const previous = blocks[index]
    blocks[index] = blocks[other]
    blocks[other] = previous
  }
  const signs = Int8Array.from({ length: CODE_BITS * REPEATS }, () => random() & 1 ? 1 : -1)
  return { blocks, signs }
}

function hammingEncode(bytes: Uint8Array): Uint8Array {
  const bits = new Uint8Array(CODE_BITS)
  let offset = 0
  for (const byte of bytes) {
    for (const shift of [4, 0]) {
      const nibble = (byte >>> shift) & 15
      const a = (nibble >>> 3) & 1
      const b = (nibble >>> 2) & 1
      const c = (nibble >>> 1) & 1
      const d = nibble & 1
      bits.set([a ^ b ^ d, a ^ c ^ d, a, b ^ c ^ d, b, c, d], offset)
      offset += 7
    }
  }
  return bits
}

function hammingDecode(bits: Uint8Array): { bytes: Uint8Array; correctedCodewords: number } {
  const bytes = new Uint8Array(PAYLOAD_BYTES)
  let correctedCodewords = 0
  for (let offset = 0; offset < bits.length; offset += 7) {
    const word = bits.slice(offset, offset + 7)
    const syndrome = (word[0] ^ word[2] ^ word[4] ^ word[6])
      | ((word[1] ^ word[2] ^ word[5] ^ word[6]) << 1)
      | ((word[3] ^ word[4] ^ word[5] ^ word[6]) << 2)
    if (syndrome) { word[syndrome - 1] ^= 1; correctedCodewords++ }
    const nibble = (word[2] << 3) | (word[4] << 2) | (word[5] << 1) | word[6]
    const nibbleIndex = offset / 7
    bytes[Math.floor(nibbleIndex / 2)] |= nibble << (nibbleIndex % 2 === 0 ? 4 : 0)
  }
  return { bytes, correctedCodewords }
}

function sample(data: WatermarkImage['data'] | Float64Array, width: number, height: number, x: number, y: number, channel: number, stride: number): number {
  const clampedX = Math.min(width - 1, Math.max(0, x))
  const clampedY = Math.min(height - 1, Math.max(0, y))
  const left = Math.floor(clampedX)
  const top = Math.floor(clampedY)
  const right = Math.min(width - 1, left + 1)
  const bottom = Math.min(height - 1, top + 1)
  const dx = clampedX - left
  const dy = clampedY - top
  return (data[(top * width + left) * stride + channel] * (1 - dx)
    + data[(top * width + right) * stride + channel] * dx) * (1 - dy)
    + (data[(bottom * width + left) * stride + channel] * (1 - dx)
    + data[(bottom * width + right) * stride + channel] * dx) * dy
}

function normalizedLuminance(image: WatermarkImage): Float64Array {
  const values = new Float64Array(SIDE * SIDE)
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
      const sx = (x + 0.5) * image.width / SIDE - 0.5
      const sy = (y + 0.5) * image.height / SIDE - 0.5
      values[y * SIDE + x] = sample(image.data, image.width, image.height, sx, sy, 0, 4) * 0.299
        + sample(image.data, image.width, image.height, sx, sy, 1, 4) * 0.587
        + sample(image.data, image.width, image.height, sx, sy, 2, 4) * 0.114
    }
  }
  return values
}

function blockOrigin(block: number): number {
  return Math.floor(block / (SIDE / BLOCK)) * BLOCK * SIDE + (block % (SIDE / BLOCK)) * BLOCK
}

function coefficientDifference(values: Float64Array, block: number): number {
  const origin = blockOrigin(block)
  let difference = 0
  for (let index = 0; index < 64; index++) {
    difference += values[origin + Math.floor(index / BLOCK) * SIDE + index % BLOCK] * BASIS_DIFFERENCE[index]
  }
  return difference
}

function readBits(image: WatermarkImage, spread: Awaited<ReturnType<typeof layout>>) {
  const values = normalizedLuminance(image)
  const votes = new Float64Array(CODE_BITS)
  const observations = new Float64Array(CODE_BITS * REPEATS)
  for (let index = 0; index < observations.length; index++) {
    const difference = coefficientDifference(values, spread.blocks[index]) * spread.signs[index]
    observations[index] = Math.max(-1, Math.min(1, difference / TEXTURE_WATERMARK_DEFAULTS.strength))
    votes[index % CODE_BITS] += observations[index]
  }
  return { bits: Uint8Array.from(votes, value => value >= 0 ? 1 : 0), observations }
}

async function extractPrepared(image: WatermarkImage, key: SigningKey, spread: Awaited<ReturnType<typeof layout>>, minimumConfidence: number): Promise<TextureWatermarkExtraction> {
  const { bits, observations } = readBits(image, spread)
  const { bytes, correctedCodewords } = hammingDecode(bits)
  const corrected = hammingEncode(bytes)
  let agreement = 0
  let energy = 0
  for (let index = 0; index < observations.length; index++) {
    agreement += observations[index] * (corrected[index % CODE_BITS] ? 1 : -1)
    energy += Math.abs(observations[index])
  }
  const confidence = energy > 0 ? Math.max(0, Math.min(1, agreement / energy)) : 0
  const expectedTag = await mac(key, 'payload', bytes.slice(0, HEADER_BYTES))
  let mismatch = (bytes[0] ^ MAGIC[0]) | (bytes[1] ^ MAGIC[1])
  for (let index = 0; index < TAG_BYTES; index++) mismatch |= bytes[HEADER_BYTES + index] ^ expectedTag[index]
  const authenticated = mismatch === 0 && confidence >= minimumConfidence
  const result: TextureWatermarkExtraction = {
    status: authenticated ? 'verified' : 'not-detected', authenticated, confidence, correctedCodewords,
    algorithm: TEXTURE_WATERMARK_DEFAULTS.algorithm
  }
  if (authenticated) result.id = Array.from(bytes.slice(2, HEADER_BYTES), byte => byte.toString(16).padStart(2, '0')).join('')
  return result
}

// DCT 系数排序、密钥扩频与 Hamming 纠错的独立实现，算法背景与限制见配套文档
export async function embedTextureWatermark(source: WatermarkImage, options: EmbedTextureWatermarkOptions): Promise<TextureWatermarkEmbedding> {
  validateImage(source, TEXTURE_WATERMARK_DEFAULTS.minimumSide)
  if (!options || typeof options.id !== 'string' || !/^[0-9a-f]{8}$/i.test(options.id)) throw new Error(uiText("core.textureWatermark.watermarkIdentificationMustBeAnEightDigit"))
  const strength = options.strength ?? TEXTURE_WATERMARK_DEFAULTS.strength
  if (!Number.isFinite(strength) || strength < 24 || strength > 64) throw new Error(uiText("core.textureWatermark.watermarkStrengthMustBeBetweenAnd"))
  const original = snapshotImage(source)
  const image = snapshotImage(original)
  const id = options.id.toLowerCase()
  const key = await prepareKey(options.key)
  const spread = await layout(key)
  const payload = new Uint8Array(PAYLOAD_BYTES)
  payload.set(MAGIC)
  for (let index = 0; index < 4; index++) payload[index + 2] = Number.parseInt(id.slice(index * 2, index * 2 + 2), 16)
  payload.set((await mac(key, 'payload', payload.slice(0, HEADER_BYTES))).slice(0, TAG_BYTES), HEADER_BYTES)
  const bits = hammingEncode(payload)
  for (let pass = 0; pass < 3; pass++) {
    const values = normalizedLuminance(image)
    const residual = new Float64Array(SIDE * SIDE)
    for (let index = 0; index < CODE_BITS * REPEATS; index++) {
      const block = spread.blocks[index]
      const sign = (bits[index % CODE_BITS] ? 1 : -1) * spread.signs[index]
      const difference = coefficientDifference(values, block)
      const adjustment = sign * Math.max(0, strength - sign * difference) / 2
      const origin = blockOrigin(block)
      for (let pixel = 0; pixel < 64; pixel++) {
        residual[origin + Math.floor(pixel / BLOCK) * SIDE + pixel % BLOCK] = adjustment * BASIS_DIFFERENCE[pixel]
      }
    }
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const delta = sample(residual, SIDE, SIDE, (x + 0.5) * SIDE / image.width - 0.5, (y + 0.5) * SIDE / image.height - 0.5, 0, 1)
        const offset = (y * image.width + x) * 4
        for (let channel = 0; channel < 3; channel++) image.data[offset + channel] = Math.round(Math.max(0, Math.min(255, image.data[offset + channel] + delta)))
      }
    }
  }
  const verification = await extractPrepared(image, key, spread, TEXTURE_WATERMARK_DEFAULTS.minimumConfidence)
  if (!verification.authenticated || verification.id !== id) throw new Error(uiText("core.textureWatermark.theWaterPrintingOfTheCurrentImage"))
  let squaredError = 0
  for (let offset = 0; offset < image.data.length; offset += 4) {
    for (let channel = 0; channel < 3; channel++) squaredError += (image.data[offset + channel] - original.data[offset + channel]) ** 2
  }
  const mse = squaredError / (image.width * image.height * 3)
  const psnr = mse === 0 ? Infinity : 10 * Math.log10(255 ** 2 / mse)
  const warnings = [
    uiText("core.textureWatermark.thisModeDamagesTheExportOfRgb"),
    uiText("core.textureWatermark.noRealPhotoExtractionNoGuaranteedRecovery")
  ]
  if (psnr < 38) warnings.push(uiText("core.textureWatermark.watermarksMayAffectVisualQualityPleaseCheck"))
  return { image, id, confidence: verification.confidence, psnr, warnings, algorithm: TEXTURE_WATERMARK_DEFAULTS.algorithm }
}

export async function extractTextureWatermark(source: WatermarkImage, options: ExtractTextureWatermarkOptions): Promise<TextureWatermarkExtraction> {
  validateImage(source, TEXTURE_WATERMARK_DEFAULTS.minimumSide)
  if (!options) throw new Error(uiText("core.textureWatermark.weNeedAKeyToExtractThe"))
  const threshold = options.minimumConfidence ?? TEXTURE_WATERMARK_DEFAULTS.minimumConfidence
  if (!Number.isFinite(threshold) || threshold < 0.7 || threshold > 1) throw new Error(uiText("core.textureWatermark.watermarkErrorThresholdMustBeBetweenAnd"))
  const image = options.corners ? rectifyTextureWatermarkImage(source, options.corners) : snapshotImage(source)
  const key = await prepareKey(options.key)
  return extractPrepared(image, key, await layout(key), threshold)
}

function solveLinear(matrix: number[][]): number[] {
  const count = matrix.length
  for (let column = 0; column < count; column++) {
    let pivot = column
    for (let row = column + 1; row < count; row++) if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row
    if (Math.abs(matrix[pivot][column]) < 1e-10) throw new Error(uiText("core.textureWatermark.theFourCornersOfThePictureAre"))
    ;[matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]]
    const divisor = matrix[column][column]
    for (let entry = column; entry <= count; entry++) matrix[column][entry] /= divisor
    for (let row = 0; row < count; row++) {
      if (row === column) continue
      const factor = matrix[row][column]
      for (let entry = column; entry <= count; entry++) matrix[row][entry] -= factor * matrix[column][entry]
    }
  }
  return matrix.map(row => row[count])
}

// 四角顺序为左上、右上、右下、左下，坐标采用原始照片的像素中心
export function rectifyTextureWatermarkImage(source: WatermarkImage, corners: WatermarkCorners): WatermarkImage {
  validateImage(source, TEXTURE_WATERMARK_DEFAULTS.minimumSide)
  if (!Array.isArray(corners) || corners.length !== 4) throw new Error(uiText("core.textureWatermark.theVisualCorrectionTakesFourOrderlyAngles"))
  const points = corners.map(point => ({ x: point?.x, y: point?.y }))
  let area = 0
  for (let index = 0; index < 4; index++) {
    const point = points[index]
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0
      || point.x > source.width - 1 || point.y > source.height - 1) throw new Error(uiText("core.textureWatermark.theCornerOfThePhotoMustBe"))
    const next = points[(index + 1) % 4]
    const after = points[(index + 2) % 4]
    const cross = (next.x - point.x) * (after.y - next.y) - (next.y - point.y) * (after.x - next.x)
    if (!(cross > 1)) throw new Error(uiText("core.textureWatermark.theFourCornersOfThePictureMust"))
    area += point.x * next.y - next.x * point.y
  }
  if (area / 2 < (SIDE - 1) ** 2) throw new Error(uiText("core.textureWatermark.theWatermarksInThePhotosAreToo"))
  const unitCorners = [[0, 0], [1, 0], [1, 1], [0, 1]]
  const equations: number[][] = []
  for (let index = 0; index < 4; index++) {
    const [u, v] = unitCorners[index]
    const { x, y } = points[index]
    equations.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x])
    equations.push([0, 0, 0, u, v, 1, -u * y, -v * y, y])
  }
  const h = solveLinear(equations)
  const image: WatermarkImage = { width: SIDE, height: SIDE, data: new Uint8ClampedArray(SIDE * SIDE * 4) }
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
      const u = x / (SIDE - 1)
      const v = y / (SIDE - 1)
      const divisor = h[6] * u + h[7] * v + 1
      if (!Number.isFinite(divisor) || divisor < 1e-8) throw new Error(uiText("core.textureWatermark.theFourCornersOfThePictureDo"))
      const sx = (h[0] * u + h[1] * v + h[2]) / divisor
      const sy = (h[3] * u + h[4] * v + h[5]) / divisor
      const offset = (y * SIDE + x) * 4
      for (let channel = 0; channel < 3; channel++) image.data[offset + channel] = Math.round(sample(source.data, source.width, source.height, sx, sy, channel, 4))
      image.data[offset + 3] = 255
    }
  }
  return image
}

