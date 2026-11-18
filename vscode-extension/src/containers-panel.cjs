'use strict';
const crypto=require('node:crypto');
const COMMAND='vamp.openContainers';
function withContainersSidebar(html){
  const marker='<button class="secondary" data-type="manager">Open VM Manager</button>';
  return html.replace(marker,marker+'<button class="secondary" data-type="containers">Open Containers</button>');
}
function containersHTML(){
  const nonce=crypto.randomBytes(16).toString('hex');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><title>VAMP Containers</title><style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;margin:0;line-height:1.5}main{max-width:1040px;margin:auto}h1{font-size:22px;margin:0}h2{font-size:18px}p,small{color:var(--vscode-descriptionForeground)}section{margin:24px 0}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.spread{justify-content:space-between}.choices{display:grid;grid-template-columns:1fr;gap:12px}.choice{border:1px solid var(--vscode-panel-border);padding:16px;border-radius:6px}.choice.selected{border-color:var(--vscode-focusBorder)}.choice h3{margin:0 0 8px;font-size:15px}.badge{font-size:11px;border:1px solid var(--vscode-focusBorder);padding:2px 7px;border-radius:12px}.choice.unavailable{opacity:.65}button,select{font:inherit;padding:8px 12px;border:1px solid var(--vscode-button-border,transparent);border-radius:4px}button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button:disabled{opacity:.5;cursor:default}select{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border-color:var(--vscode-dropdown-border);min-width:240px;max-width:100%}button:focus-visible,select:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}.container{border-top:1px solid var(--vscode-panel-border);padding:14px 0;overflow-wrap:anywhere}.container strong{font-size:15px}#status{padding:12px;background:var(--vscode-textBlockQuote-background);border-left:3px solid var(--vscode-focusBorder)}#status.error{border-color:var(--vscode-errorForeground)}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto;background:var(--vscode-textCodeBlock-background);padding:12px}.muted{color:var(--vscode-descriptionForeground)}[hidden]{display:none!important}@media(max-width:700px){.choices{grid-template-columns:1fr}body{padding:12px}.row>*{max-width:100%}select{width:100%}}
</style></head><body><main><header><h1>Containers</h1></header>
<details><summary>Set up a Podman connection</summary><p class="engine-note">A Podman engine is required. Podman Desktop is optional.</p><div class="choices"><article class="choice"><h3>Linux host</h3><p>Use the local rootless Podman engine on Linux.</p><small>Refresh targets, explicitly select Linux local (rootless), then test it. Nothing runs automatically.</small></article><article class="choice"><h3>Existing Debian VM</h3><p>Use an existing named Podman connection to your Debian VM.</p><small>No VM is created or changed. The connection name does not verify its guest OS.</small></article><article class="choice"><h3>Create Debian VM</h3><p>Build a headless Debian VM for Podman, then verify its SSH connection.</p><button data-action="create-debian">Create Debian VM</button> <button class="secondary" data-action="debian-status">Refresh build status</button><p><small>Windows/Linux VirtualBox or Linux KVM. Requires a local ISO and independently trusted SHA-256. No WSL activation.</small></p></article><article class="choice"><h3>WSL 2</h3><p>Automatic setup is not available. Follow the manual setup guide.</p><button class="secondary" data-action="detect-local">Detect installed Podman</button> <button class="secondary" data-action="wsl-guide">WSL 2 setup guide</button><p><small>Detection checks the installed Podman version and machine list.</small></p></article></div></details>

<details><summary>VeraCrypt workspace (native Linux)</summary><p>Unlock the volume first and configure VAMP: Podman Workspace Config Path in machine settings. After checking the workspace, you can grant a new desktop write access to /workspace.</p><button data-action="workspace-status" disabled>Check workspace</button> <button data-action="workspace-attach" disabled>Create workspace desktop</button></details>
<section aria-labelledby="connection-heading"><h2 id="connection-heading">Podman connection</h2><label for="connection">Existing Podman target</label><div class="row"><select id="connection" aria-describedby="connection-help"><option value="">Choose a connection</option></select><button id="refresh" data-action="refresh" class="secondary">Refresh targets</button><button id="test" data-action="test" disabled>Test connection</button><button id="list" data-action="list" class="secondary" disabled>Refresh containers</button></div><p id="connection-help">Choose the local rootless engine on Linux, or a named SSH connection for a VM or WSL engine.</p></section>
<p id="status" role="status" aria-live="polite">No connection selected.</p><section aria-labelledby="containers-heading"><h2 id="containers-heading">Container list</h2><div id="containers"></div></section><section id="logs-section" hidden><h2>Recent container logs</h2><p id="logs-title"></p><pre id="logs" tabindex="0"></pre><button id="clear-logs" class="secondary">Clear displayed logs</button></section></main>
<script nonce="${nonce}">
const api=acquireVsCodeApi(),$=id=>document.getElementById(id);let state={busy:false,connection:'',connections:[],containers:[]};
function send(action,id){api.postMessage({action,id,connection:$('connection').value});}
function controls(){for(const button of document.querySelectorAll('button[data-action]'))button.disabled=state.busy||(!['refresh','wsl-guide','detect-local','create-debian','debian-status'].includes(button.dataset.action)&&!state.connection)||button.dataset.unavailable==='true'||(button.dataset.action.startsWith('workspace-')&&!state.workspaceLocal);$('connection').disabled=state.busy;}
document.addEventListener('click',event=>{const button=event.target.closest('button[data-action]');if(button&&!button.disabled)send(button.dataset.action,button.dataset.id);});
$('connection').addEventListener('change',()=>send('select'));$('clear-logs').addEventListener('click',()=>{$('logs').textContent='';$('logs-section').hidden=true;});
window.addEventListener('message',event=>{const message=event.data;if(message.type==='state'){state=message;const select=$('connection');select.replaceChildren();const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent=state.connections.length?'Choose a connection':'No named connections found';select.appendChild(placeholder);for(const connection of state.connections){const option=document.createElement('option');option.value=connection.name;option.textContent=connection.label||connection.name;select.appendChild(option);}select.value=state.connection;$('status').textContent=state.message||'';$('status').className=state.error?'error':'';const target=$('containers');target.replaceChildren();for(const item of state.containers){const row=document.createElement('article');row.className='container';const title=document.createElement('strong');title.textContent=item.name||item.id;const detail=document.createElement('p');detail.textContent=(item.state||'unknown')+' · '+(item.image||'image unavailable')+' · '+item.id;row.append(title,detail);const buttons=document.createElement('div');buttons.className='row';for(const [action,label,available] of [['start','Start',['exited','stopped','created','configured'].includes(item.state)],['stop','Stop',item.state==='running'],['logs','View logs',true],['capture','Capture desktop',item.state==='running'],['desktop','Open Desktop',item.state==='running']]){const button=document.createElement('button');button.textContent=label;button.className='secondary';button.dataset.action=action;button.dataset.id=item.id;button.dataset.unavailable=String(!available);button.setAttribute('aria-label',label+' '+(item.name||item.id));buttons.appendChild(button);}row.appendChild(buttons);target.appendChild(row);}if(!state.containers.length){const empty=document.createElement('p');empty.textContent=state.connection?'No containers loaded. Test the connection, then refresh containers.':'Select a named connection first.';target.appendChild(empty);}if(message.clearLogs){$('logs').textContent='';$('logs-section').hidden=true;}controls();}if(message.type==='logs'){$('logs-title').textContent=message.title;$('logs').textContent=message.text;$('logs-section').hidden=false;}});
api.postMessage({action:'ready'});
</script></body></html>`;
}
function registerContainers(context,{vscode,createBackend,output,openCapture,openDesktop,createDebianHost,debianHostStatus}={}){
  let localWorkspaceTarget=false;
  let panel,backend,inventoryBinding,debianJob,inFlight=false,closed=false,generation=0;
  const state={type:'state',busy:false,connection:'',connections:[],containers:[],workspaceLocal:false,message:'Refresh targets to begin.',error:false};
  const post=(extra={})=>{if(panel&&!closed)panel.webview.postMessage({...state,...extra});};
  const service=()=>{if(!backend)backend=createBackend();return backend;};
  const knownConnection=name=>state.connections.some(row=>row.name===name);
  async function listContainers(){
    const report=await service().list(state.connection);
    inventoryBinding=undefined;
    if(!report||report.connection!==state.connection||typeof report.binding!=='string'||!report.binding||!Array.isArray(report.containers))throw Error('Container inventory binding could not be verified. Refresh containers.');
    state.containers=report.containers;inventoryBinding=report.binding;
  }
  async function action(message){
    if(!message||typeof message!=='object'||!['ready','refresh','select','test','list','start','stop','logs','capture','desktop','wsl-guide','detect-local','workspace-status','workspace-attach','create-debian','debian-status'].includes(message.action))return;
    if(message.action==='ready'){post();return;}
    if(inFlight)return;
    if(message.action==='wsl-guide'){
      try{await vscode.commands.executeCommand('markdown.showPreview',vscode.Uri.joinPath(context.extensionUri,'CONTAINERS_WSL.md'));}
      catch(error){state.error=true;state.message='Could not open the WSL 2 setup guide: '+String(error?.message||error);post();}
      return;
    }
    if(message.action==='select'){
      if(message.connection!==''&&!knownConnection(message.connection))return;
      state.connection=message.connection;state.workspaceLocal=localWorkspaceTarget&&state.connection==='local-linux';state.containers=[];inventoryBinding=undefined;state.error=false;state.message=state.connection?'Connection selected. Test it before managing containers.':'Select a named connection.';post({clearLogs:true});return;
    }
    if(!['refresh','detect-local','create-debian','debian-status'].includes(message.action)&&(!knownConnection(message.connection)||message.connection!==state.connection))return;
    const activeGeneration=generation;
    inFlight=true;state.busy=true;state.error=false;state.message='Working…';post();
    try{
      if(message.action==='create-debian'){
        if(typeof createDebianHost!=='function')throw Error('Debian engine builder is unavailable in this installation.');
        const result=await createDebianHost(()=>!closed&&generation===activeGeneration);
        if(result?.status==='cancelled'){state.message='Canceled. No Debian engine build was requested.';}
        else{
          if(result?.status!=='queued'||typeof result.job_id!=='string'||!result.job_id)throw Error('Build request outcome could not be verified. Review build status before retrying.');
          debianJob=result.job_id;state.message='Debian engine build queued. No box, running VM or Podman connection is verified yet. Refresh build status.';
        }
      }else if(message.action==='debian-status'){
        if(!debianJob||typeof debianHostStatus!=='function')throw Error('No Debian build job is tracked in this panel.');
        const result=await debianHostStatus(debianJob);
        const stage=result?.status;
        state.message=stage==='box_ready'?'Debian box ready. Authorized deployment may follow; guest boot and Podman connection remain unverified.':stage==='vm_started'?'Debian VM started. SSH and Podman connection are not yet verified.':stage==='failed'?'Debian engine build failed. Review the build log; existing VMs were not intentionally changed.':['queued','building','deploying'].includes(stage)?'Debian engine build: '+stage+'. No ready engine is verified.':'Debian build outcome is not verified. Review its local build log.';
      }else if(message.action==='detect-local'){
        const report=await service().detectLocal();
        if(report?.platform!=='win32')state.message='Installed Podman detection is available on Windows only. Nothing was started.';
        else if(report.cli!=='available')state.message='Podman CLI was not detected or could not be checked. It may be missing from PATH. See the WSL 2 setup guide.';
        else{
          const version=typeof report.version==='string'?' ('+report.version+')':'';
          const machines=Array.isArray(report.machines)?report.machines.filter(row=>row.provider==='wsl'):[];
          state.message='Podman CLI detected'+version+'. '+(report.machineInventory!=='known'?'Machine inventory could not be checked.':machines.length?'WSL machines: '+machines.map(row=>row.name+' ('+(row.running===true?'running':row.running===false?'stopped':'state unknown')+')').join(', ')+'.':'No WSL Podman machines detected.')+' Connection readiness is not verified. Nothing was started.';
        }
      }else if(message.action==='refresh'){
        const rows=await service().connections();
        localWorkspaceTarget=Array.isArray(rows)&&rows.some(row=>row?.name==='local-linux'&&row.transport==='local');
        state.workspaceLocal=localWorkspaceTarget&&state.connection==='local-linux';
        state.connections=(Array.isArray(rows)?rows:[]).filter(row=>row&&typeof row.name==='string').map(row=>row.name==='local-linux'&&row.transport==='local'?{name:row.name,label:'Linux local (rootless)'}:{name:row.name});
        if(!knownConnection(state.connection)){state.connection='';state.containers=[];}
        state.message=state.connections.length?'Select a Podman target, then test it.':'No Podman targets found. Configure a named connection outside this panel, then refresh.';
      }else if(message.action==='workspace-status'||message.action==='workspace-attach'){
        if(!localWorkspaceTarget||state.connection!=='local-linux')throw Error('Workspace attachment is available only on the local Linux target, not WSL or SSH.');
        await listContainers();
        const targetConnection=state.connection,targetBinding=inventoryBinding;
        const report=await service().workspaceStatus(targetConnection,targetBinding);
        if(closed||generation!==activeGeneration)return;
        if(report?.status!=='ready_to_attach'){
          state.message='Workspace unavailable. Check the machine-local workspace configuration, unlocked mount and exclusive access. Nothing was attached.';
        }else if(typeof report.approval_id!=='string'||!(/^[a-f0-9]{64}$/).test(report.approval_id)){
          throw Error('Workspace approval scope could not be verified.');
        }else if(message.action==='workspace-status'){
          state.message='Workspace ready to attach. No desktop was created and nothing was unlocked.';
        }else{
          const approvalId=report.approval_id;
          const choice=await vscode.window.showWarningMessage('Create a disposable desktop with writable VeraCrypt workspace?',{modal:true,detail:'Local Linux rootless Podman only, with network disabled. This creates a NEW isolated disposable desktop with write access to the already-unlocked workspace at /workspace. Files written there persist. Nothing is unlocked and no existing container is changed. The machine-local configuration selects the mount and trusted image.'},'Create Workspace Desktop');
          if(closed||generation!==activeGeneration||state.connection!==targetConnection||inventoryBinding!==targetBinding||choice!=='Create Workspace Desktop'){state.message='Canceled. No workspace desktop was created.';return;}
          const result=await service().workspaceAttach(targetConnection,targetBinding,approvalId);
          if(!result||result.status!=='attached'||result.destination!=='/workspace'||typeof result.id!=='string'||!(/^[a-f0-9]{64}$/).test(result.id))throw Error('Workspace attachment outcome could not be verified. Check local container inventory before retrying.');
          state.message='Workspace desktop created: '+result.id+'. Files in /workspace are writable and persist. Desktop readiness is not yet verified.';
        }
      }else if(message.action==='test'){
        const report=await service().status(state.connection);
        if(report?.status!=='ready')throw Error(report?.message||'Podman connection is not ready.');
        state.message='Connection test succeeded: '+state.connection+'. Refresh containers to list workloads.';
      }else if(message.action==='list'){
        await listContainers();state.message='Loaded '+state.containers.length+' container(s) from '+state.connection+'.';
      }else{
        if(typeof message.id!=='string'||!state.containers.some(row=>row.id===message.id))return;
        await listContainers();const item=state.containers.find(row=>row.id===message.id);
        const targetConnection=state.connection,targetBinding=inventoryBinding;
        if(!item)throw Error('Container no longer exists in this connection. Refresh the list.');
        if(message.action==='desktop'){
          if(item.state!=='running'||typeof openDesktop!=='function')throw Error('Desktop viewer is unavailable. Use Capture desktop.');
          await service().screenTarget(targetConnection,item.id,targetBinding);
          await openDesktop({containerId:item.id,openScreenStream:()=>service().openScreenStream(targetConnection,item.id,targetBinding)});
          state.message='View-only desktop requested. Trusted image and connection are checked before streaming. Workspace readiness is not implied.';
        }else if(message.action==='capture'){
          if(item.state!=='running')throw Error('Desktop capture requires a running container.');
          if(typeof openCapture!=='function')throw Error('Desktop capture viewer is unavailable.');
          const result=await service().capture(targetConnection,item.id,targetBinding);
          if(closed||generation!==activeGeneration)return;
          if(result?.connection!==targetConnection||result?.id!==item.id||result?.binding!==targetBinding)throw Error('Desktop capture target changed. Refresh containers.');
          openCapture(result);state.message='Desktop snapshot opened, view only. Screen data may contain sensitive information; no file was saved.';
        }else if(message.action==='logs'){
          const logs=await service().logs(targetConnection,item.id,targetBinding);
          const text=String(typeof logs==='string'?logs:logs?.text||'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').slice(-32768);
          if(panel&&!closed&&generation===activeGeneration)panel.webview.postMessage({type:'logs',title:state.connection+' · '+(item.name||item.id),text});
          state.message='Displayed recent logs. Logs may contain application secrets; do not share them without checking.';
        }else{
          if(message.action==='start'&&!['exited','stopped','created','configured'].includes(item.state))throw Error('Container cannot be started from its current state: '+item.state);
          if(message.action==='stop'&&item.state!=='running')throw Error('Container is no longer running.');
          const verb=message.action==='start'?'Start':'Stop';
          const confirm=await vscode.window.showWarningMessage(verb+' '+(item.name||item.id)+'?',{modal:true,detail:'Connection: '+state.connection+'\nContainer ID: '+item.id+'\n'+(verb==='Start'?'This starts the existing container workload.':'This requests the existing container to stop with a 10-second grace period. Podman may kill it after that timeout; running application work may be lost.')},verb+' Container');
          if(closed||generation!==activeGeneration||state.connection!==targetConnection||inventoryBinding!==targetBinding||confirm!==verb+' Container'){state.message='Canceled. No container action was sent.';return;}
          await service()[message.action](targetConnection,item.id,targetBinding);await listContainers();
          const fresh=state.containers.find(row=>row.id===item.id);
          const verified=verb==='Start'?fresh?.state==='running':fresh&&['exited','stopped','configured'].includes(fresh.state);
          state.message=verified?verb+' verified for '+(item.name||item.id)+'.':verb+' request sent. The expected state is not yet verified; refresh containers.';
        }
      }
    }catch(error){state.error=true;state.message=message.action.startsWith('workspace-')?'Workspace action could not be verified. Check the machine-local configuration and container inventory before retrying; a partial operation may have created a container. No unlock was requested.':String(error?.message||error);output?.appendLine('Containers: '+state.message);}
    finally{inFlight=false;state.busy=false;post({clearLogs:message.action==='refresh'});}
  }
  context.subscriptions.push(vscode.commands.registerCommand(COMMAND,()=>{
    if(panel){panel.reveal();post();return;}
    closed=false;generation++;panel=vscode.window.createWebviewPanel('vamp.containers','VAMP · Containers',vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[]});
    panel.webview.html=containersHTML();panel.webview.onDidReceiveMessage(action);panel.onDidDispose(()=>{closed=true;generation++;panel=undefined;state.containers=[];});
    post();
  }));
  context.subscriptions.push({dispose(){panel?.dispose();}});
}
module.exports={COMMAND,withContainersSidebar,containersHTML,registerContainers};
