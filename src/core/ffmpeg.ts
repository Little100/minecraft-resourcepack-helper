import { uiText } from '../i18n/messages'
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile, spawn, type ChildProcess } from 'node:child_process'

export type FfmpegSource = 'setting' | 'path'

export interface FfmpegStatus {
  available: boolean
  path?: string
  version?: string
  source?: FfmpegSource
  reason?: string
}

const PATH_LOOKUP_TIMEOUT_MS = 3000
// 版本探测的超时时间, 避免用户误选图形界面程序时探测无限挂起
const PROBE_TIMEOUT_MS = 10000
// 抽帧超时, 损坏视频或网盘路径下避免 ffmpeg 无限等待 stdin 或输出
const EXTRACT_TIMEOUT_MS = 10 * 60 * 1000
const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.bat', '.cmd']

export function resolveFfmpegPath(): string | undefined {
  const configured = vscode.workspace.getConfiguration('mcrh').get<string>('ffmpegPath')
  const trimmed = stripQuotes((configured ?? '').trim())
  if (trimmed.length === 0) return undefined
  return resolveFfmpegCandidate(trimmed)
}

function resolveFfmpegCandidate(raw: string): string {
  const trimmed = stripQuotes(raw.trim())
  try {
    if (fs.statSync(trimmed).isDirectory()) {
      for (const name of ffmpegNames()) {
        const candidate = path.join(trimmed, name)
        if (fs.existsSync(candidate)) return candidate
      }
    }
  } catch {
    // 保留原路径，让检查程序报告错误
  }
  return trimmed
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, '')
}

function ffmpegNames(): string[] {
  return process.platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg.bat', 'ffmpeg.cmd'] : ['ffmpeg']
}

export async function probeFfmpeg(): Promise<FfmpegStatus> {
  const configured = resolveFfmpegPath()
  if (configured) return probeFfmpegAt(configured, 'setting')
  const found = await lookupOnPath()
  if (found) return probeFfmpegAt(found, 'path')
  return {
    available: false,
    reason: uiText("core.ffmpeg.noFfmpegPathConfiguredAndFfmpegNot")
  }
}

export async function probeFfmpegAt(target: string, source: FfmpegSource): Promise<FfmpegStatus> {
  const resolved = resolveFfmpegCandidate(target)
  const problem = inspectTarget(resolved)
  if (problem) return { available: false, path: resolved, source, reason: problem }

  const version = await runFfmpeg(resolved, ['-version'], PROBE_TIMEOUT_MS)
  if (!version.ok) {
    return { available: false, path: resolved, source, reason: uiText("core.ffmpeg.implementationFailed", version.error ?? uiText("collaboration.server.unknownError")) }
  }
  const match = /ffmpeg version (\S+)/.exec(version.stdout)
  if (!match) {
    return {
      available: false,
      path: resolved,
      source,
      reason: uiText("core.ffmpeg.executingFailedFfmpegVersionOfOutputIs")
    }
  }
  return { available: true, path: resolved, source, version: match[1] }
}

// 在文件系统层面先排除路径不存在与明显不可执行的情况, 避免无意义的进程调用
function inspectTarget(target: string): string | undefined {
  let stat: fs.Stats
  try {
    stat = fs.statSync(target)
  } catch {
    return uiText("core.ffmpeg.fileDoesNotExist", target)
  }
  if (stat.isDirectory()) return uiText("core.ffmpeg.notExecutableIsAFolderWhereNo", target)
  if (!isExecutableFile(target)) {
    return process.platform === 'win32'
      ? uiText("core.ffmpeg.notExecutableWindowsOnlySupportsExeEtc", target)
      : uiText("core.ffmpeg.notExecutableNoEnforcementPermissions", target)
  }
  return undefined
}

function isExecutableFile(target: string): boolean {
  if (process.platform === 'win32') {
    return WINDOWS_EXECUTABLE_EXTENSIONS.includes(path.extname(target).toLowerCase())
  }
  try {
    fs.accessSync(target, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function windowsCmd(): string {
  return path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
}

function lookupOnPath(): Promise<string | undefined> {
  return new Promise(resolve => {
    const options = { timeout: PATH_LOOKUP_TIMEOUT_MS, windowsHide: true }
    const done = (error: Error | null, stdout: string): void => {
      if (error) {
        resolve(undefined)
        return
      }
      const first = stdout.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0)
      resolve(first)
    }
    if (process.platform === 'win32') {
      const cmd = windowsCmd()
      execFile(cmd, ['/d', '/s', '/c', '"chcp 65001 >nul & where ffmpeg"'], { ...options, windowsVerbatimArguments: true }, done)
      return
    }
    execFile('which', ['ffmpeg'], options, done)
  })
}

interface RunResult {
  ok: boolean
  stdout: string
  error?: string
}

// 批处理脚本无法被 spawn 直接执行, 交由 cmd.exe 转交并给每个参数加引号, % 需转义为 %% 避免 cmd 环境变量展开
function launchSpec(execPath: string, args: string[]): { file: string; args: string[]; verbatim: boolean } {
  if (process.platform === 'win32' && /\.(bat|cmd)$/i.test(execPath)) {
    const line = [execPath, ...args].map(item => `"${item.replaceAll('%', '%%')}"`).join(' ')
    return { file: windowsCmd(), args: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
  }
  return { file: execPath, args, verbatim: false }
}

function runFfmpeg(execPath: string, args: string[], timeoutMs?: number): Promise<RunResult> {
  return new Promise(resolve => {
    const launch = launchSpec(execPath, args)
    let child: ChildProcess
    try {
      child = spawn(launch.file, launch.args, {
        windowsHide: true,
        windowsVerbatimArguments: launch.verbatim,
        timeout: timeoutMs ?? 0
      })
    } catch (error) {
      resolve({ ok: false, stdout: '', error: errorMessage(error) })
      return
    }
    let stdout = ''
    let error = ''
    child.stdout?.on('data', chunk => { if (stdout.length < 4096) stdout += String(chunk) })
    child.stderr?.on('data', chunk => { if (error.length < 512) error += String(chunk) })
    child.on('error', err => resolve({ ok: false, stdout, error: err.message }))
    child.on('close', (code, signal) => {
      if (signal && timeoutMs) {
        resolve({ ok: false, stdout, error: uiText("core.ffmpeg.moreThanMillisecondNoResponseAborted", timeoutMs) })
        return
      }
      if (signal) {
        resolve({ ok: false, stdout, error: uiText("core.ffmpeg.beamedTermination", signal) })
        return
      }
      resolve(code === 0 ? { ok: true, stdout } : { ok: false, stdout, error: error.trim() || uiText("core.ffmpeg.exitCode", code) })
    })
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function byFrameIndex(a: string, b: string): number {
  const indexA = Number(/frame-(\d+)/.exec(a)?.[1] ?? 0)
  const indexB = Number(/frame-(\d+)/.exec(b)?.[1] ?? 0)
  return indexA - indexB
}

export interface ExtractFrame {
  index: number
  data: Uint8Array
}

export interface ExtractOptions {
  fps?: number
  maxFrames?: number
  width?: number
}

export async function extractFrames(
  execPath: string,
  sourceFile: string,
  workDir?: string,
  options?: ExtractOptions
): Promise<ExtractFrame[]> {
  const dir = workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mcrh-frames-'))
  try {
    const filters: string[] = []
    if (options?.fps && options.fps > 0) filters.push(`fps=${options.fps}`)
    if (options?.width && options.width > 0) filters.push(`scale=${options.width}:-1:flags=neighbor`)
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', sourceFile]
    if (filters.length > 0) args.push('-vf', filters.join(','))
    // 帧数上限前置给 ffmpeg, 避免先抽完整个视频再丢弃; 字典序会把 10000 排到 9999 之前, 需按数字比较
    if (options?.maxFrames && options.maxFrames > 0) args.push('-frames:v', String(options.maxFrames))
    args.push('-y', path.join(dir, 'frame-%04d.png'))
    const result = await runFfmpeg(execPath, args, EXTRACT_TIMEOUT_MS)
    if (!result.ok) throw new Error(uiText("core.ffmpeg.ffmpegExecutionFailed", result.error ?? uiText("core.convertPipeline.unknownCause")))
    const names = fs.readdirSync(dir).filter(name => /\.png$/i.test(name)).sort(byFrameIndex)
    const limited = options?.maxFrames && options.maxFrames > 0 ? names.slice(0, options.maxFrames) : names
    return limited.map((name, index) => ({ index, data: new Uint8Array(fs.readFileSync(path.join(dir, name))) }))
  } finally {
    if (!workDir) fs.rmSync(dir, { recursive: true, force: true })
  }
}
