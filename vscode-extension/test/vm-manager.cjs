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
  const child={stdin:{on(){},end(value){calls.push(['provision',JSON.parse(value)]);}}};
  const execFile=(exe,args,options,callback)=>{setImmediate(()=>callback(null,JSON.stringify({status:'installation_started',installation_mode:'unattended'}),''));return child;};
  execFile[promisify.custom]=async(exe,args)=>{
    calls.push(args);
    if(args[0]==='-c') {if(answers.missingPython)throw Error('missing dependency');return {stdout:''};}
    if(args[0]==='--version')return {stdout:'7.2.6\n'};
    if(args[0]==='list')return {stdout:`"Lab <desktop>" {${id}}\n`};
    if(args[0]==='showvminfo')return {stdout:`VMState="${answers.state}"\nmemory=4096\ncpus=2\n`};
    return {stdout:''};
  };
  const vscode={workspace:{getConfiguration(){return {get(){}};}},ViewColumn:{Active:1},Uri:{parse:x=>x,joinPath:(...args)=>args.join('/')},env:{openExternal:async()=>{}},
    commands:{registerCommand(name,fn){commands.set(name,fn);return {dispose(){}};},executeCommand:async()=>{}},
    window:{createWebviewPanel:()=>panel,showOpenDialog:async()=>[{fsPath:'/tmp/installer.iso'}],showInformationMessage:async(...args)=>{notices.push(args);return answers.confirm;},showWarningMessage:async(...args)=>{warnings.push(args);return answers.warning;}}};
  const module={exports:{}};
  const req=name=>name==='vscode'?vscode:name==='node:child_process'?{execFile}:name==='node:os'||name==='os'?{...require('node:os'),totalmem:()=>16*1024**3}:name==='./host-backends'?{hostBackends:(context,args)=>require(path.join(root,'host-backends')).hostBackends(context,{...args,execute:execFile[promisify.custom]})}:require(name);
  vm.runInNewContext(`(function(require,module,exports){${fs.readFileSync(path.join(root,'vm-manager.js'),'utf8')}\n})`,{setInterval,clearInterval,process,console})(req,module,module.exports);
  const api=module.exports;
  api.registerManager(context,{pythonPath:()=>__filename,runtime:'/runtime',output:{appendLine(){},show(){}},setupPython:async()=>{calls.push(['setup']);return answers.setup;}});
  return {api,calls,messages,warnings,answers,notices,open:()=>commands.get('vamp.openManager')(),send:m=>receive(m),close:()=>panel.dispose()};
}
test('inventory parser handles quotes and markup without accepting malformed IDs',()=>{
  const h=harness();const rows=h.api.parseInventory(`"My \"Lab\" <img>" {${id}}\n"bad" {bad}`);
  assert.equal(rows.length,1);assert.equal(rows[0].name,'My "Lab" <img>');
  const html=h.api.managerHTML();assert.match(html,/default-src 'none'/);assert.ok(!html.includes('innerHTML'));h.close();
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
    const request=h.calls.find(c=>c[0]==='provision')[1];assert.equal(request.iso_path,'/tmp/installer.iso');assert.equal(request.name,'My-Desktop');assert.equal(request.disk_mb,65536);assert.ok(request.cpus<=2);assert.equal(request.allow_manual_install,true);assert.ok(h.calls.some(c=>c[0]==='setup'));
    assert.match(h.messages.findLast(m=>m.type==='progress').message,/not yet mean the guest is ready/);
  }finally{h.close();}
});
test('failed preparation never launches provisioning and returns controls to idle',async()=>{
  const h=harness();try {
    await h.open();await h.send({type:'iso'});h.answers.missingPython=true;h.answers.setup=false;
    await h.send({type:'create',os:'debian',name:'My-Desktop'});
    assert.ok(!h.calls.some(c=>c[0]==='provision'));assert.match(h.messages.findLast(m=>m.type==='error').message,/Python setup failed/);assert.equal(h.messages.at(-1).busy,false);
  }finally{h.close();}
});
