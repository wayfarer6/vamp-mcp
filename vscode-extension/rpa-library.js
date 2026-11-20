const vscode=require('vscode');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const runGit=require('node:util').promisify(execFile);
function registerLibrary(context,{runtime,output}){
 const store=require('./dist/library_store.cjs');let panel,items=new Map(),selected,busy=false,loading=false,signature='';
 const post=message=>panel?.webview.postMessage(message);
 function roots(){
  const repository=vscode.workspace.getConfiguration('vamp').get('kvmRepositoryPath');
  const list=[{path:path.join(context.globalStorageUri.fsPath,'rpa-catalog'),label:'My RPA skills'},{path:path.join(process.env.VAMP_DATA_DIR||path.join(os.homedir(),'VAMP'),'recordings'),label:'Saved VM recordings'},{path:path.join(runtime,'artifacts/imported-recordings'),label:'Imported VM recordings'}];
  for(const folder of vscode.workspace.workspaceFolders || [])list.push({path:path.join(folder.uri.fsPath,'rpas'),label:folder.name+' · RPAs'});
  if(repository)list.push({path:path.join(repository,'rpas'),label:'VAMP repository'},{path:path.join(repository,'artifacts','imported-recordings'),label:'Imported recordings'});
  for(const folder of [...vscode.workspace.getConfiguration('vamp').get('rpaDirectories',[]),...context.globalState.get('vamp.rpaFolders',[])])list.push({path:folder,label:path.basename(folder)});
  list.push({path:path.join(runtime,'rpas'),label:'Bundled examples'});return list;
 }
 async function refresh(){
  if(loading)return;loading=true;
  try{
   const result=await store.catalog(roots());items=new Map(result.items.map(item=>[item.id,item]));
   const next=JSON.stringify(result.items.map(i=>[i.id,i.modified,i.files.length]));if(next===signature)return;signature=next;
   post({type:'catalog',items:result.items.map(({files,manifest,...item})=>({...item,files:files.map(({relative,bytes})=>({name:relative,bytes}))})),issues:result.issues});
   if(selected&&!items.has(selected)){selected=undefined;post({type:'clear'});}
  }catch(error){post({type:'error',message:error.message});}finally{loading=false;}
 }
 async function select(id,file){
  const item=items.get(id);if(!item)throw Error('This RPA is no longer available. Refresh the library.');selected=id;
  const name=file || item.files.find(f=>f.relative.endsWith('.robot'))?.relative || item.files.find(f=>f.relative.endsWith('.py'))?.relative || item.files[0]?.relative;
  post({type:'detail',id,filename:name,source:name?await store.preview(item,name):'No source files found.'});
 }
 async function receive(message){
  if(!message || typeof message.type!=='string')return;
  try{
   if(message.type==='ready'||message.type==='refresh'){await refresh();return;}
   if(busy)return;
   if(message.type==='select'){await select(message.id,message.file);return;}
   if(message.type==='folder'){
    const folders=await vscode.window.showOpenDialog({canSelectFolders:true,canSelectFiles:false,canSelectMany:false,title:'Choose a folder containing RPA packages or saved recordings'});if(!folders?.length)return;
    const existing=context.globalState.get('vamp.rpaFolders',[]);await context.globalState.update('vamp.rpaFolders',[...new Set([...existing,folders[0].fsPath])]);await refresh();return;
   }
   if(message.type==='ai'||message.type==='prompt'){
    let item=items.get(message.id);
    if(!item){
      const candidates=[...items.values()].filter(i=>i.kind==='recording');
      const picked=await vscode.window.showQuickPick(candidates.map(i=>({label:i.name,description:i.origin,item:i})),{title:'Choose the script you recorded in the VM'});item=picked?.item;
    }
    if(!item)return;
    const source=await store.sourceText(item);const author=require('./rpa-author');
    if(message.type==='prompt'){
      await vscode.env.clipboard.writeText(author.makePrompt({name:item.name,goal:'Ask me questions and prepare title, description and usage metadata',source,backend:context.globalState.get('vamp.manager.backend','virtualbox')}));
      post({type:'exported',message:'Structural AI request copied; original source and recorded values were withheld. Do not add IDs or passwords.'});return;
    }
    busy=true;post({type:'busy',value:true});
    const metadata=await author.createMetadata(item,source,context);
    if(metadata)post({type:'author',source:item.id,metadata,editing:message.editing});
    return;
   }
   if(message.type==='register'){
    const sourceItem=items.get(message.source);if(!sourceItem)throw Error('Choose a saved recording first.');
    const source=sourceItem.files.find(f=>f.relative.endsWith('.py'));if(!source)throw Error('Create currently accepts Python recorder scripts.');
    busy=true;post({type:'busy',value:true});
    const python=path.join(context.globalStorageUri.fsPath,'python',process.platform==='win32'?'Scripts/python.exe':'bin/python');
    if(!fs.existsSync(python)&&!await vscode.commands.executeCommand('vamp.setupPython'))throw Error('Prepare the VAMP Python environment first.');
    const registry=path.join(context.globalStorageUri.fsPath,'rpa-catalog');
    const edited=items.get(message.editing);
    const request={registry,source_path:source.file,title:message.title,description:message.description,when_to_use:message.when_to_use,expected_result:message.expected_result,start_text:message.start_text,tags:message.tags,inputs:message.inputs,backend:message.backend,width:message.width,height:message.height,reviewed:message.reviewed===true};
    if(edited?.kind==='saved'&&edited.path.startsWith(registry+path.sep))request.id=edited.manifest.id;
    const result=await new Promise((resolve,reject)=>{
      const child=execFile(python,[path.join(runtime,'backends/library/registry.py')],{env:{...process.env,PYTHONIOENCODING:'utf-8'},windowsHide:true,timeout:30000,maxBuffer:1024*1024},(error,stdout,stderr)=>{let value;try{value=JSON.parse(stdout);}catch{}if(error||value?.status==='error')reject(Error(value?.message||stderr||error?.message||'Registration failed'));else resolve(value);});child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(request));
    });
    await refresh();const created=[...items.values()].find(i=>i.path===result.folder);
    post({type:'created',id:created?.id,message:'RPA saved. Its title, description, tags and input contract are searchable through VAMP RPA Library MCP.'});return;
   }
   if(message.type==='history'){
    const item=items.get(message.id);if(item?.kind!=='saved')throw Error('Choose a saved RPA skill.');
    const text=(await runGit('git',['-C',item.path,'log','-20','--format=%h %ad %s','--date=short'],{timeout:15000})).stdout.trim();
    await vscode.window.showQuickPick(text.split('\n').map(label=>({label})),{title:item.name+' · version history',placeHolder:'Latest commit first. ZIP exports include the latest commit only.'});return;
   }
   if(message.type==='export'){
    const item=items.get(message.id);if(!item)throw Error('Select an RPA first.');
    busy=true;post({type:'busy',value:true});
    const snapshot=await store.prepareExport(item);
    if(!await require('./rpa-export-review').reviewExport(snapshot))return;
    store.approveExport(snapshot,{aiReviewed:true,userConfirmed:true});
    const slug=item.name.replace(/[^\p{L}\p{N}_.-]/gu,'_').slice(0,80)||'vamp-rpa';
    const target=await vscode.window.showSaveDialog({title:'Export selected RPA source as ZIP',saveLabel:'Export RPA',defaultUri:vscode.Uri.file(path.join(os.homedir(),slug+'.zip')),filters:{'RPA source archive':['zip']}});if(!target)return;
    if(fs.existsSync(target.fsPath)){
     const answer=await vscode.window.showWarningMessage('Replace the existing export '+path.basename(target.fsPath)+'?',{modal:true},'Replace Export');if(answer!=='Replace Export')return;
    }
    busy=true;post({type:'busy',value:true});const result=await store.exportItem(item,target.fsPath,{snapshot});
    post({type:'exported',message:`Exported ${result.files} source files to ${path.basename(result.path)}. SHA-256: ${result.sha256}`});
    const answer=await vscode.window.showInformationMessage('RPA exported: '+target.fsPath,'Reveal Export');if(answer==='Reveal Export')await vscode.commands.executeCommand('revealFileInOS',target);
   }
  }catch(error){output.appendLine('RPA library: '+error.message);post({type:'error',message:error.message});}
  finally{if(busy){busy=false;post({type:'busy',value:false});}}
 }
 context.subscriptions.push(vscode.commands.registerCommand('vamp.openRpaLibrary',async()=>{
  if(panel){panel.reveal();await refresh();return;}
  panel=vscode.window.createWebviewPanel('vamp.rpaLibrary','VAMP · RPA Library',vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true});
  panel.webview.html=libraryHTML();panel.webview.onDidReceiveMessage(receive);const timer=setInterval(()=>{if(panel?.visible&&!busy)refresh();},5000);panel.onDidDispose(()=>{clearInterval(timer);panel=undefined;items.clear();selected=undefined;signature='';});await refresh();
 }));
 context.subscriptions.push({dispose(){panel?.dispose();}});
}
function libraryHTML(){
 const nonce=crypto.randomBytes(16).toString('hex');
 return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">
*{box-sizing:border-box}body{font-family:var(--vscode-font-family);background:var(--vscode-editor-background);color:var(--vscode-foreground);margin:0;padding:24px}header{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}h1{font-size:20px;margin-bottom:8px}p,small{color:var(--vscode-descriptionForeground);line-height:1.6}button,input,select,textarea{font:inherit;border:1px solid var(--vscode-input-border,transparent);border-radius:4px;padding:9px 12px}button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button:disabled{opacity:.5;cursor:default}input,select,textarea{background:var(--vscode-input-background);color:var(--vscode-input-foreground)}button:focus-visible,input:focus,select:focus{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}.toolbar{display:flex;gap:12px;margin:18px 0;flex-wrap:wrap}#query{flex:1;min-width:180px}.layout{display:grid;grid-template-columns:minmax(230px,32%) minmax(0,1fr);gap:20px;min-height:65vh}.panel{border:1px solid var(--vscode-panel-border);border-radius:2px;overflow:hidden}#list{max-height:70vh;overflow:auto}.item{display:block;text-align:left;width:100%;border:0;border-radius:0;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-list-inactiveSelectionBackground);color:var(--vscode-foreground);padding:16px}.item[aria-selected=true]{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground);border-left:3px solid var(--vscode-focusBorder)}.item strong,.item small{display:block;overflow-wrap:anywhere}.item small{color:inherit;opacity:.85;margin-top:6px}.detail{padding:20px;min-width:0}textarea{width:100%;resize:vertical}#creator input:not([type=checkbox]),#creator select{width:100%}#creator label{margin:14px 0;line-height:1.7}#creator .review{display:flex;gap:8px;align-items:center}#creator details{margin:18px 0}#creator input[type=number]{max-width:140px}#skill-contract{color:var(--vscode-descriptionForeground);line-height:1.7}h2{font-size:19px;overflow-wrap:anywhere}.meta{overflow-wrap:anywhere}pre{padding:16px;overflow:auto;max-height:42vh;background:var(--vscode-textCodeBlock-background);font-family:var(--vscode-editor-font-family,monospace);font-size:12px;line-height:1.6;border:1px solid var(--vscode-panel-border)}.actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap}#message{padding:12px 0;line-height:1.6;overflow-wrap:anywhere}#message.error{color:var(--vscode-errorForeground)}#empty{padding:24px}.hidden,[hidden]{display:none!important}label{display:block;margin:12px 0}#files{max-width:100%}@media(max-width:720px){body{padding:16px}.layout{grid-template-columns:1fr}#list{max-height:32vh}}
body{height:100vh;display:flex;flex-direction:column;overflow:hidden}header,.toolbar,#count{flex-shrink:0}.layout{flex:1;min-height:0;height:auto;overflow:hidden}.panel{min-height:0;overflow:auto}#list{max-height:none;overflow:visible}.detail:has(#creator:not([hidden])){overflow:hidden}#creator{height:100%;min-height:0;display:flex;flex-direction:column}.form-scroll{flex:1;min-height:0;overflow:auto;padding-right:8px}.form-actions{flex-shrink:0;border-top:1px solid var(--vscode-panel-border);padding-top:10px}.form-note{flex-shrink:0;font-size:11px}.mobile-back{display:none}#message:empty{display:none}#message{flex-shrink:0;max-height:80px;overflow:auto}#detail>.actions{position:sticky;top:-20px;background:var(--vscode-editor-background);padding:8px 0;z-index:1}@media(max-height:600px){body{padding:10px}header h1{margin:0}header p,.form-note{display:none}.toolbar{margin:8px 0}#count{margin:4px 0}button,input,select,textarea{padding:6px 8px}.detail{padding:12px}#creator label{margin:8px 0}}@media(max-width:720px){.layout{display:block}.layout>.panel{height:100%}.layout>.detail{display:none}body.selected .layout>.panel:first-child{display:none}body.selected .layout>.detail{display:block}body.selected .mobile-back{display:block}header{gap:8px}header .actions{gap:6px}#list{max-height:none}.toolbar{gap:6px}}
</style></head><body><header><div><h1>RPA Library</h1><p>Saved skills, recordings and source files.</p></div><div class="actions"><button id="create">Create</button><button id="create-ai" class="secondary">Create with AI</button><button id="folder" class="secondary">Add RPA Folder</button><button id="refresh" class="secondary">Refresh</button></div></header><div class="toolbar"><button id="back" class="secondary mobile-back">Back to list</button><input id="query" type="search" aria-label="Search RPAs" placeholder="Search by name, source or entry point…"><select id="kind" aria-label="Filter RPA type"><option value="all">All workflows</option><option value="saved">My RPA skills</option><option value="package">RPA packages</option><option value="recording">Saved recordings</option><option value="draft">AI drafts</option></select></div><p id="count" role="status">Loading your workflows…</p><div class="layout"><div class="panel"><div id="list" role="listbox" aria-label="Saved RPAs"></div><p id="empty" hidden>No matching workflows. Clear the search or add your recording folder.</p></div><div class="panel detail"><form id="creator" hidden><div class="form-scroll"><h2 id="form-title">Create RPA</h2><p>Choose a VM recording and describe when this skill should be reused.</p><label>Recorded script<select id="create-source" required></select></label><label>Name<input id="create-title" maxlength="120" required></label><label>Description<textarea id="create-description" rows="3" minlength="10" required></textarea></label><label>When should the agent use it?<textarea id="create-use" rows="2"></textarea></label><label>Expected result<textarea id="create-result" rows="2"></textarea></label><label>Starting-screen text (optional)<input id="create-start-text" maxlength="240" placeholder="Example: QA-042"></label><label>Search tags<input id="create-tags" placeholder="browser, search, invoice"></label><details><summary>Replay settings and inputs</summary><label>Backend<select id="create-backend"><option value="virtualbox">VirtualBox</option><option value="kvm">KVM / VNC</option></select></label><label>Recorded resolution<div class="actions"><input id="create-width" type="number" min="320" max="16384" value="1920" aria-label="Recorded width"><input id="create-height" type="number" min="200" max="16384" value="1080" aria-label="Recorded height"></div></label><label>Input names<input id="create-inputs" placeholder="Names matching placeholders in recorded text"></label><small>Optional inputs replace dollar-brace placeholders in recorded text. Hyper-V desktop replay is unsupported.</small></details><label class="review"><input id="create-reviewed" type="checkbox"> I reviewed this recording and allow agent reuse</label></div><div class="actions form-actions"><button type="submit" id="save-rpa">Save RPA</button><button type="button" id="form-ai" class="secondary">Ask AI Questions</button><button type="button" id="cancel-create" class="secondary">Cancel</button></div><p class="form-note">Saving parses the recording without executing it. Agent replay still requires an explicit target VM and confirmation.</p></form><div id="placeholder"><h2>Choose a workflow</h2><p>Your recordings and RPA packages appear on the left. Select one to see its files and source.</p><p>Saved VirtualBox recordings are found in ~/VAMP/recordings. Add a folder if you keep RPAs somewhere else.</p></div><div id="detail" hidden><h2 id="title"></h2><p id="skill-description"></p><div id="skill-contract"></div><p id="meta" class="meta"></p><div class="actions"><button id="export">Export ZIP</button><button id="edit" class="secondary" hidden>Edit Details</button><button id="history" class="secondary" hidden>Version History</button><button id="ai" class="secondary">Create with AI</button><button id="prompt" class="secondary">Copy AI Request</button><small id="summary"></small></div><details><summary>Export and privacy</summary><p>Inspect every file before upload. Export requires local screening, AI review of a structural report and your final confirmation. Replace private values with inputs. AI does not receive original source and cannot guarantee privacy. Drafts are never run automatically.</p></details><label>Preview file <select id="files" aria-label="Preview source file"></select></label><pre id="source" tabindex="0" aria-label="RPA source preview"></pre></div></div></div><div id="message" role="status" aria-live="polite"></div><script nonce="${nonce}">
const api=acquireVsCodeApi(),$=id=>document.getElementById(id);let items=[],selected=null,visible=[],busy=false,editing=null;
function send(type,data={}){api.postMessage({type,...data});}
function choose(id){if(busy)return;document.body.classList.add('selected');selected=id;render();send('select',{id});}
function render(){const q=$('query').value.toLowerCase().trim();visible=items.filter(i=>($('kind').value==='all'||i.kind===$('kind').value)&&[i.name,i.description,i.when_to_use,i.origin,i.version,...(i.tags||[]),...i.entries].join(' ').toLowerCase().includes(q));$('list').replaceChildren();$('count').textContent=visible.length+' workflows · '+items.filter(i=>i.kind==='recording').length+' saved recordings';$('empty').hidden=visible.length>0;for(const item of visible){const button=document.createElement('button');button.className='item';button.setAttribute('role','option');button.setAttribute('aria-selected',String(item.id===selected));button.tabIndex=item.id===selected||(!visible.some(i=>i.id===selected)&&visible[0]===item)?0:-1;button.dataset.id=item.id;const title=document.createElement('strong');title.textContent=item.name;const meta=document.createElement('small');meta.textContent=(item.kind==='package'?'RPA package':item.kind==='saved'?(item.reviewed?'Saved skill · reviewed':'Saved skill · needs review'):item.kind==='draft'?'AI draft · review required':'Recording')+' · '+item.origin+(item.version?' · v'+item.version:'');button.append(title,meta);button.addEventListener('click',()=>choose(item.id));$('list').append(button);}}
$('back').onclick=()=>{document.body.classList.remove('selected');selected=null;$('creator').hidden=true;render();};$('query').addEventListener('input',()=>{document.body.classList.remove('selected');render();});$('kind').addEventListener('change',render);$('refresh').onclick=()=>send('refresh');$('folder').onclick=()=>send('folder');$('export').onclick=()=>send('export',{id:selected});$('history').onclick=()=>send('history',{id:selected});$('ai').onclick=()=>send('ai',{id:selected});$('create-ai').onclick=()=>send('ai',{id:items.find(i=>i.id===selected&&i.kind==='recording')?.id});$('prompt').onclick=()=>send('prompt',{id:selected});$('files').onchange=()=>send('select',{id:selected,file:$('files').value});
$('list').addEventListener('keydown',event=>{if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();const index=visible.findIndex(i=>i.id===selected);const next=event.key==='Home'?0:event.key==='End'?visible.length-1:Math.max(0,Math.min(visible.length-1,index+(event.key==='ArrowDown'?1:-1)));if(visible[next]){choose(visible[next].id);$('list').querySelector('[aria-selected=true]')?.focus();}});
function form(sourceId,metadata={},editId=null){document.body.classList.add('selected');editing=editId;const candidates=items.filter(i=>i.kind==='recording'||i.id===sourceId);$('create-source').replaceChildren();for(const item of candidates){const option=document.createElement('option');option.value=item.id;option.textContent=item.name+' · '+item.origin;$('create-source').append(option);}$('create-source').value=sourceId||candidates[0]?.id||'';$('form-title').textContent=editId?'Edit RPA Details':'Create RPA';for(const [field,key] of [['title','name'],['description','description'],['use','when_to_use'],['result','expected_result']])$('create-'+field).value=metadata[key]||metadata[field]||'';$('create-start-text').value=metadata.start_text||metadata.manifest?.start_text||'';$('create-tags').value=(metadata.tags||[]).join(', ');$('create-inputs').value=(metadata.inputs||[]).join(', ');$('create-backend').value=metadata.backend||'virtualbox';$('create-width').value=metadata.resolution?.[0]||1920;$('create-height').value=metadata.resolution?.[1]||1080;$('create-reviewed').checked=metadata.reviewed===true;$('creator').hidden=false;$('detail').hidden=true;$('placeholder').hidden=true;$('create-title').focus();}
$('create').onclick=()=>form(items.find(i=>i.id===selected&&i.kind==='recording')?.id);$('edit').onclick=()=>{const item=items.find(i=>i.id===selected);if(item)form(item.id,item,item.id);};$('cancel-create').onclick=()=>{$('creator').hidden=true;if(selected)choose(selected);else $('placeholder').hidden=false;};$('form-ai').onclick=()=>send('ai',{id:$('create-source').value,editing});$('create-source').onchange=()=>{$('create-reviewed').checked=false;};
$('creator').onsubmit=event=>{event.preventDefault();send('register',{source:$('create-source').value,editing,title:$('create-title').value,description:$('create-description').value,when_to_use:$('create-use').value,expected_result:$('create-result').value,start_text:$('create-start-text').value,tags:$('create-tags').value.split(',').map(s=>s.trim()).filter(Boolean),inputs:$('create-inputs').value.split(',').map(s=>s.trim()).filter(Boolean),backend:$('create-backend').value,width:Number($('create-width').value),height:Number($('create-height').value),reviewed:$('create-reviewed').checked});};
window.addEventListener('message',event=>{const m=event.data;if(m.type==='author'){form(m.source,{...items.find(i=>i.id===m.editing),...m.metadata,name:m.metadata.title,reviewed:false},m.editing);}if(m.type==='created'){$('creator').hidden=true;$('message').textContent=m.message;if(m.id)choose(m.id);}if(m.type==='catalog'){items=m.items;if(!selected||!items.some(i=>i.id===selected))selected=null;render();if(m.issues.length)$('message').textContent=m.issues.map(i=>i.origin+': '+i.message).join('; ');}
if(m.type==='clear'){selected=null;$('detail').hidden=true;$('placeholder').hidden=false;}
if(m.type==='detail'&&m.id===selected){$('creator').hidden=true;const item=items.find(i=>i.id===selected);if(!item)return;$('placeholder').hidden=true;$('detail').hidden=false;$('title').textContent=item.name;$('meta').textContent=item.origin+' · '+item.path;$('summary').textContent=item.files.length+' source files';$('ai').hidden=item.kind==='package'||item.kind==='saved';$('prompt').hidden=item.kind==='package'||item.kind==='saved';$('edit').hidden=item.kind!=='saved';$('history').hidden=item.kind!=='saved';$('skill-description').textContent=item.description||'';$('skill-contract').textContent=item.kind==='saved'?'Use when: '+item.when_to_use+' · Expected result: '+item.expected_result+' · Inputs: '+(item.inputs.join(', ')||'none')+' · '+item.backend:'';$('files').replaceChildren();for(const file of item.files){const o=document.createElement('option');o.value=file.name;o.textContent=file.name+' · '+file.bytes+' B';$('files').append(o);}$('files').value=m.filename;$('source').textContent=m.source;}
if(m.type==='busy'){busy=m.value;for(const id of ['export','ai','prompt','create','create-ai','save-rpa','form-ai','folder','refresh','files','query','kind'])$(id).disabled=busy;}
if(m.type==='error'||m.type==='exported'){$('message').textContent=m.message;$('message').className=m.type==='error'?'error':'';}});send('ready');
</script></body></html>`;
}
module.exports={registerLibrary,libraryHTML};
