import type { PackFormat } from './advanced/versionCapabilities'

// 上界省略 minor 时包含该 major 下的所有次版本
export function parsePackFormat(value: unknown, upper = false): PackFormat | undefined {
  if (Array.isArray(value) && value.length === 1) return parsePackFormat(value[0], upper)
  if (Number.isSafeInteger(value) && Number(value) >= 0) return { major: Number(value), minor: upper ? Number.MAX_SAFE_INTEGER : 0 }
  if (Array.isArray(value) && value.length === 2 && value.every(part => Number.isSafeInteger(part) && part >= 0)) return { major: value[0], minor: value[1] }
  return undefined
}
export function comparePackFormats(left: PackFormat, right: PackFormat): number { return left.major - right.major || left.minor - right.minor }
