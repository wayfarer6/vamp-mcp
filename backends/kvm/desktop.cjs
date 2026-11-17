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
/** @returns {import('../common/desktop-interface').DesktopAdapter} */
function createKvmAdapter(context,{runtime,config,execute=run,platform=process.platform}){
  require('../common/host-support.cjs').requireBackendHost('kvm',platform);
  const storage=path.join(process.env.VAMP_HOME||path.join(require('node:os').homedir(),'.vamp'),'vms');
  const uri=()=>config().get('libvirtUri') || 'qemu:///session';
  const command=async(exe,args,timeout=30000)=>(await execute(exe,args,{timeout,maxBuffer:4*1024**2,env:{...process.env,LC_ALL:'C'}})).stdout;
  const virsh=args=>command('virsh',['-c',uri(),...args]);
  const checkID=id=>{if(!UUID.test(id))throw Error('Invalid VM identifier');return id;};
  function managed(backend,id){
    for(const base of [storage,path.join(context.globalStorageUri.fsPath,'desktops')]){
      const root=path.join(base,backend);if(!fs.existsSync(root))continue;
      for(const name of fs.readdirSync(root)){
        const record=path.join(root,name,'vamp-ui.json');
        try{const item=JSON.parse(fs.readFileSync(record,'utf8'));if(item.id===id)return {...item,folder:path.dirname(record)};}catch{}
      }
    }
  }
  async function ensureNoVirtualBox(){
    if(platform!=='linux')return;
    try {const active=await command(process.env.VBOXMANAGE_PATH||'VBoxManage',['list','runningvms']);if(active.trim())throw Error('A VirtualBox VM is active. Shut it down before starting KVM; simultaneous execution can crash VirtualBox (VERR_SVM_IN_USE).');}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return {
    async check(){
      if(platform!=='linux')throw Error('KVM requires a Linux host. Choose VirtualBox or Hyper-V on Windows.');
      await virsh(['list','--all','--uuid']);
      await command('virt-install',['--version']);await command('qemu-img',['--version']);
      return 'KVM · '+uri();
    },
    async list(){
      const ids=(await virsh(['list','--all','--uuid'])).split(/\s+/).filter(id=>UUID.test(id));
      return Promise.all(ids.map(async id=>{
        const info=domainInfo(await virsh(['dumpxml',id]));
        const raw=(await virsh(['domstate',id])).trim();
        return {...info,backend:'kvm',state:({'shut off':'poweroff',running:'running',paused:'paused',crashed:'aborted'})[raw]||raw,managed:!!managed('kvm',id)};
      }));
    },
    create:values=>require('../common/packer.cjs').packer({runtime,python:()=>config().get('kvmPythonExecutable')||'python3'})('create',{backend:'kvm',libvirt_uri:uri(),...values}),
    async start(id){checkID(id);await ensureNoVirtualBox();await virsh(['start',id]);const state=(await virsh(['domstate',id])).trim();if(state!=='running')throw Error('VM did not reach Running state: '+state);return {status:'running',startup_verified:true};},
    async stop(id){checkID(id);return virsh(['shutdown',id]);},
    async endpoint(id){checkID(id);return vncEndpoint(await virsh(['dumpxml',id]));},
    async remove(id){
      checkID(id);
      const item=managed('kvm',id);if(!item)throw Error('Only desktops created by VAMP can be deleted here.');
      const state=(await virsh(['domstate',id])).trim();if(state!=='shut off')throw Error('Shut down the VM before deleting it.');
      await virsh(['undefine',id,'--nvram','--tpm','--managed-save','--snapshots-metadata','--checkpoints-metadata']);
      if(item.volume){
        if(item.pool!=='default'||!/^vamp-[A-Za-z][A-Za-z0-9_-]{0,62}\.qcow2$/.test(item.volume))throw Error('Unexpected managed storage volume; inspect the ownership record.');
        await virsh(['vol-delete','--pool',item.pool,item.volume]);
      }
      fs.rmSync(item.folder,{recursive:true,force:true});
    }
  };
}
module.exports={createKvmAdapter,domainInfo,vncEndpoint};
