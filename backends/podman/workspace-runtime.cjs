'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHmac,randomBytes}=require('node:crypto');
const {createMountedWorkspaceSource}=require('../common/veracrypt-workspace.cjs');
const ID=/^[a-f0-9]{64}$/;
const LABEL='io.vamp.workspace';
const DEST='/workspace';
const TMPFS=new Set(['/tmp','/run','/var/tmp','/home/desktop']);
const ENTRYPOINT=['/usr/bin/tini','--','/usr/bin/python3','-I','-B','/opt/vamp-desktop/desktop.py'];
const overlap=(a,b)=>a===b||a==='/'||b==='/'||a.startsWith(b+'/')||b.startsWith(a+'/');
const safePath=s=>typeof s==='string'&&s.startsWith('/')&&s!=='/'&&!/[\x00-\x20\x7f\\,:]/.test(s)&&path.normalize(s)===s&&!s.endsWith('/');
async function readConfig(file,uid){
  if(!safePath(file)||await fs.realpath(file)!==file)throw Error('Configure a private local workspace file first');
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const before=await handle.stat();
    if(!before.isFile()||before.uid!==uid||(before.mode&0o777)!==0o600||before.nlink!==1||before.size<2||before.size>16384)throw Error('Workspace configuration must be a private owner-only file');
    const bytes=Buffer.alloc(before.size+1);
    const {bytesRead}=await handle.read(bytes,0,bytes.length,0);
    const after=await handle.stat();
    if(bytesRead!==before.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error('Workspace configuration changed');
    const raw=bytes.subarray(0,bytesRead).toString('utf8');
    return {config:JSON.parse(raw),raw};
  }finally{await handle.close();}
}
async function locked(uid,fn){
  const parent='/run/user/'+uid;
  const stat=await fs.lstat(parent);
  if(!stat.isDirectory()||stat.uid!==uid||(stat.mode&0o777)!==0o700||await fs.realpath(parent)!==parent)throw Error('Trusted local runtime directory unavailable');
  const lock=path.join(parent,'vamp-workspace-attach.lock');
  try{await fs.mkdir(lock,{mode:0o700});}catch{throw Error('Another workspace attach is active or a previous reservation must be reviewed');}
  try{return await fn();}finally{await fs.rmdir(lock).catch(()=>{});}
}
function workspaceRuntime({platform,allowedImages,configPath,read=readConfig,reserve=locked,sourceFactory=createMountedWorkspaceSource,release=os.release,now=Date.now}){
  const secret=randomBytes(32);
  const approvals=new Map();
  function supported(snapshot){return platform==='linux'&&snapshot?.local===true&&!/microsoft|wsl/i.test(release());}
  async function context(snapshot){
    if(!supported(snapshot))throw Error('Workspace attachment is supported only by the native Linux local rootless engine');
    let raw,config;
    try{({raw,config}=await read(configPath,snapshot.uid));}catch{throw Error('An owner-only workspace configuration is required on this Linux host');}
    if(!config||Array.isArray(config)||Object.keys(config).some(x=>!['veracryptPath','volumePath','mountPoint','directory','imageId','workloadId','protectedPaths'].includes(x))||!ID.test(config.imageId||'')||!allowedImages().includes(config.imageId)||typeof config.workloadId!=='string'||!/^[a-z0-9][a-z0-9-]{0,47}$/.test(config.workloadId))throw Error('Workspace configuration or trusted immutable desktop image is invalid');
    return {config,raw,source:sourceFactory({platform,veracryptPath:config.veracryptPath,protectedPaths:config.protectedPaths,
      selection:{topology:'linux-local',volumePath:config.volumePath,mountPoint:config.mountPoint,directory:config.directory,workloadId:config.workloadId}})};
  }
  const proof=(snapshot,ctx,m)=>createHmac('sha256',secret).update(JSON.stringify([snapshot.binding,ctx.raw,m.mountId,m.scopeId])).digest('hex');
  async function status(snapshot,scan){
    const ctx=await context(snapshot);
    return ctx.source.readForAttachment(async m=>{
      await scan(m);
      const approval_id=randomBytes(32).toString('hex');
      for(const [id,value] of approvals)if(value.expires<=now())approvals.delete(id);
      while(approvals.size>=32)approvals.delete(approvals.keys().next().value);
      approvals.set(approval_id,{fingerprint:proof(snapshot,ctx,m),expires:now()+300000});
      return {status:'ready_to_attach',destination:DEST,access:'rw',network:'none',approval_id,actual_read_write_verified:false};
    });
  }
  async function attach(snapshot,approvalId,{scan,command,inspect}){
    if(!ID.test(approvalId||''))throw Error('Check the workspace and confirm that exact approval ID first');
    const approved=approvals.get(approvalId);
    approvals.delete(approvalId);
    if(!approved||approved.expires<=now())throw Error('This check expired or was already used; check and authorize again');
    return reserve(snapshot.uid,async()=>{
      const ctx=await context(snapshot);
      return ctx.source.readForAttachment(async (m,revalidate)=>{
        if(!safePath(m.directory)||proof(snapshot,ctx,m)!==approved.fingerprint)throw Error('Workspace approval no longer matches the mounted folder; check and authorize again');
        await scan(m);
        const image='sha256:'+ctx.config.imageId, label=labelFor(m);
        const images=JSON.parse(await command(['image','inspect','--',image]));
        const imageInfo=Array.isArray(images)&&images.length===1?images[0]:null;
        if(String(imageInfo?.Id||'').replace(/^sha256:/,'')!==ctx.config.imageId||JSON.stringify(imageInfo?.Config?.Entrypoint)!==JSON.stringify(ENTRYPOINT)||imageInfo?.Config?.User!=='1000:1000')throw Error('Approved VAMP desktop image is not available with the expected entrypoint and user');
        await revalidate();
        let id;
        try{
          id=(await command(['create','--pull=never','--rm','--restart=no','--read-only','--read-only-tmpfs=false','--network=none','--userns=keep-id:uid=1000,gid=1000','--user=1000:1000','--cap-drop=all','--security-opt=no-new-privileges','--pids-limit=512','--memory=3g','--cpus=2','--shm-size=512m',
            '--tmpfs=/tmp:rw,nosuid,nodev,mode=1777','--tmpfs=/home/desktop:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700','--volume',m.directory+':'+DEST+':rw,private,nodev,nosuid,noexec','--label',LABEL+'='+label,
            '--name','vamp-workspace-'+ctx.config.workloadId+'-'+randomBytes(6).toString('hex'),'--',image])).trim();
          if(!ID.test(id)||!verifiedMount(await inspect(id),m,ctx.config.imageId))throw Error('Created workspace mount did not validate');
          await revalidate();
          await scan(m,id);
          const fresh=await context(snapshot);
          if(fresh.raw!==ctx.raw)throw Error('Workspace approval configuration changed');
          await command(['start','--',id]);
          const started=await inspect(id);
          if(started.State?.Running!==true||!verifiedMount(started,m,ctx.config.imageId))throw Error('Workspace container start not verified');
          await revalidate();
          return {status:'attached',id,destination:DEST,access:'rw',network:'none',actual_read_write_verified:false};
        }catch{
          // Preserve evidence on uncertain failures; no automatic rm/stop of
          // anything not independently known to have stayed unstarted.
          if(ID.test(id||''))try{const created=await inspect(id);if(created?.Config?.Labels?.[LABEL]===label&&created?.State?.Running===false)await command(['rm','--',id]);}catch{}
          throw Error('Workspace attachment did not verify. Refresh the local container list before retrying or dismounting.');
        }
      });
    });
  }
  async function verify(snapshot,value){
    const ctx=await context(snapshot);
    return ctx.source.readForAttachment(async m=>verifiedMount(value,m,ctx.config.imageId));
  }
  return {status,attach,verify,supported};
}
const labelFor=m=>m.mountId+'.'+m.scopeId;
function verifiedMount(v,m,imageId){
  const host=v?.HostConfig, config=v?.Config;
  const expected=v?.Mounts?.filter?.(row=>row?.Destination===DEST)||[];
  const mount=expected[0];
  return String(v?.Image||'').replace(/^sha256:/,'')===imageId&&config?.Labels?.[LABEL]===labelFor(m)&&
    host?.NetworkMode==='none'&&host?.AutoRemove===true&&host?.ReadonlyRootfs===true&&host?.Privileged===false&&config?.User==='1000:1000'&&
    Array.isArray(host.CapAdd)&&!host.CapAdd.length&&Array.isArray(host.CapDrop)&&host.CapDrop.some(c=>String(c).toUpperCase()==='ALL')&&
    Array.isArray(host.SecurityOpt)&&host.SecurityOpt.some(x=>/^no-new-privileges(?::true|=true)?$/.test(x))&&
    expected.length===1&&mount?.Type==='bind'&&mount.Source===m.directory&&mount.RW===true&&['private','rprivate'].includes(mount.Propagation)&&
    v.Mounts.every(row=>row===mount||(row?.Type==='tmpfs'&&TMPFS.has(row.Destination)&&(!row.Source||row.Source==='tmpfs')))&&
    (!host.Tmpfs||Object.keys(host.Tmpfs).every(k=>TMPFS.has(k)))&&
    (!host.Devices||host.Devices.length===0)&&(!host.DeviceRequests||host.DeviceRequests.length===0)&&
    ['PidMode','IpcMode','UTSMode','UsernsMode'].every(k=>typeof host[k]==='string'&&!/^(host|container:)/.test(host[k]));
}
async function writerAbsent(values,m,except,resolve=fs.realpath){
  for(const v of values){
    if(v?.Id===except)continue;
    if(!ID.test(v?.Id||'')||!Array.isArray(v?.Mounts))throw Error('Podman workspace writer inventory could not be verified');
    for(const entry of v.Mounts){
      if(entry?.Type==='tmpfs')continue;
      if(typeof entry?.Source!=='string'||!entry.Source.startsWith('/'))throw Error('Podman workspace writer inventory could not be verified');
      let source;
      try{source=await resolve(entry.Source);}catch{throw Error('Podman workspace writer inventory could not be verified');}
      if(overlap(path.normalize(entry.Source),m.directory)||overlap(source,m.directory))throw Error('Another local rootless Podman container already reserves or may see this workspace');
    }
  }
}
module.exports={workspaceRuntime,verifiedMount,writerAbsent,LABEL};
