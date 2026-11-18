'use strict';
const {execFile,spawn}=require('node:child_process');
const {inflateSync}=require('node:zlib');
const {promisify}=require('node:util');
const {createHash}=require('node:crypto');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const NAME=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ID=/^[a-f0-9]{64}$/;
const MAX=1024*1024;
const LOCAL_TARGET='local-linux';
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
function createPodmanAdapter({execute,platform=process.platform,spawnProcess=spawn,desktopImageIds=process.env.VAMP_DESKTOP_IMAGE_IDS||'',userIdentity=()=>({uid:process.getuid?.(),euid:process.geteuid?.(),home:os.userInfo().homedir})}={}){
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
  function localIdentity(){
    if(platform!=='linux')throw Error('Local target requires native Linux');
    const value=userIdentity();
    if(!Number.isSafeInteger(value.uid)||value.uid<=0||value.euid!==value.uid||typeof value.home!=='string'||!path.posix.isAbsolute(value.home)||/[\x00-\x1f]/.test(value.home))throw Error('Local target requires the same unprivileged Linux user');
    return {uid:value.uid,home:value.home};
  }
  function commandOptions(snapshot){
    const args=snapshot?.local?['--remote=false']:[];
    const env={};
    const allowed=/^(SystemRoot|WINDIR|USERPROFILE|HOME|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|LANG|LC_ALL)$/i;
    for(const [key,value] of Object.entries(process.env))if(allowed.test(key))env[key]=value;
    for(const k of Object.keys(env))if(/^(CONTAINER_HOST|CONTAINER_CONNECTION|CONTAINER_SSHKEY|DOCKER_HOST|PODMAN_CONNECTIONS_CONF|CONTAINERS_CONF|CONTAINERS_CONF_OVERRIDE|CONTAINERS_CONF_MODULES|SSH_AUTH_SOCK|SSH_AGENT_PID)$/i.test(k))delete env[k];
    if(args[0]==='--remote=false'){
      const local=localIdentity();
      if(!snapshot?.local||local.uid!==snapshot.uid||local.home!==snapshot.home)throw Error('Local user changed; refresh and authorize again');
      for(const key of Object.keys(env))if(/^(HOME|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key))delete env[key];
      env.HOME=local.home;env.XDG_RUNTIME_DIR=`/run/user/${local.uid}`;
    }
    const exe=binary();return {exe,options:{cwd:injected?undefined:path.dirname(exe),timeout:30000,maxBuffer:MAX,encoding:'utf8',windowsHide:true,shell:false,env}};
  }
  async function run(args,snapshot){
    let r;
    try{const {exe,options}=commandOptions(snapshot);r=await execute(exe,args,options);}
    catch{throw Error('Podman command failed or exceeded its limit. Check the explicitly selected target locally.');}
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
    const rows=(await configured()).filter(row=>row?.Name!==LOCAL_TARGET&&identityIsAbsolute(row?.Identity)).map(connectionRecord).filter(Boolean);
    try{localIdentity();rows.unshift({name:LOCAL_TARGET,transport:'local',rootlessCandidate:true});}catch{}
    return rows;
  }
  async function selected(name){
    if(name===LOCAL_TARGET){
      const local=localIdentity();
      const binding=createHash('sha256').update(JSON.stringify([LOCAL_TARGET,local.uid,local.home,binary()])).digest('hex');
      return {connection:LOCAL_TARGET,local:true,uid:local.uid,home:local.home,binding};
    }
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
  const args=(snapshot,tail)=>snapshot.local?['--remote=false',...tail]:['--remote','--url',snapshot.uri,'--identity',snapshot.identity,'--ssh','golang',...tail];
  async function same(snapshot){
    if((await selected(snapshot.connection)).binding!==snapshot.binding)throw Error('Connection changed; refresh and authorize again');
  }
  async function ready(connection,binding){
    const snapshot=await selected(connection);
    if(binding!==undefined&&binding!==snapshot.binding)throw Error('Connection changed; refresh and authorize again');
    const info=parse(await run(args(snapshot,['info','--format','json']),snapshot));
    if(info?.host?.security?.rootless!==true||info?.host?.serviceIsRemote!==(snapshot.local?false:true))throw Error(snapshot.local?'Explicit local rootless Podman state is required':'Explicit remote rootless Podman state is required');
    await same(snapshot);
    return snapshot;
  }
  async function check(connection){
    const snapshot=await ready(connection);
    return {connection,status:'ready',rootless:true,binding:snapshot.binding};
  }
  async function rows(snapshot){
    const data=parse(await run(args(snapshot,['ps','--all','--no-trunc','--format','json']),snapshot));
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
    await run(args(snapshot,[verb,...(verb==='stop'?['--time','10']:[]),'--',id]),snapshot);
    return {connection,id,status:'requested'};
  }
  async function logs(connection,id,tail=100,binding){
    if(!Number.isInteger(tail)||tail<1||tail>1000)throw Error('Log tail must be an integer from 1 to 1000');
    const snapshot=await existing(connection,id,binding);
    const text=await run(args(snapshot,['logs','--tail',String(tail),'--',id]),snapshot);
    const bytes=Buffer.from(text);
    return {connection,id,tail,text:bytes.subarray(0,24*1024).toString('utf8'),truncated:bytes.length>24*1024};
  }
  async function desktop(connection,id,binding){
    const snapshot=await existing(connection,id,binding);
    const allowed=String(desktopImageIds).split(/[\s,]+/).filter(Boolean);
    if(!allowed.length||allowed.some(value=>!ID.test(value)))throw Error('Configure trusted VAMP Desktop image IDs first');
    const values=parse(await run(args(snapshot,['inspect','--type','container','--',id]),snapshot));
    const value=Array.isArray(values)&&values.length===1?values[0]:null;
    const imageId=String(value?.Image||'').replace(/^sha256:/,'');
    const host=value?.HostConfig,config=value?.Config;
    if(value?.Id!==id||value?.State?.Running!==true||!ID.test(imageId)||!allowed.includes(imageId))throw Error('Running container must use a trusted immutable VAMP Desktop image');
    const safeTmpfs=new Set(['/tmp','/run','/var/tmp']);
    const mountsSafe=Array.isArray(value.Mounts)&&value.Mounts.every(m=>m&&m.Type==='tmpfs'&&safeTmpfs.has(m.Destination)&&(!m.Source||m.Source==='tmpfs'));
    const declaredTmpfs=host?.Tmpfs;
    const tmpfsSafe=declaredTmpfs==null||(typeof declaredTmpfs==='object'&&!Array.isArray(declaredTmpfs)&&Object.keys(declaredTmpfs).every(key=>safeTmpfs.has(key)));
    if(config?.User!=='1000:1000'||host?.Privileged!==false||host?.ReadonlyRootfs!==true||!mountsSafe||!tmpfsSafe||
       !Array.isArray(host.CapAdd)||host.CapAdd.length||!Array.isArray(host.CapDrop)||!host.CapDrop.some(x=>String(x).toUpperCase()==='ALL')||
       !Array.isArray(host.SecurityOpt)||!host.SecurityOpt.some(x=>/^no-new-privileges(?::true|=true)?$/.test(x))||
       ['NetworkMode','PidMode','IpcMode','UTSMode','UsernsMode'].some(key=>typeof host[key]!=='string'||/^(host|container:)/.test(host[key]))||
       (host.Devices!=null&&(!Array.isArray(host.Devices)||host.Devices.length))||
       (host.DeviceRequests!=null&&(!Array.isArray(host.DeviceRequests)||host.DeviceRequests.length)))throw Error('Container desktop isolation could not be verified');
    await same(snapshot);
    return {snapshot,metadata:{connection,id,binding,imageId,width:1920,height:1080}};
  }
  async function screenTarget(connection,id,binding){
    const {metadata}=await desktop(connection,id,binding);
    return {connection:metadata.connection,id:metadata.id,imageId:metadata.imageId,width:metadata.width,height:metadata.height};
  }
  const desktopArgs=(snapshot,id,helper,mode='view_only')=>args(snapshot,['exec','--user','1000:1000',...(helper==='view'?['--interactive']:[]),'--',id,'/usr/bin/python3','-I','-B',`/opt/vamp-desktop/${helper}.py`,...(helper==='view'&&mode==='control'?['--interactive']:[])]);
  async function capture(connection,id,binding){
    const {snapshot,metadata}=await desktop(connection,id,binding);
    const {exe,options}=commandOptions(snapshot);
    let output;
    try{output=await execute(exe,desktopArgs(snapshot,id,'capture'),{...options,encoding:'buffer',maxBuffer:8*1024*1024,timeout:20000});}catch{throw Error('Desktop capture failed or exceeded its limit');}
    const png=output.stdout;
    validatePng(png);
    return {...metadata,png};
  }
  async function openScreenStream(connection,id,binding,streamOptions={}){
    if(!streamOptions||typeof streamOptions!=='object'||Array.isArray(streamOptions)||Object.keys(streamOptions).some(key=>key!=='mode')||!['view_only','control'].includes(streamOptions.mode??'view_only'))throw Error('Unsupported desktop stream options');
    const mode=streamOptions.mode??'view_only';
    const {snapshot,metadata}=await desktop(connection,id,binding);
    const {exe,options}=commandOptions(snapshot);
    const child=spawnProcess(exe,desktopArgs(snapshot,id,'view',mode),{cwd:options.cwd,env:options.env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    child.stdout.pause();
    let closed=false,stderrBytes=0,stdoutBytes=0;
    const close=()=>{if(closed)return;closed=true;clearTimeout(timer);child.stdin.end();child.kill();};
    const timer=setTimeout(close,5*60*1000);timer.unref?.();
    child.stdout.on('data',chunk=>{stdoutBytes+=chunk.length;if(chunk.length>1024*1024||stdoutBytes>128*1024*1024)close();});
    child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>16*1024)close();});
    child.once('error',close);child.once('exit',()=>{closed=true;clearTimeout(timer);});
    child.stdin.on('error',close);child.stdout.on('error',close);
    child.stdout.pause();
    return {...metadata,viewOnly:mode==='view_only',mode,child,close};
  }
  return {screenTarget,capture,openScreenStream,detectLocal,connections,check,list,start:(c,id,binding)=>action(c,id,binding,'start'),stop:(c,id,binding)=>action(c,id,binding,'stop'),logs};
}
module.exports={createPodmanAdapter,standardLocations,LOCAL_TARGET};

function crc32(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let n=0;n<8;n++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;}
function validatePng(png){
  const fail=()=>{throw Error('Expected a valid 1920x1080 RGB/RGBA PNG');};
  if(!Buffer.isBuffer(png)||png.length>8*1024*1024||png.length<57||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))fail();
  let at=8,channels=0,ended=false,seenData=false;const data=[];
  while(at<png.length){
    if(at+12>png.length)fail();const length=png.readUInt32BE(at);if(length>8*1024*1024||at+12+length>png.length)fail();
    const type=png.toString('ascii',at+4,at+8),body=png.subarray(at+8,at+8+length);
    if(crc32(png.subarray(at+4,at+8+length))!==png.readUInt32BE(at+8+length))fail();
    if(at===8){if(type!=='IHDR'||length!==13||body.readUInt32BE(0)!==1920||body.readUInt32BE(4)!==1080||body[8]!==8||![2,6].includes(body[9])||body[10]||body[11]||body[12])fail();channels=body[9]===2?3:4;}
    else if(type==='IDAT'){seenData=true;data.push(body);}
    else if(type==='IEND'){if(length||!seenData||at+12!==png.length)fail();ended=true;}
    else fail(); // Helpers emit only IHDR/IDAT/IEND, no ancillary payloads.
    at+=12+length;
  }
  if(!ended)fail();const stride=1920*channels+1;let pixels;try{pixels=inflateSync(Buffer.concat(data),{maxOutputLength:stride*1080});}catch{fail();}
  if(pixels.length!==stride*1080)fail();for(let row=0;row<1080;row++)if(pixels[row*stride]>4)fail();return true;
}
module.exports.validatePng=validatePng;
