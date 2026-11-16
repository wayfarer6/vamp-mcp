// Host lifecycle adapters. Commands use argument arrays; installation media
// remain host-local. Existing guest disks are never selected for deletion.
const fs=require('node:fs');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const decode=s=>s.replace(/&(?:amp|lt|gt|quot|apos);/g,c=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[c]));
function attributes(text){const result={};for(const m of text.matchAll(/([\w:-]+)\s*=\s*(['"])(.*?)\2/g))result[m[1]]=decode(m[3]);return result;}
function domainInfo(xml){
  const tag=name=>decode(xml.match(new RegExp('<'+name+'(?:\\s[^>]*)?>([^<]*)</'+name+'>'))?.[1] || '');
  const memoryTag=xml.match(/<memory\b([^>]*)>/)?.[1] || '';
  const unit=attributes(memoryTag).unit || 'KiB';
  const multipliers={KiB:1/1024,MiB:1,GiB:1024,bytes:1/1024**2,k:1/1024,M:1,G:1024};
  return {id:tag('uuid'),name:tag('name'),memory:Math.round(Number(tag('memory'))*(multipliers[unit]||1/1024)),cpus:Number(tag('vcpu'))};
}
function vncEndpoint(xml){
  for(const tag of xml.matchAll(/<graphics\b([^>]*)(?:\/>|>([\s\S]*?)<\/graphics>)/g)){
    const a=attributes(tag[1]);if(a.type!=='vnc')continue;
    const listen=attributes(tag[2]?.match(/<listen\b([^>]*)\/>/)?.[1] || '');
    const host=a.listen || listen.address || '127.0.0.1',port=Number(a.port);
    if(!['127.0.0.1','localhost','::1'].includes(host)||!Number.isInteger(port)||port<1||port>65535)throw Error('This VM needs an active VNC display listening on localhost.');
    return {host,port};
  }
  throw Error('This VM does not expose VNC. Create a KVM desktop here to use the embedded viewer.');
}
function hostBackends(context,{runtime,config,execute=run}){
  const storage=path.join(context.globalStorageUri.fsPath,'desktops');
  const uri=()=>config().get('libvirtUri') || 'qemu:///session';
  const command=async(exe,args,timeout=30000)=>(await execute(exe,args,{timeout,maxBuffer:4*1024**2,env:{...process.env,LC_ALL:'C'}})).stdout;
  const virsh=args=>command('virsh',['-c',uri(),...args]);
  const checkID=id=>{if(!UUID.test(id))throw Error('Invalid VM identifier');return id;};
  const record=(backend,name)=>path.join(storage,backend,name,'vamp-ui.json');
  function managed(backend,id){
    const root=path.join(storage,backend);
    if(!fs.existsSync(root))return;
    for(const name of fs.readdirSync(root)){
      try{const item=JSON.parse(fs.readFileSync(record(backend,name),'utf8'));if(item.id===id)return {...item,folder:path.dirname(record(backend,name))};}catch{}
    }
  }
  async function hyperv(action,data={}){
    if(process.platform!=='win32')throw Error('Hyper-V management is available on a Windows host with Hyper-V enabled.');
    const result=await command('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(runtime,'backends/hyperv/scripts/Manage-Desktop.ps1'),'-RequestBase64',Buffer.from(JSON.stringify({action,...data})).toString('base64'),'-StoragePath',path.join(storage,'hyperv')],180000);
    return JSON.parse(result);
  }
  return {
    async check(backend){
      if(backend==='hyperv'){await hyperv('check');return 'Hyper-V ready';}
      if(process.platform!=='linux')throw Error('KVM requires a Linux host. Choose VirtualBox or Hyper-V on Windows.');
      await virsh(['list','--all','--uuid']);
      await command('virt-install',['--version']);await command('qemu-img',['--version']);
      return 'KVM · '+uri();
    },
    async list(backend){
      if(backend==='hyperv')return (await hyperv('list')).vms;
      const ids=(await virsh(['list','--all','--uuid'])).split(/\s+/).filter(id=>UUID.test(id));
      return Promise.all(ids.map(async id=>{
        const info=domainInfo(await virsh(['dumpxml',id]));
        const raw=(await virsh(['domstate',id])).trim();
        return {...info,backend:'kvm',state:({'shut off':'poweroff',running:'running',paused:'paused',crashed:'aborted'})[raw]||raw,managed:!!managed('kvm',id)};
      }));
    },
    async create(backend,{name,iso_path,guest_os,memory_mb,cpus,disk_mb}){
      if(!/^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test(name))throw Error('Use a name starting with a letter, followed by letters, numbers, hyphens or underscores.');
      if(!['debian','ubuntu','windows11'].includes(guest_os))throw Error('Unsupported operating system');
      if(backend==='hyperv')return hyperv('create',{name,iso_path,guest_os,memory_mb,cpus,disk_mb});
      if(!fs.statSync(iso_path).isFile() || iso_path.includes(','))throw Error('Choose a readable local ISO without a comma in its path.');
      const existing=await virsh(['list','--all','--name']);if(existing.split(/\r?\n/).includes(name))throw Error('A VM with this name already exists.');
      const folder=path.join(storage,'kvm',name);fs.mkdirSync(path.dirname(folder),{recursive:true});fs.mkdirSync(folder);
      const disk=path.join(folder,'disk.qcow2');
      fs.writeFileSync(path.join(folder,'creation.json'),JSON.stringify({status:'preparing',name,disk,iso_path}));
      await command('qemu-img',['create','-f','qcow2',disk,`${disk_mb}M`]);
      const args=['--connect',uri(),'--name',name,'--virt-type','kvm','--memory',String(memory_mb),'--vcpus',String(cpus),'--cpu','host-passthrough','--disk',`path=${disk},format=qcow2,bus=${guest_os==='windows11'?'sata':'virtio'}`,'--disk',`path=${iso_path},device=cdrom,readonly=on`,'--import','--osinfo','detect=on,require=off','--graphics','vnc,listen=127.0.0.1','--video',guest_os==='windows11'?'vga':'virtio','--input','tablet,bus=usb','--network',uri().endsWith('/session')?'user,model=e1000e':'network=default,model=virtio','--noautoconsole'];
      if(guest_os==='windows11')args.push('--boot','uefi,hd,cdrom','--tpm','backend.type=emulator,backend.version=2.0,model=tpm-crb');
      else args.push('--boot','hd,cdrom');
      try{await command('virt-install',args,180000);}catch(error){throw Error(`KVM setup failed. Partial setup preserved at ${folder}. ${error.message}`);}
      const id=(await virsh(['domuuid',name])).trim();checkID(id);
      fs.writeFileSync(record('kvm',name),JSON.stringify({id,name,disk,guest_os,installation_mode:'manual'}));
      return {status:'installation_started',installation_mode:'manual',vm:name,id};
    },
    async start(backend,id){checkID(id);if(backend==='hyperv')return hyperv('start',{id});return virsh(['start',id]);},
    async stop(backend,id){checkID(id);if(backend==='hyperv')return hyperv('stop',{id});return virsh(['shutdown',id]);},
    async endpoint(id){checkID(id);return vncEndpoint(await virsh(['dumpxml',id]));},
    async remove(backend,id){
      checkID(id);if(backend==='hyperv')return hyperv('delete',{id});
      const item=managed('kvm',id);if(!item)throw Error('Only desktops created by VAMP can be deleted here.');
      const state=(await virsh(['domstate',id])).trim();if(state!=='shut off')throw Error('Shut down the VM before deleting it.');
      await virsh(['undefine',id,'--nvram','--tpm','--managed-save','--snapshots-metadata','--checkpoints-metadata']);
      fs.rmSync(item.folder,{recursive:true,force:true});
    }
  };
}
module.exports={hostBackends,domainInfo,vncEndpoint};
