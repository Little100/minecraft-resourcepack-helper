import { uiText } from '../i18n/messages'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { resourcePath } from './contracts'

export function isPackResource(value: string): boolean {
  return /(?:^|\/)assets\/[^/]+\/.+\.(?:png|json|mcmeta|lang|properties)$/i.test(value) || /(?:^|\/)(?:pack\.mcmeta|pack\.png)$/i.test(value)
}
export async function resolveResource(root: string, relative: string, allowMissing = false): Promise<string> {
  resourcePath.parse(relative)
  if (!isPackResource(relative)) throw new Error(uiText("mcp.resourceAccess.onlyPngJsonMcmetaLangAndProperties"))
  const base = await fs.realpath(root), parts = relative.split('/'); let current = base
  for (let index=0;index<parts.length;index++) {
    current = path.join(current,parts[index])
    const stat = await fs.lstat(current).catch((error:NodeJS.ErrnoException) => { if(allowMissing && index===parts.length-1 && error.code==='ENOENT')return undefined; throw error })
    if (!stat) return current
    if (stat.isSymbolicLink() || index < parts.length-1 && !stat.isDirectory() || index===parts.length-1 && !stat.isFile()) throw new Error(uiText("mcp.resourceAccess.mcpDoesNotAccessSymbolicLinksOr"))
    const real = await fs.realpath(current), relation = path.relative(base,real)
    if (relation.startsWith('..') || path.isAbsolute(relation)) throw new Error(uiText("mcp.resourceAccess.resourcePathBeyondWorkArea"))
  }
  return current
}
export async function enumerateResources(root: string, maximum=10000): Promise<{ paths:string[]; truncated:boolean }> {
  const paths:string[]=[], queue=['']; let visited=0, truncated=false
  while(queue.length) {
    const relative=queue.shift()!, directory=path.join(root,relative)
    for await(const entry of await fs.opendir(directory)) {
      if(++visited>50000 || paths.length>=maximum) {truncated=true;break}
      if(entry.name.startsWith('.') || entry.isSymbolicLink() || entry.name==='node_modules')continue
      const item=relative?relative+'/'+entry.name:entry.name
      if(entry.isDirectory())queue.push(item)
      else if(entry.isFile()&&isPackResource(item)&&resourcePath.safeParse(item).success)paths.push(item)
    }
    if(truncated)break
  }
  return {paths:paths.sort(),truncated}
}
export async function readResourceBytes(root:string, relative:string, limit:number):Promise<Buffer> {
  const file=await resolveResource(root,relative), handle=await fs.open(file,'r')
  try {const stat=await handle.stat();if(stat.size>limit)throw new Error(uiText("mcp.resourceAccess.resourcesExceedReadOutBudgetPleaseNarrow")); const buffer=Buffer.alloc(limit+1); let length=0
    while(length<=limit){const {bytesRead}=await handle.read(buffer,length,buffer.length-length,null);if(!bytesRead)break;length+=bytesRead}
    if(length>limit)throw new Error(uiText("mcp.resourceAccess.resourcesExceedReadOutBudget"));return buffer.subarray(0,length)
  } finally {await handle.close()}
}
