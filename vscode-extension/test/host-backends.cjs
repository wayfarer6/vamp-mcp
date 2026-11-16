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
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vamp-backends-'));const calls=[];
 try {
 const execute=async(exe,args)=>{calls.push([exe,...args]);if(args.includes('--uuid'))return {stdout:id};if(args.includes('dumpxml'))return {stdout:xml};if(args.includes('domstate'))return {stdout:'shut off\n'};return {stdout:''};};
 const backend=hostBackends({globalStorageUri:{fsPath:root}},{runtime:root,config:()=>({get:()=>undefined}),execute});
 const rows=await backend.list('kvm');assert.equal(rows[0].managed,false);assert.equal(rows[0].state,'poweroff');
 await assert.rejects(backend.remove('kvm',id),/Only desktops created/);assert.ok(!calls.some(c=>c.includes('undefine')));
 await assert.rejects(backend.start('kvm','--destroy'),/identifier/);assert.ok(!calls.some(c=>c.includes('start')));
 await backend.start('kvm',id);await backend.stop('kvm',id);assert.ok(calls.some(c=>c.includes('start')&&c.includes(id)));assert.ok(calls.some(c=>c.includes('shutdown')));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
