'use strict';
// Only newly authored server source is evaluated; SDK, schemas and adapter are mocks.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
test('thin MCP routes only six tools and performs no startup target access',async()=>{
 const calls=[];const adapter={};
 for(const method of ['connections','check','list','start','stop','logs'])adapter[method]=async(...args)=>{calls.push({method,args});return {ok:true};};
 class McpServer{constructor(meta,options){this.meta=meta;this.options=options;this.tools=new Map();}tool(name,description,schema,annotations,callback){this.tools.set(name,{schema,annotations,callback});}}
 const schema={regex(){return this;},int(){return this;},min(){return this;},max(){return this;},default(){return this;}};
 const z={string:()=>schema,number:()=>schema,literal:()=>schema};
 const context=vm.createContext({process:{argv:[]}});
 const modules={
  '../../third_party/mcp-virtualbox/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js':{McpServer},
  '../../third_party/mcp-virtualbox/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js':{StdioServerTransport:class{}},
  '../../third_party/mcp-virtualbox/node_modules/zod/index.js':{z},'node:url':{pathToFileURL},'node:path':{default:path},
  './adapter.cjs':{default:{createPodmanAdapter:()=>adapter}}
 };
 const mod=new vm.SourceTextModule(fs.readFileSync(path.join(__dirname,'server.mjs'),'utf8'),{context,initializeImportMeta:m=>{m.url='file:///mock/server.mjs';}});
 await mod.link(async spec=>{assert.ok(modules[spec],`unexpected import ${spec}`);const values=modules[spec];return new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v]of Object.entries(values))this.setExport(k,v);},{context});});
 await mod.evaluate();const server=mod.namespace.createPodmanServer({adapter});
 assert.equal(calls.length,0);assert.equal(server.tools.size,6);
 assert.deepEqual([...server.tools.keys()],['podman_connections','podman_check','podman_list','podman_start','podman_stop','podman_logs']);
 for(const [tool,method]of [['podman_connections','connections'],['podman_check','check'],['podman_list','list'],['podman_start','start'],['podman_stop','stop'],['podman_logs','logs']]){
  await server.tools.get(tool).callback({connection:'qa',id:'a'.repeat(64),tail:5,binding:'b'.repeat(64),confirmed:true});assert.equal(calls.at(-1).method,method);if(['start','stop'].includes(method))assert.equal(calls.at(-1).args[2],'b'.repeat(64));if(method==='logs')assert.equal(calls.at(-1).args[3],'b'.repeat(64));
 }
 const count=calls.length;const denied=await server.tools.get('podman_start').callback({connection:'qa',id:'a'.repeat(64)});assert.equal(denied.isError,true);assert.equal(calls.length,count);assert.equal(server.tools.get('podman_list').annotations.readOnlyHint,true);assert.equal(server.tools.get('podman_stop').annotations.readOnlyHint,false);
 assert.match(server.options.instructions,/untrusted/);assert.match(server.options.instructions,/runtime\/skills/);
});
