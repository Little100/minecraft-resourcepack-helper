import { uiText } from '../i18n/messages'
import * as fs from 'node:fs/promises'
import { McpOperationError, type McpFailure } from './errors'
import * as path from 'node:path'
import { instanceSchema, type McpInstance, type McpOperation, type McpProject } from './contracts'

export class McpProjectRouter {
  constructor(readonly registry: string) {}
  private async instances(): Promise<McpInstance[]> {
    const names = await fs.readdir(this.registry).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return [];throw error}), result:McpInstance[]=[]
    for(const name of names.slice(0,256)) {
      if(!/^[a-f0-9-]{36}\.json$/.test(name))continue
      try {
        const file=path.join(this.registry,name), stat=await fs.lstat(file)
        if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024)continue
        const instance=instanceSchema.parse(JSON.parse(await fs.readFile(file,'utf8'))), url=new URL(instance.endpoint)
        if(instance.expiresAt<Date.now()||instance.expiresAt>Date.now()+60000||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/call'||url.search||url.hash||url.username||url.password||!url.port)continue
        result.push(instance)
      }catch{}
    }
    return result
  }
  private async call(instance:McpInstance,projectId:string,operation:McpOperation,args:Record<string,unknown>):Promise<unknown>{
    const response=await fetch(instance.endpoint,{method:'POST',headers:{Authorization:'Bearer '+instance.token,'Content-Type':'application/json'},body:JSON.stringify({projectId,operation,args}),signal:AbortSignal.timeout(operation==='describe'?2000:90000),redirect:'error'})
    const reader=response.body?.getReader(), chunks:Uint8Array[]=[];let total=0
    if(!reader)throw new Error(uiText("mcp.router.mcpReturnsEmpty"))
    try{while(true){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>24*1024*1024)throw new Error(uiText("mcp.router.mcpReturnsTooBigPleaseNarrowDown"));chunks.push(part.value)}}finally{await reader.cancel()}
    const bytes=Buffer.concat(chunks)
    const payload=JSON.parse(Buffer.from(bytes).toString('utf8')) as {result?:unknown;error?:string;details?:McpFailure;projects?:McpProject[]}
    if(!response.ok)throw payload.details ? new McpOperationError(payload.details) : new Error(payload.error??uiText("mcp.router.vsCodeMcpRequestFailed"))
    return operation==='describe'?payload:payload.result
  }
  async projects():Promise<Array<McpProject & {instanceId:string}>>{
    const live=await Promise.all((await this.instances()).map(async instance=>{try{const result=await this.call(instance,'','describe',{}) as {projects:McpProject[]};return instanceSchema.shape.projects.parse(result.projects).filter(project=>project.id.startsWith(instance.instanceId+':')).map(project=>({...project,instanceId:instance.instanceId}))}catch{return []}}))
    return live.flat()
  }
  async invoke(projectId:string,operation:McpOperation,args:Record<string,unknown>):Promise<unknown>{
    const instance=(await this.instances()).find(value=>projectId.startsWith(value.instanceId+':'))
    if(!instance)throw new Error(uiText("mcp.router.itemIdDoesNotExistOrIs"))
    return this.call(instance,projectId,operation,args)
  }
}
