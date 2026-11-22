import { uiText } from '../i18n/messages'
import * as path from 'node:path'
import * as vscode from 'vscode'

export interface LangIssue {
  key: string
  // 包含这条翻译的文件路径
  files: string[]
}

export interface LangReport {
  // 用来对照的翻译条数
  totalKeys: number
  // 各语言文件的相对路径
  files: string[]
  // 与基准相比缺少的翻译
  missing: LangIssue[]
  // 用来对照的文件
  baseFile?: string
}

export function isLangFile(file: string): boolean {
  const normalized = file.replace(/\\/g, '/').toLowerCase()
  return /\/assets\/[^/]+\/lang\/[a-z0-9_]+\.json$/.test(normalized)
}

export function langCodeOf(file: string): string | undefined {
  const match = /\/lang\/([a-z0-9_]+)\.json$/i.exec(file.replace(/\\/g, '/'))
  return match?.[1]?.toLowerCase()
}

function keysOfText(text: string): string[] | undefined {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return Object.keys(parsed)
  } catch {
    return undefined
  }
}

async function readKeys(uri: vscode.Uri, override?: string): Promise<string[] | undefined> {
  if (override !== undefined) return keysOfText(override)
  try {
    const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')
    return keysOfText(text)
  } catch {
    return undefined
  }
}

export async function collectLangFiles(langDir: string): Promise<string[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(langDir))
    return entries
      .filter(([name, kind]) => kind === vscode.FileType.File && /^[a-z0-9_]+\.json$/i.test(name))
      .map(([name]) => path.join(langDir, name))
  } catch {
    return []
  }
}

export interface LangCheckOptions {
  // 用文件路径找到 lang 目录
  file: string
  // 有未保存内容以其进行检查
  content?: string
}

// 用包内翻译最多的文件作对照，不读原版
export async function checkLang(options: LangCheckOptions): Promise<LangReport | undefined> {
  const normalized = options.file.replace(/\\/g, '/')
  const dirMatch = /^(.*\/assets\/[^/]+\/lang)\//i.exec(normalized)
  if (!dirMatch) return undefined
  const langDir = dirMatch[1]

  const files = await collectLangFiles(langDir)
  if (files.length === 0) return undefined

  const keySets = new Map<string, Set<string>>()
  for (const file of files) {
    const override = file === path.normalize(options.file) ? options.content : undefined
    const keys = await readKeys(vscode.Uri.file(file), override)
    if (keys) keySets.set(file, new Set(keys))
  }
  if (keySets.size === 0) return undefined

  let baseFile = ''
  let baseKeys: Set<string> = new Set()
  for (const [file, keys] of keySets) {
    if (keys.size > baseKeys.size) {
      baseFile = file
      baseKeys = keys
    }
  }

  const missing: LangIssue[] = []
  for (const key of baseKeys) {
    const holders = [...keySets.entries()].filter(([, keys]) => keys.has(key)).map(([file]) => file)
    if (holders.length === keySets.size) continue
    missing.push({ key, files: holders })
  }

  return {
    totalKeys: baseKeys.size,
    files,
    missing,
    baseFile
  }
}

export function toDiagnostics(report: LangReport): Map<string, vscode.Diagnostic[]> {
  const grouped = new Map<string, vscode.Diagnostic[]>()
  const known = new Set(report.files)
  for (const issue of report.missing) {
    for (const file of report.files) {
      if (issue.files.includes(file)) continue
      if (!known.has(file)) continue
      const list = grouped.get(file) ?? []
      const range = new vscode.Range(0, 0, 0, 0)
      const diagnostic = new vscode.Diagnostic(
        range,
        uiText("core.langCheck.missingLanguageKeys", issue.key),
        vscode.DiagnosticSeverity.Warning
      )
      diagnostic.source = 'MCRH'
      list.push(diagnostic)
      grouped.set(file, list)
    }
  }
  return grouped
}
