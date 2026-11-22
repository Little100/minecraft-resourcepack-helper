import { uiText } from '../i18n/messages'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { MCP_PAINTING_WORKFLOW } from './workflow'

export interface McpRuntime {
  launcher: string
  registry: string
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(uiText("mcp.runtime.mcpStorageDirectoryCannotBeALink"))
}

// 启动器跟随扩展更新，客户端配置只引用稳定的全局存储位置
export async function ensureMcpRuntime(extensionRoot: string, storageRoot: string): Promise<McpRuntime> {
  const directory = path.join(storageRoot, 'mcp')
  const runtime = { launcher: path.join(directory, 'launcher.cjs'), registry: path.join(directory, 'instances') }
  await ensurePrivateDirectory(directory)
  await ensurePrivateDirectory(runtime.registry)
  const source = path.join(extensionRoot, 'out', 'mcp-cli.cjs')
  let bytes: Buffer
  try { bytes = await fs.readFile(source) }
  catch { throw new Error(uiText("mcp.runtime.applicationPackageMissingMcpCliPleaseRe")) }
  const existing = await fs.lstat(runtime.launcher).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error(uiText("mcp.runtime.mcpStarterPathInvalid"))
  if (existing && existing.size === bytes.length && (await fs.readFile(runtime.launcher)).equals(bytes)) return runtime
  const temporary = runtime.launcher + '.' + randomUUID() + '.tmp'
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    await fs.rename(temporary, runtime.launcher)
  } finally { await fs.rm(temporary, { force: true }) }
  return runtime
}

export function buildMcpInstallPrompt(runtime: McpRuntime, enabled: boolean): string {
  const configuration = { mcpServers: { mcrh: { command: 'node', args: [runtime.launcher] } } }
  return [
    uiText("mcp.runtime.pleaseHelpMeToAccessTheCurrent"),
    uiText("mcp.runtime.theNextPathFromTheCurrentlyRunning"),
    uiText("mcp.runtime.exampleJsonOnlyExpressesCommandAndArgs"),
    JSON.stringify(configuration, null, 2),
    uiText("mcp.runtime.currentWindowMcp", (enabled ? uiText("mcp.runtime.open") : uiText("browser.resources.close"))),
    uiText("mcp.runtime.registerDirectoryParsedByTheStarterFrom"),
    uiText("mcp.runtime.callMcrhListProjectsAfterConnectionList"),
    uiText("mcp.runtime.afterInstallationIsCompleteUseTheFollowing", MCP_PAINTING_WORKFLOW),
    uiText("mcp.runtime.remoteHttpUsesTheSameStarterPlus"),
    uiText("mcp.runtime.mcpOpenAllowsEditingClosesAndDisconnects")
  ].join('\n\n')
}
