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
 const backend=hostBackends({globalStorageUri:{fsPath:root}},{runtime:root,config:()=>({get:()=>undefined}),execute});
 const rows=await backend.list('kvm');assert.equal(rows[0].managed,false);assert.equal(rows[0].state,'poweroff');
 await assert.rejects(backend.remove('kvm',id),/Only desktops created/);assert.ok(!calls.some(c=>c.includes('undefine')));
 await assert.rejects(backend.start('kvm','--destroy'),/identifier/);assert.ok(!calls.some(c=>c.includes('start')));
 await backend.start('kvm',id);await backend.stop('kvm',id);assert.ok(calls.some(c=>c.includes('start')&&c.includes(id)));assert.ok(calls.some(c=>c.includes('shutdown')));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('KVM creation prepares Debian media, starts from ISO, and verifies Running',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vamp-create-'));const calls=[];
 try {
 const iso=path.join(root,'Debian installer.iso');fs.writeFileSync(iso,'test');
 const execute=async(exe,args)=>{calls.push([exe,...args]);if(args.includes('build_debian_installer.py')||args.some(a=>String(a).endsWith('/build_debian_installer.py')))return {stdout:JSON.stringify({iso:path.join(root,'prepared.iso')})};if(args.includes('domuuid'))return {stdout:id};if(args.includes('domstate'))return {stdout:'running'};return {stdout:''};};
 const backend=hostBackends({globalStorageUri:{fsPath:root}},{runtime:root,config:()=>({get:()=>undefined}),execute});
 const result=await backend.create('kvm',{name:'Debian-Test',iso_path:iso,guest_os:'debian',memory_mb:2048,cpus:2,disk_mb:32768});
 assert.equal(result.installation_mode,'unattended');assert.equal(result.startup_verified,true);assert.equal(result.installation_verified,false);
 const command=calls.find(call=>call[0]==='virt-install');assert.ok(command.includes(`path=${path.join(root,'prepared.iso')},device=cdrom,readonly=on`));assert.equal(command[command.indexOf('--boot')+1],'hd,cdrom');assert.equal(result.credentials.username,'vboxuser');
 await assert.rejects(backend.create('kvm',{name:'Debian-Test',iso_path:iso,guest_os:'debian',memory_mb:2048,cpus:2,disk_mb:32768}),/EEXIST/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('KVM start failure cannot report installation started; invalid resources never create disks',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vamp-create-fail-'));const calls=[];
 try {
 const iso=path.join(root,'source.iso');fs.writeFileSync(iso,'test');
 const execute=async(exe,args)=>{calls.push([exe,...args]);if(args.includes('domuuid'))return {stdout:id};if(args.includes('domstate'))return {stdout:'shut off'};return {stdout:''};};
 const backend=hostBackends({globalStorageUri:{fsPath:root}},{runtime:root,config:()=>({get:()=>undefined}),execute});
 await assert.rejects(backend.create('kvm',{name:'Invalid',iso_path:iso,guest_os:'debian',memory_mb:1,cpus:2,disk_mb:32768}),/Invalid VM resources/);assert.equal(calls.length,0);
 await assert.rejects(backend.create('kvm',{name:'Not-Started',iso_path:iso,guest_os:'ubuntu',memory_mb:2048,cpus:2,disk_mb:32768}),/did not start/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('KVM refuses to create or start while VirtualBox holds hardware virtualization',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vamp-conflict-'));const calls=[];
 try {
 const iso=path.join(root,'source.iso');fs.writeFileSync(iso,'test');
 const execute=async(exe,args)=>{calls.push([exe,...args]);return {stdout:exe.endsWith('VBoxManage')?'"busy-vm" {11111111-2222-3333-4444-555555555555}':''};};
 const backend=hostBackends({globalStorageUri:{fsPath:root}},{runtime:root,config:()=>({get:()=>undefined}),execute});
 await assert.rejects(backend.create('kvm',{name:'Conflict',iso_path:iso,guest_os:'debian',memory_mb:2048,cpus:2,disk_mb:32768}),/VirtualBox VM is active/);
 await assert.rejects(backend.start('kvm',id),/VirtualBox VM is active/);
 assert.ok(!calls.some(call=>call[0]==='qemu-img'||call.includes('start')));
 assert.equal(fs.existsSync(path.join(root,'desktops')),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
