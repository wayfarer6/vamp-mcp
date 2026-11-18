const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {promisify}=require('node:util');
const root=path.resolve(__dirname,'..');
const id='12345678-1234-1234-1234-123456789abc';
function harness() {
  const commands=new Map(),messages=[],calls=[],warnings=[],notices=[];
  let receive,dispose;
  const context={subscriptions:[],extensionUri:'/extension',globalStorageUri:{fsPath:'/tmp/vamp-manager-test'},globalState:{get:()=>undefined,update:async()=>{}}};
  const panel={visible:false,reveal(){},webview:{cspSource:'test:',asWebviewUri:x=>x,postMessage(m){messages.push(m);},onDidReceiveMessage(fn){receive=fn;}},onDidDispose(fn){dispose=fn;},onDidChangeViewState(){},dispose(){dispose?.();}};
  const answers={warning:undefined,confirm:'Create and Start',state:'poweroff',setup:true,missingPython:false};
  const child={stdin:{on(){},end(value){if(value)calls.push(['provision',JSON.parse(value)]);}}};
  const execFile=(exe,args,options,callback)=>{
    if(String(args?.[0]||'').endsWith('runner.py')){setImmediate(()=>callback(null,JSON.stringify(args[1]==='images'?{images:answers.goldens||[]}:args[1]==='delete-image'?{status:'deleted',path:'/golden/fixture'}:{status:'installation_started',engine:'packer',installation_mode:'unattended'}),''));return {stdin:{on(){},end(value){if(value)calls.push(['provision',JSON.parse(value)]);}}};}
    if(String(args?.[0]||'').endsWith('script_server.py')){setImmediate(()=>callback(null,JSON.stringify({status:'running',port:8421,guest_urls:{virtualbox_nat:'http://10.0.2.2:8421'}}),''));return {stdin:{end(){}}};}
    setImmediate(()=>callback(null,JSON.stringify({status:'installation_started',installation_mode:'unattended'}),''));return child;
  };
  execFile[promisify.custom]=async(exe,args)=>{
    calls.push(args);
    if(exe==='virsh')return {stdout:answers.activeKvm&&args.includes(answers.activeKvm)?'active-kvm':''};
    if(args[0]==='-c') {if(answers.missingPython)throw Error('missing dependency');return {stdout:''};}
    if(args[0]==='startvm'&&!answers.startFails)answers.state='running';
    if(args[0]==='--version')return {stdout:'7.2.6\n'};
    if(args[0]==='list')return {stdout:`"Lab <desktop>" {${id}}\n`};
    if(args[0]==='showvminfo')return {stdout:`VMState="${answers.state}"\nmemory=4096\ncpus=2\n`};
    return {stdout:''};
  };
  const vscode={workspace:{getConfiguration(){return {get(){}};}},ViewColumn:{Active:1},Uri:{parse:x=>x,joinPath:(...args)=>args.join('/')},env:{openExternal:async()=>{}},ProgressLocation:{Notification:15},
    commands:{registerCommand(name,fn){commands.set(name,fn);return {dispose(){}};},executeCommand:async(...args)=>{calls.push(['command',...args]);}},
    window:{createWebviewPanel:()=>panel,showOpenDialog:async()=>[{fsPath:'/tmp/installer.iso'}],showInformationMessage:async(...args)=>{notices.push(args);return answers.confirm;},showErrorMessage:async(...args)=>{notices.push(args);return undefined;},showWarningMessage:async(...args)=>{warnings.push(args);return answers.warning;},showQuickPick:async items=>answers.quickPick?items.find(item=>item.label===answers.quickPick):items?.[0],withProgress:async(_options,task)=>task({report(){}})}};
  const module={exports:{}};
  const req=name=>name==='vscode'?vscode:name==='node:child_process'?{execFile}:name==='./guest-bootstrap'?require(path.join(root,'guest-bootstrap')):name==='./script-server'?require(path.join(root,'script-server')):name==='node:os'||name==='os'?{...require('node:os'),totalmem:()=>16*1024**3}:name==='./host-backends'?{packer:options=>require(path.join(root,'host-backends')).packer({...options,spawn:execFile}),hostBackends:(context,args)=>require(path.join(root,'host-backends')).hostBackends(context,{...args,execute:execFile[promisify.custom]})}:require(name);
  vm.runInNewContext(`(function(require,module,exports){${fs.readFileSync(path.join(root,'vm-manager.js'),'utf8')}\n})`,{setInterval,clearInterval,process,console})(req,module,module.exports);
  const api=module.exports;
  api.registerManager(context,{pythonPath:()=>__filename,runtime:'/runtime',output:{appendLine(){},show(){}},setupPython:async()=>{calls.push(['setup']);return answers.setup;}});
  return {api,calls,messages,warnings,answers,notices,commands,open:()=>commands.get('vamp.openManager')(),send:m=>receive(m),close:()=>panel.dispose()};
}
test('inventory parser handles quotes and markup without accepting malformed IDs',()=>{
  const h=harness();const rows=h.api.parseInventory(`"My \"Lab\" <img>" {${id}}\n"bad" {bad}`);
  assert.equal(rows.length,1);assert.equal(rows[0].name,'My "Lab" <img>');
  const html=h.api.managerHTML();assert.match(html,/default-src 'none'/);assert.ok(!html.includes('innerHTML'));h.close();
});
test('resolution warning opens the dedicated guide without dispatching a VM operation',async()=>{
  const h=harness();try {
    await h.open();
    const html=h.api.managerHTML();
    assert.match(html,/Before automation: set the guest display to 1920×1080 at 100% scaling/);
    assert.match(html,/data-action="resolutionGuide"/);
    h.calls.length=0;
    await h.send({type:'resolutionGuide'});
    assert.deepEqual(h.calls,[['command','vamp.openResolutionGuide']]);
  }finally{h.close();}
});

test('low-resource hosts keep a CPU for the host and use expanding disks',()=>{
  const h=harness();const r=h.api.recommendedResources({totalmem:()=>8*1024**3,cpus:()=>[{}]});
  assert.equal(r.cpus,1);assert.equal(r.memory_mb,2048);assert.equal(r.disk_mb,65536);h.close();
});
test('inventory, UUID resolution, graceful shutdown and delete cancellation',async()=>{
  const h=harness();try {
    await h.open();assert.equal(h.messages.at(-1).vms[0].state,'poweroff');
    await h.send({type:'delete',id});assert.equal(h.warnings.length,1);assert.ok(!h.calls.some(c=>c[0]==='unregistervm'));
    h.answers.warning='Delete VM and Disks';await h.send({type:'delete',id});assert.ok(h.calls.some(c=>c[0]==='unregistervm'&&c[1]===id&&c[2]==='--delete'));
    const n=h.calls.length;await h.send({type:'start',id:'--delete'});assert.ok(!h.calls.slice(n).some(c=>c[0]==='startvm'));
    h.answers.state='running';await h.send({type:'delete',id});assert.equal(h.warnings.length,2);
    await h.send({type:'stop',id});assert.ok(h.calls.some(c=>c[0]==='controlvm'&&c[2]==='acpipowerbutton'));
  }finally{h.close();}
});
test('one-click create installs missing dependencies and ignores injected paths and resources',async()=>{
  const h=harness();try {
    await h.open();await h.send({type:'iso'});h.answers.missingPython=true;
    await h.send({type:'create',os:'debian',name:'My-Desktop',iso:'/malicious.iso',cpus:64});
    const request=h.calls.find(c=>c[0]==='provision')[1];assert.equal(request.iso_path,'/tmp/installer.iso');assert.equal(request.name,'My-Desktop');assert.equal(request.disk_mb,65536);assert.ok(request.cpus<=2);assert.equal(request.backend,'virtualbox');assert.ok(h.calls.some(c=>c[0]==='setup'));
    assert.match(h.messages.findLast(m=>m.type==='progress').message,/Packer build queued/);
  }finally{h.close();}
});
test('failed preparation never launches provisioning and returns controls to idle',async()=>{
  const h=harness();try {
    await h.open();await h.send({type:'iso'});h.answers.missingPython=true;h.answers.setup=false;
    await h.send({type:'create',os:'debian',name:'My-Desktop'});
    assert.ok(!h.calls.some(c=>c[0]==='provision'));assert.match(h.messages.findLast(m=>m.type==='error').message,/Environment setup failed/);assert.equal(h.messages.at(-1).busy,false);
  }finally{h.close();}
});

test('Start button verifies VM state instead of treating CLI success as a running guest',async()=>{
 const h=harness();try {
  await h.open();h.answers.startFails=true;
  await h.send({type:'start',id});
  assert.ok(h.messages.some(m=>m.type==='error'&&/did not reach Running/.test(m.message)));
  assert.equal(h.messages.findLast(m=>m.type==='busy').value,false);
 }finally{h.close();}
});

test('VirtualBox Start button checks system KVM guests even when manager connection is session',{skip:process.platform!=='linux'},async()=>{
 const h=harness();try{
  await h.open();h.answers.activeKvm='qemu:///system';await h.send({type:'start',id});
  assert.ok(h.messages.some(m=>m.type==='error'&&/KVM desktop is running at qemu:\/\/\/system/.test(m.message)));
  assert.ok(!h.calls.some(call=>call[0]==='startvm'));
 }finally{h.close();}
});

test('Windows bootstrap elevates PowerShell, approves UAC and configures policy before setup',async()=>{
 const {runGuestBootstrap,guestOsFromType}=require(path.join(root,'guest-bootstrap'));
 const calls=[],clicks=[];
 const result=await runGuestBootstrap({vm:id,os:'windows11',bootWaitSec:0},{
  vbox:async args=>{calls.push(args);},
  click:async(x,y)=>{clicks.push([x,y]);},
  sleep:async()=>{},
  log:()=>{},
 });
 assert.deepEqual(calls[0],['controlvm',id,'keyboardputscancode','e0','5b','13','93','e0','db']);
 const keys=calls.filter(call=>call[2]==='keyboardputscancode').map(call=>call.slice(3));
 assert.deepEqual(keys[1],['1d','2a','1c','9c','aa','9d']);
 assert.deepEqual(keys[2],['e0','4b','e0','cb','1c','9c']);
 assert.deepEqual(clicks,[]);
 assert.equal(result.status,'completed');
 assert.equal(result.verified,false);
 assert.match(result.next_action,/not proof of execution/);
 const typed=calls.filter(call=>call[2]==='keyboardputstring').map(call=>call[3]).join('');
 assert.ok(typed.includes('powershell -NoProfile -NoExit -ExecutionPolicy Unrestricted'));
 assert.ok(typed.includes('WindowsBuiltInRole]::Administrator'));
 assert.ok(typed.includes('Set-ExecutionPolicy -Scope Process -ExecutionPolicy Unrestricted -Force'));
 assert.ok(typed.indexOf('WindowsBuiltInRole') < typed.indexOf('irm http'));
 assert.ok(typed.includes('irm http://10.0.2.2:8421/setup.ps1 | iex'));
 assert.equal(guestOsFromType('Windows11_64'),'windows11');
 assert.equal(guestOsFromType('Debian12_64'),'debian');
});

test('Debian bootstrap keeps the password out of the returned plan and log',async()=>{
 const {runGuestBootstrap}=require(path.join(root,'guest-bootstrap'));
 const typed=[],logged=[];
 const result=await runGuestBootstrap({vm:id,os:'debian',bootWaitSec:0,username:'vboxuser',password:'password123!'},{
  vbox:async args=>{if(args[2]==='keyboardputstring')typed.push(args[3]);},
  click:async()=>{},
  sleep:async()=>{},
  log:message=>logged.push(message),
 });
 assert.deepEqual(typed,['vboxuser','password123!','wget -qO- http://10.0.2.2:8421/setup.sh | sh']);
 assert.ok(!JSON.stringify(result).includes('password123!'));
 assert.ok(!logged.join(' ').includes('password123!'));
});

test('bootstrap command plans a running desktop and refuses a stopped one',async()=>{
 const h=harness();try{
  await h.open();
  h.answers.state='running';
  const plan=await h.commands.get('vamp.bootstrapGuest')(id,'windows11',{dryRun:true});
  assert.equal(plan.status,'dry_run');
  assert.equal(plan.command,'powershell -ExecutionPolicy Unrestricted -Command "irm http://10.0.2.2:8421/setup.ps1 | iex"');
  assert.ok(plan.plan.some(step=>step.label==='approve UAC with Left and Enter'));
  assert.ok(!h.calls.some(call=>call[2]==='keyboardputstring'));
  h.answers.state='poweroff';
  assert.equal(await h.commands.get('vamp.bootstrapGuest')(id,'windows11',{dryRun:true}),undefined);
  assert.match(h.messages.findLast(m=>m.type==='progress').message,/Start the desktop/);
 }finally{h.close();}
});

test('VM manager offers Inject Bootstrap and refuses it on a stopped desktop',async()=>{
 const h=harness();try{
  assert.match(h.api.managerHTML(),/Inject Bootstrap/);
  await h.open();
  await h.send({type:'bootstrap',id});
  assert.ok(h.messages.some(m=>m.type==='error'&&/Start the desktop/.test(m.message)));
  assert.ok(!h.calls.some(call=>call[2]==='keyboardputstring'));
 }finally{h.close();}
});

test('unattended creation uses its post-install hook without a bootstrap prompt',async()=>{
 const h=harness();try{
  await h.open();await h.send({type:'iso'});
  await h.send({type:'create',os:'windows11',name:'Win-Desktop'});
  const offer=h.notices.findLast(args=>String(args[0]).includes('installation started'));
  assert.equal(offer,undefined);
  assert.ok(!h.calls.some(call=>call[2]==='keyboardputstring'));
 }finally{h.close();}
});

test('golden deletion resolves a known ID, shows path/size and requires explicit confirmation',async()=>{
 const h=harness();try{
  h.answers.goldens=[{id:'a'.repeat(32),name:'Fixture',path:'/golden/fixture',bytes:1024**3,status:'completed'}];
  await h.open();
  await h.send({type:'goldenDelete',id:'a'.repeat(32),path:'/untrusted/path'});
  assert.match(h.warnings.at(-1)[1].detail,/\/golden\/fixture/);
  assert.match(h.warnings.at(-1)[1].detail,/1.00 GiB/);
  assert.ok(!h.warnings.at(-1)[1].detail.includes('/untrusted/path'));
  h.answers.warning='Delete Golden Image';
  await h.send({type:'goldenDelete',id:'a'.repeat(32)});
  assert.ok(h.messages.some(m=>m.type==='progress'&&m.message.includes('Golden image deleted')));
 }finally{h.close();}
});


test('Packer network options are scoped to the matching hypervisor',()=>{
 const h=harness();
 const {buildNetworkOptions,managerHTML}=h.api;
 const options={bootstrapHost:' 172.20.1.1 ',switchName:'Default Switch'};
 assert.equal(JSON.stringify(buildNetworkOptions('hyperv',options)),JSON.stringify({bootstrap_host:'172.20.1.1',switch_name:'Default Switch'}));
 assert.equal(JSON.stringify(buildNetworkOptions('kvm',options)),JSON.stringify({bootstrap_host:'172.20.1.1'}));
 for(const backend of ['virtualbox','remote'])assert.equal(JSON.stringify(buildNetworkOptions(backend,options)),'{}');
 assert.equal(JSON.stringify(buildNetworkOptions('hyperv',{})),'{}');
 assert.throws(()=>buildNetworkOptions('kvm',{bootstrapHost:'http://10.0.2.2:8421'}),/plain IPv4/);
 assert.throws(()=>buildNetworkOptions('hyperv',{switchName:'bad\nname'}),/valid Hyper-V switch/);
 assert.match(managerHTML(),/id="packer-network" hidden/);
});
