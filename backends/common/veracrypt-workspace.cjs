'use strict';
// Linux-local evidence source and checked dismount. No passwords, file-content
// scanning, remote execution or automatic executable discovery. Trusted host code
// supplies the selected paths and complete protected-path policy; never MCP JSON.
const nativeFs=require('node:fs/promises');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const path=require('node:path').posix;
const {createHash}=require('node:crypto');
const BAD_NAME=/(?:\.(?:kdbx?|keyx?|pem|p12|pfx|crt|cer)|^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|^\.env(?:\..*)?|^credentials(?:\..*)?|^master[-_]?key(?:\..*)?)$/i;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inside=(child,parent)=>child===parent||child.startsWith(parent+'/');
function canonical(p){return typeof p==='string'&&p.startsWith('/')&&p!=='/'&&!/[\x00-\x20\x7f\\,:]/.test(p)&&path.normalize(p)===p&&!p.endsWith('/');}
function fail(){throw Error('workspace_evidence_unavailable');}
function mountRows(text){
 if(typeof text!=='string'||Buffer.byteLength(text)>1024*1024)fail();
 return text.trim().split('\n').filter(Boolean).map(line=>{
  const parts=line.split(' - ');if(parts.length!==2)fail();const a=parts[0].split(' '),b=parts[1].split(' ');
  if(a.length<6||b.length<3||!/^\d+:\d+$/.test(a[2]))fail();
  const decode=s=>s.replace(/\\(040|011|012|134)/g,(_,o)=>String.fromCharCode(parseInt(o,8)));
  return {id:a[0],device:a[2],root:decode(a[3]),mount:decode(a[4]),options:a[5].split(','),type:b[0],source:decode(b[1])};
 });
}
function deviceNumber(value){
 const d=BigInt(value);const major=((d>>8n)&0xfffn)|((d>>32n)&0xfffff000n);const minor=(d&0xffn)|((d>>12n)&0xffffff00n);
 return `${major}:${minor}`;
}
function createMountedWorkspaceSource({selection,veracryptPath,protectedPaths,platform=process.platform,
 execute=promisify(execFile),fs=nativeFs,now=Date.now,uid=process.getuid?.()}={}){
 // Copy, so a UI object mutated after selection cannot retarget this source.
 const chosen=selection&&Object.freeze({...selection});const protectedList=Array.isArray(protectedPaths)?[...protectedPaths]:null;
 async function plainDirectory(directory){
  const segments=directory.split('/').filter(Boolean);let current='';
  for(const segment of segments){current+='/'+segment;const st=await fs.lstat(current);
   if(st.isSymbolicLink()||!st.isDirectory())fail();
  }
  if(await fs.realpath(directory)!==directory)fail();return fs.lstat(directory);
 }
 async function observe(){
  if(platform!=='linux'||!chosen||chosen.topology!=='linux-local'||!canonical(veracryptPath)||
    !['volumePath','mountPoint','directory'].every(k=>canonical(chosen[k]))||typeof chosen.workloadId!=='string'||!/^[-A-Za-z0-9_.]{1,128}$/.test(chosen.workloadId)||
    !inside(chosen.directory,chosen.mountPoint)||chosen.directory===chosen.mountPoint||
    !protectedList?.length||!protectedList.every(canonical)||!Number.isInteger(uid))fail();
  await plainDirectory(path.dirname(veracryptPath));
  const executable=await fs.lstat(veracryptPath);
  if(executable.isSymbolicLink()||!executable.isFile()||(executable.mode&0o022)||!(executable.mode&0o111))fail();
  // No inherited loader/config/SSH variables, no shell and no PATH lookup.
  const output=await execute(veracryptPath,['--text','--non-interactive','--list'],{
   cwd:'/',env:{LANG:'C',LC_ALL:'C',PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:15000,maxBuffer:256*1024,shell:false,windowsHide:true});
  const text=String(output.stdout||'');if(Buffer.byteLength(text)>256*1024)fail();
  const rows=text.split(/\r?\n/).filter(line=>line.trim()).map(line=>{
   const m=/^\s*([1-9][0-9]*):\s+(\S+)\s+(\S+)\s+(\S+)\s*$/.exec(line);if(!m)fail();return {slot:m[1],volume:m[2],device:m[3],mount:m[4]};
  });
  const matches=rows.filter(r=>r.volume===chosen.volumePath&&r.mount===chosen.mountPoint);
  if(matches.length!==1||!/^\/dev\/mapper\/veracrypt[1-9][0-9]*$/.test(matches[0].device))fail();
  const mounts=mountRows(await fs.readFile('/proc/self/mountinfo','utf8'));
  const entries=mounts.filter(m=>m.mount===chosen.mountPoint);
  if(entries.length!==1)fail();const mount=entries[0];
  if(mount.root!=='/'||!mount.options.includes('rw')||mount.options.includes('ro'))fail();
  if(mounts.some(m=>m!==mount&&inside(m.mount,chosen.mountPoint)&&(inside(m.mount,chosen.directory)||inside(chosen.directory,m.mount))))fail();
  const rootStat=await plainDirectory(chosen.mountPoint),scopeStat=await plainDirectory(chosen.directory);
  const device=await fs.stat(matches[0].device);
  if(!device.isBlockDevice()||deviceNumber(device.rdev)!==mount.device||deviceNumber(rootStat.dev)!==mount.device||rootStat.dev!==scopeStat.dev)fail();
  if(await fs.realpath(mount.source)!==await fs.realpath(matches[0].device))fail();
  // Resolve protected paths without reading their content; missing/inaccessible
  // configured exclusions fail closed rather than silently excluding nothing.
  for(const protectedPath of protectedList){
   const actual=await fs.realpath(protectedPath);
   if(inside(actual,chosen.directory)||inside(chosen.directory,actual))fail();
  }
  let count=0;const pending=[chosen.directory];
  while(pending.length){
   const current=pending.pop(),st=await fs.lstat(current);
   if(++count>2000||st.isSymbolicLink()||st.dev!==rootStat.dev||st.uid!==uid||(st.mode&0o022))fail();
   if(st.isDirectory()){
    const children=await fs.readdir(current);if(children.length>2000-count)fail();
    for(const name of children){if(!name||name==='.'||name==='..'||name.includes('/')||/[\x00-\x1f\x7f]/.test(name)||BAD_NAME.test(name))fail();pending.push(path.join(current,name));}
   }else if(!st.isFile()||st.nlink!==1)fail();
  }
  const end=mountRows(await fs.readFile('/proc/self/mountinfo','utf8'));
  if(JSON.stringify(end)!==JSON.stringify(mounts))fail();
  const final=await fs.lstat(chosen.directory);
  if(final.ino!==scopeStat.ino||final.dev!==scopeStat.dev||final.isSymbolicLink())fail();
  const mountId=digest([mount.id,mount.device,mount.root,mount.source,chosen.mountPoint]);
  const scopeId=digest([mountId,chosen.directory,String(final.ino)]);
  return Object.freeze({topology:'linux-local',workloadId:chosen.workloadId,observedAt:now(),mountId,scopeId,
   directory:chosen.directory,mountPoint:chosen.mountPoint,access:'rw',mounted:true,metadataPolicy:'passed',
   arbitrarySecretAbsenceVerified:false,entriesChecked:count});
 }
 async function inspect(){try{const s=await observe();return {state:'verified_mounted_scope',mountId:s.mountId,scopeId:s.scopeId,observedAt:s.observedAt,metadataPolicy:s.metadataPolicy,arbitrarySecretAbsenceVerified:false};}
  catch{return {state:'unavailable',reason:'linux_local_mounted_scope_not_verified'};}}
 async function readForAttachment(callback){
  if(typeof callback!=='function')throw Error('Trusted attachment callback required');
  let snapshot;try{snapshot=await observe();}catch{throw Error('Mounted workspace verification failed');}
  const revalidate=async()=>{const fresh=await observe();if(fresh.mountId!==snapshot.mountId||fresh.scopeId!==snapshot.scopeId)throw Error('Mounted workspace changed');return fresh;};
  // Callback is host-owned, never a model-supplied route. It must check engine,
  // exact owner authorization and single-writer reservation, then revalidate.
  // Local privileged races cannot be made atomic by a pathname-only Node API.
  return callback(snapshot,revalidate);
 }
 async function dismount(expected){
  const fresh=await observe();
  if(fresh.mountId!==expected.mountId||fresh.scopeId!==expected.scopeId)fail();
  await execute(veracryptPath,['--text','--non-interactive','--unmount',fresh.mountPoint],{
   cwd:'/',env:{LANG:'C',LC_ALL:'C',PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:120000,maxBuffer:256*1024,shell:false,windowsHide:true});
  const mounts=mountRows(await fs.readFile('/proc/self/mountinfo','utf8'));
  return !mounts.some(m=>m.mount===fresh.mountPoint||inside(m.mount,fresh.mountPoint));
 }
 return Object.freeze({inspect,readForAttachment,dismount});
}
module.exports={createMountedWorkspaceSource};
