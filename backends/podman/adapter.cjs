'use strict';
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {createHash}=require('node:crypto');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const NAME=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ID=/^[a-f0-9]{64}$/;
const MAX=1024*1024;
function standardLocations(platform,home=os.homedir()){
  if(platform!=='win32')return ['/usr/bin/podman','/usr/local/bin/podman'];
  const locations=['C:\\Program Files\\RedHat\\Podman\\podman.exe','C:\\Program Files\\Podman\\podman.exe'];
  if(/^[A-Za-z]:[\\/]/.test(home)){
    locations.unshift(path.win32.join(home,'AppData','Local','Programs','Podman','podman.exe'));
  }
  return locations;
}
function connectionRecord(row){
  if(!row||typeof row.Name!=='string'||typeof row.URI!=='string'||!NAME.test(row.Name))return null;
  try{
    const u=new URL(row.URI);
    if(u.protocol!=='ssh:'||!u.hostname||!u.username||u.password||u.hash||u.search||decodeURIComponent(u.username).toLowerCase()==='root')return null;
    const m=/^\/run\/user\/([1-9][0-9]*)\/podman\/podman\.sock$/.exec(u.pathname);
    if(!m)return null;
    return {name:row.Name,transport:'ssh',rootlessCandidate:true};
  }catch{return null;}
}
function createPodmanAdapter({execute,platform=process.platform}={}){
  const injected=typeof execute==='function';
  execute=execute||promisify(execFile);
  let executable;
  function binary(){
    if(injected)return 'podman';
    if(executable)return executable;
    // Deliberately no PATH/cwd search. Nonstandard installs require future explicit configuration.
    for(const candidate of standardLocations(platform)){try{
      const real=fs.realpathSync(candidate);
      const matches=platform==='win32'?real.toLowerCase()===candidate.toLowerCase():real===candidate;
      if(!matches||!fs.statSync(real).isFile())continue;
      executable=real;return real;
    }catch{}}
    throw Error('Podman is not available in a supported standard installation directory');
  }
  async function run(args){
    const env={};
    const allowed=/^(SystemRoot|WINDIR|USERPROFILE|HOME|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|LANG|LC_ALL)$/i;
    for(const [key,value] of Object.entries(process.env))if(allowed.test(key))env[key]=value;
    for(const k of Object.keys(env))if(/^(CONTAINER_HOST|CONTAINER_CONNECTION|CONTAINER_SSHKEY|DOCKER_HOST|PODMAN_CONNECTIONS_CONF|CONTAINERS_CONF|CONTAINERS_CONF_OVERRIDE|CONTAINERS_CONF_MODULES|SSH_AUTH_SOCK|SSH_AGENT_PID)$/i.test(k))delete env[k];
    let r;
    try{const exe=binary();r=await execute(exe,args,{cwd:injected?undefined:path.dirname(exe),timeout:30000,maxBuffer:MAX,encoding:'utf8',windowsHide:true,shell:false,env});}
    catch{throw Error('Podman command failed or exceeded its limit. Check the explicitly selected SSH connection locally.');}
    const out=String(r.stdout||'');
    if(Buffer.byteLength(out)>MAX)throw Error('Podman output exceeds limit');
    return out;
  }
  function parse(s){try{return JSON.parse(s);}catch{throw Error('Invalid Podman JSON response');}}
  // Explicit local inventory only. Never starts WSL or checks a remote service.
  // Documented machine list fields: Name, VMType, Running.
  // https://docs.podman.io/en/latest/markdown/podman-machine-list.1.html
  async function detectLocal(){
    const result={platform,cli:'not-checked',machineInventory:'not-checked',machines:[],readiness:'unknown'};
    if(platform!=='win32')return result;
    try{
      const version=(await run(['--version'])).trim();
      if(!/^podman version [0-9][^\r\n]{0,100}$/.test(version))throw Error('Unrecognized version');
      result.cli='available';result.version=version;
    }catch{result.cli='unavailable-or-error';return result;}
    result.machineInventory='unknown';
    try{
      const machines=parse(await run(['machine','list','--format','json']));
      if(!Array.isArray(machines)||machines.length>200)throw Error('Invalid machine inventory');
      result.machines=machines.map(row=>{
        if(!row||typeof row.Name!=='string'||!NAME.test(row.Name))throw Error('Invalid machine name');
        return {name:row.Name,provider:row.VMType==='wsl'?'wsl':typeof row.VMType==='string'&&row.VMType?'other':'unknown',running:typeof row.Running==='boolean'?row.Running:null,readiness:'unknown'};
      });
      result.machineInventory='known';
    }catch{result.machines=[];}
    return result;
  }
  async function configured(){
    const rows=parse(await run(['system','connection','list','--format','json']));
    if(!Array.isArray(rows)||rows.length>200)throw Error('Invalid Podman connection list or exceeds 200 connections');
    return rows;
  }
  function identityIsAbsolute(identity){
    return typeof identity==='string'&&!/[\x00-\x1f]/.test(identity)&&
      (platform==='win32'?/^[A-Za-z]:[\\/]/.test(identity):path.posix.isAbsolute(identity));
  }
  async function connections(){
    return (await configured()).filter(row=>identityIsAbsolute(row?.Identity)).map(connectionRecord).filter(Boolean);
  }
  async function selected(name){
    if(typeof name!=='string'||!NAME.test(name))throw Error('An explicit configured connection name is required');
    const rows=(await configured()).filter(r=>r.Name===name);
    if(rows.length!==1||!connectionRecord(rows[0]))throw Error('Connection must be a configured non-root SSH rootless socket');
    const identity=rows[0].Identity;
    // Never resolve relative keys against a mutable working directory or use ambient defaults.
    if(!identityIsAbsolute(identity))throw Error('An absolute configured SSH identity is required');
    const uri=rows[0].URI;
    const binding=createHash('sha256').update(JSON.stringify([name,uri,identity])).digest('hex');
    return {connection:name,uri,identity,binding};
  }
  // Explicit flags have precedence; golang mode avoids native SSH config redirection.
  const args=(snapshot,tail)=>['--remote','--url',snapshot.uri,'--identity',snapshot.identity,'--ssh','golang',...tail];
  async function same(snapshot){
    if((await selected(snapshot.connection)).binding!==snapshot.binding)throw Error('Connection changed; refresh and authorize again');
  }
  async function ready(connection,binding){
    const snapshot=await selected(connection);
    if(binding!==undefined&&binding!==snapshot.binding)throw Error('Connection changed; refresh and authorize again');
    const info=parse(await run(args(snapshot,['info','--format','json'])));
    if(info?.host?.security?.rootless!==true||info?.host?.serviceIsRemote!==true)throw Error('Explicit remote rootless Podman state is required');
    await same(snapshot);
    return snapshot;
  }
  async function check(connection){
    const snapshot=await ready(connection);
    return {connection,status:'ready',rootless:true,binding:snapshot.binding};
  }
  async function rows(snapshot){
    const data=parse(await run(args(snapshot,['ps','--all','--no-trunc','--format','json'])));
    if(!Array.isArray(data)||data.length>200)throw Error('Invalid container list or exceeds 200 containers');
    return data.map(r=>{
      if(!ID.test(r.Id||r.ID||''))throw Error('Expected full container ID');
      const text=v=>String(v??'').slice(0,512);
      return {id:r.Id||r.ID,name:text(Array.isArray(r.Names)?r.Names.join(', '):r.Names),image:text(r.Image),state:text(r.State),status:text(r.Status)};
    });
  }
  async function list(connection){const snapshot=await ready(connection);const containers=await rows(snapshot);await same(snapshot);return {connection,binding:snapshot.binding,containers};}
  async function existing(connection,id,binding){
    if(typeof binding!=='string'||!ID.test(binding))throw Error('A checked connection binding is required');
    if(typeof id!=='string'||!ID.test(id))throw Error('A full 64-character container ID is required');
    const snapshot=await ready(connection,binding);
    if(!(await rows(snapshot)).some(r=>r.id===id))throw Error('Container is not present on the selected connection');
    await same(snapshot);
    return snapshot;
  }
  async function action(connection,id,binding,verb){
    const snapshot=await existing(connection,id,binding);
    await run(args(snapshot,[verb,...(verb==='stop'?['--time','10']:[]),'--',id]));
    return {connection,id,status:'requested'};
  }
  async function logs(connection,id,tail=100,binding){
    if(!Number.isInteger(tail)||tail<1||tail>1000)throw Error('Log tail must be an integer from 1 to 1000');
    const snapshot=await existing(connection,id,binding);
    const text=await run(args(snapshot,['logs','--tail',String(tail),'--',id]));
    const bytes=Buffer.from(text);
    return {connection,id,tail,text:bytes.subarray(0,24*1024).toString('utf8'),truncated:bytes.length>24*1024};
  }
  return {detectLocal,connections,check,list,start:(c,id,binding)=>action(c,id,binding,'start'),stop:(c,id,binding)=>action(c,id,binding,'stop'),logs};
}
module.exports={createPodmanAdapter,standardLocations};
