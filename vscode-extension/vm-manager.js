const vscode = require('vscode');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const bootstrapEngine = require('./guest-bootstrap');
const run = promisify(execFile);

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
  let panel, refreshing=false, busy=false, selectedISO;
  const cfg=()=>vscode.workspace.getConfiguration('vamp');
  const executable=()=>cfg().get('vboxManagePath') || (process.platform==='win32'
    ? path.join(process.env.ProgramFiles || 'C:/Program Files','Oracle/VirtualBox/VBoxManage.exe') : 'VBoxManage');
  const vbox=async args=>(await run(executable(),args,{timeout:30000,maxBuffer:4*1024**2})).stdout;
  let backend=context.globalState?.get('vamp.manager.backend') || 'virtualbox';
  const adapters=require('./host-backends').hostBackends(context,{runtime,config:cfg});
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
    const planned=bootstrapEngine.planBootstrap({...options,os});
    const request={...options,vm:vm.id,os};
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
    const rows=parseInventory(await vbox(['list','vms']));
    return Promise.all(rows.map(async row=>{
      try {
        const info=parseInfo(await vbox(['showvminfo',row.id,'--machinereadable']));
        let installation;
        try {installation=JSON.parse(fs.readFileSync(path.join(path.dirname(info.CfgFile),'vamp-install.json'),'utf8'));}catch{}
        return {...row,backend:'virtualbox',managed:true,state:info.VMState,memory:info.memory,cpus:info.cpus,guestOS:info.ostype,
          installation:installation ? {status:installation.status,verified:installation.installation_verified,mode:installation.installation_mode} : undefined};
      } catch {return {...row,state:'unavailable'};}
    }));
  }
  async function refresh() {
    if(refreshing || !panel)return;
    refreshing=true;
    const currentBackend=backend;
    const currentConnection=cfg().get('libvirtUri') || 'qemu:///session';
    try {
      let version,problem,rows=[];
      try {
        if(currentBackend==='remote'){
          const info=remote?remote.summary():{configured:false,detail:'Remote support is not loaded.'};
          if(!info.configured)throw Error(info.detail);
          version=info.detail;rows=await inventory('remote');
        } else {
          version=currentBackend==='virtualbox'?(await vbox(['--version'])).trim():await adapters.check(currentBackend);rows=await inventory(currentBackend);
        }
      }catch(error){problem=error.message;}
      if(currentBackend!==backend || currentConnection!==(cfg().get('libvirtUri') || 'qemu:///session'))return;
      if(!fs.existsSync(pythonPath()))environment={state:'missing',message:'Not prepared'};
      if(environment.state==='unknown')await verifyEnvironment();
      post({type:'state',environment,backend,connection:currentConnection,version,problem,pythonReady:fs.existsSync(pythonPath()),vms:rows,
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
    if(message.type==='refresh'){await refresh();return;}
    if(message.type==='guide'){await vscode.commands.executeCommand('vamp.openGuide');return;}
    if(message.type==='pythonDownloads'){await vscode.env.openExternal(vscode.Uri.parse('https://www.python.org/downloads/'));return;}
    if(message.type==='downloads'){await vscode.env.openExternal(vscode.Uri.parse('https://www.virtualbox.org/wiki/Downloads'));return;}
    if(message.type==='viewer'){await vscode.commands.executeCommand('vamp.openKvmViewer');return;}
    if(message.type==='vault'){await vscode.commands.executeCommand('vamp.openVault');return;}
    if(message.type==='bootstrap'){
      try{await bootstrapGuest(message.id,undefined,{});}catch(error){progress(error.message);post({type:'error',message:error.message});}
      return;
    }
    if(message.type==='logs'){output.show();return;}
    if(message.type==='remoteDocs'){await vscode.commands.executeCommand('vamp.openGuide');return;}
    if(message.type==='remoteSave'){
      try{await remote.saveSettings({enabled:true,host:message.host,port:message.port,username:message.user,privateKeyPath:message.key,backend:message.remoteBackend,libvirtUri:message.uri});progress('Remote connection saved. Verify the environment next.');}
      catch(error){progress(error.message);post({type:'error',message:error.message});}
      await refresh();return;
    }
    if(busy)return;
    if(message.type==='connection'){
      if(!['qemu:///session','qemu:///system'].includes(message.connection))return;
      await cfg().update('libvirtUri',message.connection,vscode.ConfigurationTarget.Global);await refresh();return;
    }
    if(message.type==='backend'){
      if(!['virtualbox','kvm','hyperv','remote'].includes(message.backend))return;
      backend=message.backend;await context.globalState?.update('vamp.manager.backend',backend);selectedISO=undefined;await refresh();return;
    }
    busy=true;post({type:'busy',value:true});
    try {
      if(message.type==='iso') {
        const files=await vscode.window.showOpenDialog({canSelectMany:false,filters:{'OS installation ISO':['iso']},title:'Choose a Debian, Windows 11 or Ubuntu installation ISO'});
        if(files?.length)selectedISO=files[0].fsPath;
      } else if(message.type==='verifyEnv'){await verifyEnvironment();return;}
      if(message.type==='remoteVerify'){const report=await remote.verify({quiet:true});progress(report.ready?'Remote environment ready.':`Remote environment needs attention: ${(report.blockers||[]).map(item=>item.detail).join(' · ')}`);return;}
      if(message.type==='remoteSetup'){progress('Preparing the remote environment. This can take several minutes…');const result=await remote.setup();progress(result.after?.ready?'Remote environment ready.':'Remote setup finished with items that need attention. See the VAMP output log.');return;}
      if(message.type==='removeEnv'){if(await vscode.commands.executeCommand('vamp.removePython'))environment={state:'missing',message:'Deleted. Prepare Environment to create it again.'};return;}
      if(message.type==='setup') {
        if(!await setupPython())throw new Error('Environment preparation did not finish. See VAMP output for the next step.');
        await verifyEnvironment();
        if(environment.state!=='ready')throw Error(environment.message);
        progress('Environment verified. Select an ISO to create your first VM.');
      } else if(message.type==='create') {
        if(backend==='remote')throw new Error('Create remote desktops on the remote host, then manage and screenshot them here.');
        if(!selectedISO)throw new Error('Choose an installation ISO first.');
        if(!['debian','windows11','ubuntu'].includes(message.os))throw new Error('Choose a supported operating system.');
        const name=String(message.name || '').trim();
        if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name))throw new Error('Use 1–64 letters, numbers, hyphens or underscores for the VM name.');
        const resources=recommendedResources();
        if(message.os==='windows11')resources.memory_mb=Math.max(4096,resources.memory_mb);
        if(os.totalmem()/1024**2 < resources.memory_mb+2048)throw new Error('Not enough host memory for this preset. Close other VMs or use a host with more RAM.');
        if(backend==='virtualbox')await vbox(['--version']);else await adapters.check(backend);
        await checkOtherHypervisor();
        const choice=await vscode.window.showInformationMessage(
          `Create ${name}? ${resources.memory_mb/1024} GB memory, ${resources.cpus} CPUs, 64 GB expanding disk. Installation ISO: ${path.basename(selectedISO)}. ${backend==='virtualbox'||(backend==='kvm'&&message.os==='debian')?'Automatic-install login: vboxuser / password123! (public sandbox credentials).':'Complete OS installation in the guest and choose your own account.'}${message.os==='windows11' ? ' Windows requires your own license.' : ''}`,
          {modal:true},'Create and Start');
        if(choice!=='Create and Start')return;
        let details;
        if(backend!=='virtualbox'){
          progress('1/3 · Checking '+backend+' and preparing the desktop…');
          details=await adapters.create(backend,{iso_path:selectedISO,name,guest_os:message.os,...resources});
        }else{
        progress('1/3 · Preparing the host environment…');
        let ready=false;
        if(fs.existsSync(pythonPath())){try {await run(pythonPath(),['-c','import mcp, robot, pycdlib'],{timeout:15000});ready=true;}catch{}}
        if(!ready && !await setupPython())throw new Error('Python setup failed. Open logs for installation details.');
        progress('2/3 · Checking your ISO and preparing the VM…');
        details=await new Promise((resolve,reject)=>{
          const child=execFile(pythonPath(),[path.join(runtime,'backends/virtualbox/provision.py'),'--json-stdin'],
            {env:{...process.env,VBOXMANAGE_PATH:executable()},timeout:420000,maxBuffer:4*1024**2},(error,stdout,stderr)=>{
              let data;try {data=JSON.parse(stdout);}catch{}
              if(error || data?.status==='failed')reject(new Error(data?.error || stderr || error?.message || 'VM creation failed.'));
              else resolve(data);
            });
          child.stdin.on('error',()=>{});
          child.stdin.end(JSON.stringify({iso_path:selectedISO,name,guest_os:message.os,windows_confirmed:message.os==='windows11',allow_manual_install:true,...resources}));
        });
        }
        output.appendLine(JSON.stringify(details,null,2));
        if(details.status!=='installation_started')throw new Error(details.action_required || details.status);
        const created=(await inventory()).find(row=>row.name===name);
        if(created && backend!=='hyperv')await openScreen(created);
        if(details.installation_mode==='manual') {
          progress(backend==='hyperv'?'3/3 · Hyper-V VM created. Embedded display is unsupported. Open VMConnect to complete OS installation. Use the account you create there.':'3/3 · VM created. Follow the installer in the VM screen. Choose your own guest account. Automatic recorder setup has not run.');
          return;
        }
        progress('3/3 · Installation started. Open the VM screen to follow OS installation. A running VM does not yet mean the guest is ready.');
        vscode.window.showInformationMessage(`${name}: installation started. Follow the VM screen; setup completion has not been verified. When the guest desktop appears, VAMP can inject the post-install script with keystrokes (Win+R → cmd → PowerShell).`, 'Inject Bootstrap Script', 'Not Now')
          .then(choice=>{
            if(choice!=='Inject Bootstrap Script')return;
            return bootstrapGuest(created?.id || name, message.os==='windows11'?'windows11':'debian', {}).catch(error=>{output.appendLine(error.message);vscode.window.showErrorMessage('VAMP bootstrap: '+error.message);});
          });
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
                await vbox(['startvm',vm.id,'--type','headless']);
                const started=parseInfo(await vbox(['showvminfo',vm.id,'--machinereadable']));
                if(started.VMState!=='running')throw Error('VM did not reach Running state: '+(started.VMState||'unknown'));
              }else await adapters.start(backend,vm.id);
            }
          }
          if(backend!=='hyperv')await openScreen(vm);else progress(vm.name+': startup requested. Embedded Hyper-V display is unsupported; use VMConnect.');
        }
        if(message.type==='screen')await openScreen(vm);
        if(message.type==='stop') {
          if(backend==='remote')await remote.stop(vm);
          else if(backend==='virtualbox')await vbox(['controlvm',vm.id,'acpipowerbutton']);else await adapters.stop(backend,vm.id);
          progress(`${vm.name}: shutdown requested. The status changes after the guest shuts down.`);
        }
        if(message.type==='delete') {
          if(backend==='remote')throw Error('Delete remote desktops on the remote host or with the remote hypervisor tools. This manager does not remove them.');
          if(backend!=='virtualbox' && !vm.managed)throw Error('Only desktops created by VAMP can be deleted here.');
          if(!['poweroff','saved','aborted'].includes(vm.state))throw new Error('Shut down the VM before deleting it.');
          const answer=await vscode.window.showWarningMessage(`Delete ${vm.name} and its virtual disks? All files stored inside this VM will be permanently removed.`,{modal:true},'Delete VM and Disks');
          if(answer==='Delete VM and Disks'){if(backend==='virtualbox')await vbox(['unregistervm',vm.id,'--delete']);else await adapters.remove(backend,vm.id);}
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
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;padding:20px}main{max-width:1040px;margin:auto}h1{font-size:20px;margin-bottom:8px}h2{font-size:19px}p{line-height:1.6;color:var(--vscode-descriptionForeground)}section{border-bottom:1px solid var(--vscode-panel-border);padding:16px 0;margin:12px 0}.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.spread{justify-content:space-between}button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:9px 14px;border-radius:4px;cursor:pointer}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button:disabled{opacity:.5;cursor:default}input,select{box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:9px;width:100%;margin:7px 0 16px}label{display:block;flex:1;min-width:0;flex-basis:220px}#notice{white-space:pre-wrap;line-height:1.6;padding:12px;background:var(--vscode-textBlockQuote-background);border-left:3px solid var(--vscode-focusBorder)}.vm{border-top:1px solid var(--vscode-panel-border);padding:18px 0}.vm strong{font-size:16px}.badge{font-size:12px;color:var(--vscode-descriptionForeground)}.error{color:var(--vscode-errorForeground)}.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}#env-check{display:inline-flex;width:20px;height:20px;align-items:center;justify-content:center;border-radius:50%;background:var(--vscode-testing-iconPassed,#238636);color:#fff;margin-left:8px}#env-check[hidden]{display:none}.step{padding:12px;background:var(--vscode-textBlockQuote-background);border-radius:2px}small{display:block;line-height:1.6;color:var(--vscode-descriptionForeground)}button:focus-visible,input:focus,select:focus{outline:2px solid var(--vscode-focusBorder)}.remote{border:1px solid rgba(124,92,255,.45);border-left:3px solid #7c5cff;border-radius:4px;padding:14px 16px;margin:14px 0;background:var(--vscode-textBlockQuote-background)}.remote[hidden],#env-step[hidden],#create-section[hidden]{display:none}.remote .badge{font-size:11px;color:#b6a6ff;border:1px solid rgba(124,92,255,.5);border-radius:999px;padding:2px 9px;background:rgba(124,92,255,.16)}.remote h3{font-size:15px;margin:0}.remote small{max-width:70ch}
@media(max-height:600px){body{padding:10px}h1{margin:4px 0}section{padding:10px 0;margin:8px 0}}@media(max-width:480px){body{padding:12px}button{max-width:100%;white-space:normal}.row{gap:8px}.steps{grid-template-columns:1fr}}
</style></head><body><main>
<div class="row spread"><div class="row">${logoUri?`<img src="${logoUri}" width="36" height="36" alt="VAMP purple bat and VM">`:""}<div><h1>Virtual Machines</h1><p>Manage desktops on this computer.</p></div></div><button class="secondary" data-action="guide">Setup guide</button></div>
<section><h2>Connection</h2><label>Virtualization platform<select id="backend"><option value="virtualbox">VirtualBox · Linux / Windows / macOS</option><option value="kvm">KVM / QEMU · Linux · live VNC screen</option><option value="hyperv">Hyper-V · Windows · management only</option><option value="remote">Remote server · SSH · screenshots</option></select></label><label id="connection-label" hidden>KVM connection<select id="connection"><option value="qemu:///session">My desktops · no administrator needed</option><option value="qemu:///system">System desktops · libvirt permission needed</option></select></label><p id="backend-note"></p>
<div id="remote-panel" class="remote" hidden>
<div class="row spread"><h3>Remote server · SSH</h3><span class="badge">screenshots only</span></div>
<p id="remote-status" role="status">Connect to the host that owns the desktops. This computer only runs the SSH client.</p>
<div class="row"><label>Host<input id="remote-host" placeholder="lab-host.local" spellcheck="false" autocomplete="off" aria-describedby="remote-status"></label><label>Port<input id="remote-port" type="number" min="1" max="65535" placeholder="22"></label></div>
<div class="row"><label>User<input id="remote-user" placeholder="your account on that host" spellcheck="false" autocomplete="off"></label><label>Private key<input id="remote-key" placeholder="~/.ssh/id_ed25519" spellcheck="false" autocomplete="off"></label></div>
<div class="row"><label>Hypervisor<select id="remote-backend"><option value="kvm">KVM / libvirt · virsh</option><option value="virtualbox">VirtualBox · VBoxManage</option></select></label><label>libvirt URI<input id="remote-uri" placeholder="qemu:///system" spellcheck="false" autocomplete="off"></label></div>
<div class="row"><button class="mutating" data-action="remoteSave">Save connection</button><button class="secondary mutating" data-action="remoteVerify">Verify environment</button><button class="secondary mutating" data-action="remoteSetup">Prepare remote environment</button><button class="secondary" data-action="remoteDocs">Remote setup guide</button></div>
<small>Screenshots are taken by the hypervisor on that host and sent over SSH. There is no live stream: open a desktop to see it refresh every few seconds. Guest credentials and the vault stay on the remote host.</small>
</div><div class="steps"><div class="step"><strong id="host-label">VirtualBox</strong><p id="host">Checking your computer…</p><button id="vbox-download" class="secondary" data-action="downloads">Get VirtualBox</button></div><div class="step" id="env-step"><strong>Automation environment <span id="env-check" role="img" aria-label="Environment verified" hidden>✓</span></strong><p id="python">Checking Python…</p><div class="row"><button data-action="setup" class="mutating">Prepare Environment</button><button class="secondary mutating" data-action="verifyEnv" aria-label="Refresh and test environment activation" title="Activate the virtual environment and verify required imports">↻</button><button class="secondary mutating" data-action="removeEnv">Delete</button></div><button class="secondary" data-action="pythonDownloads">Get Python</button></div></div><small>Install the selected hypervisor on this computer first. VirtualBox automation also needs Python 3.11+. Host installation may require administrator access.</small></section>
<section id="create-section"><h2>New Virtual Machine</h2><p>Recommended settings are filled in automatically. Choose an OS installation ISO from your computer.</p><div class="row"><label>Desktop name<input id="name" value="VAMP-Desktop" maxlength="63" placeholder="VAMP-Desktop" aria-describedby="name-help"><small id="name-help">Start with a letter. Use letters, numbers, hyphens or underscores.</small></label><label>Operating system<select id="os"><option value="debian">Debian desktop · recommended</option><option value="windows11">Windows 11 · your license required</option><option value="ubuntu">Ubuntu desktop · experimental</option></select></label></div><div class="row"><button class="secondary mutating" data-action="iso">Choose installation ISO</button><span id="iso">No ISO selected</span></div><p id="resources"></p><button id="create" class="mutating" data-action="create" disabled>Create and Start</button><small id="create-hint">Choose an installation ISO to continue.</small><p><small id="install-note">Python setup runs automatically if needed. Compatible ISOs install automatically. If unattended installation is unsupported, VAMP opens the installer for you to complete. A failed setup is kept for inspection. Installation can take several minutes.</small></p></section>
<div id="notice" role="status" aria-live="polite">Select an ISO to get started.</div>
<section><div class="row spread"><h2>Machines</h2><button class="secondary" data-action="refresh">Refresh</button></div><div id="vms">Loading…</div><small>Stop requests a normal guest shutdown. Delete permanently removes the VM and its virtual disks after confirmation. Inject Bootstrap types the post-install script into a running Windows or Debian desktop through Win+R → cmd → PowerShell or the open terminal; the guest desktop must already be ready, and delivery is not proof that the script ran. Automatic-install login: vboxuser / password123!. With manual installation, use the account you created.</small></section>
<section><h2>Connect your agent</h2><p>VirtualBox screens open inside VS Code and refresh about once per second. KVM uses a live VNC stream. A remote SSH host offers screenshots only, with no live stream. Hyper-V embedded display is unsupported. VAMP VirtualBox is available in VS Code’s MCP server list. KVM agent tools use the configured VAMP repository and VM profile; creating a KVM VM here does not automatically configure those tools. Guest OS installation and Guest Additions may still need attention in the VM screen.</p><div class="row"><button class="secondary" data-action="vault">Browse Credentials</button><button class="secondary" data-action="viewer">Open existing KVM viewer</button><button class="secondary" data-action="logs">View setup log</button></div><small>VirtualBox: embedded screenshots. KVM: embedded live VNC. Remote SSH: hypervisor screenshots over SSH, no live stream. Hyper-V: lifecycle management; embedded screen unsupported. KVM/Hyper-V ISO installation is completed manually. Deletion of existing KVM/Hyper-V guests is restricted to desktops created here.</small></section>
</main><script nonce="${nonce}">
const api=acquireVsCodeApi();let state={},busy=false,inventorySignature='';const $=id=>document.getElementById(id);
function send(type,id){api.postMessage({type,id,backend:$('backend').value,connection:$('connection').value,name:$('name').value,os:$('os').value,host:$('remote-host').value,port:$('remote-port').value,user:$('remote-user').value,key:$('remote-key').value,remoteBackend:$('remote-backend').value,uri:$('remote-uri').value});}
document.addEventListener('click',event=>{const button=event.target.closest('button[data-action]');if(button)send(button.dataset.action,button.dataset.id);});
const filled={};function setField(id,value){const el=$(id);if(!el)return;const next=value===undefined||value===null?'' : String(value);if(document.activeElement===el)return;if(el.value!==''&&filled[id]!==undefined&&el.value!==filled[id])return;el.value=next;filled[id]=next;}
function controls(){document.querySelectorAll('.mutating').forEach(b=>b.disabled=busy || b.dataset.unavailable==='true');const validName=/^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test($('name').value.trim());$('create').disabled=busy || state.backend==='remote' || !state.iso || !state.version || !validName;$('create-hint').textContent=busy?'Working… keep this window open.':state.backend==='remote'?'Desktops are created on the remote host; manage them here.':!state.version?'Prepare the selected hypervisor first.':!validName?'Enter a valid desktop name.':!state.iso?'Choose an installation ISO to continue.':state.backend==='hyperv'?'Ready. Your VM will start; open VMConnect for its screen.':'Ready. Your VM will start and its screen will open automatically.';$('remote-panel').hidden=state.backend!=='remote';$('env-step').hidden=state.backend==='remote';$('create-section').hidden=state.backend==='remote';$('backend').disabled=busy;$('connection').disabled=busy;$('name').disabled=busy;$('os').disabled=busy;}
function resources(){const r=state.resources;if(r)$('resources').textContent=(($('os').value==='windows11'?Math.max(4096,r.memory_mb):r.memory_mb)/1024)+' GB memory · '+r.cpus+' CPUs · 64 GB expanding disk (uses space as needed)';}
for(const id of ['remote-host','remote-port','remote-user','remote-key','remote-uri']){$(id).addEventListener('input',()=>{filled[id]=$(id).value;});}
$('remote-backend').addEventListener('change',()=>{filled['remote-backend']=$('remote-backend').value;});
$('name').addEventListener('input',controls);$('os').addEventListener('change',resources);$('connection').addEventListener('change',()=>send('connection'));$('backend').addEventListener('change',()=>send('backend'));
window.addEventListener('message',event=>{const m=event.data;if(m.type==='busy'){busy=m.value;controls();}if(m.type==='progress'||m.type==='error'){$('notice').textContent=m.message;$('notice').className=m.type==='error'?'error':'';}
if(m.type==='state'){state=m;busy=m.busy;$('backend').value=m.backend;$('connection-label').hidden=m.backend!=='kvm';$('connection').value=m.connection;$('host-label').textContent={virtualbox:'VirtualBox',kvm:'KVM / QEMU',hyperv:'Hyper-V',remote:'Remote host'}[m.backend];$('host').textContent=m.backend==='remote'?(m.version?'Connected over SSH · '+m.version:(m.problem||'Set the remote host, then verify.')):(m.version?'Ready · '+m.version:(m.problem||'Install the selected hypervisor, then refresh.'));$('vbox-download').hidden=m.backend!=='virtualbox';$('backend-note').textContent=m.backend==='remote'?'Desktops run on the remote host. This window takes screenshots over SSH and can start or stop them; there is no live screen stream.':m.backend==='hyperv'?'Manage Hyper-V desktops here. Embedded VM screen is unsupported; use VMConnect. Windows Hyper-V permissions are required.':m.backend==='kvm'?'Linux host: install KVM, libvirt, virt-install and qemu-img. New desktops use local VNC for the embedded live viewer.':'Start a desktop to open its screen in the editor automatically.';$('python').textContent=m.environment?.message||'Not verified';$('env-check').hidden=m.environment?.state!=='ready';$('install-note').textContent=m.backend==='virtualbox'?'Python setup runs automatically if needed. Compatible ISOs install automatically; other ISOs open an installer for you to complete.':m.backend==='kvm'?'Debian amd64 installer ISOs install automatically (xorriso and Python required). Public sandbox login: vboxuser / password123!. Other OS installers are manual.':'VAMP creates the VM and attaches your ISO. Complete OS installation in VMConnect.';$('iso').textContent=m.iso||'No ISO selected';
if(m.backend==='remote'&&m.remote){setField('remote-host',m.remote.host);setField('remote-port',m.remote.port);setField('remote-user',m.remote.username);setField('remote-key',m.remote.privateKeyPath);setField('remote-backend',m.remote.backend);setField('remote-uri',m.remote.libvirtUri);$('remote-status').textContent=m.problem?m.problem:(m.remote.configured?(m.remote.report?(m.remote.report.ready?'Environment verified · ':'Needs attention · ')+m.remote.detail:'Configured · '+m.remote.detail):m.remote.detail);$('remote-status').className=m.problem||m.remote.error?'error':'';}
resources();controls();const signature=m.backend+JSON.stringify(m.vms);if(signature===inventorySignature)return;inventorySignature=signature;$('vms').replaceChildren();
if(!m.vms.length){const p=document.createElement('p');p.textContent=m.version?'No desktops yet. Create your first one above.':'VMs appear here after the selected hypervisor is ready.';$('vms').append(p);}
const labels={running:'Running',poweroff:'Stopped',saved:'Saved',paused:'Paused',aborted:'Stopped unexpectedly',unavailable:'Unavailable',gurumeditation:'VM error · inspect in VirtualBox'};
for(const vm of m.vms){const row=document.createElement('div');row.className='vm';const title=document.createElement('strong');title.textContent=vm.name;const info=document.createElement('p');info.textContent=(labels[vm.state]||vm.state)+' · '+(vm.memory||'?')+' MB · '+(vm.cpus||'?')+' CPUs';row.append(title,info);
if(vm.installation&&!vm.installation.verified){const note=document.createElement('small');note.textContent=vm.installation.status==='failed'?'Setup needs attention. Open the screen or setup log.':vm.installation.mode==='manual'?'Manual installation: follow the installer in the VM screen. Use the account you create there.':'OS installation started; desktop readiness has not been verified.';row.append(note);}
const actions=document.createElement('div');actions.className='row';const machineActions=m.backend==='remote'?[['start',vm.state==='running'?'View screen':'Start'],['screen','Screenshot'],['stop','Shut Down']]:m.backend==='virtualbox'?[['start','Start / View Screen'],['bootstrap','Inject Bootstrap'],['stop','Shut Down'],['delete','Delete']]:[['start',m.backend==='hyperv'?'Start':'Start / View Screen'],['stop','Shut Down'],['delete','Delete']];for(const [type,label] of machineActions){const b=document.createElement('button');b.textContent=label;b.setAttribute('aria-label',label+' '+vm.name);b.dataset.action=type;b.dataset.id=vm.id;b.className='secondary mutating';b.disabled=busy||(type==='screen'&&!['running','paused'].includes(vm.state))||(type==='bootstrap'&&!['running','paused'].includes(vm.state))||(type==='delete'&&(!['poweroff','saved','aborted'].includes(vm.state)||(m.backend!=='virtualbox'&&!vm.managed)))||(type==='stop'&&vm.state!=='running')||(type==='start'&&(!['running','poweroff','saved','aborted'].includes(vm.state)||(m.backend==='hyperv'&&vm.state==='running')));b.dataset.unavailable=String(b.disabled&&!busy);actions.append(b);}row.append(actions);$('vms').append(row);}
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
 return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:16px;line-height:1.6}img{display:block;margin:8px auto;width:80px;height:80px;object-fit:contain}h2{text-align:center;font-size:17px}p{color:var(--vscode-descriptionForeground)}button{display:block;width:100%;margin:12px 0;border:1px solid var(--vscode-button-border,transparent);border-radius:3px;padding:9px 8px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}small{color:var(--vscode-descriptionForeground)}</style></head><body><img src="${logoUri}" alt="VAMP bat with a virtual machine"><h2>VAMP</h2><p>RPAs, virtual machines and credentials.</p><button data-type="library">RPA Library</button><button class="secondary" data-type="manager">Open VM Manager</button><button class="secondary" data-type="vault">Browse Credentials</button><button class="secondary" data-type="screen">View Running VM</button><button class="secondary" data-type="remote">Remote Server (SSH)</button><button class="secondary" data-type="guide">Setup Guide</button><small>VirtualBox and KVM: screen inside VS Code.<br>Hyper-V: management only; use VMConnect.<br>Remote: screenshots over SSH.</small><script nonce="${nonce}">const api=acquireVsCodeApi();function select(type){document.querySelectorAll('button[data-type]').forEach(button=>{const active=button.dataset.type===type;button.classList.toggle('secondary',!active);button.setAttribute('aria-current',active?'page':'false');});api.setState({selected:type});}select(api.getState()?.selected||'library');document.addEventListener('click',e=>{const b=e.target.closest('button[data-type]');if(b){select(b.dataset.type);api.postMessage({type:b.dataset.type});}});</script></body></html>`;
}
module.exports={registerManager,parseInventory,parseInfo,recommendedResources,managerHTML,screenHTML,sidebarHTML,bootstrapGuestEngine:bootstrapEngine};
