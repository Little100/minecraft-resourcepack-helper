import { uiText } from '../../i18n/messages'
import { decodeTexturePng as decodePng } from './pngCodec'
import { PNG } from 'pngjs'

export interface PbrGeneratedFile {
  path: string
  content: Uint8Array | string
}

export const LAB_PBR_METALS = Object.freeze({
  iron: 230, gold: 231, aluminum: 232, chrome: 233,
  copper: 234, lead: 235, platinum: 236, silver: 237, custom: 255
})

export type LabPbrMetal = keyof typeof LAB_PBR_METALS
export type PbrEdgeMode = 'clamp' | 'wrap'

export interface HeightNormalOptions {
  normalStrength?: number
  edgeMode?: PbrEdgeMode
  ambientOcclusion?: number
}

export interface PbrGenerateOptions extends HeightNormalOptions {
  texturePath: string
  albedoPng: Uint8Array
  heightPng?: Uint8Array
  roughness?: number
  metalness?: number
  metal?: LabPbrMetal
  porosity?: number
  emission?: number
  dielectricF0?: number
  normalSuffix?: '_n' | '_normal'
}

export interface PbrGenerationResult {
  files: PbrGeneratedFile[]
  width: number
  height: number
  format: 'labPBR-1.3' | 'oldPBR'
  requiresShader: true
  warnings: string[]
}

const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]

function range(value: number | undefined, fallback: number, name: string, max = 1): number {
  const result = value ?? fallback
  if (!Number.isFinite(result) || result < 0 || result > max) throw new Error(uiText("core.advanced.pbr.itHasToBeAtZeroBetween", name, max))
  return result
}


function encodePng(width: number, height: number, data: Buffer): Uint8Array {
  const image = new PNG({ width, height })
  image.data = data
  return PNG.sync.write(image, { colorType: 6 })
}

function settings(options: HeightNormalOptions): Required<HeightNormalOptions> {
  const edgeMode = options.edgeMode ?? 'clamp'
  if (edgeMode !== 'clamp' && edgeMode !== 'wrap') throw new Error(uiText("core.advanced.pbr.edgemodeOnlySupportsClapOrWrap"))
  return {
    normalStrength: range(options.normalStrength, 1, 'normalStrength', 128),
    ambientOcclusion: range(options.ambientOcclusion, 1, 'ambientOcclusion'),
    edgeMode
  }
}

function luminance(data: Buffer, index: number): number {
  return (data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722) / 255
}

// 材质图的alpha存储高度或发光，不使用底图的透明度
function normalPixels(source: PNG, options: Required<HeightNormalOptions>, coverage: Buffer = source.data): Buffer {
  const { width, height, data } = source
  const result = Buffer.alloc(width * height * 4)
  const coord = (value: number, size: number): number => options.edgeMode === 'wrap'
    ? (value + size) % size : Math.max(0, Math.min(size - 1, value))
  const sample = (x: number, y: number, fallback: number): number => {
    const offset = (coord(y, height) * width + coord(x, width)) * 4
    return coverage[offset + 3] === 0 || data[offset + 3] === 0 ? fallback : luminance(data, offset)
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4
      if (coverage[index + 3] === 0) {
        result.set([128, 128, 255, 255], index)
        continue
      }
      const h = data[index + 3] === 0 ? 1 : luminance(data, index)
      const nx = -(sample(x + 1, y, h) - sample(x - 1, y, h)) * options.normalStrength / 2
      const ny = -(sample(x, y + 1, h) - sample(x, y - 1, h)) * options.normalStrength / 2
      const length = Math.hypot(nx, ny, 1)
      result[index] = Math.round((nx / length * 0.5 + 0.5) * 255)
      result[index + 1] = Math.round((ny / length * 0.5 + 0.5) * 255)
      while (Math.hypot(result[index] / 127.5 - 1, result[index + 1] / 127.5 - 1) > 1) {
        const channel = Math.abs(result[index] - 127.5) >= Math.abs(result[index + 1] - 127.5) ? index : index + 1
        result[channel] += result[channel] > 127.5 ? -1 : 1
      }
      result[index + 2] = Math.round(options.ambientOcclusion * 255)
      result[index + 3] = Math.max(1, Math.round(h * 255))
    }
  }
  return result
}

export function heightToNormalPng(heightPng: Uint8Array, options: HeightNormalOptions = {}): Uint8Array {
  const input = decodePng(heightPng, uiText("core.advanced.pbr.heightChart"))
  return encodePng(input.width, input.height, normalPixels(input, settings(options)))
}

export function generatePbrFiles(options: PbrGenerateOptions): PbrGenerationResult {
  const texturePath = options.texturePath
  if (typeof texturePath !== 'string' || !/^assets\/[a-z0-9_.-]+\/textures\/(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.png$/.test(texturePath)
    || texturePath.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error(uiText("core.advanced.pbr.texturepathMustBeSafeAssetsNamespaceTextures"))
  }
  const normalSuffix = options.normalSuffix ?? '_n'
  if (normalSuffix !== '_n' && normalSuffix !== '_normal') throw new Error(uiText("core.advanced.pbr.normalsuffixOnlySupportsNOrNormal"))
  const normalOptions = settings(options)
  const roughness = range(options.roughness, 0.5, 'roughness')
  const metalness = range(options.metalness, 0, 'metalness')
  const porosity = range(options.porosity, 0, 'porosity')
  const emission = range(options.emission, 0, 'emission')
  const dielectricF0 = range(options.dielectricF0, 0.04, 'dielectricF0', 229 / 255)
  const metal = options.metal ?? 'custom'
  if (!Object.hasOwn(LAB_PBR_METALS, metal)) throw new Error(uiText("core.advanced.pbr.metalIsNotASupportedLabpbrMetal"))
  const albedo = decodePng(options.albedoPng, uiText("core.advanced.pbr.bottomChart"))
  const height = options.heightPng === undefined ? albedo : decodePng(options.heightPng, uiText("core.advanced.pbr.heightChart"))
  if (albedo.width !== height.width || albedo.height !== height.height) throw new Error(uiText("core.advanced.pbr.theHeightAndBaseScaleMustBe"))
  const specular = Buffer.alloc(albedo.width * albedo.height * 4)
  const smoothnessByte = Math.round((1 - Math.sqrt(roughness)) * 255)
  const f0Byte = Math.round(dielectricF0 * 255)
  const emissionByte = Math.round(emission * 254)
  for (let y = 0; y < albedo.height; y++) {
    for (let x = 0; x < albedo.width; x++) {
      const index = (y * albedo.width + x) * 4
      if (albedo.data[index + 3] === 0) {
        specular.set([0, f0Byte, 0, 0], index)
        continue
      }
      const metallic = metalness === 1 || metalness > (BAYER[y % 4][x % 4] + 0.5) / 16
      specular.set([smoothnessByte, metallic ? LAB_PBR_METALS[metal] : f0Byte,
        metallic ? 0 : Math.round(porosity * 64), emissionByte], index)
    }
  }
  const warnings = [uiText("core.advanced.pbr.shaderNeedsToBeEnabledForLabpbr")]
  if (options.heightPng === undefined) warnings.push(uiText("core.advanced.pbr.noHeightMapsProvidedAndCondensedCones"))
  if (normalSuffix === '_normal') warnings.push(uiText("core.advanced.pbr.couldNotCloseTemporaryFolderS"))
  if (metalness > 0 && metalness < 1) warnings.push(uiText("core.advanced.pbr.labpbrDoesNotHaveAContinuousMetalness"))
  if (metalness > 0 && porosity > 0) warnings.push(uiText("core.advanced.pbr.metallicPixelsZeroPorosityNonMetallicPixels"))
  const stem = texturePath.slice(0, -4)
  return {
    files: [
      { path: texturePath, content: Uint8Array.from(options.albedoPng) },
      { path: `${stem}${normalSuffix}.png`, content: encodePng(albedo.width, albedo.height, normalPixels(height, normalOptions, albedo.data)) },
      { path: `${stem}_s.png`, content: encodePng(albedo.width, albedo.height, specular) }
    ],
    width: albedo.width, height: albedo.height, format: 'labPBR-1.3', requiresShader: true, warnings
  }
}




// 经典通道使用完整RGB法线与平滑度、金属度、自发光材质图
export function generateOldPbrFiles(options: PbrGenerateOptions): PbrGenerationResult {
  const generated = generatePbrFiles(options)
  const metalness = Math.round(range(options.metalness, 0, 'metalness') * 255)
  const emission = Math.round(range(options.emission, 0, 'emission') * 255)
  const files = generated.files.map(file => {
    if (typeof file.content === 'string' || file.path === options.texturePath) return file
    const image = decodePng(file.content, uiText("core.advanced.pbr.materialMap"))
    for (let offset = 0; offset < image.data.length; offset += 4) {
      if (file.path.endsWith('_s.png')) {
        image.data[offset + 1] = metalness
        image.data[offset + 2] = emission
        image.data[offset + 3] = 255
      } else {
        const x = image.data[offset] / 127.5 - 1, y = image.data[offset + 1] / 127.5 - 1
        image.data[offset + 2] = Math.round((Math.sqrt(Math.max(0, 1 - x * x - y * y)) * 0.5 + 0.5) * 255)
      }
    }
    return { path: file.path, content: encodePng(image.width, image.height, image.data) }
  })
  return { ...generated, files, format: 'oldPBR', warnings: [uiText("core.advanced.pbr.possibilityOfTheClassicOldpbrChannelNeeds"), uiText("core.advanced.pbr.estimateCondensationFromBottomFigureToProvide")] }
}
