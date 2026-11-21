'use strict';
// Evaluates registrar source only; every project/SDK dependency is replaced by an inert mock.
const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');const url=require('node:url');
const root=path.resolve(__dirname,'../..');
const unexpected=()=>{throw Error('Unexpected host/process/startup activity');};
const schema=new Proxy(function(){},{get:()=>schema,apply:()=>schema});
class McpServer{constructor(meta,options){this.meta=meta;this.options=options;this.names=[];}tool(name){assert.ok(!this.names.includes(name),'duplicate '+name);this.names.push(name);}connect(){unexpected();}}
async function load(relative,overrides={}){
 const source=fs.readFileSync(path.join(root,relative),'utf8');
 const context=vm.createContext({process:{argv:['node',relative==='backends/unified/server.mjs'?'/mock/test.mjs':'/mock/backends/unified/server.mjs'],env:{},platform:'linux'},console:{error:unexpected},URL,Buffer,setTimeout:unexpected});
 const module=new vm.SourceTextModule(source,{context,initializeImportMeta:m=>m.url=url.pathToFileURL(path.join(root,'backends/unified/server.mjs')).href});
 await module.link(async spec=>{
  let exports=overrides[spec];
  if(!exports){
   if(spec==='node:path')exports={default:path};else if(spec==='node:url')exports={fileURLToPath:url.fileURLToPath,pathToFileURL:url.pathToFileURL};
   else if(spec==='../../npm-package/package.json')exports={default:require('../../npm-package/package.json')};
   else if(spec==='node:fs/promises')exports=Object.fromEntries(['readdir','readFile','mkdtemp','writeFile','rm','open'].map(n=>[n,unexpected]));
   else if(spec==='node:util')exports={promisify:()=>unexpected};
   else if(spec==='node:os')exports={default:{homedir:()=>'/mock'}};
   else if(spec.endsWith('/mcp.js'))exports={McpServer};else if(spec.endsWith('/stdio.js'))exports={StdioServerTransport:class{constructor(){unexpected();}}};
   else if(spec.includes('/zod/'))exports={z:schema};
   else if(spec.endsWith('packer.cjs'))exports={default:{packer:()=>unexpected}};
   else if(spec.endsWith('/hyperv/uac.cjs'))exports={default:{createHyperVUac:()=>({request:unexpected})}};
   else if(spec.endsWith('vision-preload.cjs'))exports={default:{ensureVisionServices:unexpected}};
   else if(spec.endsWith('adapter.cjs'))exports={default:{createPodmanAdapter:()=>({})}};
   else if(spec.endsWith('workspace.cjs'))exports={default:{createWorkspacePlanner:()=>({planWorkspace:unexpected})}};
   else if(spec.endsWith('types.js'))exports={config:{}};
   else {
    const declaration=source.split('\n').find(line=>line.includes("'"+spec+"'"));
    const named=declaration.match(/import\s*\{([^}]+)\}/);
    exports=named?Object.fromEntries(named[1].split(',').map(n=>[n.trim(),n.trim().startsWith('register')?()=>{}:unexpected])):{default:{}};
   }
  }
  return new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v]of Object.entries(exports))this.setExport(k,v);},{context});
 });await module.evaluate();return module.namespace;
}
test('VM, RPA and Podman registrars retain every declared tool without startup effects',async()=>{
 for(const [folder,fn]of [['virtualbox','registerVirtualBoxTools'],['library','registerLibraryTools'],['podman','registerPodmanTools']]){
  const m=await load(`backends/${folder}/server.mjs`);const server=new McpServer();m[fn](server);
  const source=fs.readFileSync(path.join(root,`backends/${folder}/server.mjs`),'utf8');
  const names=[...source.matchAll(/(?:server\.tool|add)\('([^']+)'/g)].map(x=>x[1]);
  if(folder==='podman'){
   const detach=names.indexOf('podman_workspace_detach');
   assert.notEqual(detach,-1);
   names.splice(detach+1,0,'podman_workspace_attach','vault_attach_container');
  }
  assert.deepEqual(server.names,names);assert.ok(names.length>0);
 }
});
test('unified combines four public registrars once and forwards options without connection',async()=>{
 const calls=[];const overrides={};
 for(const [folder,name,instructions]of [['virtualbox','registerVirtualBoxTools','virtualBoxInstructions'],['library','registerLibraryTools','libraryInstructions'],['podman','registerPodmanTools','podmanInstructions'],['remote_ssh','registerRemoteTools','remoteInstructions']])overrides[`../${folder}/server.mjs`]={[name]:(s,o)=>calls.push([folder,s,o]),[instructions]:folder};
 const m=await load('backends/unified/server.mjs',overrides);
 const remote={configured:true},podman={mock:true};const server=m.createUnifiedServer({remote,podman});
 assert.equal(calls.length,4);assert.ok(calls.every(c=>c[1]===server));assert.equal(calls[2][2],podman);assert.equal(calls[3][2],remote);
 assert.equal(server.meta.version,require('../../npm-package/package.json').version);
 assert.match(server.options.instructions,/Vault remains a separate server/);
});
