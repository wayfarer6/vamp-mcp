'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {workspaceRuntime,verifiedMount,writerAbsent,LABEL}=require('./workspace-runtime.cjs');
const cid='c'.repeat(64),imageId='a'.repeat(64),binding='b'.repeat(64);
function fixture({release,platform='linux',override,now}={}){
  const calls=[],m={mountId:'m',scopeId:'s',directory:'/mnt/work/approved'},config={imageId,workloadId:'fixture'};
  const configFixture={raw:'private-config',config};
  let exists=false,running=false,saved=null;
  const host={ReadonlyRootfs:true,Privileged:false,AutoRemove:true,NetworkMode:'none',CapAdd:[],CapDrop:['ALL'],
    SecurityOpt:['no-new-privileges'],UsernsMode:'keep-id',IpcMode:'private',PidMode:'private',UTSMode:'private'};
  const v={Id:cid,Image:imageId,HostConfig:host,Config:{User:'1000:1000',Labels:{[LABEL]:'m.s'}},
    Mounts:[{Destination:'/workspace',Type:'bind',Source:m.directory,RW:true,Propagation:'private'}]};
  const rt=workspaceRuntime({platform,release:release||(()=> '6.16.0'),allowedImages:()=>[imageId],configPath:'/private/conf',now,
    read:async()=>configFixture,reserve:async(_uid,f)=>f(),sourceFactory:()=>({readForAttachment:fn=>fn(m,async()=>{calls.push(['revalidate']);})}),
    state:async(_uid,action,value)=>{
      if(action==='save')saved=value;
      if(action==='clear')saved=null;
      return saved;
    }});
  const snapshot={binding,local:true,uid:1000};
  const scan=async(_m,skip)=>{calls.push(['scan',skip]);};
  const command=async argv=>{
    calls.push(argv);
    switch(argv[0]){
      case 'image': return JSON.stringify([{Id:'sha256:'+imageId,Config:{User:'1000:1000',Entrypoint:['/usr/bin/tini','--','/usr/bin/python3','-I','-B','/opt/vamp-desktop/desktop.py']}}]);
      case 'create': exists=true;return cid;
      case 'start': assert.equal(saved?.id,cid);running=true;return cid;
      case 'rm': exists=false;return cid;
      default: throw Error('Unexpected command');
    }
  };
  const inspect=async()=>{assert.ok(exists);return {...v,State:{Running:running}};};
  const ops={scan,command,inspect,...override};
  return {rt,m,calls,ops,v,snapshot,configFixture};
}
test('status is redacted and approval pins exact config and mount then starts one isolated container',async()=>{
 const f=fixture(),s=await f.rt.status(f.snapshot,f.ops.scan);
 assert.deepEqual(f.calls,[['scan',undefined]]);
 assert.equal(s.status,'ready_to_attach');assert.match(s.approval_id,/^[a-f0-9]{64}$/);
 assert.doesNotMatch(JSON.stringify(s),/approved|private-config/);
 const result=await f.rt.attach(f.snapshot,s.approval_id,f.ops);
 assert.deepEqual(result,{status:'attached',id:cid,destination:'/workspace',access:'rw',network:'none',actual_read_write_verified:false});
 const step=f.calls.find(c=>c[0]==='create');assert.ok(step.includes('--network=none')&&step.includes('--read-only')&&step.includes('--pull=never')&&step.includes('--rm'));
 assert.ok(step.includes(f.m.directory+':/workspace:rw,private,nodev,nosuid,noexec'));
 assert.equal(step.at(-1),'sha256:'+imageId);
 assert.deepEqual(f.calls.filter(c=>c[0]==='start'),[['start','--',cid]]);
 await assert.rejects(f.rt.attach(f.snapshot,s.approval_id,f.ops),/expired or was already used/);
 assert.equal(await f.rt.verify(f.snapshot,f.v),true);
});
test('an expired approval cannot start a container',async()=>{
 let time=1000;
 const f=fixture({now:()=>time}),s=await f.rt.status(f.snapshot,f.ops.scan);
 time+=300001;
 await assert.rejects(f.rt.attach(f.snapshot,s.approval_id,f.ops),/expired/);
 assert.ok(!f.calls.some(c=>c[0]==='create'));
});
test('changed config/mounted identity and remote/WSL fail before creation',async()=>{
 const f=fixture(),s=await f.rt.status(f.snapshot,f.ops.scan);
 f.configFixture.raw='changed';
 await assert.rejects(f.rt.attach(f.snapshot,s.approval_id,f.ops),/no longer matches/);
 assert.ok(!f.calls.some(c=>c[0]==='create'));
 const g=fixture();const q=await g.rt.status(g.snapshot,g.ops.scan);
 g.m.scopeId='new';
 await assert.rejects(g.rt.attach(g.snapshot,q.approval_id,g.ops),/no longer matches/);
 await assert.rejects(g.rt.status({...g.snapshot,local:false},g.ops.scan),/native Linux/);
 const w=fixture({release:()=> '6.6.87.2-microsoft-standard-WSL2'});
 await assert.rejects(w.rt.status(w.snapshot,w.ops.scan),/native Linux/);
});
test('invalid creation inspection cleans up only unstarted owned candidate',async()=>{
 const f=fixture(),s=await f.rt.status(f.snapshot,f.ops.scan);
 f.v.HostConfig.NetworkMode='host';
 await assert.rejects(f.rt.attach(f.snapshot,s.approval_id,f.ops),/did not verify/);
 assert.ok(!f.calls.some(c=>c[0]==='start'));assert.deepEqual(f.calls.at(-1),['rm','--',cid]);
 assert.equal(verifiedMount(f.v,f.m,imageId),false);
});
test('a bind of an ancestor, descendant, or symlink target reserves the workspace',async()=>{
 for(const source of ['/mnt/work','/mnt/work/approved','/mnt/work/approved/sub','/alias']){
  const other={Id:cid,Mounts:[{Type:'bind',Source:source}]};
  await assert.rejects(writerAbsent([other],{directory:'/mnt/work/approved'},undefined,async p=>p==='/alias'?'/mnt/work/approved':p),/reserves/);
 }
 await assert.rejects(writerAbsent([{Id:cid,Mounts:null}],{directory:'/mnt/work/approved'}),/inventory/);
 await writerAbsent([{Id:cid,Mounts:[{Type:'bind',Source:'/other'}]}],{directory:'/mnt/work/approved'},undefined,async p=>p);
});
test('workspace verification accepts the empty capability sets reported by Podman',()=>{
 const {v,m}=fixture();
 v.HostConfig.CapDrop=['CAP_CHOWN','CAP_SETUID'];
 v.BoundingCaps=null;
 v.EffectiveCaps=null;
 assert.equal(verifiedMount(v,m,imageId),true);
 v.BoundingCaps=['CAP_CHOWN'];
 assert.equal(verifiedMount(v,m,imageId),false);
 v.BoundingCaps=[];
 v.EffectiveCaps=['CAP_CHOWN'];
 assert.equal(verifiedMount(v,m,imageId),false);
});
