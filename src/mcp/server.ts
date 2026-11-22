import { uiText } from '../i18n/messages'
import { mcpFailure } from './errors'
import packageInfo from '../../package.json'
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { editOperations } from './contracts'
import { operationSchemas, type ToolOperation } from './toolSchemas'
import type { McpProjectRouter } from './router'
import { MCP_PAINTING_WORKFLOW } from './workflow'

const descriptions:Record<ToolOperation,string>={
  collaboration_status: uiText("mcp.server.localSavedChangesConflictsMembershipAndSubmission"),
  collaboration_submit: uiText("mcp.server.callLocallySavedChangesToTheCurrent"),
  list_resources:uiText("mcp.server.searchAndListTheMaterialPackageResource"),
  read_text:uiText("mcp.server.readTheCurrentlyUnsavedModelJsonMcmeta"),
  get_textures: uiText("mcp.server.batchPreviewOfRawPicturesWithoutOpening"),
  context: uiText("mcp.server.queryTheActivityResourcesOfTheSelected"),
  references: uiText("mcp.server.listQueryTargetPngAddedReferenceDiagrams"),
  create_texture: uiText("mcp.server.createsAnExistingBlankPngTheDefault"),
  batch_texture: uiText("mcp.server.applyTheSamePaletteToUpTo"),
  resize_texture: uiText("mcp.server.recentNeighboringOrAdjustingCanvassAllLayers"),
  texture_frames: uiText("mcp.server.reorderCopyDeleteFramesByOrderInsert"),
  get_texture:uiText("mcp.server.preDrawCallReturningTheFirstVisible"),
  open_editor:uiText("mcp.server.opensTheResourcePngInTheSpecified"),
  edit_pixels:uiText("mcp.server.locallyModifiedPreferencesOnlyThinPixelsOr"),
  paint_texture:uiText("mcp.server.localPatternOrBatchDrawingOnlySmall"),
  texture_history:uiText("mcp.server.listsThePaintingHistoryOfTheSpecified"),
  edit_layers:uiText("mcp.server.addDeleteRenameHideAdjustOrIndex"),
  transform_layers:uiText("mcp.server.theWholeMoveTheRecentAlliedZoom"),
  recolor_edges:uiText("mcp.server.identifyTheEdgesAndWriteBackTo"),
  write_json:uiText("mcp.server.verifyAndReplaceTheResourceJsonMcmeta"),
  save_resource:uiText("mcp.server.visibleSavingVerifiedReviewResourcesAreOnly"),
  diagnose:uiText("mcp.server.checkToSpecifyASavedResourceUnder"),
  git_status:uiText("mcp.server.readItemsGitFileChangeStateWithout")
}
export function createMcrhServer(router:McpProjectRouter):McpServer {
  const server=new McpServer({name:'mcrh',version:packageInfo.version},{instructions:MCP_PAINTING_WORKFLOW})
  server.registerResource('texture-workflow', 'mcrh://docs/texture-workflow', { mimeType: 'text/plain', description: uiText("mcp.server.pasteReadingReferenceDiagramsLocalModificationsBatch") }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: MCP_PAINTING_WORKFLOW + uiText("mcp.server.accurateMatricesUpToPixelsColoursUnilateral") }] }))
  server.registerTool('mcrh_list_projects',{description:uiText("mcp.server.findsThatTheCurrentUserHasEnabled"),inputSchema:z.object({query:z.string().max(512).optional()}).strict(),annotations:{readOnlyHint:true,openWorldHint:false}},async({query})=>{
    const projects=(await router.projects()).map(project=>({...project,connection_state:'connected'})), search=query?.toLocaleLowerCase(),filtered=search?projects.filter(project=>(project.name+' '+project.root).toLocaleLowerCase().includes(search)):projects
    return {content:[{type:'text',text:JSON.stringify({projects:filtered,note:filtered.length?uiText("mcp.server.projectIdUsesTheSameNameFor"):uiText("mcp.server.mcpConnectedButNoMatchingOpenedItems")})}]}
  })
  for(const operation of Object.keys(operationSchemas) as ToolOperation[]) {
    const schema=z.object({project_id:z.string().min(1).max(128),...operationSchemas[operation].shape}).strict(),editing=editOperations.has(operation)
    server.registerTool('mcrh_'+operation,{description:descriptions[operation],inputSchema:schema,annotations:{readOnlyHint:!editing,destructiveHint:editing,idempotentHint:!editing,openWorldHint:operation==='collaboration_status'||operation==='collaboration_submit'}},async(input):Promise<CallToolResult>=>{
      try {
        const {project_id,...args}=input, result=await router.invoke(project_id,operation,args)
        if(operation==='get_texture'||operation==='paint_texture'||(operation==='references' && ('png_base64' in (result as object)||'image_base64' in (result as object)))||(operation==='texture_history'&&typeof (result as Record<string,unknown>).png_base64==='string')) {
          const {png_base64,image_base64,mime_type,...metadata}=result as Record<string,unknown>
          const image = png_base64 ?? image_base64
          if(typeof image!=='string')throw new Error(uiText("mcp.server.previewsDoNotReturnPictures"))
          return {content:[{type:'text',text:JSON.stringify(metadata)},{type:'image',data:image,mimeType:typeof mime_type === 'string' ? mime_type : 'image/png'}]}
        }
        if (operation === 'get_textures') {
          const textures = (result as { textures: Record<string,unknown>[] }).textures
          const content: CallToolResult['content'] = []
          for (const { png_base64, ...metadata } of textures) { content.push({ type: 'text', text: JSON.stringify(metadata) }); if (typeof png_base64 === 'string') content.push({ type: 'image', data: png_base64, mimeType: 'image/png' }) }
          return { content }
        }
        return {content:[{type:'text',text:JSON.stringify(result)}]}
      } catch(error) {return {isError:true,content:[{type:'text',text:JSON.stringify(mcpFailure(error))}]}}
    })
  }
  server.registerPrompt('mcrh_edit_texture',{description:uiText("mcp.server.workstreamPackageByProjectDiscoveryVisualizationEditing"),argsSchema:z.object({project:z.string().max(512),task:z.string().max(4000)})},({project,task})=>({messages:[{role:'user',content:{type:'text',text:MCP_PAINTING_WORKFLOW+uiText("mcp.server.userSpecifyItems")+project+uiText("mcp.server.otherOrganiser")+task}}]}))
  return server
}
