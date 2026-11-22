import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { desktopLaunchEnvironment } from './desktopProcess'

const WINDOWS_APP_DIR = 'Blockbench'
const WINDOWS_EXECUTABLE = 'Blockbench.exe'
const MAC_EXECUTABLE = '/Applications/Blockbench.app/Contents/MacOS/Blockbench'
const LINUX_COMMAND = 'blockbench'
const SUPPORTED_EXTENSIONS = ['.bbmodel', '.json'] as const
// 顶层含有任一模型字段即视为 Minecraft 模型, 语言文件等普通 json 不会命中
const MODEL_KEYS = ['elements', 'parent', 'textures'] as const

export type Environment = Record<string, string | undefined>
export type FileProbe = (file: string) => Promise<boolean>
export type Spawner = (command: string, args: string[], options: SpawnOptions) => ChildProcess

// 按优先级返回候选路径, 设置中的路径排第一, 环境变量缺失的 Windows 候选直接跳过
export function candidateExecutables(platform: NodeJS.Platform, env: Environment, configured: string | undefined): string[] {
  const candidates: string[] = []
  const custom = nonEmpty(configured)
  if (custom) candidates.push(custom)
  if (platform === 'win32') {
    const localAppData = nonEmpty(env.LOCALAPPDATA)
    if (localAppData) candidates.push(path.win32.join(localAppData, 'Programs', WINDOWS_APP_DIR, WINDOWS_EXECUTABLE))
    const programFiles = nonEmpty(env.ProgramFiles)
    if (programFiles) candidates.push(path.win32.join(programFiles, WINDOWS_APP_DIR, WINDOWS_EXECUTABLE))
    const programFilesX86 = nonEmpty(env['ProgramFiles(x86)'])
    if (programFilesX86) candidates.push(path.win32.join(programFilesX86, WINDOWS_APP_DIR, WINDOWS_EXECUTABLE))
    candidates.push(WINDOWS_EXECUTABLE)
  } else if (platform === 'darwin') {
    candidates.push(MAC_EXECUTABLE)
  } else {
    candidates.push(LINUX_COMMAND)
  }
  return candidates
}

export async function findBlockbench(
  platform: NodeJS.Platform,
  env: Environment,
  configured: string | undefined,
  isFile: FileProbe = isExistingFile
): Promise<string | undefined> {
  for (const candidate of candidateExecutables(platform, env, configured)) {
    const found = await resolveCandidate(platform, env, candidate, isFile)
    if (found) return found
  }
  return undefined
}

async function resolveCandidate(platform: NodeJS.Platform, env: Environment, candidate: string, isFile: FileProbe): Promise<string | undefined> {
  if (candidate.includes('/') || candidate.includes('\\')) {
    return (await isFile(candidate)) ? candidate : undefined
  }
  if (platform === 'win32') {
    const executable = /\.exe$/i.test(candidate) ? candidate : candidate + '.exe'
    for (const directory of (env.PATH ?? '').split(path.win32.delimiter)) {
      const trimmed = directory.trim().replace(/^"|"$/g, '')
      if (!trimmed) continue
      const file = path.win32.join(trimmed, executable)
      if (await isFile(file)) return file
    }
    return undefined
  }
  for (const dir of (env.PATH ?? '').split(path.posix.delimiter)) {
    if (!dir) continue
    const file = path.posix.join(dir, candidate)
    if (await isFile(file)) return file
  }
  return undefined
}

export async function isExistingFile(file: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(file)).isFile()
  } catch {
    return false
  }
}

export function hasBlockbenchExtension(file: string): boolean {
  const lower = file.toLowerCase()
  return SUPPORTED_EXTENSIONS.some(extension => lower.endsWith(extension))
}

// 顶层必须是普通对象且含有模型字段之一, 非法 JSON 与数组一律不像模型
export function looksLikeModel(text: string): boolean {
  const parsed = parseObject(text)
  return parsed !== undefined && MODEL_KEYS.some(key => Object.hasOwn(parsed, key))
}

export function launchBlockbench(executable: string, file: string, spawner: Spawner = spawn): ChildProcess {
  return spawner(executable, [file], { detached: true, stdio: 'ignore', env: desktopLaunchEnvironment(process.env) })
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
  } catch {
    return undefined
  }
}
