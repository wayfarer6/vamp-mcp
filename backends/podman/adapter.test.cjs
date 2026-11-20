'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createPodmanAdapter,standardLocations,boundedExecutor}=require('./adapter.cjs');
const {EventEmitter}=require('node:events');
const id='a'.repeat(64);
const {createHash}=require('node:crypto');
const good={Name:'qa',URI:'ssh://tester@example.test/run/user/1000/podman/podman.sock',Identity:'/not/read'};
const binding=createHash('sha256').update(JSON.stringify(['qa',good.URI,good.Identity])).digest('hex');
test('an I/O-blocked Podman command returns at the deadline and blocks a retry while it is still live',async()=>{
 const child=new EventEmitter();
 const signals=[];
 let calls=0,detached=false;
 child.kill=signal=>signals.push(signal);
 child.unref=()=>{detached=true;};
 const execute=boundedExecutor((exe,args,options,done)=>{
   calls++;
   if(calls>1)setImmediate(()=>done(null,'ok',''));
   return child;
 });
 await assert.rejects(execute('podman',['create'],{timeout:5}),/exceeded its deadline/);
 assert.deepEqual(signals,['SIGKILL']);
 assert.equal(detached,true);
 await assert.rejects(execute('podman',['create'],{timeout:5}),/still exiting/);
 assert.equal(calls,1);
 child.emit('close');
 assert.deepEqual(await execute('podman',['ps'],{timeout:100}),{stdout:'ok',stderr:''});
});
test('standard search includes the official per-user Windows MSI location, not PATH or the checkout',()=>{
 assert.equal(standardLocations('win32','D:\\Users\\tester')[0],'D:\\Users\\tester\\AppData\\Local\\Programs\\Podman\\podman.exe');
 assert.deepEqual(standardLocations('linux'),['/usr/bin/podman','/usr/local/bin/podman']);
 assert.ok(!standardLocations('win32','relative').some(p=>p.includes('relative')));
});
function fixture({connections=[good],info={host:{security:{rootless:true},serviceIsRemote:true}},containers=[{Id:id,Names:['demo'],Image:'image',State:'running',Status:'Up'}],fail=false,output='bounded output'}={}){
 const calls=[];
 const adapter=createPodmanAdapter({platform:'darwin',execute:async(exe,args,options)=>{
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
 let n=0;const a=createPodmanAdapter({platform:'linux',execute:async(exe,args)=>({stdout:JSON.stringify(args[0]==='system'?[{...good,URI:++n===1?good.URI:good.URI.replace('example.test','changed.test')}]:{host:{security:{rootless:true},serviceIsRemote:true}})})});await assert.rejects(a.check('qa'),/changed/);
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
  const adapter=createPodmanAdapter({platform:'linux',execute:async(exe,args)=>{
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

function localFixture({info={host:{security:{rootless:true},serviceIsRemote:false}},identity={uid:1000,euid:1000,home:'/home/qa'},platform='linux'}={}){
 const calls=[];const user=typeof identity==='function'?identity:()=>identity;
 const adapter=createPodmanAdapter({platform,userIdentity:user,execute:async(exe,args,options)=>{
  calls.push({args,options});
  if(args[0]==='system')return {stdout:JSON.stringify([good,{...good,Name:'local-linux'}])};
  assert.equal(args[0],'--remote=false');assert.equal(options.env.HOME,'/home/qa');assert.equal(options.env.XDG_RUNTIME_DIR,'/run/user/1000');
  if(args[1]==='info')return {stdout:JSON.stringify(info)};
  if(args[1]==='ps')return {stdout:JSON.stringify([{Id:id,Names:['native'],State:'running'}])};
  return {stdout:'local logs'};
 }});return {adapter,calls};
}
test('explicit local target discovery is disconnected and reserved',async()=>{
 const {adapter,calls}=localFixture();const rows=await adapter.connections();
 assert.equal(rows.filter(r=>r.name==='local-linux').length,1);assert.equal(rows[0].transport,'local');assert.equal(calls.length,1);assert.equal(calls[0].args[0],'system');
});
test('native local rootless list lifecycle and logs use only remote=false fixed arguments',async()=>{
 const {adapter,calls}=localFixture();const listed=await adapter.list('local-linux');assert.equal(listed.containers[0].id,id);
 assert.equal((await adapter.check('local-linux')).binding,listed.binding);
 await adapter.start('local-linux',id,listed.binding);assert.deepEqual(calls.at(-1).args,['--remote=false','start','--',id]);
 await adapter.stop('local-linux',id,listed.binding);assert.deepEqual(calls.at(-1).args,['--remote=false','stop','--time','10','--',id]);
 assert.equal((await adapter.logs('local-linux',id,10,listed.binding)).text,'local logs');
 assert.ok(calls.every(c=>c.args[0]==='--remote=false'));assert.ok(!JSON.stringify(listed).includes('/home/qa'));
});
test('local target rejects root, setuid mismatch, other OS and unknown/remote/rootful info',async()=>{
 for(const options of [{identity:{uid:0,euid:0,home:'/root'}},{identity:{uid:1000,euid:0,home:'/home/qa'}},{platform:'win32'},{platform:'darwin'}]){
  const {adapter,calls}=localFixture(options);await assert.rejects(adapter.check('local-linux'));assert.equal(calls.length,0);
 }
 for(const info of [{},{host:{security:{rootless:true},serviceIsRemote:true}},{host:{security:{rootless:true}}},{host:{security:{rootless:false},serviceIsRemote:false}}])await assert.rejects(localFixture({info}).adapter.check('local-linux'),/local rootless/);
});
test('local bindings reject UID/home drift and missing binding before mutations',async()=>{
 let identity={uid:1000,euid:1000,home:'/home/qa'};const {adapter,calls}=localFixture({identity:()=>identity});
 const {binding}=await adapter.check('local-linux');await assert.rejects(adapter.start('local-linux',id),/binding/);
 identity={uid:1001,euid:1001,home:'/home/other'};const count=calls.length;await assert.rejects(adapter.start('local-linux',id,binding),/changed/);assert.equal(calls.length,count);
});

const {deflateSync}=require('node:zlib');
const {validatePng}=require('./adapter.cjs');
function pngFixture(){
 function crc(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let n=0;n<8;n++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
 function chunk(type,data){const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(type,4);data.copy(out,8);out.writeUInt32BE(crc(out.subarray(4,8+data.length)),8+data.length);return out;}
 const header=Buffer.alloc(13);header.writeUInt32BE(1920);header.writeUInt32BE(1080,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc((1920*3+1)*1080))),chunk('IEND',Buffer.alloc(0))]);
}
function desktopFixture(change=()=>{},allow='b'.repeat(64),spawnProcess,capStatus=''){
 const calls=[];const value={Id:id,Image:'sha256:'+'b'.repeat(64),State:{Running:true},Config:{User:'1000:1000'},Mounts:[],HostConfig:{Privileged:false,ReadonlyRootfs:true,CapAdd:[],CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],Devices:[],NetworkMode:'none',PidMode:'',IpcMode:'private',UTSMode:'',UsernsMode:''}};change(value);
 const adapter=createPodmanAdapter({platform:'darwin',desktopImageIds:allow,spawnProcess,execute:async(exe,args,options)=>{
  calls.push({args,options});if(args[0]==='system')return {stdout:JSON.stringify([good])};
  const command=args[7];if(command==='info')return {stdout:JSON.stringify({host:{security:{rootless:true},serviceIsRemote:true}})};
  if(command==='ps')return {stdout:JSON.stringify([{Id:id}])};if(command==='inspect')return {stdout:JSON.stringify([value])};
  if(command==='exec')return {stdout:args.at(-1)==='/proc/1/status'?capStatus:pngFixture()};throw Error('unexpected command');
 }});return {adapter,calls};
}
test('capture only runs fixed trusted-image helper and returns validated bounded PNG',async()=>{
 const {adapter,calls}=desktopFixture();const result=await adapter.capture('qa',id,binding);
 assert.equal(result.width,1920);assert.equal(result.height,1080);assert.equal(validatePng(result.png),true);assert.equal(result.imageId,'b'.repeat(64));
 assert.deepEqual(calls.at(-1).args.slice(7),['exec','--user','1000:1000','--',id,'/usr/bin/python3','-I','-B','/opt/vamp-desktop/capture.py']);assert.equal(calls.at(-1).options.timeout,20000);assert.equal(calls.at(-1).options.maxBuffer,8388608);
});
test('capture rejects image, identity, stopped, privileged, mounts and host namespace drift before exec',async()=>{
 for(const change of [v=>v.Image='c'.repeat(64),v=>v.Id='c'.repeat(64),v=>v.State.Running=false,v=>v.Config.User='0',v=>v.HostConfig.Privileged=true,v=>v.HostConfig.ReadonlyRootfs=false,v=>v.Mounts=[{Destination:'/opt'}],v=>v.HostConfig.NetworkMode='host',v=>v.HostConfig.PidMode='container:other',v=>v.HostConfig.CapAdd=['SYS_ADMIN'],v=>v.HostConfig.CapDrop=[],v=>v.HostConfig.SecurityOpt=[],v=>v.HostConfig.Devices=[{}]]){
  const {adapter,calls}=desktopFixture(change);await assert.rejects(adapter.capture('qa',id,binding));assert.ok(!calls.some(c=>c.args[7]==='exec'));
 }
 await assert.rejects(desktopFixture(()=>{},'').adapter.capture('qa',id,binding),/image IDs/);
});
test('capture accepts Podman expanded drops only with zero capability sets and a tmpfs home',async()=>{
 const change=v=>{v.HostConfig.CapDrop=['CAP_CHOWN'];v.HostConfig.Tmpfs={'/home/desktop':'mode=0700'};};
 const zeros=['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].map(key=>key+': 0000000000000000').join('\n');
 assert.equal((await desktopFixture(change,undefined,undefined,zeros).adapter.capture('qa',id,binding)).width,1920);
 await assert.rejects(desktopFixture(change,undefined,undefined,zeros.replace('CapBnd: 0','CapBnd: 1')).adapter.capture('qa',id,binding),/isolation/);
});
test('PNG validates chunk CRC, size, strict dimensions and rejects trailing bytes',()=>{
 const png=pngFixture();assert.equal(validatePng(png),true);
 const corrupt=Buffer.from(png);corrupt[20]^=1;
 for(const value of [corrupt,png.subarray(0,25),Buffer.concat([png,Buffer.from('extra')]),Buffer.alloc(8388609),'text'])assert.throws(()=>validatePng(value));
});

test('screen stream uses fixed view-only helper and bounded disposal, never a listener',async()=>{
 const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();let killed=0;child.kill=()=>{killed++;};let spawned;
 const {adapter}=desktopFixture(()=>{},'b'.repeat(64),(exe,args,options)=>{spawned={exe,args,options};return child;});
 const handle=await adapter.openScreenStream('qa',id,binding);assert.equal(handle.child,child);assert.equal(handle.viewOnly,true);assert.equal(handle.imageId,'b'.repeat(64));
 assert.deepEqual(spawned.args.slice(7),['exec','--user','1000:1000','--interactive','--',id,'/usr/bin/python3','-I','-B','/opt/vamp-desktop/view.py']);assert.equal(spawned.options.shell,false);
 child.stderr.write(Buffer.alloc(16385));assert.equal(killed,1);handle.close();assert.equal(killed,1);
});

test('screenTarget is metadata only after exact trusted inspection, with no capture or stream',async()=>{
 const {adapter,calls}=desktopFixture();assert.deepEqual(await adapter.screenTarget('qa',id,binding),{connection:'qa',id,imageId:'b'.repeat(64),width:1920,height:1080});
 assert.ok(calls.some(c=>c.args[7]==='inspect'));assert.ok(!calls.some(c=>c.args[7]==='exec'));
});
test('desktop permits only declared benign tmpfs, never bind or code-shadowing mounts',async()=>{
 for(const destination of ['/tmp','/run','/var/tmp']){
  const {adapter}=desktopFixture(v=>{v.Mounts=[{Type:'tmpfs',Destination:destination,Source:'tmpfs'}];v.HostConfig.Tmpfs={[destination]:'rw,nosuid,nodev'};});
  assert.equal((await adapter.screenTarget('qa',id,binding)).imageId,'b'.repeat(64));
 }
 for(const change of [v=>v.Mounts=[{Type:'bind',Destination:'/tmp',Source:'/host'}],v=>v.Mounts=[{Type:'tmpfs',Destination:'/opt'}],v=>v.Mounts=[{Type:'tmpfs',Destination:'/usr'}],v=>v.Mounts=[{Type:'tmpfs',Destination:'/workspace'}],v=>v.HostConfig.Tmpfs={'/opt':'rw'},v=>v.Mounts=[{Type:'tmpfs',Destination:'/tmp',Source:'/host'}]]){
  const {adapter,calls}=desktopFixture(change);await assert.rejects(adapter.screenTarget('qa',id,binding),/isolation/);assert.ok(!calls.some(c=>c.args[7]==='exec'));
 }
});

test('human and RPA control use distinct fixed mode flags; default stays view-only',async()=>{
 const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');const spawned=[];
 const {adapter,calls}=desktopFixture(()=>{},'b'.repeat(64),(exe,args)=>{spawned.push(args);const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};return child;});
 for(const options of [{mode:'exec'},{mode:'control',args:['bad']},['control'],null,{command:'shell'}])await assert.rejects(adapter.openScreenStream('qa',id,binding,options),/options/);
 assert.equal(calls.length,0);assert.equal(spawned.length,0);
 const view=await adapter.openScreenStream('qa',id,binding);assert.equal(view.mode,'view_only');assert.equal(view.viewOnly,true);assert.equal(spawned[0].at(-1),'/opt/vamp-desktop/view.py');view.close();
 const control=await adapter.openScreenStream('qa',id,binding,{mode:'control'});assert.equal(control.mode,'control');assert.equal(control.viewOnly,false);
 assert.deepEqual(spawned[1].slice(7),['exec','--user','1000:1000','--interactive','--',id,'/usr/bin/python3','-I','-B','/opt/vamp-desktop/view.py','--interactive']);control.close();
 const rpa=await adapter.openScreenStream('qa',id,binding,{mode:'rpa'});assert.equal(rpa.viewOnly,false);
 assert.deepEqual(spawned[2].slice(7),[...spawned[1].slice(7,-1),'--rpa']);rpa.close();
 assert.equal(calls.filter(c=>c.args[7]==='inspect').length,3);
});

test('local workspace uses checked binding, pinned image, single disposable container and verified scope',async()=>{
 const imageId='b'.repeat(64),other='d'.repeat(64);
 const m={mountId:'mount',scopeId:'scope',directory:'/mnt/volume/task',mountPoint:'/mnt/volume'};
 const config={imageId,workloadId:'fixture',volumePath:'/private/fixture.hc',mountPoint:'/mnt/volume',
  veracryptPath:'/usr/bin/veracrypt',credentialEntry:'VeraCrypt/Fixture'};
 let created=false,running=false,conflict=false,dismounted=false,cleanup=null;
 const calls=[];
 const adapter=createPodmanAdapter({platform:'linux',desktopImageIds:imageId,
  userIdentity:()=>({uid:1000,euid:1000,home:'/home/test'}),workspaceConfigPath:'/private/config',
  workspaceDependencies:{release:()=> '6.8.0',read:async()=>({config,raw:'fixture'}),reserve:async(_uid,fn)=>fn(),
    state:async(_uid,action,value)=>{
      if(action==='save')cleanup=value;
      else if(action==='clear')cleanup=null;
      else return cleanup;
    },
    sourceFactory:()=>({readForAttachment:fn=>fn(m,async()=>m),inspect:async()=>({state:'verified_mounted_scope'}),
      dismount:async observed=>{assert.equal(observed,m);dismounted=true;return true;}})},
  execute:async(_exe,argv,options)=>{
    assert.equal(argv[0],'--remote=false');assert.equal(options.shell,false);
    const cmd=argv.slice(1);calls.push(cmd);
    assert.equal(options.timeout,cmd[0]==='create'?120000:30000);
    let result;
    if(cmd[0]==='info')result={host:{security:{rootless:true},serviceIsRemote:false}};
    else if(cmd[0]==='ps')result=[...(created?[{Id:id,State:running?'running':'created',Labels:{'io.vamp.workspace':'mount.scope'}}]:[]),...(conflict?[{Id:other}]:[])];
    else if(cmd[0]==='image')result=[{Id:imageId,Config:{User:'1000:1000',Entrypoint:['/usr/bin/tini','--','/usr/bin/python3','-I','-B','/opt/vamp-desktop/desktop.py']}}];
    else if(cmd[0]==='inspect'&&cmd.at(-1)===other)result=[{Id:other,Mounts:[{Type:'bind',Source:'/'}]}];
    else if(cmd[0]==='inspect'&&cmd.at(-1)===id)result=[{Id:id,Image:imageId,State:{Running:running},
      Config:{User:'1000:1000',Labels:{'io.vamp.workspace':'mount.scope'}},
      HostConfig:{NetworkMode:'none',AutoRemove:true,ReadonlyRootfs:true,Privileged:false,CapAdd:[],CapDrop:['ALL'],
        SecurityOpt:['no-new-privileges'],PidMode:'private',IpcMode:'private',UTSMode:'private',UsernsMode:'keep-id'},
      Mounts:[{Destination:'/workspace',Type:'bind',Source:m.directory,RW:true,Propagation:'private'}]}];
    else if(cmd[0]==='create'){created=true;return {stdout:id};}
    else if(cmd[0]==='start'){running=true;return {stdout:id};}
    else if(cmd[0]==='stop'){assert.deepEqual(cmd,['stop','--time','10','--',id]);created=false;running=false;return {stdout:id};}
    else throw Error('Unexpected command');
    return {stdout:JSON.stringify(result)};
  }});
 const {binding}=await adapter.check('local-linux');
 assert.deepEqual(await adapter.workspaceUnlock('local-linux',binding,async target=>{
   assert.deepEqual(target,{volumePath:config.volumePath,mountPoint:config.mountPoint,
     veracryptPath:config.veracryptPath,credentialEntry:config.credentialEntry});
   return {status:'mounted'};
 }),{status:'mounted'});
 assert.deepEqual(await adapter.workspaceUnlock('local-linux',binding,async()=>({status:'denied'})),{status:'denied'});
 await assert.rejects(adapter.workspaceStatus('qa',binding),/native Linux/);
 await assert.rejects(adapter.workspaceStatus('local-linux','f'.repeat(64)),/Connection changed/);
 conflict=true;
 await assert.rejects(adapter.workspaceStatus('local-linux',binding),/reserves/);
 conflict=false;
 const check=await adapter.workspaceStatus('local-linux',binding);
 assert.equal(calls.filter(a=>a[0]==='create').length,0);
 assert.equal((await adapter.workspaceAttach('local-linux',binding,check.approval_id)).status,'attached');
 assert.equal((await adapter.screenTarget('local-linux',id,binding)).id,id);
 assert.equal((await adapter.list('local-linux')).containers[0].workspaceManaged,true);
 await assert.rejects(adapter.start('local-linux',id,binding),/fresh authorized workspace/);
 assert.equal(calls.filter(a=>a[0]==='start').length,1);
 await assert.rejects(adapter.workspaceDetach('local-linux',other,binding),/managed container/);
 assert.equal(calls.filter(a=>a[0]==='stop').length,0);
 assert.deepEqual(await adapter.workspaceDetach('local-linux',id,binding),{status:'detached',id,local_podman_writers_verified_absent:true});
 assert.equal((await adapter.list('local-linux')).containers.length,0);
 conflict=true;
 await assert.rejects(adapter.workspaceLock('local-linux',binding,async()=>{}),/reserves/);
 assert.equal(dismounted,false);
 conflict=false;
 assert.deepEqual(await adapter.workspaceLock('local-linux',binding,async target=>{
   assert.equal(target.mountPoint,config.mountPoint);assert.equal(target.volume,config.volumePath);
 }),{status:'unmounted',local_podman_writers_verified_absent:true});
 assert.equal(dismounted,true);
 dismounted=false;
 const assertDetached=async target=>{
   assert.equal(target.volume,config.volumePath);
   assert.equal(target.mountPoint,config.mountPoint);
 };
 const first=await adapter.workspaceStatus('local-linux',binding);
 await adapter.workspaceAttach('local-linux',binding,first.approval_id);
 conflict=true;
 const deferred=await adapter.workspaceDetach('local-linux',id,binding,assertDetached);
 assert.equal(deferred.status,'detached');
 assert.equal(deferred.workspace_cleanup,'pending');
 assert.equal(dismounted,false);
 conflict=false;
 await adapter.workspaceLock('local-linux',binding,assertDetached);
 assert.equal(dismounted,true);
 dismounted=false;
 const second=await adapter.workspaceStatus('local-linux',binding);
 await adapter.workspaceAttach('local-linux',binding,second.approval_id);
 const cleaned=await adapter.workspaceDetach('local-linux',id,binding,assertDetached);
 assert.equal(cleaned.workspace_cleanup,'unmounted');
 assert.equal(dismounted,true);
 dismounted=false;
 const third=await adapter.workspaceStatus('local-linux',binding);
 await adapter.workspaceAttach('local-linux',binding,third.approval_id);
 assert.equal((await adapter.reconcileWorkspace(assertDetached)).status,'waiting_for_shutdown');
 created=false;
 running=false;
 conflict=true;
 await assert.rejects(adapter.reconcileWorkspace(assertDetached),/reserves/);
 assert.equal(dismounted,false);
 assert.equal(cleanup.id,id);
 conflict=false;
 assert.equal((await adapter.reconcileWorkspace(assertDetached)).status,'unmounted');
 assert.equal(cleanup,null);
});
