// Common lifecycle interface: check/list/create/start/stop/remove.
// Backends are loaded lazily after host checks; unsupported tools never run.
const {requireBackendHost,requireInstallHost,backendCapabilities}=require('./host-support.cjs');
const {domainInfo,vncEndpoint}=require('../kvm/desktop.cjs');
function hostBackends(context,options){
  const platform=options.platform||process.platform;
  const cache=new Map();
  function adapter(backend){
    requireBackendHost(backend,platform);
    if(backend==='apple-hypervisor')throw Error('Apple Hypervisor adapter is not implemented');
    if(!cache.has(backend)){
      if(backend==='kvm')cache.set(backend,require('../kvm/desktop.cjs').createKvmAdapter(context,{...options,platform}));
      else if(backend==='hyperv')cache.set(backend,require('../hyperv/desktop.cjs').createHyperVAdapter(context,{...options,platform}));
      else if(backend==='virtualbox')cache.set(backend,require('../virtualbox/desktop.cjs').createVirtualBoxAdapter(context,{...options,platform}));
      else throw Error('Unsupported backend');
    }
    const implementation=cache.get(backend);
    for(const method of ['check','list','create','start','stop','remove']){
      if(typeof implementation[method]!=='function')throw Error(`${backend} adapter is missing ${method}`);
    }
    return implementation;
  }
  const uuid=id=>{if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))throw Error('Invalid VM identifier');return id;};
  return {
    command:async(backend,args)=>adapter(backend).command(args),
    capabilities:()=>backendCapabilities(platform),
    check:async backend=>adapter(backend).check(),
    list:async backend=>adapter(backend).list(),
    async create(backend,values){requireInstallHost(backend,platform,options.architecture||process.arch);return (options.packerCall||require('./packer.cjs').packer(options))('create',{backend,libvirt_uri:options.config?.().get('libvirtUri'),...values});},
    start:async(backend,id)=>adapter(backend).start(uuid(id)),
    stop:async(backend,id)=>adapter(backend).stop(uuid(id)),
    remove:async(backend,id)=>adapter(backend).remove(uuid(id)),
    endpoint:async id=>adapter('kvm').endpoint(uuid(id)),
  };
}
const preparePacker=(options,backend)=>require('./packer.cjs').packer(options)('prepare',{backend:backend==='remote'?'virtualbox':backend});
module.exports={hostBackends,domainInfo,vncEndpoint,preparePacker,packer:require('./packer.cjs').packer};
