'use strict';
// Isolated new-module tests: no existing project runtime or Podman process loads.
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {containersHTML,withContainersSidebar,registerContainers}=require('../src/containers-panel.cjs');
const ID='a'.repeat(64);
function harness(){
  const commands=new Map(),calls=[],messages=[],prompts=[];
  let receive,dispose,factoryCalls=0,current='exited',confirmation='Start Container',failure=null;
  const rows=()=>[{id:ID,name:'demo',image:'example/image',state:current}];
  const backend={connections:async()=>{calls.push(['connections']);if(failure)throw Error(failure);return [{name:'debian-vm',uri:'must-not-display-secret'}];},status:async name=>{calls.push(['status',name]);return {status:'ready',rootless:true};},list:async name=>{calls.push(['list',name]);return {connection:name,binding:'opaque-binding',containers:rows()};},start:async(...args)=>{calls.push(['start',...args]);current='running';},stop:async(...args)=>{calls.push(['stop',...args]);current='exited';},logs:async(...args)=>{calls.push(['logs',...args]);return {text:'<script>not executable</script>\u0000\nlog'};}};
  const panel={webview:{html:'',postMessage:m=>messages.push(m),onDidReceiveMessage:fn=>{receive=fn;}},reveal(){},onDidDispose:fn=>{dispose=fn;},dispose:()=>dispose?.()};
  const context={subscriptions:[],extensionUri:{path:'/mock/extension'}};
  const vscode={Uri:{joinPath:(uri,name)=>({path:uri.path+'/'+name})},commands:{executeCommand:async(...args)=>{calls.push(['command',...args]);},registerCommand:(name,fn)=>{commands.set(name,fn);return {}; }},ViewColumn:{Active:1},window:{createWebviewPanel:()=>panel,showWarningMessage:async(...args)=>{prompts.push(args);return typeof confirmation==='function'?confirmation():confirmation;}}};
  registerContainers(context,{vscode,createBackend:()=>{factoryCalls++;return backend;},output:{appendLine(){}}});
  return {calls,messages,prompts,panel,backend,commands,open:()=>commands.get('vamp.openContainers')(),send:m=>receive(m),close:()=>panel.dispose(),factoryCalls:()=>factoryCalls,setConfirmation:x=>{confirmation=x;},setFailure:x=>{failure=x;},state:()=>messages.findLast(m=>m.type==='state')};
}
async function select(h){h.open();await h.send({action:'refresh'});await h.send({action:'select',connection:'debian-vm'});await h.send({action:'list',connection:'debian-vm'});}
test('new panel parses, stays theme native and presents unavailable choices honestly',()=>{
 const html=containersHTML();assert.match(html,/Content-Security-Policy/);assert.match(html,/var\(--vscode-editor-background\)/);assert.match(html,/Existing Debian VM/);assert.match(html,/Recommended with VirtualBox/);assert.match(html,/Podman Desktop is optional/);assert.match(html,/grid-template-columns:1fr/);assert.ok(!html.includes('repeat(3'));assert.match(html,/A Podman engine is required. Podman Desktop is optional.<\/p><div class="choices">/);assert.match(html,/<h3>WSL 2<\/h3>/);assert.match(html,/data-action="wsl-guide"/);assert.ok(!html.includes('<button disabled>Not available yet'));assert.ok(!html.includes('innerHTML'));for(const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
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
