// Optional existing Python VM controller, reached only by an explicit tool call.
// No Python import, subprocess, model preload or VM connection during discovery.
import path from 'node:path';
import { z } from '../../third_party/mcp-virtualbox/node_modules/zod/index.js';
export const PYTHON_TOOLS=Object.freeze([
 'vm_list','vm_rpas','vm_start','vm_inspect','vm_capture','vm_input','vm_run_rpa',
 'vm_read_evidence','vm_models','hyperv_open_console','vm_recorder_media',
 'virtualbox_create','vm_create','vm_lifecycle','vm_viewer_info',
 'vm_exchange_prepare','vm_file_put','vm_file_get',
]);
const failure=error=>({isError:true,content:[{type:'text',text:JSON.stringify({status:'error',message:String(error?.message||error)})}]});
export function pythonChildEnvironment(config,env={}){
 const allowed=new Set(['PATH','Path','PATHEXT','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','HOME','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','TEMP','TMP','TMPDIR','LANG','LC_ALL','LC_CTYPE','XDG_RUNTIME_DIR','XDG_CONFIG_HOME','XDG_CACHE_HOME']);
 const childEnv=Object.fromEntries(Object.entries(env).filter(([key,value])=>allowed.has(key)&&typeof value==='string'));
 childEnv.PYTHONIOENCODING='utf-8';
 childEnv.VAMP_PRELOAD_MODELS='0';
 if(config.config)childEnv.VM_MCP_CONFIG=config.config;
 return childEnv;
}
async function connectPython(config,env){
 const [{Client},{StdioClientTransport}]=await Promise.all([
  import('../../third_party/mcp-virtualbox/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'),
  import('../../third_party/mcp-virtualbox/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'),
 ]);
 const client=new Client({name:'VAMP optional Python bridge',version:'0.3.3'});
 const childEnv=pythonChildEnvironment(config,env);
 const transport=new StdioClientTransport({command:config.python,
  args:[path.join(config.repo,'vm_mcp_server.py')],cwd:config.repo,env:childEnv,stderr:'pipe'});
 try{await client.connect(transport);}catch(error){await transport.close().catch(()=>{});throw error;}
 // Diagnostics stay out of protocol/model output and cannot block a full pipe.
 transport.stderr?.resume();
 return {call:(name,args)=>client.callTool({name,arguments:args},undefined,{timeout:1900000}),close:()=>client.close()};
}
export function registerPythonTools(server,options={}){
 const env=options.env||process.env;
 function config(){
  const raw=options.pythonConfig??(env.VAMP_PYTHON_CONFIG_JSON ? JSON.parse(env.VAMP_PYTHON_CONFIG_JSON):undefined);
  if(!raw || raw.enabled!==true)throw Error('Optional Python VM controller is disabled. Configure its existing Python environment, repository and VM config; no fallback was attempted.');
  for(const key of ['python','repo'])if(typeof raw[key]!=='string'||!raw[key].trim()||/[\0\r\n]/.test(raw[key]))throw Error(`Invalid Python bridge ${key}`);
  if(!path.isAbsolute(raw.python))throw Error('Python bridge python must be an absolute existing interpreter path');
  if(!path.isAbsolute(raw.repo))throw Error('Python bridge repo must be an absolute existing VAMP repository path');
  if(raw.config!==undefined && (typeof raw.config!=='string'||!path.isAbsolute(raw.config)||/[\0\r\n]/.test(raw.config)))throw Error('Python bridge config must be an absolute VM config path');
  return raw;
 }
 server.registerTool('kvm_python_tools',{description:'Discover the fixed optional Python VM/VNC controller tool names without starting Python. These use a separate explicitly configured local repository, never the remote SSH target.',inputSchema:{} ,annotations:{readOnlyHint:true}},async()=>({content:[{type:'text',text:JSON.stringify({tools:PYTHON_TOOLS,configuration:'VAMP_PYTHON_CONFIG_JSON',lazy:true,target:'explicit local Python repository',schema_source:'existing vm_mcp_server.py in that repository'})}]}));
 const inputSchema=z.object({tool:z.enum(PYTHON_TOOLS),arguments:z.record(z.string(),z.unknown()).default({})}).strict();
 server.registerTool('kvm_python_call',{description:'Invoke exactly one existing optional Python VM/VNC controller tool by fixed allowlisted name. Original tool validation and authorization still apply. vm_input, vm_start, vm_create, vm_lifecycle, vm_run_rpa, vm_models, exchange and file tools can change state; obtain task authorization first. Python starts only for this call, with model preload disabled. Uses the configured local Python repository, not remote SSH.',inputSchema,annotations:{readOnlyHint:false}},async args=>{
  let child;
  try{
   const parsed=inputSchema.parse(args);
   if(Buffer.byteLength(JSON.stringify(parsed.arguments))>128*1024)throw Error('Python tool arguments exceed 128 KiB');
   const selected=config();
   child=await (options.connectPython||connectPython)(selected,pythonChildEnvironment(selected,env));
   return await child.call(parsed.tool,parsed.arguments);
  }catch(error){return failure(error);}finally{if(child)await child.close().catch(()=>{});}
 });
 return {names:['kvm_python_tools','kvm_python_call']};
}
