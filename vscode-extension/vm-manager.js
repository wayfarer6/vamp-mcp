const vscode = require('vscode');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {isIPv4} = require('node:net');
const bootstrapEngine = require('./guest-bootstrap');
const {SCRIPT_SERVER_PORT, createScriptServer} = require('./script-server');
const exec = promisify(execFile);
const run = (command,args,options) => exec(command,args,{...options,windowsHide:true});

function hyperVFeatureIssue(code) {
  if(code==='hyperv_module_missing')return 'Hyper-V management tools are missing. Open Windows Features and enable Hyper-V Management Tools (including the PowerShell module), if supported on this Windows edition.';
  if(code==='hyperv_service_missing')return 'Hyper-V host service is missing. Open Windows Features and enable Hyper-V Platform, if supported on this Windows edition.';
  return '';
}

function unavailableEngineLabel(backend,platform=process.platform,release=()=>os.release()) {
  return backend==='hyperv' && platform==='win32' ? 'Hyper-V · Windows '+release() : undefined;
}

function buildNetworkOptions(backend, message) {
  if (!['hyperv','kvm'].includes(backend)) return {};
  const options={};
  const host=String(message.bootstrapHost ?? '').trim();
  if (host && !isIPv4(host)) throw Error('Enter a plain IPv4 address for the Packer bootstrap host.');
  if (host) options.bootstrap_host=host;
  if (backend==='hyperv') {
    const name=String(message.switchName ?? '').trim();
    if (name && (name.length>128 || /[\x00-\x1f\x7f]/.test(name))) throw Error('Enter a valid Hyper-V switch name.');
    if (name) options.switch_name=name;
  }
  return options;
}

function parseInventory(text) {
  return text.split(/\r?\n/).flatMap(line => {
    const m = line.match(/^"(.*)"\s+\{([a-f0-9-]{36})\}$/i);
    return m ? [{name:m[1],id:m[2]}] : [];
  });
}
function parseInfo(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([^=]+)=(.*)$/);
    if(m) result[m[1]] = m[2].replace(/^"|"$/g,'');
  }
  return result;
}
function recommendedResources(platform = os) {
  const total = Math.floor(platform.totalmem()/1024**2);
  return {memory_mb:total>=12288 ? 4096 : 2048,cpus:Math.max(1,Math.min(2,platform.cpus().length-1)),disk_mb:65536};
}
function registerManager(context,{pythonPath,runtime,output,setupPython,remote}) {
  let panel, refreshing=false, busy=false, selectedISO, serverBusy=false, serverState={status:'unknown'};
  const cfg=()=>vscode.workspace.getConfiguration('vamp');
  const executable=()=>cfg().get('vboxManagePath') || (process.platform==='win32'
    ? path.join(process.env.ProgramFiles || 'C:/Program Files','Oracle/VirtualBox/VBoxManage.exe') : 'VBoxManage');
  const vbox=args=>adapters.command('virtualbox',args);
  let hypervUac;
  let hypervFeatureIssue='';
  let backend=context.globalState?.get('vamp.manager.backend') || 'virtualbox';
  const scriptServer=createScriptServer({
    runtime,
    python:()=>fs.existsSync(pythonPath())?pythonPath():(cfg().get('pythonExecutable')||(process.platform==='win32'?'python':'python3')),
    log:message=>output.appendLine('[script-server] '+message),
  });
  context.subscriptions.push({dispose(){scriptServer.dispose().catch(()=>{});}});
  const packer=require('./host-backends').packer({runtime,python:()=>fs.existsSync(pythonPath())?pythonPath():(cfg().get('pythonExecutable')||(process.platform==='win32'?'python':'python3'))});
  const adapters=require('./host-backends').hostBackends(context,{runtime,config:cfg,python:pythonPath,vboxExecutable:executable,spawn:execFile});
  let environment={state:'unknown',message:'Not verified yet'};
  async function verifyEnvironment(){
    const folder=path.join(context.globalStorageUri.fsPath,'python');
    if(!fs.existsSync(pythonPath()))return environment={state:'missing',message:'Not prepared'};
    environment={state:'checking',message:'Testing activation and required packages…'};
    const code='import sys,os,json,importlib.metadata as m; from pathlib import Path; import mcp,robot,pycdlib,asyncvnc; expected=Path(sys.argv[1]).resolve(); assert Path(sys.prefix).resolve()==expected and sys.prefix!=sys.base_prefix; assert Path(os.environ["VIRTUAL_ENV"]).resolve()==expected; print(json.dumps({"status":"ready","activated":True,"version":sys.version.split()[0],"packages":{n:m.version(n) for n in ["mcp","robotframework","pycdlib","asyncvnc"]}}))';
    try{
      const result=process.platform==='win32'
        ? await run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(runtime,'backends/common/Test-Environment.ps1'),'-EnvironmentPath',folder],{timeout:30000,maxBuffer:1024*1024})
        : await run('bash',['--noprofile','--norc','-c','set -e; source "$1"; python -c "$2" "$3"','vamp-env-check',path.join(folder,'bin/activate'),code,folder],{timeout:30000,maxBuffer:1024*1024});
      const details=JSON.parse(result.stdout);if(details.status!=='ready'||!details.activated)throw Error('Activation was not verified');
      environment={state:'ready',message:'Python '+details.version+' · activation and 4 required packages verified',details};
    }catch(error){output.appendLine('Environment verification: '+error.message);environment={state:'error',message:'Verification failed. Open the setup log for the activation/import error.'};}
    return environment;
  }
  const screens=new Map();
  async function openKvmScreen(vm) {
    const key='kvm:'+vm.id;
    if(screens.has(key)){screens.get(key).reveal();return;}
    const {startBridge,viewerHTML}=require('./dist/viewer_bridge.cjs');
    const target=await adapters.endpoint(vm.id);
    const bridge=await startBridge({...target,resolveTarget:()=>adapters.endpoint(vm.id),onError:message=>output.appendLine(message)});
    let screen;
    try{
      screen=vscode.window.createWebviewPanel('vamp.kvmViewer','VAMP Screen · '+vm.name,vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'dist/webview')]});
      const scriptUri=screen.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,'dist/webview/viewer.js'));
      screen.webview.html=viewerHTML({scriptUri:String(scriptUri),wsUrl:bridge.url,cspSource:screen.webview.cspSource,name:vm.name,...target});
      screens.set(key,screen);
      screen.webview.onDidReceiveMessage(async message=>{try{if(message?.type==='copyEndpoint'){const current=await adapters.endpoint(vm.id);await vscode.env.clipboard.writeText(current.host+':'+current.port);screen.webview.postMessage({type:'endpointCopied'});}}catch(error){output.appendLine(error.message);}});
      screen.onDidDispose(()=>{bridge.dispose();screens.delete(key);});
    }catch(error){bridge.dispose();screen?.dispose();throw error;}
  }
  async function openScreen(vm) {
    if(vm.backend==='remote'){if(!remote)throw Error('Remote support is not loaded in this build.');return remote.openScreen(vm);}
    if(vm.backend==='hyperv')throw Error('Hyper-V embedded display is not supported. Use VMConnect on your Windows host.');
    if(vm.backend==='kvm')return openKvmScreen(vm);
    if(screens.has(vm.id)){screens.get(vm.id).reveal();return;}
    const screen=vscode.window.createWebviewPanel('vamp.vmScreen','VAMP Screen · '+vm.name,vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true});
    screens.set(vm.id,screen);
    screen.webview.html=screenHTML(vm.name);
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'vamp-screen-'));
    const file=path.join(directory,'frame.png');
    let disposed=false,capturing=false,ready=false;
    const clean=()=>{if(disposed&&!capturing)fs.rmSync(directory,{recursive:true,force:true});};
    const capture=async()=>{
      if(disposed || capturing || !ready || !screen.visible)return;
      capturing=true;
      try {
        await vbox(['controlvm',vm.id,'screenshotpng',file]);
        const image=await fs.promises.readFile(file);
        if(!disposed)screen.webview.postMessage({type:'frame',image:'data:image/png;base64,'+image.toString('base64'),time:new Date().toLocaleTimeString()});
      } catch(error) {if(!disposed)screen.webview.postMessage({type:'screenStatus',message:'Screen unavailable. The VM may be starting, stopped or installing display drivers. '+error.message});}
      finally{capturing=false;clean();}
    };
    const timer=setInterval(capture,1000);
    screen.webview.onDidReceiveMessage(async message=>{
      if(message?.type==='ready'){ready=true;await capture();}
      if(message?.type==='native'){
        try{await vbox(['startvm',vm.id,'--type','separate']);}catch(error){output.appendLine(error.message);vscode.window.showErrorMessage('VAMP: '+error.message);}
      }
    });
    screen.onDidChangeViewState(()=>capture());
    screen.onDidDispose(()=>{disposed=true;clearInterval(timer);screens.delete(vm.id);clean();});
  }
  context.subscriptions.push({dispose(){for(const screen of screens.values())screen.dispose();}});
  const post=message=>panel?.webview.postMessage(message);
  const progress=message=>{post({type:'progress',message});output.appendLine(message);};
  async function bootstrapGuest(vmOrId, guestOs, options) {
    if(typeof options==='string')options={command:options};
    options=options||{};
    const rows=await inventory();
    const vm=rows.find(row=>row.id===vmOrId || row.name===vmOrId);
    if(!vm)throw new Error('This desktop is no longer registered. Refresh the list.');
    if(vm.backend!=='virtualbox')throw new Error('Keystroke injection uses VBoxManage, so it works only with VirtualBox desktops on this computer.');
    if(!['running','paused'].includes(vm.state))throw new Error('Start the desktop and wait for its login screen before injecting the bootstrap script.');
    const os=guestOs || bootstrapEngine.guestOsFromType(vm.guestOS) || 'windows11';
    const request={...options,vm:vm.id,os};
    if(!String(options.command||'').trim() && !options.dryRun){
      if(!scriptServer.available())throw new Error(`The guest setup script server is missing at ${scriptServer.script}. Reinstall the VAMP extension.`);
      const server=await scriptServer.ensure({ttlSeconds:1800});
      if(server.status!=='running')throw new Error(`The guest setup HTTP server is not running on port ${SCRIPT_SERVER_PORT}. ${server.error||server.status}`);
      request.scriptServerUrl=server.guest_urls?.virtualbox_nat || bootstrapEngine.scriptBaseUrl();
      progress(`${vm.name}: guest setup is served at ${request.scriptServerUrl}/setup.sh (port ${SCRIPT_SERVER_PORT}). The server lifetime is renewed for new installations; Stop Web Server ends it explicitly.`);
    }
    const planned=bootstrapEngine.planBootstrap({...request});
    progress(`${vm.name}: keystroke bootstrap (${os}) will type: ${planned.command}`);
    const result=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:`VAMP: injecting the bootstrap script into ${vm.name}`,cancellable:false},async ()=>{
      return bootstrapEngine.runGuestBootstrap(request,{
        vbox:args=>vbox(args),
        click:(x,y)=>run(pythonPath(),[path.join(runtime,'backends/virtualbox/mouse_click.py'),vm.id,String(x),String(y),'left'],{timeout:60000}),
        log:message=>output.appendLine(`[bootstrap] ${vm.name}: ${message}`),
      });
    });
    if(result.status==='dry_run'){progress(`${vm.name}: bootstrap plan (dry run) · ${planned.steps.length} steps`);return result;}
    for(const warning of result.warnings)progress(`${vm.name}: ${warning}`);
    if(result.status==='failed'){progress(`${vm.name}: bootstrap failed while ${result.error}`);post({type:'error',message:`${vm.name}: bootstrap failed. ${result.error}`});return result;}
    progress(`${vm.name}: keystrokes sent (${result.executed.length} steps). Delivery is not proof the script ran; check the guest screen or its setup log.`);
    vscode.window.showInformationMessage(`${vm.name}: bootstrap keystrokes sent. Setup completion has not been verified.`);
    return result;
  }
  async function inventory(selectedBackend=backend) {
    if(selectedBackend==='remote'){
      if(!remote)throw Error('Remote support is not loaded in this build.');
      const result=await remote.list();
      return (result.vms||[]).map(vm=>({...vm,memory:vm.memory_mb,backend:'remote',managed:false}));
    }
    if(selectedBackend!=='virtualbox')return adapters.list(selectedBackend);
    return adapters.list('virtualbox');
  }

  async function refresh() {
    if(refreshing || !panel)return;
    refreshing=true;
    const currentBackend=backend;
    const currentConnection=cfg().get('libvirtUri') || 'qemu:///session';
    try {
      let version,problem,engineLabel,rows=[];
      try {
        if(currentBackend==='remote'){
          const info=remote?remote.summary():{configured:false,detail:'Remote support is not loaded.'};
          if(!info.configured)throw Error(info.detail);
          version=info.detail;rows=await inventory('remote');
        } else if(currentBackend==='hyperv') {
          // Displaying this tab never probes Get-VMHost or claims readiness.
          engineLabel=unavailableEngineLabel(currentBackend);
          try { rows=await inventory(currentBackend); } catch { rows=[]; }
        } else {
          version=currentBackend==='virtualbox'?(await vbox(['--version'])).trim():await adapters.check(currentBackend);rows=await inventory(currentBackend);
        }
      }catch(error){
        version=undefined;
        engineLabel=unavailableEngineLabel(currentBackend);
        problem=engineLabel?undefined:error.message;
      }
      if(currentBackend!==backend || currentConnection!==(cfg().get('libvirtUri') || 'qemu:///session'))return;
      if(!fs.existsSync(pythonPath()))environment={state:'missing',message:'Not prepared'};
      if(environment.state==='unknown')await verifyEnvironment();
      if(!serverBusy){try{serverState=await scriptServer.status();}catch(error){serverState={status:'failed',error:error.message};}}
      let goldenImages=[],goldenError='';try{goldenImages=(await packer('images')).images;}catch(error){goldenError=error.message;}
      post({type:'state',goldenImages,goldenError,scriptServer:serverState,serverBusy,environment,capabilities:adapters.capabilities(),backend,connection:currentConnection,version,problem,engineLabel,engineReady:!!version,hypervFeatureIssue:backend==='hyperv'?hypervFeatureIssue:'',pythonReady:fs.existsSync(pythonPath()),vms:rows,
        remote:remote?{...remote.summary(),report:remote.state?.report||null,error:remote.state?.error||''}:{configured:false,detail:'Remote support is not loaded.'},
        resources:recommendedResources(),iso:selectedISO ? path.basename(selectedISO) : '',busy});
    } finally {refreshing=false;if(currentBackend!==backend || currentConnection!==(cfg().get('libvirtUri') || 'qemu:///session'))refresh();}
  }
  async function checkOtherHypervisor() {
    if(process.platform!=='linux')return;
    if(backend==='virtualbox'){
      for(const uri of ['qemu:///session','qemu:///system']){
        let active='';try{active=(await run('virsh',['-c',uri,'list','--name'],{timeout:10000})).stdout;}catch{}
        if(active.trim())throw Error('A KVM desktop is running at '+uri+'. Shut it down before starting VirtualBox; these hypervisors can compete for hardware virtualization on this host.');
      }
    }
    if(backend==='kvm'){
      let active='';try{active=await vbox(['list','runningvms']);}catch{}
      if(active.trim())throw Error('A VirtualBox desktop is running. Shut it down before starting KVM on this host.');
    }
  }
  async function action(message) {
    if(message.type==='hypervUac'){
      if(backend!=='hyperv'||process.platform!=='win32')return;
      const answer=await vscode.window.showWarningMessage('Open a read-only Hyper-V permission diagnosis with Windows UAC?',{modal:true,detail:'Only a fixed Windows diagnosis window is elevated. No VM, policy, account membership, VS Code or MCP server is changed. This is not an elevated VM build broker.'},'Open Diagnosis');
      if(answer!=='Open Diagnosis')return;
      hypervUac ||= require(path.join(runtime,'backends/hyperv/uac.cjs')).createHyperVUac();
      const result=await hypervUac.request({confirmed:true});
      progress(result.message||result.status);return;
    }
    if(message.type==='refresh'){await refresh();return;}
    if(message.type==='guide'){await vscode.commands.executeCommand('vamp.openGuide');return;}
    if(message.type==='resolutionGuide'){await vscode.commands.executeCommand('vamp.openResolutionGuide');return;}
    if(message.type==='pythonDownloads'){await vscode.env.openExternal(vscode.Uri.parse('https://www.python.org/downloads/'));return;}
    if(message.type==='downloads'){await vscode.env.openExternal(vscode.Uri.parse('https://www.virtualbox.org/wiki/Downloads'));return;}
    if(message.type==='viewer'){await vscode.commands.executeCommand('vamp.openKvmViewer');return;}
    if(message.type==='vault'){await vscode.commands.executeCommand('vamp.openVault');return;}
    if(message.type==='bootstrap'){
      try{await bootstrapGuest(message.id,undefined,{});}catch(error){progress(error.message);post({type:'error',message:error.message});}
      return;
    }
    if(['scriptServerStart','scriptServerStop'].includes(message.type)){
      if(serverBusy||busy)return;
      serverBusy=true;post({type:'scriptServerState',server:serverState,busy:true});
      try{
        serverState=message.type==='scriptServerStart'?await scriptServer.start({ttlSeconds:7200}):await scriptServer.stop();
        progress(serverState.status==='running'?`Guest setup web server running on port ${SCRIPT_SERVER_PORT}.`:serverState.status==='stopped'?`Guest setup web server stopped (port ${SCRIPT_SERVER_PORT}).`:`Guest setup web server: ${serverState.error||serverState.status}`);
      }catch(error){serverState={status:'failed',error:error.message};progress(error.message);post({type:'error',message:error.message});}
      finally{serverBusy=false;post({type:'scriptServerState',server:serverState,busy:false});}
      return;
    }
    if(message.type==='logs'){output.show();return;}
    if(message.type==='remoteDocs'){await vscode.commands.executeCommand('vamp.openGuide');return;}
    if(message.type==='remoteSave'){
      try{await remote.saveSettings({enabled:true,host:message.host,port:message.port,username:message.user,privateKeyPath:message.key,backend:message.remoteBackend,libvirtUri:message.uri});progress('Remote connection saved. Verify the environment next.');}
      catch(error){progress(error.message);post({type:'error',message:error.message});}
      await refresh();return;
    }
    if(busy||serverBusy)return;
    if(message.type==='connection'){
      if(!['qemu:///session','qemu:///system'].includes(message.connection))return;
      await cfg().update('libvirtUri',message.connection,vscode.ConfigurationTarget.Global);await refresh();return;
    }
    if(message.type==='backend'){
      if(!['virtualbox','kvm','hyperv','remote'].includes(message.backend))return;
      hypervFeatureIssue='';backend=message.backend;await context.globalState?.update('vamp.manager.backend',backend);selectedISO=undefined;await refresh();return;
    }
    busy=true;post({type:'busy',value:true});
    try {
      if(message.type==='iso') {
        const files=await vscode.window.showOpenDialog({canSelectMany:false,filters:{'OS installation ISO':['iso']},title:'Choose a Debian or Windows 11 installation ISO'});
        if(files?.length)selectedISO=files[0].fsPath;
      } else if(message.type==='verifyEnv'){await verifyEnvironment();return;}
      if(message.type==='remoteVerify'){const report=await remote.verify({quiet:true});progress(report.ready?'Remote environment ready.':`Remote environment needs attention: ${(report.blockers||[]).map(item=>item.detail).join(' · ')}`);return;}
      if(message.type==='remoteSetup'){progress('Preparing the remote environment. This can take several minutes…');const result=await remote.setup();progress(result.after?.ready?'Remote environment ready.':'Remote setup finished with items that need attention. See the VAMP output log.');return;}
      if(message.type==='removeEnv'){if(await vscode.commands.executeCommand('vamp.removePython'))environment={state:'missing',message:'Deleted. Prepare Environment to create it again.'};return;}
      if(['goldenOpen','goldenDelete','goldenImport'].includes(message.type)){
        const image=(await packer('images')).images.find(row=>row.id===message.id);
        if(!image)throw Error('Golden image is no longer available. Refresh the list.');
        if(message.type==='goldenOpen'){await vscode.env.openExternal(vscode.Uri.file(image.path));return;}
        if(message.type==='goldenImport'){
          if(backend!=='virtualbox'||image.backend!=='virtualbox')throw Error('Select VirtualBox to create a VM from this image.');
          const name=await vscode.window.showInputBox({title:'Create VM from '+image.name,prompt:'Enter a unique name for the new VirtualBox VM',validateInput:value=>/^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test(value)?undefined:'Use 1–63 letters, digits, underscores or hyphens. Start with a letter.'});
          if(!name)return;
          const preview=await packer('import-image',{id:image.id,name});
          const answer=await vscode.window.showInformationMessage('Create VM '+name+'?',{modal:true,detail:preview.image_path+'\n\nA separate disk will be created. The VM will remain stopped.'},'Create VM');
          if(answer!=='Create VM')return;
          progress('Importing golden image into '+name+'…');
          await packer('import-image',{id:image.id,name,confirmed:true});
          progress('VM created from golden image: '+name);
          return;
        }
        const answer=await vscode.window.showWarningMessage('Delete golden image '+image.name+'?',{modal:true,detail:image.path+'\n'+(image.bytes/1024**3).toFixed(2)+' GiB. This permanently deletes the golden artifact and build logs. Deployed VM disks are stored separately.'},'Delete Golden Image');
        if(answer==='Delete Golden Image'){const result=await packer('delete-image',{id:image.id,confirmed:true});progress('Golden image deleted: '+result.path);}
        return;
      }
      if(message.type==='setup') {
        if(!await setupPython())throw new Error('Environment preparation did not finish. See VAMP output for the next step.');
        await verifyEnvironment();
        if(environment.state!=='ready')throw Error(environment.message);
        progress('Environment verified. Select an ISO to create your first VM.');
      } else if(message.type==='create') {
        if(backend==='remote')throw new Error('Create remote desktops on the remote host, then manage and screenshot them here.');
        if(!selectedISO)throw new Error('Choose an installation ISO first.');
        if(!['debian','windows11'].includes(message.os))throw new Error('Choose a supported operating system.');
        const name=String(message.name || '').trim();
        if(!/^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test(name))throw new Error('Start the VM name with a letter and use up to 63 letters, numbers, hyphens or underscores.');
        const network=buildNetworkOptions(backend,message);
        const resources=recommendedResources();
        if(message.os==='windows11')resources.memory_mb=Math.max(4096,resources.memory_mb);
        if(os.totalmem()/1024**2 < resources.memory_mb+2048)throw new Error('Not enough host memory for this preset. Close other VMs or use a host with more RAM.');
        if(backend==='virtualbox')await vbox(['--version']);else {
          try { await adapters.check(backend); if(backend==='hyperv')hypervFeatureIssue=''; }
          catch(error) { if(backend==='hyperv')hypervFeatureIssue=hyperVFeatureIssue(error.code); throw error; }
        }
        await checkOtherHypervisor();
        const connectionDetails=[network.switch_name&&'Hyper-V switch: '+network.switch_name,network.bootstrap_host&&'Bootstrap host IPv4: '+network.bootstrap_host].filter(Boolean).join(' · ');
        const confirmationDetails = [
          path.basename(selectedISO),
          `${resources.memory_mb/1024} GB RAM · ${resources.cpus} CPUs · 64 GB expandable disk`,
          connectionDetails,
          message.os==='windows11' ? 'Windows requires your own license.'
            : backend==='hyperv' ? 'Debian installs without DHCP. Vagrant provisions it over the reserved IP using the SSH key in VAMP_HYPERV_DEBIAN_CONFIG.'
            : 'The Debian sandbox uses the public login vboxuser / password123!.',
          'Packer may download build tools and will save a golden image separately from the running VM. Keep the host awake during setup.',
        ].filter(Boolean).join('\n');
        const choice=await vscode.window.showInformationMessage(`Create ${name}?`,{modal:true,detail:confirmationDetails},'Create and Start');
        if(choice!=='Create and Start')return;
        progress('1/3 - Preparing the host environment and Packer...');
        let ready=false;
        if(fs.existsSync(pythonPath())){try{await run(pythonPath(),['-c','import mcp, robot, pycdlib'],{timeout:15000});ready=true;}catch{}}
        if(!ready && !await setupPython())throw new Error('Environment setup failed. Open logs for installation details.');
        progress('2/3 - Queuing the Packer build...');
        const details=await adapters.create(backend,{iso_path:selectedISO,name,guest_os:message.os,windows_confirmed:message.os==='windows11',...resources,...network});
        output.appendLine(JSON.stringify(details,null,2));
        if(details.post_create_notice){
          post({type:'creationNotice',notice:details.post_create_notice});
          vscode.window.showWarningMessage('Packer is installing the guest and post-install scripts. Keep the host awake until the build completes.','Setup instructions').then(choice=>{if(choice)vscode.commands.executeCommand('vamp.openManager');});
        }
        if(details.status!=='installation_started')throw new Error(details.action_required || details.status);
        const created=(await inventory()).find(row=>row.name===name);
        if(created && backend!=='hyperv')await openScreen(created);
        progress('Installation queued. Follow progress in Golden images.');
      } else if(['start','screen','stop','delete'].includes(message.type)) {
        // Resolve an actual inventory UUID; webview data never supplies a command or filesystem path.
        const vm=(await inventory()).find(row=>row.id===message.id);
        if(!vm)throw new Error('This VM is no longer registered. Refresh the list.');
        if(message.type==='start'){
          if(!['running','paused'].includes(vm.state)){
            if(backend==='remote')await remote.start(vm);
            else {
              await checkOtherHypervisor();
              if(backend==='virtualbox'){
                await adapters.start('virtualbox',vm.id);
              }else await adapters.start(backend,vm.id);
            }
          }
          if(backend!=='hyperv')await openScreen(vm);else progress(vm.name+': startup requested. Embedded Hyper-V display is unsupported; use VMConnect.');
        }
        if(message.type==='screen')await openScreen(vm);
        if(message.type==='stop') {
          if(backend==='remote')await remote.stop(vm);
          else await adapters.stop(backend,vm.id);
          progress(`${vm.name}: shutdown requested. The status changes after the guest shuts down.`);
        }
        if(message.type==='delete') {
          if(backend==='remote')throw Error('Delete remote desktops on the remote host or with the remote hypervisor tools. This manager does not remove them.');
          if(backend!=='virtualbox' && !vm.managed)throw Error('Only desktops created by VAMP can be deleted here.');
          if(!['poweroff','saved','aborted'].includes(vm.state))throw new Error('Shut down the VM before deleting it.');
          const answer=await vscode.window.showWarningMessage(`Delete ${vm.name} and its virtual disks? All files stored inside this VM will be permanently removed.`,{modal:true},'Delete VM and Disks');
          if(answer==='Delete VM and Disks'){await adapters.remove(backend,vm.id);}
        }
      }
    } catch(error) {progress(error.message);post({type:'error',message:error.message});}
    finally {busy=false;post({type:'busy',value:false});await refresh();}
  }
  context.subscriptions.push(vscode.commands.registerCommand('vamp.verifyEnvironment',async()=>{const value=await verifyEnvironment();await refresh();return value;}));
  context.subscriptions.push(vscode.commands.registerCommand('vamp.bootstrapGuest',async (id,os,options)=>{
    try {
      let target;
      if(id)target=(await inventory()).find(row=>row.id===id);
      else {
        const running=(await inventory()).filter(row=>row.backend==='virtualbox'&&['running','paused'].includes(row.state));
        const item=await vscode.window.showQuickPick(running.map(row=>({label:row.name,description:`${row.guestOS||'guest OS unknown'} · ${row.state}`,row})),{title:'VAMP: inject the bootstrap script into which running desktop?'});
        if(!item)return undefined;
        target=item.row;
      }
      if(!target)throw new Error('This desktop is no longer registered. Refresh the list.');
      let guestOs=os;
      if(!guestOs){
        guestOs=bootstrapEngine.guestOsFromType(target.guestOS);
        if(!guestOs){
          const item=await vscode.window.showQuickPick([{label:'Windows 11',value:'windows11'},{label:'Debian',value:'debian'}],{title:'Which guest OS is this desktop running?'});
          if(!item)return undefined;
          guestOs=item.value;
        }
      }
      return await bootstrapGuest(target.id,guestOs,options);
    } catch(error){progress(error.message);post({type:'error',message:error.message});output.appendLine(error.message);vscode.window.showErrorMessage('VAMP bootstrap: '+error.message);return undefined;}
  }));
  context.subscriptions.push(vscode.commands.registerCommand('vamp.openVmScreen',async id=>{
    try {
      const rows=(await inventory()).filter(vm=>['running','paused'].includes(vm.state));
      let selected=id ? rows.find(vm=>vm.id===id) : undefined;
      if(!id){const item=await vscode.window.showQuickPick(rows.map(vm=>({label:vm.name,vm})),{title:'Choose a running desktop'});selected=item?.vm;}
      if(selected)await openScreen(selected);
      else if(id || !rows.length)vscode.window.showInformationMessage('Start a desktop in VAMP VM Manager first.');
    }catch(error){output.appendLine(error.message);vscode.window.showErrorMessage('VAMP screen: '+error.message);}
  }));
  context.subscriptions.push(vscode.commands.registerCommand('vamp.openManager',async selectedBackend=>{
    if(!busy && ['virtualbox','kvm','hyperv','remote'].includes(selectedBackend)){backend=selectedBackend;await context.globalState?.update('vamp.manager.backend',backend);}
    if(panel){panel.reveal();return refresh();}
    panel=vscode.window.createWebviewPanel('vamp.manager','VAMP · VM Manager',vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'assets')]});
    const logo=panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,'assets/sidebar-brand.png'));
    panel.webview.html=managerHTML({logoUri:String(logo),cspSource:panel.webview.cspSource});
    panel.webview.onDidReceiveMessage(message=>{if(message && typeof message.type==='string')return action(message).catch(error=>output.appendLine(String(error)));});
    panel.onDidChangeViewState(()=>{if(panel?.visible)refresh();});
    const timer=setInterval(()=>{if(panel?.visible && !busy)refresh();},10000);
    panel.onDidDispose(()=>{clearInterval(timer);panel=undefined;});
    return refresh();
  }));
  context.subscriptions.push({dispose(){panel?.dispose();}});
}
function managerHTML({logoUri,cspSource}={}) {
  const nonce=crypto.randomBytes(16).toString('hex');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource || 'data:'}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;padding:20px}main{max-width:1040px;margin:auto}h1{font-size:20px;margin-bottom:8px}h2{font-size:19px}p{line-height:1.6;color:var(--vscode-descriptionForeground)}section{border-bottom:1px solid var(--vscode-panel-border);padding:16px 0;margin:12px 0}.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.spread{justify-content:space-between}button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:9px 14px;border-radius:4px;cursor:pointer}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button:disabled{opacity:.5;cursor:default}input,select{box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:9px;width:100%;margin:7px 0 16px}label{display:block;flex:1;min-width:0;flex-basis:220px}#notice:empty{display:none}#notice{white-space:pre-wrap;line-height:1.6;padding:12px;background:var(--vscode-textBlockQuote-background);border-left:3px solid var(--vscode-focusBorder)}.vm{border-top:1px solid var(--vscode-panel-border);padding:18px 0}.vm strong{font-size:16px}.badge{font-size:12px;color:var(--vscode-descriptionForeground)}.error{color:var(--vscode-errorForeground)}.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}#env-check{display:inline-flex;width:20px;height:20px;align-items:center;justify-content:center;border-radius:50%;background:var(--vscode-testing-iconPassed,#238636);color:#fff;margin-left:8px}#env-check[hidden]{display:none}.step{padding:12px;background:var(--vscode-textBlockQuote-background);border-radius:2px}small{display:block;line-height:1.6;color:var(--vscode-descriptionForeground)}button:focus-visible,input:focus,select:focus{outline:2px solid var(--vscode-focusBorder)}.remote{border:1px solid rgba(124,92,255,.45);border-left:3px solid #7c5cff;border-radius:4px;padding:14px 16px;margin:14px 0;background:var(--vscode-textBlockQuote-background)}.remote[hidden],#env-step[hidden],#create-section[hidden],#packer-network[hidden],#packer-switch-label[hidden]{display:none}.remote .badge{font-size:11px;color:#b6a6ff;border:1px solid rgba(124,92,255,.5);border-radius:999px;padding:2px 9px;background:rgba(124,92,255,.16)}.remote h3{font-size:15px;margin:0}.remote small{max-width:70ch}
@media(max-height:600px){body{padding:10px}h1{margin:4px 0}section{padding:10px 0;margin:8px 0}}@media(max-width:480px){body{padding:12px}button{max-width:100%;white-space:normal}.row{gap:8px}.steps{grid-template-columns:1fr}}
#connection-label[hidden]{display:none}#creation-notice{border:3px solid var(--vscode-editorWarning-foreground,#cca700);background:var(--vscode-textBlockQuote-background);padding:20px;margin:20px 0}#creation-notice[hidden]{display:none}#creation-notice h2{font-size:23px;color:var(--vscode-editorWarning-foreground,#cca700)}#creation-notice p{font-size:16px;color:var(--vscode-foreground)}#creation-notice pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;background:var(--vscode-editor-background)}
.display-warning{border-left:3px solid var(--vscode-editorWarning-foreground,#cca700);padding:14px;margin:18px 0;background:var(--vscode-textBlockQuote-background)}.display-warning p{margin:8px 0}details{margin:12px 0}summary{cursor:pointer;color:var(--vscode-descriptionForeground)}details button{margin:8px 8px 0 0}[hidden]{display:none!important}
</style></head><body><main>
<div class="row spread"><div class="row">${logoUri?`<img src="${logoUri}" width="36" height="36" alt="VAMP purple bat and VM">`:""}<div><h1>Virtual Machines</h1></div></div><button class="secondary" data-action="guide">Setup guide</button></div>
<details class="display-warning"><summary>Guest display and automation</summary><p>After guest setup finishes, keep the VM awake and unlocked. Before running automation, confirm the guest display is 1920×1080 at 100% scaling.</p><button class="secondary" data-action="resolutionGuide">Display setup and reset guide</button></details>
<aside id="creation-notice" role="alert" hidden><h2 id="creation-title"></h2><p id="creation-message"></p><pre id="creation-command"></pre><p id="resolution-note"></p><pre id="resolution-command"></pre></aside>
<section><h2>Host</h2><label>Virtualization platform<select id="backend"><option value="virtualbox">VirtualBox · Linux / Windows / macOS</option><option value="kvm">KVM / QEMU · Linux · live VNC screen</option><option value="hyperv">Hyper-V · Windows · management only</option><option value="remote">Remote server · SSH · screenshots</option></select></label><label id="connection-label" hidden>KVM connection<select id="connection"><option value="qemu:///session">My desktops · no administrator needed</option><option value="qemu:///system">System desktops · libvirt permission needed</option></select></label><p id="backend-note"></p><button id="hyperv-uac" class="secondary" data-action="hypervUac" hidden>Check permissions (UAC)</button>
<div id="remote-panel" class="remote" hidden>
<h3>SSH connection</h3>
<p id="remote-status" role="status">Enter the SSH details for the host running your VMs.</p>
<div class="row"><label>Host<input id="remote-host" placeholder="lab-host.local" spellcheck="false" autocomplete="off" aria-describedby="remote-status"></label><label>Port<input id="remote-port" type="number" min="1" max="65535" placeholder="22"></label></div>
<div class="row"><label>User<input id="remote-user" placeholder="your account on that host" spellcheck="false" autocomplete="off"></label><label>Private key<input id="remote-key" placeholder="~/.ssh/id_ed25519" spellcheck="false" autocomplete="off"></label></div>
<div class="row"><label>Hypervisor<select id="remote-backend"><option value="kvm">KVM / libvirt · virsh</option><option value="virtualbox">VirtualBox · VBoxManage</option></select></label><label>libvirt URI<input id="remote-uri" placeholder="qemu:///system" spellcheck="false" autocomplete="off"></label></div>
<div class="row"><button class="mutating" data-action="remoteSave">Save connection</button><button class="secondary mutating" data-action="remoteVerify">Verify environment</button><button class="secondary mutating" data-action="remoteSetup">Prepare remote environment</button></div>
<small>Guest credentials stay on the remote host.</small>
</div><div class="steps"><div class="step"><strong id="host-label">VirtualBox</strong><p id="host">Checking your computer…</p><button id="vbox-download" class="secondary" data-action="downloads">Get VirtualBox</button></div><div class="step" id="env-step"><strong>Automation environment <span id="env-check" role="img" aria-label="Environment verified" hidden>✓</span></strong><p id="python">Checking Python…</p><div class="row"><button data-action="setup" class="mutating">Prepare environment</button><button class="secondary mutating" data-action="verifyEnv" aria-label="Verify automation environment">Verify</button><details><summary>Setup help</summary><button class="secondary" data-action="pythonDownloads">Get Python</button><button class="secondary mutating" data-action="removeEnv">Delete environment</button></details></div></div></div></section>
<section id="create-section"><h2>Create a virtual machine</h2><div class="row"><label>Desktop name<input id="name" value="VAMP-Desktop" maxlength="63" placeholder="VAMP-Desktop" aria-describedby="name-help"><small id="name-help">Start with a letter. Use letters, numbers, hyphens or underscores.</small></label><label>Operating system<select id="os"><option value="debian">Debian desktop · recommended</option><option value="windows11">Windows 11 · your license required</option></select></label></div><div class="row"><button class="secondary mutating" data-action="iso">Choose installation ISO</button><span id="iso">No ISO selected</span></div><p id="resources"></p><details id="packer-network" hidden><summary>Advanced network settings</summary><div class="row"><label id="packer-switch-label">Hyper-V switch name <input id="packer-switch" maxlength="128" placeholder="Default Switch" spellcheck="false" autocomplete="off"></label><label>Bootstrap host IPv4 (optional)<input id="packer-bootstrap" maxlength="15" inputmode="decimal" spellcheck="false" autocomplete="off" aria-describedby="packer-network-help"></label></div><small id="packer-network-help"></small></details><button id="create" class="mutating" data-action="create" disabled>Create and Start</button><p id="create-hint" role="status">Choose an installation ISO to continue.</p><p><small>Keep the host awake during installation. After the guest starts, leave it unlocked until setup finishes.</small></p></section>
<div id="notice" role="status" aria-live="polite"></div>
<section><h2>Golden images</h2><div id="golden-images">Loading images…</div></section>
<section><div class="row spread"><h2>Virtual machines</h2><button class="secondary" data-action="refresh">Refresh VMs and images</button></div><div id="vms">Loading…</div><details class="tools"><summary>Setup tools</summary><p id="script-server-status" role="status">Web server: checking...</p><div class="row"><button id="script-server-start" class="secondary" data-action="scriptServerStart">Start Web Server (8421)</button><button id="script-server-stop" class="secondary" data-action="scriptServerStop">Stop Web Server</button></div><small>Keep the server running until guest setup completes.</small><button class="secondary" data-action="logs">View setup log</button></details></section>

</main><script nonce="${nonce}">
const api=acquireVsCodeApi();let state={},busy=false,serverBusy=false,serverState={},inventorySignature='';const $=id=>document.getElementById(id);
const buildStages=new Map([
 ['static_network_preflight','Checking the static network'],
 ['offline_answer_media','Preparing offline answer media'],
 ['offline_install','Installing Debian from the ISO'],
 ['package_golden_image','Packaging the golden image'],
 ['static_ip_provisioning','Provisioning the live VM at its static IP'],
 ['verify_static_ip_after_reboot','Verifying SSH and guest setup after reboot'],
 ['golden_export','Exporting the golden image'],
]);
function renderGolden(message){
 const container=$('golden-images');container.replaceChildren();
 for(const image of message.goldenImages||[]){
  const row=document.createElement('div');row.className='vm';
  const installer=image.installer_hint||(image.installer_preseed_received===true?'Installer requested its configuration.':image.installer_preseed_received===false?'Waiting for the installer to request its configuration.':'');
  for(const [tag,text] of [['strong',image.name],['p',image.backend+' / '+image.status+(image.guest_setup_completed?' / Guest setup complete':'')+' / '+(image.bytes/1024**3).toFixed(2)+' GiB'],['p',image.path],['small',buildStages.get(image.stage)],['small',installer],['small',image.error||image.log_path||'']]){
   if(!text)continue;
   const element=document.createElement(tag);element.textContent=text;element.style.overflowWrap='anywhere';row.appendChild(element);
  }
  if(image.vm_disk_path||image.vm_path){const detail=document.createElement('p');detail.style.overflowWrap='anywhere';detail.textContent='Live VM storage: '+(image.vm_disk_path||image.vm_path);row.appendChild(detail);}
  for(const file of image.files||[]){const detail=document.createElement('p');detail.style.overflowWrap='anywhere';detail.textContent=file.path+' ('+(file.bytes/1024**3).toFixed(2)+' GiB)';row.appendChild(detail);}
  if(message.backend==='virtualbox'&&image.backend==='virtualbox'&&image.status==='completed'&&image.installation_verified&&(image.files||[]).filter(file=>file.path.toLowerCase().endsWith('.ova')).length===1){
   const button=document.createElement('button');button.className='secondary mutating';button.dataset.action='goldenImport';button.dataset.id=image.id;button.dataset.unavailable=String(!message.version);button.textContent='Create VM from image';button.setAttribute('aria-label','Create VM from '+image.name);row.appendChild(button);
  }
  for(const [action,label] of [['goldenOpen','Open folder'],['goldenDelete','Delete golden image']]){
   const button=document.createElement('button');button.className='secondary';button.dataset.action=action;button.dataset.id=image.id;button.textContent=label;
   button.disabled=action==='goldenDelete'&&['queued','building','deploying'].includes(image.status);row.appendChild(button);
  }
  container.appendChild(row);
 }
 if(!container.childNodes.length)container.textContent=message.goldenError||'No golden images yet.';
}
function send(type,id){api.postMessage({type,id,backend:$('backend').value,connection:$('connection').value,name:$('name').value,os:$('os').value,...(type==='create'?{bootstrapHost:$('packer-bootstrap').value,switchName:$('packer-switch').value}:{}),host:$('remote-host').value,port:$('remote-port').value,user:$('remote-user').value,key:$('remote-key').value,remoteBackend:$('remote-backend').value,uri:$('remote-uri').value});}
document.addEventListener('click',event=>{const button=event.target.closest('button[data-action]');if(button)send(button.dataset.action,button.dataset.id);});
const filled={};function setField(id,value){const el=$(id);if(!el)return;const next=value===undefined||value===null?'' : String(value);if(document.activeElement===el)return;if(el.value!==''&&filled[id]!==undefined&&el.value!==filled[id])return;el.value=next;filled[id]=next;}
function controls(){document.querySelectorAll('.mutating').forEach(b=>b.disabled=busy || serverBusy || b.dataset.unavailable==='true');const validName=/^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test($('name').value.trim());$('create').disabled=busy || serverBusy || state.backend==='remote' || !state.iso || (!state.version && !(state.backend==='hyperv' && state.engineLabel)) || !validName;$('create-hint').textContent=busy?'Working… keep this window open.':state.backend==='remote'?'Desktops are created on the remote host; manage them here.':!state.version&&!(state.backend==='hyperv'&&state.engineLabel)?'Prepare the selected hypervisor first.':!validName?'Enter a valid desktop name.':!state.iso?'Choose an installation ISO to continue.':state.backend==='hyperv'?'Windows permissions are checked when you create.':'';$('remote-panel').hidden=state.backend!=='remote';$('env-step').hidden=state.backend==='remote';$('create-section').hidden=state.backend==='remote';$('hyperv-uac').hidden=state.backend!=='hyperv'||!state.engineLabel;$('hyperv-uac').disabled=busy;$('backend').disabled=busy;$('connection').disabled=busy;$('name').disabled=busy;$('os').disabled=busy;$('packer-network').hidden=!['hyperv','kvm'].includes(state.backend);$('packer-switch-label').hidden=state.backend!=='hyperv';$('packer-switch').disabled=busy||state.backend!=='hyperv';$('packer-bootstrap').disabled=busy;$('packer-network-help').textContent=state.backend==='hyperv'?($('os').value==='debian'?'Debian requires a static profile in VAMP_HYPERV_DEBIAN_CONFIG. Leave these fields blank to use its switch and gateway.':'Leave blank to detect an IPv4 on this switch. Set the address explicitly if the switch has more than one.'):'Leave blank for the QEMU build NAT default (10.0.2.2). This does not set the deployed VM’s network.';serverControls();}
function serverControls(){const running=serverState.status==='running';$('script-server-start').disabled=busy||serverBusy||running||serverState.status==='port_in_use';$('script-server-stop').disabled=busy||serverBusy||!running;$('script-server-status').textContent=serverBusy?'Web server: working...':running?'Web server: Running on port 8421':serverState.status==='stopped'?'Web server: Stopped':'Web server: '+(serverState.error||serverState.status||'checking');}
function resources(){const r=state.resources;if(r)$('resources').textContent=(($('os').value==='windows11'?Math.max(4096,r.memory_mb):r.memory_mb)/1024)+' GB memory · '+r.cpus+' CPUs · 64 GB expanding disk (uses space as needed)';}
for(const id of ['remote-host','remote-port','remote-user','remote-key','remote-uri']){$(id).addEventListener('input',()=>{filled[id]=$(id).value;});}
$('remote-backend').addEventListener('change',()=>{filled['remote-backend']=$('remote-backend').value;});
$('name').addEventListener('input',controls);$('os').addEventListener('change',()=>{resources();controls();});$('connection').addEventListener('change',()=>send('connection'));$('backend').addEventListener('change',()=>{$('packer-switch').value='';$('packer-bootstrap').value='';$('packer-network').open=false;send('backend');});
window.addEventListener('message',event=>{const m=event.data;if(m.type==='scriptServerState'){serverState=m.server||{};serverBusy=!!m.busy;controls();}if(m.type==='creationNotice'){const notice=m.notice;$('creation-title').textContent=notice.title;$('creation-message').textContent=notice.message;$('creation-command').textContent=notice.setup_command;$('resolution-note').textContent=notice.resolution_note||'';$('resolution-command').textContent=notice.resolution_command||'';$('resolution-note').hidden=!notice.resolution_note;$('resolution-command').hidden=!notice.resolution_command;$('creation-notice').hidden=false;$('creation-notice').scrollIntoView({behavior:'smooth',block:'start'});}if(m.type==='busy'){busy=m.value;controls();}if(m.type==='progress'||m.type==='error'){$('notice').textContent=m.message;$('notice').className=m.type==='error'?'error':'';}
if(m.type==='state'){renderGolden(m);state=m;busy=m.busy;serverState=m.scriptServer||{};serverBusy=!!m.serverBusy;for(const option of $('backend').options){const capability=m.capabilities?.[option.value];option.disabled=!!capability&&(!capability.hostSupported||!capability.implemented);option.hidden=option.disabled&&option.value!==m.backend;}$('backend').value=m.backend;$('connection-label').hidden=m.backend!=='kvm';$('connection').value=m.connection;$('host-label').textContent={virtualbox:'VirtualBox',kvm:'KVM / QEMU',hyperv:'Hyper-V',remote:'Remote host'}[m.backend];$('host').className=m.hypervFeatureIssue?'error':'';$('host').textContent=m.hypervFeatureIssue?'× '+m.engineLabel+' · '+m.hypervFeatureIssue:m.engineLabel|| (m.backend==='remote'?(m.version?'Connected over SSH · '+m.version:(m.problem||'Set the remote host, then verify.')):(m.version?'Ready · '+m.version:(m.problem||'Install the selected hypervisor, then refresh.')));$('vbox-download').hidden=m.backend!=='virtualbox'||!!m.version;$('backend-note').textContent=m.backend==='remote'?'Desktops run on the remote host. This window takes screenshots over SSH and can start or stop them; there is no live screen stream.':m.backend==='hyperv'?'Hyper-V requires Windows management permissions. Use VMConnect to view the guest.':m.backend==='kvm'?'Linux host: install KVM, libvirt, virt-install and qemu-img. New desktops use local VNC for the embedded live viewer.':'Start a desktop to open its screen in the editor automatically.';$('python').textContent=m.environment?.message||'Not verified';$('env-check').hidden=m.environment?.state!=='ready';document.querySelector('[data-action=setup]').hidden=m.environment?.state==='ready';document.querySelector('[data-action=pythonDownloads]').hidden=m.environment?.state==='ready';$('iso').textContent=m.iso||'No ISO selected';
if(m.backend==='remote'&&m.remote){setField('remote-host',m.remote.host);setField('remote-port',m.remote.port);setField('remote-user',m.remote.username);setField('remote-key',m.remote.privateKeyPath);setField('remote-backend',m.remote.backend);setField('remote-uri',m.remote.libvirtUri);$('remote-status').textContent=m.problem?m.problem:(m.remote.configured?(m.remote.report?(m.remote.report.ready?'Environment verified · ':'Needs attention · ')+m.remote.detail:'Configured · '+m.remote.detail):m.remote.detail);$('remote-status').className=m.problem||m.remote.error?'error':'';}
resources();controls();const signature=m.backend+JSON.stringify(m.vms);if(signature===inventorySignature)return;inventorySignature=signature;$('vms').replaceChildren();
if(!m.vms.length){const p=document.createElement('p');p.textContent=m.version?'No desktops yet. Create your first one above.':'VMs appear here after the selected hypervisor is ready.';$('vms').append(p);}
const labels={running:'Running',poweroff:'Stopped',saved:'Saved',paused:'Paused',aborted:'Stopped unexpectedly',unavailable:'Unavailable',gurumeditation:'VM error · inspect in VirtualBox'};
for(const vm of m.vms){const row=document.createElement('div');row.className='vm';const title=document.createElement('strong');title.textContent=vm.name;const info=document.createElement('p');info.textContent=(labels[vm.state]||vm.state)+' · '+(vm.memory||'?')+' MB · '+(vm.cpus||'?')+' CPUs';row.append(title,info);
if(vm.installation&&!vm.installation.verified){const note=document.createElement('small');note.textContent=vm.installation.status==='failed'?'Setup needs attention. Open the screen or setup log.':vm.installation.mode==='manual'?'Manual installation: follow the installer in the VM screen. Use the account you create there.':'OS installation started; desktop readiness has not been verified.';row.append(note);}
const actions=document.createElement('div');actions.className='row';const more=document.createElement('details');const summary=document.createElement('summary');summary.textContent='More';more.append(summary);const machineActions=m.backend==='remote'?[['start',vm.state==='running'?'View screen':'Start'],['screen','Screenshot'],['stop','Shut Down']]:m.backend==='virtualbox'?[['start','Start / View Screen'],['bootstrap','Inject Bootstrap'],['stop','Shut Down'],['delete','Delete']]:[['start',m.backend==='hyperv'?'Start':'Start / View Screen'],['stop','Shut Down'],['delete','Delete']];for(const [type,label] of machineActions){const b=document.createElement('button');b.textContent=label;b.setAttribute('aria-label',label+' '+vm.name);b.dataset.action=type;b.dataset.id=vm.id;b.className='secondary mutating';b.disabled=busy||(type==='screen'&&!['running','paused'].includes(vm.state))||(type==='bootstrap'&&!['running','paused'].includes(vm.state))||(type==='delete'&&(!['poweroff','saved','aborted'].includes(vm.state)||(m.backend!=='virtualbox'&&!vm.managed)))||(type==='stop'&&vm.state!=='running')||(type==='start'&&(!['running','poweroff','saved','aborted'].includes(vm.state)||(m.backend==='hyperv'&&vm.state==='running')));b.dataset.unavailable=String(b.disabled&&!busy);if(['bootstrap','delete'].includes(type))more.append(b);else actions.append(b);}if(more.children.length>1)actions.append(more);row.append(actions);$('vms').append(row);}
}});api.postMessage({type:'refresh'});
</script></body></html>`;
}
function screenHTML(name) {
  const nonce=crypto.randomBytes(16).toString('hex');
  const title=String(name).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">body{margin:0;background:var(--vscode-editor-background,#181818);color:var(--vscode-foreground,#ddd);font-family:var(--vscode-font-family,sans-serif)}header{padding:14px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--vscode-panel-border,#333)}small{color:var(--vscode-descriptionForeground,#aaa)}button{margin-left:auto;background:var(--vscode-button-background,#086dcc);color:var(--vscode-button-foreground,#fff);border:0;padding:8px 12px;cursor:pointer}#status{padding:10px 20px;font-size:12px}#screen{display:block;max-width:100%;max-height:calc(100vh - 115px);margin:auto;object-fit:contain}#screen[hidden]{display:none}</style></head><body><header><strong>${title}</strong><small>Live screenshots · about 1 fps · view only</small><button id="native">Open interactive VM window</button></header><div id="status" role="status" aria-live="polite">Connecting to the VM screen…</div><img id="screen" alt="Live virtual machine screen" hidden><script nonce="${nonce}">const api=acquireVsCodeApi();window.addEventListener('message',event=>{const m=event.data;if(m.type==='frame'){const image=document.getElementById('screen');image.src=m.image;image.hidden=false;document.getElementById('status').textContent='Connected · last frame '+m.time;}if(m.type==='screenStatus'){document.getElementById('status').textContent=m.message;}});document.getElementById('native').addEventListener('click',()=>api.postMessage({type:'native'}));api.postMessage({type:'ready'});</script></body></html>`;
}
function sidebarHTML(logoUri,cspSource){
 const nonce=crypto.randomBytes(16).toString('hex');
 return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:16px;line-height:1.6}img{display:block;margin:8px auto;width:80px;height:80px;object-fit:contain}h2{text-align:center;font-size:17px}p{color:var(--vscode-descriptionForeground)}button{display:block;width:100%;margin:12px 0;border:1px solid var(--vscode-button-border,transparent);border-radius:3px;padding:9px 8px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}small{color:var(--vscode-descriptionForeground)}</style></head><body><img src="${logoUri}" alt="VAMP bat with a virtual machine"><h2>VAMP</h2><button data-type="library">RPA Library</button><button class="secondary" data-type="manager">Open VM Manager</button><button class="secondary" data-type="vault">Browse Credentials</button><button class="secondary" data-type="screen">View Running VM</button><button class="secondary" data-type="remote">Remote Server (SSH)</button><button class="secondary" data-type="guide">Setup Guide</button><script nonce="${nonce}">const api=acquireVsCodeApi();function select(type){document.querySelectorAll('button[data-type]').forEach(button=>{const active=button.dataset.type===type;button.classList.toggle('secondary',!active);button.setAttribute('aria-current',active?'page':'false');});api.setState({selected:type});}select(api.getState()?.selected||'library');document.addEventListener('click',e=>{const b=e.target.closest('button[data-type]');if(b){select(b.dataset.type);api.postMessage({type:b.dataset.type});}});</script></body></html>`;
}
module.exports={registerManager,hyperVFeatureIssue,unavailableEngineLabel,buildNetworkOptions,parseInventory,parseInfo,recommendedResources,managerHTML,screenHTML,sidebarHTML,bootstrapGuestEngine:bootstrapEngine};
