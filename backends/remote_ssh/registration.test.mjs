import test from 'node:test';
import assert from 'node:assert/strict';
import {registerRemoteTools,createMcpHandler} from './server.mjs';
import {createTools} from './tools.mjs';
import {resolveConfig} from './config.mjs';
import {remoteSchema} from './register.mjs';
import {PYTHON_TOOLS,pythonChildEnvironment} from './python-bridge.mjs';
function fixture(options={}){const tools=new Map();registerRemoteTools({registerTool:(name,schema,call)=>{assert.ok(!tools.has(name));tools.set(name,{schema,call});}},options);return tools;}
test('catalog registers all original tools without subprocess, filesystem or SSH calls',()=>{
 let connected=0;const tools=fixture({env:{VAMP_REMOTE_CONFIG_JSON:'invalid json'},run:()=>assert.fail('ran'),clientFactory:()=>{connected++;}});
 const old=createTools({config:resolveConfig({env:{}}),run:()=>assert.fail('ran')}).tools;
 assert.equal(tools.size,old.length*2+2);for(const tool of old)assert.ok(tools.has(tool.name));assert.equal(connected,0);
});
test('SSH config retains exact host and tool, never falls back after failure',async()=>{
 const calls=[];const tools=fixture({remoteConfig:{enabled:true,host:'fixture.example',username:'tester',port:2222,privateKeyPath:'/keys/user'},run:()=>assert.fail('local fallback'),clientFactory:config=>{
  assert.equal(config.host,'fixture.example');assert.equal(config.port,2222);assert.equal(config.privateKeyPath,'/keys/user');
  return {call:async(name,args)=>{calls.push({name,args});throw Error('SSH unavailable');}};
 }});
 const result=await tools.get('remote_vm_list').call({});assert.equal(result.isError,true);assert.match(result.content[0].text,/SSH unavailable/);assert.deepEqual(calls,[{name:'remote_vm_list',args:{}}]);
});
test('disabled, missing host and malformed optional settings fail closed only on call',async()=>{
 for(const env of [{},{VAMP_REMOTE_CONFIG_JSON:'{'},{VAMP_REMOTE_CONFIG_JSON:'{"enabled":false}'},{VAMP_REMOTE_CONFIG_JSON:'{"enabled":true}'}]){
  const tools=fixture({env,run:()=>assert.fail('local fallback'),clientFactory:()=>assert.fail('connect')});
  assert.equal((await tools.get('remote_vm_list').call({})).isError,true);
 }
});
test('explicit local KVM route retains original authorization checks and schema constraints',async()=>{
 const tools=fixture({env:{VAMP_REMOTE_REPO:'/fixture/repo'},platform:'linux',run:()=>assert.fail('no execution before approval')});
 const denied=await tools.get('kvm_rpa_run').call({id:'11111111-2222-3333-4444-555555555555',vm_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'});
 assert.match(JSON.stringify(denied),/confirm|authoriz/i);
 const create=await tools.get('kvm_vm_create').call({name:'test',iso_path:'/tmp/iso'});assert.match(JSON.stringify(create),/needs_confirmation/);
 assert.equal((await tools.get('kvm_vm_create').call({name:'test',iso_path:'/tmp/iso',guest_os:'ubuntu'})).isError,true);
 assert.equal((await tools.get('kvm_vm_mouse_move').call({vm:'test',x:2,y:0})).isError,true);
});
test('remote Vault replay without a host bridge never starts the replay interpreter',async t=>{
 for(const key of ['VAULT_RPA_BRIDGE_SOCKET','VAULT_RPA_BRIDGE_TOKEN']){
  const current=process.env[key];delete process.env[key];
  t.after(()=>{if(current!==undefined)process.env[key]=current;});
 }
 const tools=createTools({config:resolveConfig({env:{VAMP_REMOTE_REPO:'/fixture/repo'}}),run:()=>assert.fail('guest replay started')});
 const result=await tools.rpaRun({id:'11111111-2222-3333-4444-555555555555',
  vm_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',confirmed:true,vault_destination:'fixture'});
 assert.equal(result.status,'approval_required');
 assert.equal(result.actions_completed,0);
});
test('schema retains arrays records enums defaults and unknown-field rejection',()=>{
 const catalog=createTools({config:resolveConfig({env:{}}),run:()=>{}}).tools;
 const byName=name=>remoteSchema(catalog.find(t=>t.name===name).inputSchema);
 assert.throws(()=>byName('remote_vm_send_keys').parse({vm:'x',hotkey:Array(9).fill('ctrl')}));
 assert.throws(()=>byName('remote_rpa_run').parse({id:'x',vm_id:'y',inputs:{bad:1}}));
 assert.throws(()=>byName('remote_vm_list').parse({arbitrary:'x'}));
 assert.equal(byName('remote_vm_stop').parse({vm:'x'}).force,false);
});
test('SSH screenshot preserves image separately without duplicating base64 text',async()=>{
 const tools=fixture({remoteConfig:{enabled:true,host:'fixture'},clientFactory:()=>({call:async()=>({width:2,images:[{data:'abc',mimeType:'image/png'}]})})});
 const result=await tools.get('remote_vm_screenshot').call({vm:'test'});assert.equal(result.content[1].type,'image');assert.equal(result.content[1].data,'abc');assert.ok(!result.content[0].text.includes('abc'));
});
test('optional Python is lazy, fixed allowlisted, no preload, and closes after calls',async()=>{
 let calls=0,closed=0;const tools=fixture({env:{},pythonConfig:{enabled:true,python:'/existing/python',repo:'/existing/repo',config:'/existing/vms.json'},connectPython:async(config,env)=>{
  calls++;assert.equal(config.repo,'/existing/repo');assert.equal(env.VAMP_PRELOAD_MODELS,'0');return {call:async(name,args)=>({content:[{type:'text',text:JSON.stringify({name,args})}]}),close:async()=>{closed++;}};
 }});
 await tools.get('kvm_python_tools').call({});assert.equal(calls,0);
 assert.equal((await tools.get('kvm_python_call').call({tool:'execute_shell',arguments:{}})).isError,true);assert.equal(calls,0);
 const result=await tools.get('kvm_python_call').call({tool:'vm_viewer_info',arguments:{vm_name:'guest'}});assert.match(result.content[0].text,/vm_viewer_info/);assert.equal(calls,1);assert.equal(closed,1);
 assert.equal(PYTHON_TOOLS.length,18);
});
test('Python missing configuration cannot silently switch to SSH or auto-detect interpreter',async()=>{
 const tools=fixture({env:{},connectPython:()=>assert.fail('child must not start')});
 const result=await tools.get('kvm_python_call').call({tool:'vm_list'});assert.equal(result.isError,true);assert.match(result.content[0].text,/disabled/);
});
test('real MCP SDK discovery and SSH mock call preserve schemas and content',async()=>{
 const [{McpServer},{Client},{InMemoryTransport}]=await Promise.all([
  import('../../third_party/mcp-virtualbox/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js'),
  import('../../third_party/mcp-virtualbox/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'),
  import('../../third_party/mcp-virtualbox/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js'),
 ]);
 const server=new McpServer({name:'fixture',version:'1'});let calls=0;
 registerRemoteTools(server,{remoteConfig:{enabled:true,host:'fixture'},clientFactory:()=>({call:async(name,args)=>{calls++;return {name,args};}}),pythonConfig:{enabled:true,python:'/fixture/python',repo:'/fixture/repo'},connectPython:async()=>({call:async(name,args)=>({content:[{type:'text',text:JSON.stringify({name,args})}]}),close:async()=>{}})});
 const client=new Client({name:'fixture-client',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 try{
  const {tools}=await client.listTools();assert.equal(calls,0);assert.equal(tools.length,32);
  const schema=tools.find(t=>t.name==='remote_vm_create').inputSchema;
  assert.deepEqual(schema.properties.guest_os.enum,['debian','windows11']);
  assert.equal(schema.properties.bootstrap_host.format,'ipv4');
  assert.equal((await client.callTool({name:'remote_vm_create',arguments:{name:'Fixture',iso_path:'/fixture.iso',bootstrap_host:'http://10.0.2.2:8421'}})).isError,true);
  assert.equal(calls,0);
  const output=await client.callTool({name:'remote_vm_stop',arguments:{vm:'guest'}});assert.equal(calls,1);assert.equal(JSON.parse(output.content[0].text).args.force,false);
  const py=await client.callTool({name:'kvm_python_call',arguments:{tool:'vm_viewer_info',arguments:{vm_name:'fixture'}}});
  assert.equal(py.isError,undefined);assert.equal(JSON.parse(py.content[0].text).args.vm_name,'fixture');
 }finally{await client.close();await server.close();}
});
test('local KVM aliases work when SSH disabled and cannot inherit remote backend',async()=>{
 const calls=[];const tools=fixture({platform:'linux',env:{VAMP_REMOTE_CONFIG_JSON:'{"enabled":false}',VAMP_REMOTE_BACKEND:'virtualbox'},clientFactory:()=>assert.fail('no SSH'),run:async(exe,args)=>{calls.push([exe,args]);return {stdout:''};}});
 const result=await tools.get('kvm_vm_list').call({});assert.equal(result.isError,undefined);
 assert.ok(calls.length>0);assert.equal(calls[0][0],'virsh');assert.ok(calls[0][1].includes('qemu:///system'));
 assert.equal((await tools.get('remote_vm_list').call({})).isError,true);
});
test('local KVM rejects non-Linux before commands and never reroutes to SSH',async()=>{
 for(const platform of ['win32','darwin']){
  const tools=fixture({platform,remoteConfig:{enabled:true,host:'remote'},run:()=>assert.fail('no execution'),clientFactory:()=>assert.fail('no SSH')});
  const result=await tools.get('kvm_env_check').call({});assert.equal(result.isError,true);assert.match(result.content[0].text,/require a Linux host/);
 }
});

test('Python child environment excludes unrelated credential and runtime injection variables',()=>{
 const result=pythonChildEnvironment({config:'/vms.json'},{PATH:'/bin',HOME:'/user',OPENAI_API_KEY:'private',NPM_TOKEN:'private',AWS_SECRET_ACCESS_KEY:'private',PYTHONPATH:'/injected',NODE_OPTIONS:'--require injected',VAMP_REMOTE_CONFIG_JSON:'private',VM_MCP_CONFIG:'/wrong',VAMP_PRELOAD_MODELS:'1'});
 assert.deepEqual(result,{PATH:'/bin',HOME:'/user',PYTHONIOENCODING:'utf-8',VAMP_PRELOAD_MODELS:'0',VM_MCP_CONFIG:'/vms.json'});
});
