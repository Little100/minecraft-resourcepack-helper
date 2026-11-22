import { uiText } from '../i18n/messages'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler, hostHeaderValidation, originValidation } from '@modelcontextprotocol/node'
import { validBearer } from './bridge'
import { MCP_BODY_BYTES } from './contracts'
import { createMcrhServer } from './server'
import type { McpProjectRouter } from './router'

export interface McpHttpOptions { router:McpProjectRouter; host?:string; port?:number; token:string;  allowedHosts?:string[]; allowedOrigins?:string[]; tls?:{cert:string;key:string} }
export async function startMcpHttp(options:McpHttpOptions) {
  const host=options.host??'127.0.0.1'
  if(options.token.length<32||options.token.length>256||/\s/.test(options.token))throw new Error(uiText("mcp.httpServer.mcpHttpToNonEmptyCharactersRequired"))
  if(!['127.0.0.1','::1','localhost'].includes(host)&&!options.tls)throw new Error(uiText("mcp.httpServer.httpsCertKeyMustBeProvidedBy"))
  const handler=createMcpHandler(()=>createMcrhServer(options.router),{legacy:'stateless',maxRequestBodySize:MCP_BODY_BYTES,maxSubscriptions:16}),nodeHandler=toNodeHandler(handler)
  const validateHost=hostHeaderValidation([...new Set([host,'localhost','127.0.0.1','[::1]',...(options.allowedHosts??[])])]),validateOrigin=originValidation(options.allowedOrigins??[])
  let active=0
  const request=(req:IncomingMessage,res:ServerResponse):void=>{
    if(!validateHost(req,res)||!validateOrigin(req,res))return
    if(!validBearer(req.headers.authorization,options.token)){res.writeHead(401,{'WWW-Authenticate':'Bearer realm="mcrh"','Cache-Control':'no-store'});res.end();return}
    if(req.url!=='/mcp'){res.writeHead(404);res.end();return}
    if(++active>32){active--;res.writeHead(429);res.end();return}
    res.once('close',()=>{active--});res.setHeader('Cache-Control','no-store')
    void nodeHandler(req,res).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end()})
  }
  const server=options.tls?createHttpsServer(options.tls,request):createHttpServer(request)
  server.headersTimeout=10000;server.requestTimeout=120000
  try {await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port??0,host,()=>{server.removeListener('error',reject);resolve()})})}catch(error){await handler.close();throw error}
  const address=server.address();if(!address||typeof address==='string')throw new Error(uiText("mcp.httpServer.mcpHttpDoesNotGetAListening"))
  return {port:address.port,async close():Promise<void>{await handler.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}}
}
