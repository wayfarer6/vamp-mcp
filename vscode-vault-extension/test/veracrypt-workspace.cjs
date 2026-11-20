'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createMountedWorkspaceSource}=require('../../backends/common/veracrypt-workspace.cjs');
const selection={topology:'linux-local',workloadId:'job1',volumePath:'/volumes/data.hc',mountPoint:'/media/veracrypt1',directory:'/media/veracrypt1/work'};
function fixture({platform='linux',change,output='1: /volumes/data.hc /dev/mapper/veracrypt1 /media/veracrypt1\n',protectedPaths=['/vault/private.kdbx']}={}){
 let mountText='21 1 253:0 / /media/veracrypt1 rw,relatime - ext4 /dev/mapper/veracrypt1 rw\n';
 const calls=[];const files=new Map();
 const stat=(kind='dir',extra={})=>({mode:kind==='dir'?0o40700:0o100600,dev:64768,ino:1,uid:1000,nlink:1,isDirectory:()=>kind==='dir',isFile:()=>kind==='file',isSymbolicLink:()=>kind==='link',isBlockDevice:()=>kind==='block',...extra});
 for(const p of ['/usr','/usr/bin','/media','/media/veracrypt1','/media/veracrypt1/work','/dev','/dev/mapper'])files.set(p,stat());
 files.set('/usr/bin/veracrypt',stat('file',{mode:0o100755}));files.set('/dev/mapper/veracrypt1',stat('block',{rdev:64768}));
 files.set('/media/veracrypt1/work/report.txt',stat('file',{ino:2}));
 const children=new Map([['/media/veracrypt1/work',['report.txt']]]);
 const fs={lstat:async p=>{if(!files.has(p))throw Object.assign(Error('fixture missing'),{code:'ENOENT'});return files.get(p);},stat:async p=>{if(!files.has(p))throw Error('fixture missing');return files.get(p);},realpath:async p=>p,readFile:async p=>{assert.equal(p,'/proc/self/mountinfo');return mountText;},readdir:async p=>children.get(p)||[]};
 const execute=async(exe,args,opts)=>{calls.push({exe,args,opts});return {stdout:output};};
 const env={files,children,fs,stat,setMount:s=>mountText=s};if(change)change(env);
 const source=createMountedWorkspaceSource({selection,veracryptPath:'/usr/bin/veracrypt',protectedPaths,platform,fs,execute,uid:1000,now:()=>1234});
 return {source,calls,...env};
}
test('mocked adapter uses only fixed read-only list and mount metadata',async()=>{
 const {source,calls}=fixture();const out=await source.inspect();assert.equal(out.state,'verified_mounted_scope');assert.equal(out.arbitrarySecretAbsenceVerified,false);assert.ok(!JSON.stringify(out).includes('/media'));
 assert.equal(calls[0].exe,'/usr/bin/veracrypt');assert.deepEqual(calls[0].args,['--text','--non-interactive','--list']);assert.equal(calls[0].opts.shell,false);assert.deepEqual(Object.keys(calls[0].opts.env).sort(),['LANG','LC_ALL','PATH']);
});
test('recovery confirms absence of both the saved mapper and the mount',async()=>{
 const f=fixture(),device='/dev/mapper/veracrypt1';
 assert.equal(await f.source.confirmUnmounted(device),false);
 f.files.delete(device);
 assert.equal(await f.source.confirmUnmounted(device),false);
 f.setMount('1 0 8:1 / / rw - ext4 /dev/sda1 rw\n');
 assert.equal(await f.source.confirmUnmounted(device),true);
 await assert.rejects(f.source.confirmUnmounted('/dev/sda1'));
 assert.deepEqual(f.calls,[]);
});
test('unsupported platform and topology do not invoke CLI',async()=>{
 const f=fixture({platform:'win32'});assert.equal((await f.source.inspect()).state,'unavailable');assert.equal(f.calls.length,0);
});
test('no complete protected path policy means unavailable',async()=>{const f=fixture({protectedPaths:[]});assert.equal((await f.source.inspect()).state,'unavailable');assert.equal(f.calls.length,0);});
test('wrong volume, device and malformed list fail closed',async()=>{
 for(const output of ['','1: /volumes/other.hc /dev/mapper/veracrypt1 /media/veracrypt1\n','1: /volumes/data.hc /dev/sda /media/veracrypt1\n','Slot: 1\nVolume: /volumes/data.hc'])assert.equal((await fixture({output}).source.inspect()).state,'unavailable');
});
test('protected path overlap and filename deny policy',async()=>{
 assert.equal((await fixture({protectedPaths:['/media/veracrypt1/work/db.kdbx']}).source.inspect()).state,'unavailable');
 for(const name of ['vault.kdbx','id_ed25519','master-key','.env','data.pem']){
 const f=fixture({change:({children,files,stat})=>{children.set(selection.directory,[name]);files.set(selection.directory+'/'+name,stat('file'));}});assert.equal((await f.source.inspect()).state,'unavailable');}
});
test('symlinks, hardlinks, special files, other owners and writable groups rejected',async()=>{
 for(const change of [s=>s('link'),s=>s('file',{nlink:2}),s=>s('block'),s=>s('file',{uid:1001}),s=>s('file',{mode:0o100660})]){
 const f=fixture({change:({files,stat})=>files.set(selection.directory+'/report.txt',change(stat))});assert.equal((await f.source.inspect()).state,'unavailable');}
});
test('nested mounts, readonly mounts and device mismatch rejected',async()=>{
 for(const change of [e=>e.setMount('21 1 253:0 / /media/veracrypt1 ro - ext4 /dev/mapper/veracrypt1 ro\n'),e=>e.setMount('21 1 253:0 / /media/veracrypt1 rw - ext4 /dev/mapper/veracrypt1 rw\n22 21 253:0 /private /media/veracrypt1/work/sub rw - ext4 /dev/mapper/veracrypt1 rw\n'),e=>e.files.set('/dev/mapper/veracrypt1',e.stat('block',{rdev:64769}))])assert.equal((await fixture({change}).source.inspect()).state,'unavailable');
});
test('callback gets fresh internal identity and revalidation detects remount',async()=>{
 const f=fixture();await f.source.readForAttachment(async(s,revalidate)=>{assert.equal(s.directory,selection.directory);assert.equal((await revalidate()).scopeId,s.scopeId);f.setMount('99 1 253:0 / /media/veracrypt1 rw - ext4 /dev/mapper/veracrypt1 rw\n');await assert.rejects(revalidate,/changed/);});
});
test('failure never forwards CLI errors or selected paths',async()=>{
 const source=createMountedWorkspaceSource({selection,veracryptPath:'/usr/bin/veracrypt',protectedPaths:['/private'],platform:'linux',execute:async()=>{throw Error('SECRET');},fs:{lstat:async()=>{throw Error('SECRET');}},uid:1000});
 assert.deepEqual(await source.inspect(),{state:'unavailable',reason:'linux_local_mounted_scope_not_verified'});await assert.rejects(source.readForAttachment(()=>{}),e=>!e.message.includes('SECRET'));
});
