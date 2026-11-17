'use strict';
// Vagrant lifecycle adapter. One VAMP desktop is one Vagrant project folder
// under VAMP_HOME/vagrant, so the Vagrantfile on disk always describes exactly
// the machine that boots. Box images replace Packer's ISO installation here.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {requireBackendHost}=require('../common/host-support.cjs');
const templates=require('./templates.js');
const plugins=require('./plugin-manager.cjs');

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const STATES={running:'running',poweroff:'poweroff',saved:'saved',aborted:'aborted',not_created:'not_created',stopping:'stopping',starting:'starting',suspended:'saved'};
const MUTABLE=new Set(['running','starting','stopping']);

/** Parse `vagrant global-status --machine-readable` (timestamp,target,type,data). */
function parseGlobalStatus(text){
  const rows=new Map();
  for(const line of String(text||'').split(/\r?\n/)){
    const parts=line.split(',');
    if(parts.length<4)continue;
    const [,target,type,...rest]=parts;
    const value=rest.join(',');
    if(!target||target==='ui'||target==='metadata'||type==='metadata')continue;
    const row=rows.get(target)||{};
    if(type==='state')row.state=value;
    else if(type==='provider-name')row.provider=value;
    else if(type==='vagrantfile-path')row.directory=value;
    else if(type==='state-human-long')row.detail=value;
    rows.set(target,row);
  }
  return [...rows.values()];
}

/** Parse `vagrant ssh-config` output. */
function parseSshConfig(text){
  const entries=[];let current=null;
  for(const raw of String(text||'').split(/\r?\n/)){
    const line=raw.trim();
    if(!line||line.startsWith('#'))continue;
    const [key,...rest]=line.split(/\s+/);
    if(/^host$/i.test(key)){
      if(current)entries.push(current);
      current={Host:rest.join(' ')};
    } else if(current){
      current[key]=rest.join(' ');
    }
  }
  if(current)entries.push(current);
  return entries;
}

/** Parse `vagrant port --machine-readable` forwarded port rows. */
function parseForwards(text){
  const ports={};
  for(const line of String(text||'').split(/\r?\n/)){
    const parts=line.split(',');
    if(parts.length<5)continue;
    const [,target,type,guest,host]=parts;
    if(type!=='forwarded_port'||target==='ui')continue;
    const number=Number(host);
    if(Number.isInteger(number))ports[String(guest)]=number;
  }
  return ports;
}

/** Expanded SSH identity file, used only for reporting an endpoint. */
function readRecord(folder){
  try{
    const item=JSON.parse(fs.readFileSync(path.join(folder,'vamp-ui.json'),'utf8'));
    return item&&item.backend==='vagrant'&&UUID.test(item.id||'')?item:null;
  }catch{return null;}
}

/** @returns {import('../common/desktop-interface').DesktopAdapter} */
function createVagrantAdapter(context,{runtime,config=()=>({get:()=>undefined}),execute=promisify(execFile),platform=process.platform,architecture=process.arch,vagrantExecutable,env=process.env}={}){
  requireBackendHost('vagrant',platform);
  const home=env.VAMP_HOME||path.join(os.homedir(),'.vamp');
  const storage=path.join(home,'vagrant');
  const binary=()=>typeof vagrantExecutable==='function'?vagrantExecutable():vagrantExecutable||config().get('vagrantPath')||env.VAGRANT_PATH||'vagrant';
  const child_env={...env,VAGRANT_NO_COLOR:'1',VAGRANT_CHECKPOINT_DISABLE:'1'};

  async function call(args,{cwd=storage,timeout=120000}={}){
    if(!Array.isArray(args)||args.some(item=>typeof item!=='string'))throw new Error('Vagrant arguments must be strings');
    try{
      const result=await execute(binary(),args,{cwd,timeout,maxBuffer:8*1024**2,windowsHide:true,env:child_env});
      return String(result?.stdout??'');
    }catch(error){
      if(error?.code==='ENOENT')throw new Error('Vagrant is not installed on this host. Install Vagrant, then select this backend again.');
      const detail=String(error?.stderr||error?.stdout||error?.message||error).trim().replace(/\s+/g,' ').slice(0,600);
      throw new Error(`vagrant ${args.join(' ')} failed: ${detail}`);
    }
  }

  function records(){
    if(!fs.existsSync(storage))return [];
    return fs.readdirSync(storage,{withFileTypes:true})
      .filter(entry=>entry.isDirectory())
      .flatMap(entry=>{
        const folder=path.join(storage,entry.name);
        const item=readRecord(folder);
        return item?[{...item,folder}]:[];
      });
  }

  function project(id){
    if(!UUID.test(String(id||'')))throw new Error('Invalid VM identifier');
    const item=records().find(row=>row.id===id);
    if(!item)throw new Error('Only Vagrant desktops created by VAMP can be managed here.');
    return item;
  }

  async function machineState(item){
    try{
      const rows=parseGlobalStatus(await call(['status','--machine-readable'],{cwd:item.folder,timeout:60000}));
      const row=rows.find(entry=>entry.state)||{};
      return {raw:row.state||'not_created',detail:row.detail||''};
    }catch(error){
      return {raw:'unknown',detail:error.message};
    }
  }

  return {
    async check(){
      const version=(await call(['--version'],{timeout:30000})).trim();
      const available=[];
      const missing=[];
      const installed=await plugins.list(args=>call(args));
      for(const item of plugins.providers(platform,architecture)){
        if(!item.architecture_supported)continue;
        if(item.builtin||installed.has(item.plugin))available.push(item.provider);
        else missing.push(item.plugin);
      }
      return `${version||'Vagrant'} · providers: ${available.join(', ')||'none'}${missing.length?` · missing plugins: ${missing.join(', ')}`:''}`;
    },

    async list(){
      const rows=records();
      let states=[];
      try{states=parseGlobalStatus(await call(['global-status','--machine-readable'],{timeout:60000}));}catch{}
      return rows.map(item=>{
        const match=states.find(row=>row.directory&&path.resolve(row.directory)===path.resolve(item.folder));
        const raw=match?.state||'not_created';
        return {
          id:item.id,name:item.name,backend:'vagrant',managed:true,
          state:STATES[raw]||raw,memory:item.memory_mb,cpus:item.cpus,guestOS:item.guest_os,
          provider:item.provider,box:item.box,
          installation:{status:'box_provisioned',verified:!!match,mode:'vagrant'},
        };
      });
    },

    async create(values={}){
      const settings=templates.normalize(values);
      plugins.require_supported(settings.provider,platform,architecture);
      const plugin=await plugins.ensure(settings.provider,{run:args=>call(args),install:values.install_plugins!==false});
      const folder=path.join(storage,settings.name);
      if(fs.existsSync(folder))throw new Error(`A Vagrant project already exists at ${folder}; choose another name or remove it first.`);
      fs.mkdirSync(folder,{recursive:true});
      fs.writeFileSync(path.join(folder,'Vagrantfile'),templates.render(settings),{encoding:'utf8'});
      const record={
        schema_version:1,id:crypto.randomUUID(),name:settings.name,backend:'vagrant',managed:true,
        provider:settings.provider,provider_plugin:plugin.plugin||null,box:settings.box,guest_os:settings.guest_os,
        memory_mb:settings.memory_mb,cpus:settings.cpus,ports:settings.ports,ssh_user:settings.ssh_user,
        synced_folders:settings.synced_folders,created_at:new Date().toISOString(),
      };
      fs.writeFileSync(path.join(folder,'vamp-ui.json'),JSON.stringify(record,null,2)+'\n',{encoding:'utf8'});
      // A Vagrantfile is executed on `up`, so refuse to leave an invalid one.
      await call(['validate'],{cwd:folder,timeout:120000});
      return {status:'created',id:record.id,name:record.name,backend:'vagrant',provider:record.provider,box:record.box,folder,started:false,plugin_installed:plugin.installed_now};
    },

    async start(id){
      const item=project(id);
      plugins.require_supported(item.provider,platform,architecture);
      await plugins.ensure(item.provider,{run:args=>call(args)});
      await call(['up','--provider',item.provider],{cwd:item.folder,timeout:3600000});
      const state=await machineState(item);
      if(state.raw!=='running')throw new Error(`Vagrant machine did not reach Running state: ${state.raw||'unknown'}`);
      return {status:'running',startup_verified:true,provider:item.provider};
    },

    async stop(id){
      const item=project(id);
      await call(['halt'],{cwd:item.folder,timeout:600000});
      return {status:'stopped',machine:'poweroff'};
    },

    async remove(id){
      const item=project(id);
      const state=await machineState(item);
      if(MUTABLE.has(state.raw))throw new Error('Shut down the VM before deleting it.');
      await call(['destroy','-f'],{cwd:item.folder,timeout:600000});
      const folder=path.resolve(item.folder);
      // Delete only the VAMP project we recorded, never a neighbouring folder.
      if(path.dirname(folder)!==path.resolve(storage)||path.basename(folder)!==item.name)throw new Error('Unexpected Vagrant project location; inspect the ownership record before deleting.');
      fs.rmSync(folder,{recursive:true,force:true});
      return {status:'removed'};
    },

    async endpoint(id){
      const item=project(id);
      const entries=parseSshConfig(await call(['ssh-config'],{cwd:item.folder,timeout:60000}));
      const entry=entries.find(row=>row.Host==='default')||entries[0];
      if(!entry||!entry.HostName)throw new Error('Vagrant did not report an SSH endpoint for this desktop. Start it first.');
      const port=Number(entry.Port);
      if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Vagrant reported an invalid SSH port');
      let forwards={};
      try{forwards=parseForwards(await call(['port','--machine-readable'],{cwd:item.folder,timeout:60000}));}catch{}
      return {
        host:entry.HostName,port,
        user:entry.User||item.ssh_user||null,
        identity_file:entry.IdentityFile||null,
        ports:{...(item.ports||templates.DEFAULT_PORTS),...forwards},
      };
    },

    async command(args){
      if(!Array.isArray(args)||!args.length)throw new Error('Vagrant command needs at least one argument');
      return call(args.map(String),{timeout:300000});
    },
  };
}

module.exports={createVagrantAdapter,parseGlobalStatus,parseSshConfig,parseForwards};
