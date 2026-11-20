'use strict';
// Only newly authored server source is evaluated; SDK, schemas and adapter are mocks.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {pathToFileURL,fileURLToPath}=require('node:url');
const path=require('node:path');
test('thin MCP routes existing operations and a read-only plan without startup target access',async()=>{
 const calls=[];const adapter={};
 const assertDetached=async()=>{};
 for(const method of ['connections','check','list','start','stop','logs','workspaceStatus','workspaceAttach'])adapter[method]=async(...args)=>{calls.push({method,args});return {ok:true};};
 class McpServer{constructor(meta,options){this.meta=meta;this.options=options;this.tools=new Map();}tool(name,description,schema,annotations,callback){this.tools.set(name,{schema,annotations,callback});}}
 const schema={regex(){return this;},int(){return this;},min(){return this;},max(){return this;},default(){return this;}};
 const z={string:()=>schema,number:()=>schema,literal:()=>schema,enum:()=>schema};
 const context=vm.createContext({process:{argv:[]},URL,Buffer});
 const modules={
  '../../third_party/mcp-virtualbox/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js':{McpServer},
  '../../third_party/mcp-virtualbox/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js':{StdioServerTransport:class{}},
  '../../third_party/mcp-virtualbox/node_modules/zod/index.js':{z},'node:url':{pathToFileURL,fileURLToPath},'node:path':{default:path},
  'node:fs/promises':{readFile:()=>{throw Error('Default asset read during registration');}},
  './browser-viewer.mjs':{createBrowserViewer:()=>{throw Error('Viewer open during registration');}},
  './adapter.cjs':{default:{createPodmanAdapter:()=>adapter}},
  '../../vscode-vault-extension/src/bridge_client.mjs':{BridgeClient:{connect:()=>assert.fail('unexpected Vault bridge access')}},
  '../../vscode-vault-extension/src/vm_volume_state.mjs':{withVmVolumeState:work=>work({assertDetached})},
  './workspace.cjs':{default:require('./workspace.cjs')},
  './debian-host.cjs':{default:{createDebianHost:()=>{throw Error('Default builder constructed before use');}}}
 };
 const mod=new vm.SourceTextModule(fs.readFileSync(path.join(__dirname,'server.mjs'),'utf8'),{context,initializeImportMeta:m=>{m.url='file:///mock/server.mjs';}});
 await mod.link(async spec=>{assert.ok(modules[spec],`unexpected import ${spec}`);const values=modules[spec];return new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v]of Object.entries(values))this.setExport(k,v);},{context});});
 const shown='http://127.0.0.1:6082/#'+'b'.repeat(64);
 adapter.screenTarget=async(...args)=>{calls.push({method:'screenTarget',args});return {id:args[1]};};
 adapter.openScreenStream=async(...args)=>{calls.push({method:'openScreenStream',args});};
 adapter.capture=async(c,id)=>({connection:c,id,width:1920,height:1080,png:Buffer.from([137,80,78,71,13,10,26,10])});
 const hostBuilder={prepareDebianHost:async args=>{calls.push({method:'prepareDebianHost',args});return {status:'queued'};},debianHostStatus:async id=>{calls.push({method:'debianHostStatus',id});return {status:'building'};}};
 await mod.evaluate();const server=mod.namespace.createPodmanServer({adapter,hostBuilder,getViewerModule:async()=>'fixture',
  openBrowserViewer:async options=>{calls.push({method:'createViewer',args:[options.containerId,options.mode]});return {url:shown};}});
 assert.equal(calls.length,0);assert.equal(server.tools.size,17);
 assert.deepEqual([...server.tools.keys()],['podman_connections','podman_check','podman_list','podman_debian_vm_build_status','podman_prepare_debian_vm','podman_start','podman_stop','podman_logs','podman_workspace_plan','podman_workspace_check','podman_workspace_unlock','podman_workspace_lock','podman_workspace_detach','podman_workspace_attach','vault_attach_container','podman_capture_container_screen','podman_view_container_screen']);
 const readOnly=server.tools.get('podman_workspace_plan');
 assert.equal(readOnly.annotations.readOnlyHint,true);
 const plan=await readOnly.callback({target_id:'demo'});
 assert.equal(JSON.parse(plan.content[0].text).reason,'trusted_probe_unavailable');
 assert.equal(calls.length,0);
 for(const [tool,method]of [['podman_connections','connections'],['podman_check','check'],['podman_list','list'],['podman_start','start'],['podman_stop','stop'],['podman_logs','logs']]){
  await server.tools.get(tool).callback({connection:'qa',id:'a'.repeat(64),tail:5,binding:'b'.repeat(64),confirmed:true});assert.equal(calls.at(-1).method,method);if(['start','stop'].includes(method))assert.equal(calls.at(-1).args[2],'b'.repeat(64));if(method==='logs')assert.equal(calls.at(-1).args[3],'b'.repeat(64));
 }
 const count=calls.length;const denied=await server.tools.get('podman_start').callback({connection:'qa',id:'a'.repeat(64)});assert.equal(denied.isError,true);assert.equal(calls.length,count);assert.equal(server.tools.get('podman_list').annotations.readOnlyHint,true);assert.equal(server.tools.get('podman_stop').annotations.readOnlyHint,false);
 const p={iso_path:'/local/debian.iso',iso_sha256:'a'.repeat(64),provider:'virtualbox',confirmed:false};
 assert.equal((await server.tools.get('podman_prepare_debian_vm').callback(p)).isError,true);
 assert.equal((await server.tools.get('podman_prepare_debian_vm').callback({...p,confirmed:true})).isError,undefined);
 assert.equal(calls.at(-1).args.isoPath,p.iso_path);
 assert.equal(calls.at(-1).args.isoSha256,p.iso_sha256);
 await server.tools.get('podman_debian_vm_build_status').callback({job_id:'a'.repeat(32)});
 assert.equal(calls.at(-1).method,'debianHostStatus');
 const workspace={connection:'local-linux',binding:'c'.repeat(64),approval_id:'d'.repeat(64),confirmed:true};
 assert.equal((await server.tools.get('podman_workspace_unlock').callback({...workspace,confirmed:false})).isError,true);
 assert.equal((await server.tools.get('podman_workspace_lock').callback({...workspace,confirmed:false})).isError,true);
 await server.tools.get('podman_workspace_check').callback(workspace);
 assert.equal(calls.at(-1).method,'workspaceStatus');
 const beforeAttach=calls.length;
 assert.equal((await server.tools.get('podman_workspace_attach').callback({...workspace,confirmed:false})).isError,true);
 assert.equal(calls.length,beforeAttach);
 await server.tools.get('podman_workspace_attach').callback(workspace);
 assert.equal(calls.at(-1).method,'workspaceAttach');
 assert.equal(calls.at(-1).args[2],workspace.approval_id);
 assert.equal((await server.tools.get('vault_attach_container').callback({...workspace,confirmed:false})).isError,true);
 await server.tools.get('vault_attach_container').callback(workspace);
 assert.deepEqual(calls.at(-1).args,[workspace.connection,workspace.binding,workspace.approval_id]);
 const detach=server.tools.get('podman_workspace_detach');
 assert.equal((await detach.callback({...workspace,id:'a'.repeat(64),confirmed:false})).isError,true);
 assert.equal(calls.at(-1).method,'workspaceAttach');
 adapter.workspaceDetach=async(...args)=>{calls.push({method:'workspaceDetach',args});return {status:'detached',workspace_cleanup:'pending'};};
 const detached=JSON.parse((await detach.callback({...workspace,id:'a'.repeat(64)})).content[0].text);
 assert.equal(detached.status,'detached');
 assert.equal(detached.workspace_cleanup,'pending');
 assert.deepEqual(calls.at(-1).args,[workspace.connection,'a'.repeat(64),workspace.binding,assertDetached]);
 const request={connection:'qa',id:'a'.repeat(64),binding:'b'.repeat(64),confirmed:true,mode:'control'};
 const view=await server.tools.get('podman_view_container_screen').callback(request);
 assert.equal(view.structuredContent.url,shown);assert.equal(view.structuredContent.mode,'control');assert.equal(view.structuredContent.container_id,request.id);
 assert.equal(calls.filter(x=>x.method==='openScreenStream').length,0);
 assert.equal((await server.tools.get('podman_capture_container_screen').callback(request)).content[0].mimeType,'image/png');
 assert.equal((await server.tools.get('podman_view_container_screen').callback({...request,confirmed:false})).isError,true);
 assert.match(server.options.instructions,/untrusted/);assert.match(server.options.instructions,/runtime\/skills/);
});
