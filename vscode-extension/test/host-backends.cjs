const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {domainInfo,vncEndpoint,hostBackends}=require('../host-backends');
const id='12345678-1234-1234-1234-123456789abc';
const xml=`<domain><name>Lab &amp; VM</name><uuid>${id}</uuid><memory unit='KiB'>2097152</memory><vcpu placement='static'>2</vcpu><devices><graphics type='vnc' port='5912'><listen type='address' address='127.0.0.1'/></graphics></devices></domain>`;
test('libvirt XML resource parsing and endpoint validation',()=>{
 assert.equal(domainInfo(xml).name,'Lab & VM');assert.equal(domainInfo(xml).memory,2048);assert.equal(domainInfo(xml).cpus,2);assert.deepEqual(vncEndpoint(xml),{host:'127.0.0.1',port:5912});
 assert.throws(()=>vncEndpoint(xml.replace('127.0.0.1','0.0.0.0')),/localhost/);assert.throws(()=>vncEndpoint(xml.replace("port='5912'","port='-1'")),/active/);
});
test('KVM inventory covers unconfigured guests and never deletes their storage',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vamp-backends-'));const calls=[];let started=false;
 try {
 const execute=async(exe,args)=>{calls.push([exe,...args]);if(args.includes('--uuid'))return {stdout:id};if(args.includes('dumpxml'))return {stdout:xml};if(args.includes('start'))started=true;if(args.includes('domstate'))return {stdout:started?'running\n':'shut off\n'};return {stdout:''};};
 const backend=hostBackends({globalStorageUri:{fsPath:root}},{runtime:root,platform:'linux',architecture:'x64',config:()=>({get:()=>undefined}),execute});
 const rows=await backend.list('kvm');assert.equal(rows[0].managed,false);assert.equal(rows[0].state,'poweroff');
 await assert.rejects(backend.remove('kvm',id),/Only desktops created/);assert.ok(!calls.some(c=>c.includes('undefine')));
 await assert.rejects(backend.start('kvm','--destroy'),/identifier/);assert.ok(!calls.some(c=>c.includes('start')));
 await backend.start('kvm',id);await backend.stop('kvm',id);assert.ok(calls.some(c=>c.includes('start')&&c.includes(id)));assert.ok(calls.some(c=>c.includes('shutdown')));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('all host adapters route new VM installation through the common Packer runner',async()=>{
 for(const [backend,platform] of [['virtualbox','win32'],['hyperv','win32'],['kvm','linux']]){
  const calls=[];
  const adapter=hostBackends({globalStorageUri:{fsPath:'/unused'}},{runtime:'/runtime',platform,architecture:'x64',config:()=>({get:()=>undefined}),packerCall:async(action,request)=>{calls.push({action,request});return {status:'installation_started',engine:'packer'};}});
  const result=await adapter.create(backend,{name:'Packer-Test',iso_path:'/host/install.iso',guest_os:'debian'});
  assert.equal(result.engine,'packer');assert.equal(calls.length,1);assert.equal(calls[0].action,'create');assert.equal(calls[0].request.backend,backend);assert.equal(calls[0].request.iso_path,'/host/install.iso');
 }
});

test('host policy rejects unsupported backends before spawning tools',async()=>{
 const {backendCapabilities}=require('../../backends/common/host-support.cjs');
 for(const platform of ['win32','linux','darwin']){
   const calls=[];
   const adapter=hostBackends({globalStorageUri:{fsPath:'/unused'}},{runtime:'/unused',config:()=>({get(){}}),platform,execute:async(...args)=>{calls.push(args);return {stdout:''};}});
   const capabilities=backendCapabilities(platform);
   assert.equal(capabilities.virtualbox.hostSupported,true);
   assert.equal(capabilities.hyperv.hostSupported,platform==='win32');
   assert.equal(capabilities.kvm.hostSupported,platform==='linux');
   assert.equal(capabilities['apple-hypervisor'].hostSupported,platform==='darwin');
   assert.equal(capabilities['apple-hypervisor'].implemented,false);
   for(const backend of ['hyperv','kvm','apple-hypervisor']){
     if(!capabilities[backend].hostSupported||!capabilities[backend].implemented)await assert.rejects(adapter.check(backend),/unsupported|not implemented/);
   }
   assert.equal(calls.length,0);
 }
});

test('VirtualBox interface is available on all three hosts and gates only amd64 creation on ARM',async()=>{
 for(const platform of ['win32','linux','darwin']){
   const calls=[];
   const adapter=hostBackends({globalStorageUri:{fsPath:'/unused'}},{runtime:'/unused',config:()=>({get(){}}),platform,architecture:'arm64',execute:async(exe,args)=>{calls.push([exe,args]);return {stdout:'7.2'};}});
   assert.equal(await adapter.check('virtualbox'),'7.2');
   await assert.rejects(adapter.create('virtualbox',{}),/amd64.*x64/);
   assert.equal(calls.length,1);
 }
});


test('MCP host tools apply the same KVM host guard as the VSIX',async()=>{
 const {createTools}=await import('../../backends/remote_ssh/tools.mjs');
 for(const platform of ['win32','darwin']){
   const calls=[];
   const tools=createTools({config:{backend:'kvm',platform,libvirtUri:'qemu:///system'},run:async(...args)=>{calls.push(args);return {stdout:''};}});
   await assert.rejects(tools.list(),/unsupported/);
   assert.equal(calls.length,0);
 }
});


test('development VM visibility depends on explicit metadata, not its name',async()=>{
 const {createVirtualBoxAdapter}=require('../../backends/virtualbox/desktop.cjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vamp-dev-filter-'));
 const previous=process.env.VAMP_SHOW_DEVELOPMENT_VMS;
 try{
   delete process.env.VAMP_SHOW_DEVELOPMENT_VMS;
   fs.writeFileSync(path.join(root,'vamp-install.json'),JSON.stringify({development_only:true}));
   const adapter=createVirtualBoxAdapter(null,{runtime:root,execute:async(_exe,args)=>({stdout:args[0]==='list'?`"Developer notes" {${id}}`:`VMState="poweroff"\nCfgFile="${path.join(root,'desktop.vbox')}"`})});
   assert.equal((await adapter.list()).length,0);
   process.env.VAMP_SHOW_DEVELOPMENT_VMS='1';assert.equal((await adapter.list()).length,1);
   delete process.env.VAMP_SHOW_DEVELOPMENT_VMS;
   fs.writeFileSync(path.join(root,'vamp-install.json'),JSON.stringify({development_only:false}));
   assert.equal((await adapter.list())[0].name,'Developer notes');
 }finally{if(previous===undefined)delete process.env.VAMP_SHOW_DEVELOPMENT_VMS;else process.env.VAMP_SHOW_DEVELOPMENT_VMS=previous;fs.rmSync(root,{recursive:true,force:true});}
});
