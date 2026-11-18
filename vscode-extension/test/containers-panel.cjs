'use strict';
// Isolated new-module tests: no existing project runtime or Podman process loads.
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {containersHTML,withContainersSidebar,registerContainers}=require('../src/containers-panel.cjs');
const ID='a'.repeat(64);
function harness(extra={}){
  const commands=new Map(),calls=[],messages=[],prompts=[];
  let receive,dispose,factoryCalls=0,current='exited',confirmation='Start Container',failure=null;
  const rows=()=>[{id:ID,name:'demo',image:'example/image',state:current}];
  const backend={connections:async()=>{calls.push(['connections']);if(failure)throw Error(failure);return [{name:'debian-vm',uri:'must-not-display-secret'}];},status:async name=>{calls.push(['status',name]);return {status:'ready',rootless:true};},list:async name=>{calls.push(['list',name]);return {connection:name,binding:'opaque-binding',containers:rows()};},start:async(...args)=>{calls.push(['start',...args]);current='running';},stop:async(...args)=>{calls.push(['stop',...args]);current='exited';},logs:async(...args)=>{calls.push(['logs',...args]);return {text:'<script>not executable</script>\u0000\nlog'};}};
  const panel={webview:{html:'',postMessage:m=>messages.push(m),onDidReceiveMessage:fn=>{receive=fn;}},reveal(){},onDidDispose:fn=>{dispose=fn;},dispose:()=>dispose?.()};
  const context={subscriptions:[],extensionUri:{path:'/mock/extension'}};
  const vscode={Uri:{joinPath:(uri,name)=>({path:uri.path+'/'+name})},commands:{executeCommand:async(...args)=>{calls.push(['command',...args]);},registerCommand:(name,fn)=>{commands.set(name,fn);return {}; }},ViewColumn:{Active:1},window:{createWebviewPanel:()=>panel,showWarningMessage:async(...args)=>{prompts.push(args);return typeof confirmation==='function'?confirmation():confirmation;}}};
  registerContainers(context,{...extra,vscode,openDesktop:options=>calls.push(['openDesktop',options]),openCapture:result=>calls.push(['openCapture',result]),createBackend:()=>{factoryCalls++;return backend;},output:{appendLine(){}}});
  return {calls,messages,prompts,panel,backend,commands,open:()=>commands.get('vamp.openContainers')(),send:m=>receive(m),close:()=>panel.dispose(),factoryCalls:()=>factoryCalls,setConfirmation:x=>{confirmation=x;},setFailure:x=>{failure=x;},state:()=>messages.findLast(m=>m.type==='state')};
}
async function select(h){h.open();await h.send({action:'refresh'});await h.send({action:'select',connection:'debian-vm'});await h.send({action:'list',connection:'debian-vm'});}
test('new panel parses, stays theme native and presents unavailable choices honestly',()=>{
 const html=containersHTML();assert.match(html,/Content-Security-Policy/);assert.match(html,/var\(--vscode-editor-background\)/);assert.match(html,/Existing Debian VM/);assert.match(html,/Set up a Podman connection/);assert.match(html,/Podman Desktop is optional/);assert.match(html,/grid-template-columns:1fr/);assert.ok(!html.includes('repeat(3'));assert.match(html,/A Podman engine is required. Podman Desktop is optional.<\/p><div class="choices">/);assert.match(html,/<h3>WSL 2<\/h3>/);assert.match(html,/data-action="wsl-guide"/);assert.ok(!html.includes('<button disabled>Not available yet'));assert.ok(!html.includes('innerHTML'));for(const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
 const marker='<button class="secondary" data-type="manager">Open VM Manager</button>';assert.ok(withContainersSidebar(marker).startsWith(marker+'<button class="secondary" data-type="containers">Open Containers</button>'));
});
test('registration, opening and ready message never construct backend or run host commands',async()=>{
 const h=harness();assert.equal(h.factoryCalls(),0);h.open();await h.send({action:'ready'});assert.equal(h.factoryCalls(),0);assert.deepEqual(h.calls,[]);h.close();
});
test('connections and status are explicit; URI/secrets are never sent to webview',async()=>{
 const h=harness();try{h.open();await h.send({action:'refresh'});assert.deepEqual(h.state().connections,[{name:'debian-vm'}]);await h.send({action:'select',connection:'debian-vm'});await h.send({action:'test',connection:'debian-vm'});assert.match(h.state().message,/succeeded/);assert.ok(!JSON.stringify(h.messages).includes('must-not-display-secret'));}finally{h.close();}
});
test('unknown actions, foreign connection and arbitrary IDs never dispatch operations',async()=>{
 const h=harness();try{await select(h);const count=h.calls.length;await h.send({action:'exec',command:'whoami',connection:'debian-vm'});await h.send({action:'start',connection:'other',id:ID});await h.send({action:'start',connection:'debian-vm',id:'--all'});await h.send({action:'select',connection:'other'});assert.equal(h.calls.length,count);assert.equal(h.state().connection,'debian-vm');}finally{h.close();}
});
test('start and stop resolve inventory, confirm exact target and verify resulting state',async()=>{
 const h=harness();try{await select(h);await h.send({action:'start',connection:'debian-vm',id:ID});assert.deepEqual(h.calls.find(c=>c[0]==='start'),['start','debian-vm',ID,'opaque-binding']);assert.match(h.prompts[0][1].detail,new RegExp(ID));assert.match(h.state().message,/Start verified/);h.setConfirmation('Stop Container');await h.send({action:'stop',connection:'debian-vm',id:ID});assert.match(h.state().message,/Stop verified/);assert.equal(h.state().busy,false);}finally{h.close();}
});
test('cancel and close during confirmation never mutate containers',async()=>{
 const h=harness();try{await select(h);h.setConfirmation(undefined);await h.send({action:'start',connection:'debian-vm',id:ID});assert.ok(!h.calls.some(c=>c[0]==='start'));h.setConfirmation(()=>{h.close();return 'Start Container';});await h.send({action:'start',connection:'debian-vm',id:ID});assert.ok(!h.calls.some(c=>c[0]==='start'));}finally{h.close();}
});
test('logs are explicit bounded text and connection change clears displayed logs',async()=>{
 const h=harness();try{await select(h);await h.send({action:'logs',connection:'debian-vm',id:ID});const logs=h.messages.find(m=>m.type==='logs');assert.equal(logs.text,'<script>not executable</script>\nlog');await h.send({action:'select',connection:''});assert.equal(h.state().clearLogs,true);assert.equal(h.state().containers.length,0);}finally{h.close();}
});
test('missing dependency failure releases controls and preserves visible recovery error',async()=>{
 const h=harness();try{h.open();h.setFailure('Podman executable not found. Install Podman CLI first.');await h.send({action:'refresh'});assert.equal(h.state().error,true);assert.equal(h.state().busy,false);assert.match(h.state().message,/Install Podman CLI/);}finally{h.close();}
});

test('WSL guide previews only the fixed local Markdown without constructing a backend',async()=>{
 const h=harness();try{h.open();await h.send({action:'wsl-guide',path:'https://untrusted.example',command:'shell'});assert.equal(h.factoryCalls(),0);assert.deepEqual(h.calls,[['command','markdown.showPreview',{path:'/mock/extension/CONTAINERS_WSL.md'}]]);}finally{h.close();}
});

test('installed Podman detection is explicit and never connects or starts machines',async()=>{
 const h=harness();try{h.backend.detectLocal=async()=>{h.calls.push(['detectLocal']);return {platform:'win32',cli:'available',version:'podman version 5',machineInventory:'known',machines:[{name:'demo',provider:'wsl',running:false}]};};h.open();await h.send({action:'ready'});assert.equal(h.factoryCalls(),0);await h.send({action:'detect-local',command:'start'});assert.deepEqual(h.calls,[['detectLocal']]);assert.match(h.state().message,/demo \(stopped\)/);assert.match(h.state().message,/readiness is not verified/);assert.equal(h.state().connection,'');}finally{h.close();}
});
test('detection distinguishes unavailable CLI and unknown machine inventory without claiming absence',async()=>{
 const h=harness();try{h.open();h.backend.detectLocal=async()=>({platform:'win32',cli:'unavailable-or-error'});await h.send({action:'detect-local'});assert.match(h.state().message,/not detected or could not be checked/);h.backend.detectLocal=async()=>({platform:'win32',cli:'available',machineInventory:'unknown'});await h.send({action:'detect-local'});assert.match(h.state().message,/inventory could not be checked/);assert.equal(h.state().busy,false);}finally{h.close();}
});

test('fresh opaque binding is pinned across modal and never exposed to webview',async()=>{
 const h=harness();try{await select(h);let binding='before-modal';h.backend.list=async name=>({connection:name,binding,containers:[{id:ID,name:'demo',state:'exited'}]});h.setConfirmation(()=>{binding='changed-during-modal';return 'Start Container';});h.backend.start=async(name,id,pinned)=>{h.calls.push(['bound-start',name,id,pinned]);if(pinned!==binding)throw Error('Connection configuration changed. Refresh containers.');};await h.send({action:'start',connection:'debian-vm',id:ID});assert.deepEqual(h.calls.find(c=>c[0]==='bound-start'),['bound-start','debian-vm',ID,'before-modal']);assert.equal(h.state().error,true);assert.match(h.state().message,/configuration changed/);assert.ok(!JSON.stringify(h.messages).includes('before-modal'));}finally{h.close();}
});
test('inventory without binding fails closed before confirmation',async()=>{
 const h=harness();try{await select(h);h.backend.list=async()=>[{id:ID,state:'exited'}];await h.send({action:'start',connection:'debian-vm',id:ID});assert.equal(h.prompts.length,0);assert.ok(!h.calls.some(c=>c[0]==='start'));assert.equal(h.state().error,true);}finally{h.close();}
});

test('Linux local target discovery is explicit, labeled, never implicitly selected',async()=>{
 const h=harness();try{h.backend.connections=async()=>{h.calls.push(['connections']);return [{name:'local-linux',transport:'local',rootlessCandidate:true}];};h.open();await h.send({action:'ready'});assert.equal(h.factoryCalls(),0);await h.send({action:'refresh'});assert.deepEqual(h.state().connections,[{name:'local-linux',label:'Linux local (rootless)'}]);assert.equal(h.state().connection,'');assert.deepEqual(h.calls,[['connections']]);await h.send({action:'select',connection:'local-linux'});assert.equal(h.state().connection,'local-linux');assert.equal(h.calls.length,1);}finally{h.close();}
});
test('desktop and workspace remain explicitly unverified with no launch or mount action',async()=>{
 const html=containersHTML();assert.match(html,/VeraCrypt workspace \(native Linux\)/);assert.match(html,/grant a new desktop write access to \/workspace/);assert.ok(!html.includes('data-action="open-desktop"'));const h=harness();try{h.open();await h.send({action:'open-desktop',verified:true});await h.send({action:'mount',verified:true});assert.equal(h.factoryCalls(),0);}finally{h.close();}
});

test('capture resolves fresh target and binding, opens only matching response',async()=>{
 const h=harness();try{await select(h);h.setConfirmation('Start Container');await h.send({action:'start',connection:'debian-vm',id:ID});h.backend.capture=async(connection,id,binding)=>({connection,id,binding,png:Buffer.alloc(0)});await h.send({action:'capture',connection:'debian-vm',id:ID});assert.equal(h.calls.filter(c=>c[0]==='openCapture').length,1);h.backend.capture=async()=>({connection:'other',id:ID,binding:'opaque-binding'});await h.send({action:'capture',connection:'debian-vm',id:ID});assert.equal(h.calls.filter(c=>c[0]==='openCapture').length,1);assert.equal(h.state().error,true);}finally{h.close();}
});
test('capture viewer uses bounded PNG only, no scripts, network or persistent files',()=>{
 const {captureHTML,showCapture}=require('../src/container-capture.cjs');const png=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.write('IHDR',12);png.writeUInt32BE(1920,16);png.writeUInt32BE(1080,20);const html=captureHTML({png});assert.match(html,/default-src 'none'; img-src data:/);assert.ok(!html.includes('<script'));assert.ok(!html.includes('https:'));assert.throws(()=>captureHTML({png:Buffer.from('<script>')}));const wrong=Buffer.from(png);wrong.writeUInt32BE(1,16);assert.throws(()=>captureHTML({png:wrong}));let options;showCapture({window:{createWebviewPanel:(a,b,c,o)=>{options=o;return {webview:{}};}},ViewColumn:{Active:1}},{png});assert.equal(options.enableScripts,false);assert.deepEqual(options.localResourceRoots,[]);
});

test('Open Desktop requires trusted image precheck and pins stream target',async()=>{
 const h=harness();try{await select(h);await h.send({action:'start',connection:'debian-vm',id:ID});h.backend.screenTarget=async(...args)=>{h.calls.push(['screenTarget',...args]);};h.backend.openScreenStream=async(...args)=>args;await h.send({action:'desktop',connection:'debian-vm',id:ID});const opened=h.calls.find(c=>c[0]==='openDesktop');assert.ok(opened);assert.deepEqual(h.calls.find(c=>c[0]==='screenTarget'),['screenTarget','debian-vm',ID,'opaque-binding']);assert.deepEqual(await opened[1].openScreenStream(),['debian-vm',ID,'opaque-binding']);h.backend.screenTarget=async()=>{throw Error('Untrusted image');};await h.send({action:'desktop',connection:'debian-vm',id:ID});assert.equal(h.calls.filter(c=>c[0]==='openDesktop').length,1);}finally{h.close();}
});

async function localWorkspace(h){
 h.backend.connections=async()=>[{name:'local-linux',transport:'local'}];
 h.backend.workspaceStatus=async(...args)=>{h.calls.push(['workspaceStatus',...args]);return {status:'ready_to_attach',approval_id:'b'.repeat(64),path:'NEVER_SHOW_PATH'};};
 h.backend.workspaceAttach=async(...args)=>{h.calls.push(['workspaceAttach',...args]);return {status:'attached',id:ID,destination:'/workspace'};};
 h.open();await h.send({action:'refresh'});await h.send({action:'select',connection:'local-linux'});
}
test('workspace status and attachment pin binding, ignore WebView paths and require native approval',async()=>{
 const h=harness();try{await localWorkspace(h);await h.send({action:'workspace-status',connection:'local-linux',path:'/untrusted'});assert.match(h.state().message,/ready to attach/);assert.ok(!h.calls.some(c=>c[0]==='workspaceAttach'));h.setConfirmation('Create Workspace Desktop');await h.send({action:'workspace-attach',connection:'local-linux',path:'/untrusted',config:'/untrusted'});assert.deepEqual(h.calls.find(c=>c[0]==='workspaceAttach'),['workspaceAttach','local-linux','opaque-binding','b'.repeat(64)]);assert.equal(h.prompts[0][1].modal,true);assert.match(h.prompts[0][1].detail,/network disabled/);assert.match(h.prompts[0][1].detail,/no existing container/);assert.match(h.state().message,/created/);assert.ok(!JSON.stringify(h.messages).includes('NEVER_SHOW_PATH'));assert.ok(!JSON.stringify(h.messages).includes('opaque-binding'));}finally{h.close();}
});
test('workspace remote targets, spoofed local names and unavailable status never attach',async()=>{
 const h=harness();try{await select(h);await h.send({action:'workspace-attach',connection:'debian-vm'});assert.equal(h.prompts.length,0);h.backend.connections=async()=>[{name:'local-linux',transport:'ssh'}];await h.send({action:'refresh'});await h.send({action:'select',connection:'local-linux'});await h.send({action:'workspace-attach',connection:'local-linux'});assert.equal(h.prompts.length,0);await localWorkspace(h);h.backend.workspaceStatus=async()=>({status:'unavailable'});await h.send({action:'workspace-attach',connection:'local-linux'});assert.equal(h.prompts.length,0);assert.ok(!h.calls.some(c=>c[0]==='workspaceAttach'));}finally{h.close();}
});
test('workspace cancellation, closing modal and stale binding fail closed',async()=>{
 const h=harness();try{await localWorkspace(h);h.setConfirmation(undefined);await h.send({action:'workspace-attach',connection:'local-linux'});assert.ok(!h.calls.some(c=>c[0]==='workspaceAttach'));h.setConfirmation('Create Workspace Desktop');h.backend.workspaceAttach=async(name,binding)=>{assert.equal(binding,'opaque-binding');throw Error('/secret/path connection changed');};await h.send({action:'workspace-attach',connection:'local-linux'});assert.equal(h.state().error,true);assert.match(h.state().message,/partial operation/);assert.ok(!JSON.stringify(h.messages).includes('/secret/path'));h.setConfirmation(()=>{h.close();return 'Create Workspace Desktop';});h.backend.workspaceAttach=async()=>assert.fail('must not attach after close');await h.send({action:'workspace-attach',connection:'local-linux'});}finally{h.close();}
});
test('workspace setting is machine-only and same trusted configuration feeds MCP and UI',()=>{
 const fs=require('node:fs'),path=require('node:path');const extension=fs.readFileSync(path.join(__dirname,'../extension.js'),'utf8');const pkg=require('../package.json');assert.equal(pkg.contributes.configuration.properties['vamp.podman.workspaceConfigPath'].scope,'machine');assert.match(extension,/inspect\('podman.workspaceConfigPath'\)\?\.globalValue\|\|process.env.VAMP_WORKSPACE_CONFIG/);assert.match(extension,/workspaceConfigPath:workspaceConfigPath\(\)/);assert.match(extension,/VAMP_WORKSPACE_CONFIG:workspaceConfigPath\(\)/);assert.match(extension,/workspaceAttach:\(name,binding,approvalId\)=>adapter.workspaceAttach\(name,binding,approvalId\)/);
});

test('workspace approval must exist and remain pinned across modal changes',async()=>{
 const h=harness();try{await localWorkspace(h);for(const approval_id of [undefined,'invalid','B'.repeat(64)]){h.backend.workspaceStatus=async()=>({status:'ready_to_attach',approval_id});await h.send({action:'workspace-attach',connection:'local-linux'});assert.equal(h.prompts.length,0);assert.equal(h.state().error,true);}const report={status:'ready_to_attach',approval_id:'c'.repeat(64)};h.backend.workspaceStatus=async()=>report;h.setConfirmation(()=>{report.approval_id='d'.repeat(64);return 'Create Workspace Desktop';});h.backend.workspaceAttach=async(name,binding,approval)=>{assert.equal(approval,'c'.repeat(64));throw Error('Approval no longer matches configured scope');};await h.send({action:'workspace-attach',connection:'local-linux'});assert.equal(h.state().error,true);assert.ok(!JSON.stringify(h.messages).includes('c'.repeat(64)));assert.match(h.state().message,/could not be verified/);}finally{h.close();}
});

test('Debian build action is explicit and only reports exact queue/status evidence',async()=>{
 const seen=[];let stage='vm_started';const h=harness({createDebianHost:async()=>{seen.push('create');return {status:'queued',job_id:'job-one'};},debianHostStatus:async id=>{seen.push(id);return {status:stage};}});try{h.open();await h.send({action:'ready'});assert.deepEqual(seen,[]);await h.send({action:'create-debian',provider:'evil',isoPath:'/untrusted'});assert.deepEqual(seen,['create']);assert.match(h.state().message,/queued/);assert.equal(h.factoryCalls(),0);await h.send({action:'debian-status',job_id:'foreign'});assert.equal(seen[1],'job-one');assert.match(h.state().message,/SSH and Podman connection are not yet verified/);stage='box_ready';await h.send({action:'debian-status'});assert.match(h.state().message,/box ready/);}finally{h.close();}
});
