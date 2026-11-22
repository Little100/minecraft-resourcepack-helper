import { uiText } from '../../i18n/messages'
export interface McrhEditorDataExportOptions { includeMcrhEditorData?: boolean }
export interface EditorDataFile { path: string; content: string | Uint8Array }
const TOOL_DIRECTORIES = new Set(['.git', '.svn', '.hg', '.vscode', '.idea', 'node_modules', '__pycache__', '.cache'])
const PRIVATE_NAMES = /^(?:\.env(?:\..*)?|(?:collaboration|credentials?|secrets?|tokens?|auth|sessions?|invitations?|private[-_]?keys?)(?:\.[^.]+)?)$/i
const SECRET_CONTENT = /(?:["'](?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|secret|client[_-]?secret|password|authorization|cookie|invitation|private[_-]?key)["']\s*:\s*(?!null\b|false\b|""|'')|\b(?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|secret|password|authorization|invitation)\s*[:=]\s*\S|mcrh_bylittle100_[A-Za-z]{64}|mcrh:\/\/|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----)/i

export function validateMcrhEditorDataExportOptions(options: McrhEditorDataExportOptions): void {
  if (options.includeMcrhEditorData !== undefined && typeof options.includeMcrhEditorData !== 'boolean') throw new Error(uiText("core.advanced.editorDataExportPolicy.mcrhEditDataExportOptionsMustBe"))
}

export function isMcrhEditorDataPath(relative: string): boolean {
  return relative.toLowerCase().split('/').some(part => part === '.mcrh' || part.startsWith('.mcrh-') || part === '.history' || part === '.image-editor-history' || /\.mcrh(?:\.json)?$/.test(part))
}

export function isForbiddenPackExportPath(relative: string): boolean {
  const parts = relative.toLowerCase().split('/')
  if (parts.some(part => TOOL_DIRECTORIES.has(part) || /(?:^|\.)sourcepack(?:\.|$)/.test(part) || part.startsWith('.mcrh-sourcepack') || /^\.mcrh-(?:export|packsquash|zip)-/.test(part))) return true
  if (isMcrhEditorDataPath(relative) && /\.(?:exe|dll|com|bat|cmd|ps1|psm1|sh|bash|py|pyc|js|mjs|cjs|ts|jar|class|msi|vbs|scr|lnk|so|dylib|wasm|zip|7z|rar|tar|gz|bz2|xz)$/i.test(relative)) return true
  return isMcrhEditorDataPath(relative) && parts.some(part => PRIVATE_NAMES.test(part) || /^\.mcrh-(?:collaboration|credentials?|secrets?|tokens?|auth|sessions?)(?:\.|-|$)/.test(part))
}

export function shouldExportPackPath(relative: string, options: McrhEditorDataExportOptions = {}): boolean {
  validateMcrhEditorDataExportOptions(options)
  return !isForbiddenPackExportPath(relative) && (!!options.includeMcrhEditorData || !isMcrhEditorDataPath(relative))
}

export function canExportPackFile(file: EditorDataFile, options: McrhEditorDataExportOptions = {}): boolean {
  if (!shouldExportPackPath(file.path, options)) return false
  if (!isMcrhEditorDataPath(file.path)) return true
  const content = typeof file.content === 'string' ? file.content : new TextDecoder().decode(file.content)
  return !SECRET_CONTENT.test(content)
}

export function filterMcrhEditorData<T extends EditorDataFile>(files: readonly T[], options: McrhEditorDataExportOptions = {}): { files: T[]; omitted: string[] } {
  validateMcrhEditorDataExportOptions(options)
  const kept: T[] = [], omitted: string[] = []
  for (const file of files) {
    if (canExportPackFile(file, options)) kept.push(file)
    else omitted.push(file.path)
  }
  return { files: kept, omitted }
}
