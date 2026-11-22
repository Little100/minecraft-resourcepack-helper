import { uiText } from '../i18n/messages'
import { createHash } from 'node:crypto'
import { Euler, Matrix4, Plane, Vector3 } from 'three'
import { contourSpans, maskRectangles } from './alphaContours'
import { generatedBaseElementCount } from './generatedItemGeometry'
import { decodeTexturePng } from './advanced/pngCodec'
import { JAVA_MODEL_LIMITS, resolveJavaModelTexture, validateJavaModel, type JavaModelData } from './javaModelResources'

type Face = 'north' | 'south' | 'west' | 'east' | 'down' | 'up'
type Image = ReturnType<typeof decodeTexturePng>
type Surface = { name: Face; face: JavaModelData; image: Image; uv: number[] }
const object = (value: unknown): value is JavaModelData => value !== null && typeof value === 'object' && !Array.isArray(value)
const pairs: [Face, Face][] = [['west', 'east'], ['down', 'up'], ['north', 'south']]
const round = (value: number): number => Number(value.toFixed(8))

function baseUv(name: Face, a: number, b: number): number[] {
  if (name === 'north' || name === 'east') return [1 - a, 1 - b]
  if (name === 'up') return [a, b]
  return [a, 1 - b]
}

function mappedUv(surface: Surface, a: number, b: number): number[] {
  let [u, v] = baseUv(surface.name, a, b) as [number, number]
  for (let angle = 0; angle < Number(surface.face.rotation ?? 0); angle += 90) [u, v] = [v, 1 - u]
  return [surface.uv[0]! + (surface.uv[2]! - surface.uv[0]!) * u, surface.uv[1]! + (surface.uv[3]! - surface.uv[1]!) * v]
}

function sameSurface(a: Surface, b: Surface): boolean {
  const material = (surface: Surface): JavaModelData => {
    const face = { ...surface.face }
    delete face.uv; delete face.rotation; delete face.cullface
    return face
  }
  return JSON.stringify(material(a)) === JSON.stringify(material(b)) && [[0, 0], [1, 0], [0, 1]].every(([x, y]) => {
    const uv = mappedUv(a, x!, y!)
    return mappedUv(b, x!, y!).every((value, index) => Math.abs(value - uv[index]!) < 1e-9)
  })
}

function defaultUv(name: Face, from: number[], to: number[]): number[] {
  if (name === 'down') return [from[0]!, 16 - to[2]!, to[0]!, 16 - from[2]!]
  if (name === 'up') return [from[0]!, from[2]!, to[0]!, to[2]!]
  if (name === 'north') return [16 - to[0]!, 16 - to[1]!, 16 - from[0]!, 16 - from[1]!]
  if (name === 'south') return [from[0]!, 16 - to[1]!, to[0]!, 16 - from[1]!]
  if (name === 'west') return [from[2]!, 16 - to[1]!, to[2]!, 16 - from[1]!]
  return [16 - to[2]!, 16 - to[1]!, 16 - from[2]!, 16 - from[1]!]
}

function oppositeFace(surface: Surface): JavaModelData {
  const uv = [...surface.uv], face: JavaModelData = { ...surface.face, uv }
  delete face.cullface
  const vertical = surface.name === 'up' || surface.name === 'down', rotated = Number(surface.face.rotation ?? 0) % 180 !== 0
  const index = vertical !== rotated ? 1 : 0
  ;[uv[index], uv[index + 2]] = [uv[index + 2]!, uv[index]!]
  return face
}

const CONTOUR_FIELD = 'mcrh_alpha_contour'
const planeAxes = (axis: number): [number, number] => axis === 0 ? [2, 1] : axis === 1 ? [0, 2] : [0, 1]
const fingerprint = (elements: JavaModelData[]): string => createHash('sha256').update(JSON.stringify(elements)).digest('hex')

type ReservedPlane = { owner: JavaModelData; plane: Plane }

function modelPlane(element: JavaModelData, axis: number, coordinate: number): Plane {
  const plane = new Plane(new Vector3().setComponent(axis, 1), -coordinate)
  if (!object(element.rotation)) return plane
  const rotation = element.rotation, origin = new Vector3().fromArray(Array.isArray(rotation.origin) ? rotation.origin as number[] : [8, 8, 8])
  const angles = ['x', 'y', 'z'].map(name => Number(rotation.axis === name ? rotation.angle : rotation[name] ?? 0) * Math.PI / 180)
  const transform = new Matrix4().makeTranslation(origin.x, origin.y, origin.z)
    .multiply(new Matrix4().makeRotationFromEuler(new Euler(angles[0], angles[1], angles[2], 'ZYX')))
  if (rotation.rescale) {
    const index = typeof rotation.axis === 'string' ? ['x', 'y', 'z'].indexOf(rotation.axis) : angles.findIndex(Boolean)
    const angle = Math.abs(angles[index] ?? 0), factor = 1 / Math.cos(angle > Math.PI / 4 ? Math.PI / 2 - angle : angle)
    const scale = new Vector3(factor, factor, factor)
    if (index >= 0) scale.setComponent(index, 1)
    transform.multiply(new Matrix4().makeScale(scale.x, scale.y, scale.z))
  }
  return plane.applyMatrix4(transform.multiply(new Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z)))
}

function reservedDepths(element: JavaModelData, axis: number, planes: ReservedPlane[]): number[] {
  const zero = modelPlane(element, axis, 0), one = modelPlane(element, axis, 1)
  return planes.flatMap(({ owner, plane }) => {
    if (owner === element) return []
    const alignment = zero.normal.dot(plane.normal)
    if (Math.abs(alignment) < 1 - 1e-8) return []
    return [(Math.sign(alignment) * plane.constant - zero.constant) / (one.constant - zero.constant)]
  })
}

function contourFace(surface: Surface, direction: Face, axes: [number, number], a0: number, b0: number, a1: number, b1: number): JavaModelData {
  const sideAxis = pairs.findIndex(pair => pair.includes(direction)), sideAxes = planeAxes(sideAxis)
  const corners = [[0, 0], [1, 0], [0, 1], [1, 1]] as const
  const desired = corners.map(corner => {
    const fraction = (axis: number, lo: number, hi: number): number => {
      const index = sideAxes.indexOf(axis)
      return lo + (hi - lo) * (corner[index < 0 ? sideAxes.findIndex(value => !axes.includes(value)) : index]!)
    }
    return mappedUv(surface, fraction(axes[0], a0, a1), fraction(axes[1], b0, b1))
  })
  for (const rotation of [0, 90, 180, 270]) {
    const units = corners.map(([a, b]) => {
      let [u, v] = baseUv(direction, a, b) as [number, number]
      for (let angle = 0; angle < rotation; angle += 90) [u, v] = [v, 1 - u]
      return [u, v]
    })
    const uv = [0, 0, 0, 0]
    let matches = true
    for (const component of [0, 1]) {
      const pivot = units.findIndex(point => point[component] !== units[0]![component])
      const delta = (desired[pivot]![component]! - desired[0]![component]!) / (units[pivot]![component]! - units[0]![component]!)
      uv[component] = desired[0]![component]! - delta * units[0]![component]!
      uv[component + 2] = uv[component]! + delta
      if (units.some((point, index) => Math.abs(uv[component]! + delta * point[component]! - desired[index]![component]!) > 1e-7)) matches = false
    }
    if (!matches) continue
    const face: JavaModelData = { ...surface.face, uv: uv.map(round) }
    delete face.cullface
    delete face.rotation
    if (rotation) face.rotation = rotation
    return face
  }
  throw new Error(uiText("core.alphaModelOptimizer.unableToMaintainUvMapOnThe"))
}

export interface AlphaOptimizationOptions { rebuildSides?: boolean }

export interface AlphaOptimization { model: JavaModelData; changedElements: number; removedElements: number; before: number; after: number; skipped: string[] }

export async function optimizeAlphaModel(raw: JavaModelData, read: (path: string) => Promise<Uint8Array | undefined>, metadata: (path: string) => Promise<unknown> = async () => undefined, options: AlphaOptimizationOptions = {}): Promise<AlphaOptimization> {
  validateJavaModel(raw)
  if (!Array.isArray(raw.elements)) throw new Error(uiText("core.alphaModelOptimizer.pleaseSaveTheGeometryOfTheModel"))
  const elements = raw.elements as JavaModelData[]
  const output: JavaModelData[] = [], count = generatedBaseElementCount(raw) ?? 0, skipped = new Set<string>()
  const primary: JavaModelData[] = []
  const planes: ReservedPlane[] = []
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index]!, marker = element[CONTOUR_FIELD]
    primary.push(element)
    if (object(marker) && marker.version === 1 && Number.isSafeInteger(marker.edges) && Number(marker.edges) >= 0 && index + Number(marker.edges) < elements.length - count) {
      const from = element.from as number[], to = element.to as number[]
      if (from && to) {
        const lengths = from.map((value, axis) => to[axis]! - value), axis = lengths.indexOf(Math.min(...lengths))
        for (const side of elements.slice(index + 1, index + Number(marker.edges) + 1)) if (object(side.faces)) {
          for (const [direction, name] of pairs[axis]!.entries()) if (side.faces[name]) {
            const coordinate = Number(((direction ? side.to : side.from) as number[])[axis])
            if (coordinate > from[axis]! && coordinate < to[axis]!) planes.push({ owner: element, plane: modelPlane(element, axis, coordinate) })
          }
        }
      }
      index += Number(marker.edges)
    }
  }
  for (const element of primary) {
    const from = element.from as number[], to = element.to as number[], faces = element.faces
    if (!from || !to || !object(faces)) continue
    const lengths = from.map((value, axis) => to[axis]! - value), thin = lengths.indexOf(Math.min(...lengths)), axes = planeAxes(thin)
    const complete = lengths.every(value => value > 0) && lengths[thin]! <= Math.min(lengths[axes[0]]!, lengths[axes[1]]!) / 4
      && (options.rebuildSides || Object.keys(faces).every(name => pairs[thin]!.includes(name as Face))) && pairs[thin]!.some(name => faces[name])
    for (const [axis, names] of pairs.entries()) for (const [side, name] of names.entries()) {
      if (faces[name] || complete && axis === thin) planes.push({ owner: element, plane: modelPlane(element, axis, (side ? to : from)[axis]!) })
    }
  }
  const images = new Map<string, Image>(), animations = new Map<string, unknown>()
  let changedElements = 0, removedElements = 0
  const unchanged = (reason: string): AlphaOptimization => ({ model: raw, changedElements: 0, removedElements: 0, before: elements.length, after: elements.length, skipped: [reason] })
  for (let index = 0; index < elements.length; index++) {
    const entry = elements[index]!
    let element = entry, original = [entry]
    const marker = entry[CONTOUR_FIELD]
    if (marker !== undefined && index < elements.length - count) {
      if (!object(marker) || marker.version !== 1 || !Number.isSafeInteger(marker.edges) || Number(marker.edges) < 0 || index + Number(marker.edges) >= elements.length - count || typeof marker.hash !== 'string' || !/^[a-f0-9]{64}$/.test(marker.hash)) {
        return unchanged(uiText("core.alphaModelOptimizer.theProfileRecordIsInvalidAllElements"))
      }
      original = elements.slice(index, index + Number(marker.edges) + 1)
      index += Number(marker.edges)
      element = { ...entry }; delete element[CONTOUR_FIELD]
      if (fingerprint([element, ...original.slice(1)]) !== marker.hash) {
        return unchanged(uiText("core.alphaModelOptimizer.theContourShellHasBeenManuallyModified"))
      }
    }
    const from = element.from as number[], to = element.to as number[], faces = element.faces as JavaModelData
    const keep = (reason?: string): void => { output.push(...original); if (reason) skipped.add(reason) }
    if (index >= elements.length - count || !from || !to || !object(faces)) { keep(); continue }
    const lengths = from.map((value, axis) => to[axis]! - value), axis = lengths.indexOf(Math.min(...lengths)), axes = planeAxes(axis)
    if (lengths.some(value => value <= 0) || lengths[axis]! > Math.min(lengths[axes[0]!]!, lengths[axes[1]!]!) / 4) { keep(uiText("core.alphaModelOptimizer.nonSleptOrZeroVolumeElementsRemain")); continue }
    if (!options.rebuildSides && Object.keys(faces).some(name => !pairs[axis]!.includes(name as Face))) { keep(uiText("core.alphaModelOptimizer.blankWithSeparateSidesRemainsAsIt")); continue }
    const surfaces: Surface[] = []
    let unsupported = false
    for (const name of pairs[axis]!) {
      const face = faces[name]
      if (!object(face)) continue
      const texture = resolveJavaModelTexture(object(raw.textures) ? raw.textures : {}, String(face.texture))
      if (!texture.path) { unsupported = true; break }
      if (!animations.has(texture.path)) animations.set(texture.path, await metadata(texture.path + '.mcmeta'))
      const info = animations.get(texture.path)
      if (object(info) && info.animation !== undefined) { unsupported = true; skipped.add(uiText("core.alphaModelOptimizer.animatedStickersRemainAsTheyAreAvoiding")); break }
      if (!images.has(texture.path)) { const bytes = await read(texture.path); if (!bytes) { unsupported = true; break }; images.set(texture.path, decodeTexturePng(bytes, uiText("core.alphaModelOptimizer.modelOptimizationPaste"))) }
      const image = images.get(texture.path)!, uv = Array.isArray(face.uv) ? face.uv as number[] : defaultUv(name, from, to)
      if (uv.some(value => value < 0 || value > 16)) { unsupported = true; break }
      surfaces.push({ name, face, image, uv })
    }
    if (unsupported || !surfaces.length) { keep(uiText("core.alphaModelOptimizer.keepTheMissingPasteAnimationOrUv")); continue }
    const cuts = [new Set([0, 1]), new Set([0, 1])]
    for (const surface of surfaces) for (const dimension of [0, 1]) {
      const origin = mappedUv(surface, 0, 0), edge = mappedUv(surface, dimension === 0 ? 1 : 0, dimension === 1 ? 1 : 0)
      for (const uvAxis of [0, 1]) {
        const delta = edge[uvAxis]! - origin[uvAxis]!
        if (Math.abs(delta) < 1e-10) continue
        const pixels = uvAxis === 0 ? surface.image.width : surface.image.height
        for (let pixel = Math.ceil(Math.min(origin[uvAxis]!, edge[uvAxis]!) * pixels / 16); pixel <= Math.floor(Math.max(origin[uvAxis]!, edge[uvAxis]!) * pixels / 16); pixel++) {
          const fraction = (pixel * 16 / pixels - origin[uvAxis]!) / delta
          if (fraction > 1e-8 && fraction < 1 - 1e-8) cuts[dimension]!.add(round(fraction))
        }
      }
    }
    const xs = [...cuts[0]!].sort((a, b) => a - b), ys = [...cuts[1]!].sort((a, b) => a - b), width = xs.length - 1, height = ys.length - 1
    if (width * height > 65536) throw new Error(uiText("core.alphaModelOptimizer.theProfileGridIsTooLargeAnd"))
    const masks = surfaces.map(surface => {
      const mask = new Uint8Array(width * height)
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const [u, v] = mappedUv(surface, (xs[x]! + xs[x + 1]!) / 2, (ys[y]! + ys[y + 1]!) / 2)
        const px = Math.max(0, Math.min(surface.image.width - 1, Math.floor(u! * surface.image.width / 16))), py = Math.max(0, Math.min(surface.image.height - 1, Math.floor(v! * surface.image.height / 16)))
        mask[y * width + x] = surface.image.data[(py * surface.image.width + px) * 4 + 3]! > 0 ? 1 : 0
      }
      return mask
    })
    if (masks.every(mask => mask.every(value => value === 1)) && marker === undefined) { keep(); continue }
    const rebuilt: JavaModelData[] = []
    if (masks.some(mask => mask.some(Boolean))) {
      const mainFaces = Object.fromEntries(surfaces.map(surface => [surface.name, surface.face]))
      if (surfaces.length === 1) {
        const surface = surfaces[0]!, other = pairs[axis]!.find(name => name !== surface.name)!
        mainFaces[other] = oppositeFace(surface)
      }
      const main: JavaModelData = { ...element, faces: Object.fromEntries(pairs[axis]!.filter(name => mainFaces[name]).map(name => [name, mainFaces[name]])) }
      rebuilt.push(main)
      let midpoint = (from[axis]! + to[axis]!) / 2
      const split = surfaces.length === 2 && !sameSurface(surfaces[0]!, surfaces[1]!)
      if (split) {
        const previous = new Set(original.slice(1).flatMap(side => [Number((side.from as number[])[axis]), Number((side.to as number[])[axis])]).filter(value => value > from[axis]! && value < to[axis]!))
        if (previous.size === 1) midpoint = [...previous][0]!
        const depths = reservedDepths(entry, axis, planes).filter(value => value > from[axis]! && value < to[axis]!)
        if (depths.some(value => Math.abs(value - midpoint) < 1e-7)) {
          const cuts = [...new Set([from[axis]!, ...depths, to[axis]!])].sort((a, b) => a - b)
          let gap = 0
          for (let index = 1; index < cuts.length; index++) if (cuts[index]! - cuts[index - 1]! > gap) {
            gap = cuts[index]! - cuts[index - 1]!
            midpoint = (cuts[index]! + cuts[index - 1]!) / 2
          }
        }
        planes.push({ owner: entry, plane: modelPlane(element, axis, midpoint) })
      }
      const add = (surface: Surface, direction: Face, a0: number, b0: number, a1: number, b1: number, low: number, high: number): void => {
        const smallFrom = [...from], smallTo = [...to]
        smallFrom[axis] = low; smallTo[axis] = high
        smallFrom[axes[0]] = from[axes[0]]! + lengths[axes[0]]! * a0; smallTo[axes[0]] = from[axes[0]]! + lengths[axes[0]]! * a1
        smallFrom[axes[1]] = from[axes[1]]! + lengths[axes[1]]! * b0; smallTo[axes[1]] = from[axes[1]]! + lengths[axes[1]]! * b1
        rebuilt.push({ ...element, from: smallFrom.map(round), to: smallTo.map(round), faces: { [direction]: contourFace(surface, direction, axes, a0, b0, a1, b1) } })
        if (output.length + rebuilt.length + elements.length - index - 1 > JAVA_MODEL_LIMITS.maxElements) throw new Error(uiText("core.alphaModelOptimizer.transparentContoursOptimizedMoreThanElementNo", JAVA_MODEL_LIMITS.maxElements))
      }
      // 两面的侧壁分别衔接自己的边缘颜色，轮廓差异仅在中面生成外露台阶
      for (const [side, surface] of (split ? surfaces : surfaces.slice(0, 1)).entries()) {
        const negative = surface.name === pairs[axis]![0]
        const low = split && !negative ? midpoint : from[axis]!, high = split && negative ? midpoint : to[axis]!
        const mask = masks[side]!
        for (const span of contourSpans(width, height, mask)) {
          const a0 = xs[span.axis === 0 ? span.cell : span.start]!, a1 = xs[span.axis === 0 ? span.cell + 1 : span.end]!
          const b0 = ys[span.axis === 1 ? span.cell : span.start]!, b1 = ys[span.axis === 1 ? span.cell + 1 : span.end]!
          add(surface, pairs[axes[span.axis]]![span.sign < 0 ? 0 : 1]!, a0, b0, a1, b1, low, high)
        }
        if (split) {
          const exposed = mask.map((value, cell) => value && !masks[1 - side]![cell] ? 1 : 0)
          for (const rect of maskRectangles(width, height, exposed)) {
            add(surface, pairs[axis]![negative ? 1 : 0], xs[rect.x0]!, ys[rect.y0]!, xs[rect.x1]!, ys[rect.y1]!, low, high)
          }
        }
      }
      validateJavaModel({ elements: rebuilt })
      main[CONTOUR_FIELD] = { version: 1, edges: rebuilt.length - 1, hash: fingerprint(rebuilt) }
    }
    if (JSON.stringify(rebuilt) === JSON.stringify(original)) { keep(); continue }
    changedElements++
    if (!rebuilt.length) removedElements++
    output.push(...rebuilt)
  }

  const model = { ...raw, elements: output }
  validateJavaModel(model)
  return { model, changedElements, removedElements, before: elements.length, after: output.length, skipped: [...skipped] }
}
