export const MAX_IMAGE_IMPORT_FILES = 32
export const MAX_IMAGE_IMPORT_BYTES = 64 * 1024 * 1024
export const MAX_IMAGE_URI_LENGTH = 8192
export const MAX_IMAGE_URI_PAYLOAD = 256 * 1024

// 拖放路径只接受本机图片，工作区外的路径仍由宿主文件选择器确认
export function localImageUri(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_IMAGE_URI_LENGTH) return undefined
  const input = value.trim()
  if (!input || /[\u0000-\u001f\u007f]/.test(input)) return undefined
  if (/^[a-z]:[\\/]/i.test(input) || /^\/(?!\/)/.test(input)) return /\.(?:png|jpe?g|webp)$/i.test(input) ? input : undefined
  if (!/^file:\/\//i.test(input)) return undefined
  try {
    const uri = new URL(input), pathname = decodeURIComponent(uri.pathname)
    if (uri.protocol !== 'file:' || uri.hostname || uri.search || uri.hash || /[\u0000-\u001f\u007f\\]/.test(pathname) || pathname.startsWith('//')) return undefined
    return /\.(?:png|jpe?g|webp)$/i.test(pathname) ? uri.href : undefined
  } catch { return undefined }
}

export function imageUrisFromPayload(raw: string): string[] {
  if (!raw || raw.length > MAX_IMAGE_URI_PAYLOAD) return []
  let values: unknown[]
  if (raw.trimStart().startsWith('[')) {
    try { const parsed: unknown = JSON.parse(raw); if (!Array.isArray(parsed) || parsed.length > MAX_IMAGE_IMPORT_FILES) return []; values = parsed }
    catch { return [] }
  } else values = raw.split(/\r?\n/)
  const result = new Set<string>()
  for (const value of values) {
    const uri = localImageUri(value)
    if (uri) result.add(uri)
    if (result.size >= MAX_IMAGE_IMPORT_FILES) break
  }
  return [...result]
}
