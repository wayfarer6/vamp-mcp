'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createPodmanAdapter,standardLocations}=require('./adapter.cjs');
const id='a'.repeat(64);
const {createHash}=require('node:crypto');
const good={Name:'qa',URI:'ssh://tester@example.test/run/user/1000/podman/podman.sock',Identity:'/not/read'};
const binding=createHash('sha256').update(JSON.stringify(['qa',good.URI,good.Identity])).digest('hex');
test('standard search includes the official per-user Windows MSI location, not PATH or the checkout',()=>{
 assert.equal(standardLocations('win32','D:\\Users\\tester')[0],'D:\\Users\\tester\\AppData\\Local\\Programs\\Podman\\podman.exe');
 assert.deepEqual(standardLocations('linux'),['/usr/bin/podman','/usr/local/bin/podman']);
 assert.ok(!standardLocations('win32','relative').some(p=>p.includes('relative')));
});
function fixture({connections=[good],info={host:{security:{rootless:true},serviceIsRemote:true}},containers=[{Id:id,Names:['demo'],Image:'image',State:'running',Status:'Up'}],fail=false,output='bounded output'}={}){
 const calls=[];
 const adapter=createPodmanAdapter({execute:async(exe,args,options)=>{
  calls.push({exe,args,options});
  assert.equal(exe,'podman');assert.equal(options.shell,false);assert.equal(options.windowsHide,true);assert.equal(options.timeout,30000);assert.equal(options.maxBuffer,1048576);
  if(fail)throw Error('secret raw stderr');
  if(args[0]==='system')return {stdout:JSON.stringify(connections)};
  assert.deepEqual(args.slice(0,7),['--remote','--url',good.URI,'--identity',good.Identity,'--ssh','golang']);
  if(args[7]==='info')return {stdout:JSON.stringify(info)};
  if(args[7]==='ps')return {stdout:JSON.stringify(containers)};
  return {stdout:output};
 }});
 return {adapter,calls};
}
test('discovery never connects and suppresses URI/identity',async()=>{
 const {adapter,calls}=fixture();assert.deepEqual(await adapter.connections(),[{name:'qa',transport:'ssh',rootlessCandidate:true}]);assert.equal(calls.length,1);
});
test('reject unsafe transports, root and ambiguous connection names',async()=>{
 for(const URI of ['tcp://host:1234','unix:///run/podman/podman.sock','ssh://root@host/run/user/1000/podman/podman.sock','ssh://u@host/run/podman/podman.sock','ssh://u:p@host/run/user/1000/podman/podman.sock','ssh://u@host/run/user/1000/podman/podman.sock?secure=False']){
  const {adapter,calls}=fixture({connections:[{...good,URI}]});await assert.rejects(adapter.check('qa'));assert.equal(calls.length,1);
 }
 await assert.rejects(fixture({connections:[good,good]}).adapter.check('qa'));
});
test('explicit rootless and remote booleans required',async()=>{
 for(const info of [{},{host:{security:{rootless:'true'},serviceIsRemote:true}},{host:{security:{rootless:false},serviceIsRemote:true}},{host:{security:{rootless:true},serviceIsRemote:false}}])await assert.rejects(fixture({info}).adapter.list('qa'),/remote rootless/);
});
test('invalid name rejected before any command',async()=>{
 const {adapter,calls}=fixture();for(const n of ['',undefined,'--url=x','a;echo','qa\n'])await assert.rejects(adapter.check(n));assert.equal(calls.length,0);
});
test('list normalizes safe compact rows',async()=>{assert.deepEqual((await fixture().adapter.list('qa')).containers,[{id,name:'demo',image:'image',state:'running',status:'Up'}]);});
test('start and stop target full existing IDs with fixed args',async()=>{
 const {adapter,calls}=fixture();await adapter.start('qa',id,binding);assert.deepEqual(calls.at(-1).args,['--remote','--url',good.URI,'--identity',good.Identity,'--ssh','golang','start','--',id]);await adapter.stop('qa',id,binding);assert.deepEqual(calls.at(-1).args,['--remote','--url',good.URI,'--identity',good.Identity,'--ssh','golang','stop','--time','10','--',id]);
});
test('reject short and absent IDs without mutation',async()=>{
 const {adapter,calls}=fixture({containers:[]});await assert.rejects(adapter.start('qa','abc'));assert.equal(calls.length,0);await assert.rejects(adapter.stop('qa',id,binding),/not present/);assert.ok(!calls.some(c=>['start','stop'].includes(c.args[7])));
});
test('logs strictly bounded and do not follow',async()=>{
 const {adapter,calls}=fixture();for(const n of [0,1001,1.5,'5'])await assert.rejects(adapter.logs('qa',id,n,binding));assert.equal(calls.length,0);assert.equal((await adapter.logs('qa',id,15,binding)).text,'bounded output');assert.deepEqual(calls.at(-1).args,['--remote','--url',good.URI,'--identity',good.Identity,'--ssh','golang','logs','--tail','15','--',id]);
});
test('errors do not expose raw stderr',async()=>{await assert.rejects(fixture({fail:true}).adapter.connections(),e=>!e.message.includes('secret'));});
test('changed connection fails readiness',async()=>{
 let n=0;const a=createPodmanAdapter({execute:async(exe,args)=>({stdout:JSON.stringify(args[0]==='system'?[{...good,URI:++n===1?good.URI:good.URI.replace('example.test','changed.test')}]:{host:{security:{rootless:true},serviceIsRemote:true}})})});await assert.rejects(a.check('qa'),/changed/);
});

test('bounded success output and inventories',async()=>{
 const result=await fixture({output:'x'.repeat(30000)}).adapter.logs('qa',id,100,binding);assert.equal(result.text.length,24576);assert.equal(result.truncated,true);
 await assert.rejects(fixture({containers:Array(201).fill({Id:id})}).adapter.list('qa'),/200/);
 await assert.rejects(fixture({connections:Array(201).fill(good)}).adapter.connections(),/200/);
});

test('explicit Windows local detection uses only version and local machine list',async()=>{
 const calls=[];
 const a=createPodmanAdapter({platform:'win32',execute:async(exe,args)=>{
  calls.push(args);return {stdout:args[0]==='--version'?'podman version 5.4.0\n':JSON.stringify([{Name:'existing',VMType:'wsl',Running:false,IdentityPath:'secret'},{Name:'running',VMType:'wsl',Running:true},{Name:'other',VMType:'hyperv'},{Name:'unspecified'}])};
 }});
 assert.equal(calls.length,0);
 const r=await a.detectLocal();assert.deepEqual(calls,[['--version'],['machine','list','--format','json']]);
 assert.equal(r.cli,'available');assert.equal(r.machineInventory,'known');assert.equal(r.readiness,'unknown');
 assert.deepEqual(r.machines[0],{name:'existing',provider:'wsl',running:false,readiness:'unknown'});
 assert.equal(r.machines[1].running,true);assert.equal(r.machines[1].readiness,'unknown');
 assert.equal(r.machines[2].provider,'other');assert.equal(r.machines[2].running,null);
 assert.equal(r.machines[3].provider,'unknown');assert.ok(!JSON.stringify(r).includes('secret'));
});
test('local detection cannot infer installation absent from failed CLI or machine inventory',async()=>{
 let calls=0;
 const unavailable=createPodmanAdapter({platform:'win32',execute:async()=>{calls++;throw Error('sensitive path');}});
 const r=await unavailable.detectLocal();assert.equal(r.cli,'unavailable-or-error');assert.equal(r.readiness,'unknown');assert.equal(calls,1);
 for(const output of ['not JSON',JSON.stringify(Array(201).fill({Name:'a'})),JSON.stringify([{Name:'bad\nname'}])]){
  const a=createPodmanAdapter({platform:'win32',execute:async(exe,args)=>({stdout:args[0]==='--version'?'podman version 5.4.0':output})});
  const v=await a.detectLocal();assert.equal(v.cli,'available');assert.equal(v.machineInventory,'unknown');assert.deepEqual(v.machines,[]);
 }
});
test('local detection skips non-Windows and never invokes any command',async()=>{
 const a=createPodmanAdapter({platform:'linux',execute:async()=>{throw Error('must not run');}});
 assert.deepEqual(await a.detectLocal(),{platform:'linux',cli:'not-checked',machineInventory:'not-checked',machines:[],readiness:'unknown'});
});

test('snapshot binding is opaque and required across lifecycle steps',async()=>{
 const {adapter,calls}=fixture();const checked=await adapter.check('qa');const listed=await adapter.list('qa');
 assert.equal(checked.binding,binding);assert.equal(listed.binding,binding);
 assert.ok(!JSON.stringify(checked).includes(good.URI));assert.ok(!JSON.stringify(listed).includes(good.Identity));
 const count=calls.length;await assert.rejects(adapter.start('qa',id),/binding/);assert.equal(calls.length,count);
 await assert.rejects(adapter.stop('qa',id,'b'.repeat(64)),/changed/);assert.ok(!calls.some(c=>c.args[7]==='stop'));
});
test('URI and identity drift before mutation fail closed; last-moment drift cannot redirect pinned argv',async()=>{
 for(const field of ['URI','Identity']){
  let n=0;const calls=[];
  const adapter=createPodmanAdapter({execute:async(exe,args)=>{
   calls.push(args);
   if(args[0]==='system')return {stdout:JSON.stringify([{...good,...(++n===3?{[field]:field==='URI'?good.URI.replace('example.test','other.test'):'/other/key'}:{})}])};
   return {stdout:JSON.stringify(args[7]==='info'?{host:{security:{rootless:true},serviceIsRemote:true}}:[{Id:id}])};
  }});
  await assert.rejects(adapter.start('qa',id,binding),/changed/);assert.ok(!calls.some(a=>a[7]==='start'));
 }
 const {adapter,calls}=fixture();await adapter.start('qa',id,binding);
 const remote=calls.filter(c=>c.args[0]==='--remote');
 for(const c of remote){assert.equal(c.args[2],good.URI);assert.equal(c.args[4],good.Identity);assert.ok(!c.args.includes('--connection'));assert.equal(c.args[6],'golang');}
});
test('relative and absent identities rejected before remote access',async()=>{
 for(const Identity of ['',undefined,'./key','~/key']){
  const {adapter,calls}=fixture({connections:[{...good,Identity}]});await assert.rejects(adapter.check('qa'),/absolute/);assert.equal(calls.length,1);
 }
});
test('runner environment excludes ambient connection, SSH and PATH overrides',async()=>{
 const {adapter,calls}=fixture();await adapter.connections();
 for(const name of ['PATH','CONTAINER_HOST','container_connection','CONTAINER_SSHKEY','SSH_AUTH_SOCK','CONTAINERS_CONF','PODMAN_CONNECTIONS_CONF'])assert.equal(calls[0].options.env[name],undefined);
});
