// Cross-platform VirtualBox adapter. Guest provisioning stays in shared Python.
const path=require('node:path');
const fs=require('node:fs');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {requireBackendHost,requireInstallHost}=require('../common/host-support.cjs');
/** @returns {import('../common/desktop-interface').DesktopAdapter} */
function createVirtualBoxAdapter(_context,{runtime,config=()=>({get:()=>undefined}),execute=promisify(execFile),spawn=execFile,python=()=>process.env.RPA_HOST_PYTHON||(process.platform==='win32'?'python':'python3'),platform=process.platform,architecture=process.arch,vboxExecutable}={}){
  requireBackendHost('virtualbox',platform);
  const executable=()=>typeof vboxExecutable==='function'?vboxExecutable():vboxExecutable||config().get('vboxManagePath')||process.env.VBOXMANAGE_PATH||(platform==='win32'?path.join(process.env.ProgramFiles||'C:/Program Files','Oracle/VirtualBox/VBoxManage.exe'):'VBoxManage');
  const command=async args=>(await execute(executable(),args,{timeout:30000,maxBuffer:4*1024**2})).stdout;
  const info=text=>Object.fromEntries(text.split(/\r?\n/).flatMap(line=>{const m=line.match(/^([^=]+)=(.*)$/);return m?[[m[1],m[2].replace(/^"|"$/g,'')]]:[];}));
  return {command,
    async list(){
      const rows=(await command(['list','vms'])).split(/\r?\n/).flatMap(line=>{const m=line.match(/^"(.*)"\s+\{([a-f0-9-]{36})\}$/i);return m?[{name:m[1],id:m[2]}]:[];});
      return (await Promise.all(rows.map(async row=>{
        try{
          const details=info(await command(['showvminfo',row.id,'--machinereadable']));
          let installation;
          try{installation=JSON.parse(fs.readFileSync(path.join(path.dirname(details.CfgFile),'vamp-install.json'),'utf8'));}catch{}
          if(installation?.development_only && process.env.VAMP_SHOW_DEVELOPMENT_VMS!=='1')return null;
          return {...row,backend:'virtualbox',managed:true,state:details.VMState,memory:details.memory,cpus:details.cpus,guestOS:details.ostype,
            installation:installation?{status:installation.status,verified:installation.installation_verified,mode:installation.installation_mode}:undefined};
        }catch{return {...row,state:'unavailable'};}
      }))).filter(Boolean);
    },
    async start(id){await command(['startvm',id,'--type','headless']);const state=info(await command(['showvminfo',id,'--machinereadable'])).VMState;if(state!=='running')throw Error('VM did not reach Running state: '+(state||'unknown'));return {status:'running',startup_verified:true};},
    stop:id=>command(['controlvm',id,'acpipowerbutton']),
    remove:id=>command(['unregistervm',id,'--delete']),
    check:async()=>(await command(['--version'])).trim(),
    async create(request){
      requireInstallHost('virtualbox',platform,architecture);
      return require('../common/packer.cjs').packer({runtime,python,spawn})('create',{backend:'virtualbox',...request});
    },
  };
}
module.exports={createVirtualBoxAdapter};
