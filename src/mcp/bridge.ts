import { uiText } from '../i18n/messages'
import * as fs from 'node:fs/promises'
import { mcpFailure } from './errors'
import * as path from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { bridgeCallSchema, MCP_BODY_BYTES, projectSchema, type McpInstance, type McpOperation, type McpProject } from './contracts'

export interface BridgeOptions { registry:string; projects():McpProject[]; invoke(project:McpProject,operation:McpOperation,args:Record<string,unknown>):Promise<unknown> }
export function validBearer(header:string|undefined,token:string):boolean {
  const actual=Buffer.from(header??''),expected=Buffer.from('Bearer '+token)
  return actual.length===expected.length&&timingSafeEqual(actual,expected)
}
export async function readJsonBody(request:IncomingMessage):Promise<unknown> {
  let size=0;const chunks:Buffer[]=[]
  for await(const chunk of request){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>MCP_BODY_BYTES)throw new Error(uiText("mcp.bridge.mcpRequestInExcessOfMib"));chunks.push(bytes)}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
const answer=(response:ServerResponse,status:number,value:unknown):void=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});response.end(JSON.stringify(value))}
export async function startMcpBridge(options:BridgeOptions) {
  const instanceId=randomUUID(),token=randomBytes(48).toString('base64url'),pending=new Map<string,Promise<unknown>>()
  let closed=false,publishing=Promise.resolve(),active=0,port=0
  const projects=():McpProject[]=>options.projects().slice(0,64).map(value=>({...projectSchema.parse(value),id:instanceId+':'+value.id}))
  const server=createServer((request,response)=>{void(async()=>{
    if(request.headers.origin||request.headers.host!=='127.0.0.1:'+port||!validBearer(request.headers.authorization,token)){answer(response,403,{error:'Forbidden'});return}
    if(request.method!=='POST'||request.url!=='/call'){answer(response,404,{error:'Not found'});return}
    if(++active>16){active--;answer(response,429,{error:'Too many requests'});return}
    try {
      const call=bridgeCallSchema.parse(await readJsonBody(request))
      if(call.operation==='describe'){answer(response,200,{instanceId,projects:projects()});return}
      const project=projects().find(value=>value.id===call.projectId);if(!project)throw new Error(uiText("mcp.bridge.projectsClosedOrIidDisabledPleaseRelist"))
      const previous=pending.get(project.id)??Promise.resolve(),next=previous.catch(()=>undefined).then(()=>{if(closed)throw new Error(uiText("mcp.bridge.mcpInstanceClosed"));if(!projects().some(value=>value.id===project.id))throw new Error(uiText("mcp.bridge.projectClosed"));return options.invoke(project,call.operation,call.args)})
      pending.set(project.id,next)
      try{answer(response,200,{result:await next})}finally{if(pending.get(project.id)===next)pending.delete(project.id)}
    }catch(error){answer(response,400,{error:error instanceof Error?error.message:'MCP operation failed',details:mcpFailure(error)})}finally{active--}
  })().catch(()=>{if(!response.headersSent)answer(response,500,{error:'MCP bridge failed'});else response.end()})})
  server.requestTimeout=30000;server.headersTimeout=10000
  const file=path.join(options.registry,instanceId+'.json'),temporary=file+'.tmp';let timer:NodeJS.Timeout|undefined
  const close=async():Promise<void>=>{if(closed)return;closed=true;if(timer)clearInterval(timer);server.close();server.closeAllConnections();await publishing.catch(()=>undefined);await fs.rm(file,{force:true});await fs.rm(temporary,{force:true})}
  try {
    await fs.mkdir(options.registry,{recursive:true,mode:0o700})
    const stat=await fs.lstat(options.registry);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error(uiText("mcp.bridge.mcpRegisterInvalid"))
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve()})})
    const address=server.address();if(!address||typeof address==='string')throw new Error(uiText("mcp.bridge.mcpPortCannotBeAssigned"));port=address.port
    const publish=():Promise<void>=>{
      publishing=publishing.catch(()=>undefined).then(async()=>{if(closed)return;const instance:McpInstance={schema:1,instanceId,token,endpoint:'http://127.0.0.1:'+port+'/call',expiresAt:Date.now()+45000,projects:projects()};await fs.writeFile(temporary,JSON.stringify(instance),{mode:0o600});await fs.rename(temporary,file)})
      return publishing
    }
    await publish();timer=setInterval(()=>{void publish().catch(()=>undefined)},15000);timer.unref();server.unref()
    return {instanceId,port,publish,close}
  }catch(error){await close().catch(()=>undefined);throw error}
}
