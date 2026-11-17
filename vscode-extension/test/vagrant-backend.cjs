const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const templates=require('../../backends/vagrant/templates.js');
const plugins=require('../../backends/vagrant/plugin-manager.cjs');
const {createVagrantAdapter,parseGlobalStatus,parseSshConfig,parseForwards}=require('../../backends/vagrant/desktop.cjs');
const {hostBackends}=require('../host-backends');

function sandbox(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vamp-vagrant-'));
  return {root,env:{...process.env,VAMP_HOME:root}};
}

function runner(handler){
  const calls=[];
  const execute=async(exe,args,options={})=>{
    calls.push({exe,args,options});
    const stdout=handler(args,options);
    if(stdout instanceof Error)throw stdout;
    return {stdout:stdout??''};
  };
  return {calls,execute};
}

const id='12345678-1234-1234-1234-123456789abc';

function project(root,name,record={}){
  const folder=path.join(root,'vagrant',name);
  fs.mkdirSync(folder,{recursive:true});
  const item={schema_version:1,id:record.id||id,name,backend:'vagrant',managed:true,provider:'virtualbox',box:'generic/debian12',guest_os:'debian',memory_mb:4096,cpus:2,ports:{script_server:8421,vnc:5900,rdp:3389},...record};
  fs.writeFileSync(path.join(folder,'vamp-ui.json'),JSON.stringify(item));
  if(!fs.existsSync(path.join(folder,'Vagrantfile')))fs.writeFileSync(path.join(folder,'Vagrantfile'),templates.render(item));
  return {folder,item};
}

test('Vagrantfile carries SSH, the three forwarded ports, a shared folder and every provider block',()=>{
  const source=templates.render({name:'Lab-Debian',guest_os:'debian',provider:'libvirt',memory_mb:8192,cpus:4,
    synced_folders:[{host:'/host/share',guest:'/home/vboxuser/share'}]});
  assert.match(source,/Vagrant\.configure\("2"\)/);
  assert.match(source,/config\.vm\.communicator = "ssh"/);
  assert.match(source,/config\.vm\.box = "generic\/debian12"/);
  assert.match(source,/guest: 8421, host: 8421, host_ip: "127\.0\.0\.1", id: "vamp-script-server"/);
  assert.match(source,/guest: 5900, host: 5900, host_ip: "127\.0\.0\.1", id: "vamp-vnc"/);
  assert.match(source,/guest: 3389, host: 3389, host_ip: "127\.0\.0\.1", id: "vamp-rdp"/);
  assert.match(source,/config\.vm\.synced_folder "\/host\/share", "\/home\/vboxuser\/share"/);
  for(const provider of ['virtualbox','libvirt','hyperv','qemu','parallels'])assert.match(source,new RegExp(`config\\.vm\\.provider "${provider}"`));
  // The selected provider is emitted first, where a reader looks for it.
  assert.ok(source.indexOf('config.vm.provider "libvirt"')<source.indexOf('config.vm.provider "virtualbox"'));
  assert.match(source,/p\.memory = 8192/);
  assert.match(source,/p\.cpus = 4/);
});

test('Windows guests declare the Windows guest family and stay SSH-only',()=>{
  const source=templates.render({name:'Lab-Windows',guest_os:'windows11',provider:'hyperv',box:'gusztavvargadr/windows-11'});
  assert.match(source,/config\.vm\.guest = :windows/);
  assert.match(source,/config\.vm\.communicator = "ssh"/);
  assert.doesNotMatch(source,/winrm/i);
});

test('settings are validated before anything is written',()=>{
  assert.throws(()=>templates.normalize({name:'../escape'}),/must start with a letter/);
  assert.throws(()=>templates.normalize({name:'Lab',provider:'vmware'}),/provider must be one of/);
  assert.throws(()=>templates.normalize({name:'Lab',guest_os:'freebsd'}),/support/);
  assert.throws(()=>templates.normalize({name:'Lab',memory_mb:16}),/between 512 and 262144/);
  assert.throws(()=>templates.normalize({name:'Lab',synced_folders:[{host:'/x',guest:'relative'}]}),/absolute guest path/);
  const settings=templates.normalize({name:'Lab'});
  assert.equal(settings.box,'generic/debian12');assert.equal(settings.provider,'virtualbox');assert.equal(settings.ssh_user,'vboxuser');
});

test('provider plugins follow platform and CPU architecture',()=>{
  const linux=plugins.providers('linux','x64').map(item=>item.provider);
  assert.deepEqual(linux,['virtualbox','libvirt','qemu']);
  const mac=plugins.providers('darwin','arm64');
  assert.ok(!mac.find(item=>item.provider==='virtualbox').architecture_supported);
  assert.ok(mac.find(item=>item.provider==='qemu'));
  assert.deepEqual(plugins.providers('win32','x64').map(item=>item.provider),['virtualbox','hyperv']);
  assert.throws(()=>plugins.require_supported('hyperv','linux','x64'),/unsupported on linux/);
  assert.throws(()=>plugins.require_supported('virtualbox','darwin','arm64'),/Apple Silicon/);
  assert.equal(plugins.install_command('libvirt'),'vagrant plugin install vagrant-libvirt');
  assert.equal(plugins.install_command('virtualbox'),null);
});

test('plugin list parsing and installation only change the host when asked',async()=>{
  assert.deepEqual([...plugins.parse_list('vagrant-libvirt (0.12.2, global)\n  - Version Constraint: > 0\n')],[['vagrant-libvirt','0.12.2']]);
  assert.equal(plugins.parse_list('No plugins installed.').size,0);
  const seen=[];
  let installed=false;
  const run=async args=>{
    seen.push(args.join(' '));
    if(args.join(' ')==='plugin list')return installed?'vagrant-libvirt (0.12.2, global)\n':'';
    if(args.join(' ')==='plugin install vagrant-libvirt'){installed=true;return 'installed\n';}
    return '';
  };
  const dry=await plugins.ensure('libvirt',{run,install:false});
  assert.equal(dry.installed,false);assert.equal(dry.command,'vagrant plugin install vagrant-libvirt');
  assert.ok(!seen.includes('plugin install vagrant-libvirt'));
  const done=await plugins.ensure('libvirt',{run});
  assert.equal(done.installed,true);assert.equal(done.installed_now,true);
  assert.equal((await plugins.ensure('virtualbox',{run})).plugin,null);
});

test('global-status and ssh-config output are read into machine state and endpoints',()=>{
  const rows=parseGlobalStatus(['1620000000,ui,metadata,','1620000000,abc123,provider-name,virtualbox','1620000000,abc123,state,running','1620000000,abc123,vagrantfile-path,/home/me/.vamp/vagrant/Lab',].join('\n'));
  assert.deepEqual(rows,[{provider:'virtualbox',state:'running',directory:'/home/me/.vamp/vagrant/Lab'}]);
  const entries=parseSshConfig('Host default\n  HostName 127.0.0.1\n  User vboxuser\n  Port 2200\n  IdentityFile /home/me/.vagrant.d/insecure_private_key\n');
  assert.deepEqual(entries[0],{Host:'default',HostName:'127.0.0.1',User:'vboxuser',Port:'2200',IdentityFile:'/home/me/.vagrant.d/insecure_private_key'});
  assert.deepEqual(parseForwards('1620000000,default,forwarded_port,22,2222\n1620000000,default,forwarded_port,8421,8421\n'),{'22':2222,'8421':8421});
});

test('list reports managed projects and the state Vagrant knows about',async()=>{
  const {root,env}=sandbox();
  try{
    project(root,'Lab',{id});
    project(root,'Idle',{id:'22345678-1234-1234-1234-123456789abc'});
    const {execute}=runner(args=>args[0]==='global-status'?`1620000000,abc123,state,running\n1620000000,abc123,vagrantfile-path,${path.join(root,'vagrant','Lab')}\n`:'');
    const adapter=createVagrantAdapter({globalStorageUri:{fsPath:root}},{runtime:root,env,execute,platform:'linux',architecture:'x64'});
    const rows=await adapter.list();
    const byName=Object.fromEntries(rows.map(row=>[row.name,row]));
    assert.equal(byName.Lab.state,'running');assert.equal(byName.Lab.managed,true);assert.equal(byName.Lab.guestOS,'debian');
    assert.equal(byName.Idle.state,'not_created');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('create writes a Vagrantfile and an ownership record, then validates it',async()=>{
  const {root,env}=sandbox();
  try{
    const {calls,execute}=runner(args=>args[0]==='plugin'?'vagrant-libvirt (0.12.2, global)\n':'');
    const adapter=createVagrantAdapter({globalStorageUri:{fsPath:root}},{runtime:root,env,execute,platform:'linux',architecture:'x64'});
    const result=await adapter.create({name:'Lab-Web',guest_os:'debian',provider:'libvirt',memory_mb:2048,cpus:2});
    assert.equal(result.status,'created');assert.equal(result.started,false);
    assert.match(result.id,/^[a-f0-9-]{36}$/);
    const folder=path.join(root,'vagrant','Lab-Web');
    assert.match(fs.readFileSync(path.join(folder,'Vagrantfile'),'utf8'),/config\.vm\.provider "libvirt"/);
    const record=JSON.parse(fs.readFileSync(path.join(folder,'vamp-ui.json'),'utf8'));
    assert.equal(record.id,result.id);assert.equal(record.provider_plugin,'vagrant-libvirt');assert.equal(record.managed,true);
    assert.ok(calls.some(call=>call.args.join(' ')==='validate'&&call.options.cwd===folder));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('create refuses to overwrite an existing project folder',async()=>{
  const {root,env}=sandbox();
  try{
    project(root,'Lab',{id});
    const {execute}=runner(()=>'');
    const adapter=createVagrantAdapter({globalStorageUri:{fsPath:root}},{runtime:root,env,execute,platform:'linux',architecture:'x64'});
    await assert.rejects(adapter.create({name:'Lab'}),/already exists/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('start verifies the machine really reached running',async()=>{
  const {root,env}=sandbox();
  try{
    project(root,'Lab',{id});
    let state='poweroff';
    const {calls,execute}=runner(args=>{
      if(args[0]==='up'){state='running';return '';}
      if(args[0]==='status')return `1,default,state,${state}\n`;
      return '';
    });
    const adapter=createVagrantAdapter({globalStorageUri:{fsPath:root}},{runtime:root,env,execute,platform:'linux',architecture:'x64'});
    assert.deepEqual(await adapter.start(id),{status:'running',startup_verified:true,provider:'virtualbox'});
    const up=calls.find(call=>call.args[0]==='up');
    assert.deepEqual(up.args,['up','--provider','virtualbox']);assert.equal(up.options.cwd,path.join(root,'vagrant','Lab'));

    state='poweroff';
    const stuck=createVagrantAdapter({globalStorageUri:{fsPath:root}},{runtime:root,env,execute:runner(args=>args[0]==='status'?'1,default,state,poweroff\n':'').execute,platform:'linux',architecture:'x64'});
    await assert.rejects(stuck.start(id),/did not reach Running/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('remove destroys only a stopped VAMP project and refuses anything else',async()=>{
  const {root,env}=sandbox();
  try{
    const {folder}=project(root,'Lab',{id});
    const running=createVagrantAdapter({globalStorageUri:{fsPath:root}},{runtime:root,env,execute:runner(args=>args[0]==='status'?'1,default,state,running\n':'').execute,platform:'linux',architecture:'x64'});
    await assert.rejects(running.remove(id),/Shut down the VM/);
    assert.ok(fs.existsSync(folder));
    const stopped=createVagrantAdapter({globalStorageUri:{fsPath:root}},{runtime:root,env,execute:runner(args=>args[0]==='status'?'1,default,state,poweroff\n':'').execute,platform:'linux',architecture:'x64'});
    await assert.rejects(stopped.remove('32345678-1234-1234-1234-123456789abc'),/created by VAMP/);
    assert.deepEqual(await stopped.remove(id),{status:'removed'});
    assert.ok(!fs.existsSync(folder));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('endpoint reports the SSH port Vagrant answers on',async()=>{
  const {root,env}=sandbox();
  try{
    project(root,'Lab',{id});
    const {execute}=runner(args=>{
      if(args[0]==='ssh-config')return 'Host default\n  HostName 127.0.0.1\n  User vboxuser\n  Port 2201\n';
      if(args[0]==='port')return '1,default,forwarded_port,8421,18421\n';
      return '';
    });
    const adapter=createVagrantAdapter({globalStorageUri:{fsPath:root}},{runtime:root,env,execute,platform:'linux',architecture:'x64'});
    const endpoint=await adapter.endpoint(id);
    assert.equal(endpoint.host,'127.0.0.1');assert.equal(endpoint.port,2201);assert.equal(endpoint.user,'vboxuser');
    assert.equal(endpoint.ports['8421'],18421);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('check names the installed plugins and the missing ones',async()=>{
  const {root,env}=sandbox();
  try{
    const {execute}=runner(args=>{
      if(args[0]==='--version')return 'Vagrant 2.4.1\n';
      if(args[0]==='plugin')return 'vagrant-libvirt (0.12.2, global)\n';
      return '';
    });
    const adapter=createVagrantAdapter({globalStorageUri:{fsPath:root}},{runtime:root,env,execute,platform:'linux',architecture:'x64'});
    const report=await adapter.check();
    assert.match(report,/Vagrant 2\.4\.1/);assert.match(report,/providers: virtualbox, libvirt/);assert.match(report,/missing plugins: vagrant-qemu/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('missing Vagrant is reported as an install problem, not a crash',async()=>{
  const {root,env}=sandbox();
  try{
    const execute=async()=>{const error=new Error('spawn vagrant ENOENT');error.code='ENOENT';throw error;};
    const adapter=createVagrantAdapter({globalStorageUri:{fsPath:root}},{runtime:root,env,execute,platform:'linux',architecture:'x64'});
    await assert.rejects(adapter.check(),/Vagrant is not installed/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('host backends register vagrant, route create to its adapter, and keep the packer path',async()=>{
  const {root,env}=sandbox();
  try{
    const {calls,execute}=runner(()=>'');
    const backends=hostBackends({globalStorageUri:{fsPath:root}},{runtime:root,env,platform:'linux',architecture:'x64',execute,packerCall:async()=>{throw new Error('packer must not run for vagrant');}});
    assert.equal(backends.capabilities().vagrant.hostSupported,true);
    const created=await backends.create('vagrant',{name:'Lab',guest_os:'debian'});
    assert.equal(created.backend,'vagrant');
    assert.ok(calls.some(call=>call.args[0]==='validate'));
    const windows=hostBackends({globalStorageUri:{fsPath:root}},{runtime:root,env,platform:'win32',architecture:'x64',execute});
    assert.equal(windows.capabilities().vagrant.hostSupported,true);
    assert.equal(String(windows.capabilities().vagrant.implemented),'true');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
