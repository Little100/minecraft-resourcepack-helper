import { uiText } from '../i18n/messages'
import * as path from 'node:path'
import { Command, Option } from 'commander'
import * as fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { McpProjectRouter } from '../mcp/router'
import { createMcrhServer } from '../mcp/server'
import { startMcpHttp } from '../mcp/httpServer'

async function main():Promise<void> {
  const cli=new Command().name('mcrh-mcp').description(uiText("cli.mcp.mcrhMultiProjectMcpLocalStdioRemote")).option('--registry <directory>',uiText("cli.mcp.vsCodeMcpRegister")).option('--http',uiText("cli.mcp.enableHttpConnectToOpenWorkspace")).option('--host <address>',uiText("cli.mcp.listeningAddress"),'127.0.0.1').option('--port <number>',uiText("cli.mcp.portMeansSystemAllocation"),'0').option('--token-file <file>',uiText("cli.mcp.httpIndependentBearerDocument")).option('--generate-token <file>',uiText("cli.mcp.exitAfterGeneratingACertificateFileDo")).addOption(new Option('--allow-edit',uiText("cli.mcp.compatibleWithOldVersionParametersOpeningMcp")).hideHelp()).option('--cert <file>',uiText("cli.mcp.httpsCertificate")).option('--key <file>',uiText("cli.mcp.httpsPrivateKey")).option('--allowed-host <host...>',uiText("cli.mcp.additionalAllowedHostHostnameWithoutProtocolOr")).option('--allowed-origin <host...>',uiText("cli.mcp.additionalPermittedOriginHostname")).configureOutput({writeOut:value=>process.stderr.write(value),writeErr:value=>process.stderr.write(value)})
  cli.parse();const args=cli.opts<{registry?:string;http?:boolean;host:string;port:string;tokenFile?:string;generateToken?:string;allowEdit?:boolean;cert?:string;key?:string;allowedHost?:string[];allowedOrigin?:string[]}>()
  if(args.generateToken){await fs.writeFile(args.generateToken,randomBytes(48).toString('base64url'),{flag:'wx',mode:0o600});process.stderr.write(uiText("cli.mcp.mcpCertificateWrittenInSpecifiedDocument"));return}
  if(Number(process.versions.node.split('.')[0])<20)throw new Error(uiText("cli.mcp.nodeJsOrMoreVersionsRequired"))
  const router=new McpProjectRouter(args.registry??path.join(__dirname,'instances'))
  if(!args.http){await serveStdio(()=>createMcrhServer(router),{onerror:()=>process.stderr.write(uiText("cli.mcp.mcpStdioProtocolError"))});return}
  const port=Number(args.port);if(!/^\d+$/.test(args.port)||!Number.isInteger(port)||port<0||port>65535)throw new Error(uiText("cli.mcp.portRequiresTo"))
  let token=process.env.MCRH_MCP_TOKEN??''
  if(args.tokenFile){const stat=await fs.lstat(args.tokenFile);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>512)throw new Error(uiText("cli.mcp.invalidityOfTheCertificate"));token=(await fs.readFile(args.tokenFile,'utf8')).trim()}
  if(Boolean(args.cert)!==Boolean(args.key))throw new Error(uiText("cli.mcp.certAndKeyMustBeProvidedSimultaneously"))
  const tls=args.cert&&args.key?{cert:await fs.readFile(args.cert,'utf8'),key:await fs.readFile(args.key,'utf8')}:undefined
  const server=await startMcpHttp({router,host:args.host,port,token,allowedHosts:args.allowedHost,allowedOrigins:args.allowedOrigin,tls})
  process.stderr.write(uiText("cli.mcp.mcrhMcpPortPathMcpOpenedItem", (tls?'HTTPS':'HTTP'), server.port))
  let stopping=false;const stop=():void=>{if(stopping)return;stopping=true;void server.close().catch(()=>{process.exitCode=1})}
  process.once('SIGINT',stop);process.once('SIGTERM',stop)
}
void main().catch(error=>{process.stderr.write((error instanceof Error?error.message:uiText("cli.mcp.mcpStartFailed"))+'\n');process.exitCode=1})
