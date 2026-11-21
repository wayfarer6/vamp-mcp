const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const exec = promisify(execFile);
const run = (command,args,options) => exec(command,args,{...options,windowsHide:true});
const version = require('./package.json').version;

function activate(context) {
  if(vscode.extensions?.getExtension('wayfarer6.vamp-mcp')) {
    vscode.window.showWarningMessage('VAMP: the legacy wayfarer6.vamp-mcp extension conflicts with VAMP MCP Tools. Update VAMP Vault, uninstall the legacy extension, then reload VS Code.','Show legacy extension').then(choice=>{if(choice==='Show legacy extension')vscode.commands.executeCommand('workbench.extensions.search','@id:wayfarer6.vamp-mcp');});
    return;
  }
  const changes = new vscode.EventEmitter();
  const config = () => vscode.workspace.getConfiguration('vamp');
  const pythonPath = () => path.join(context.globalStorageUri.fsPath,'python',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const runtime = context.asAbsolutePath('dist/runtime');
  const output = vscode.window.createOutputChannel('VAMP');
  const administrator = process.platform === 'win32'
    ? require(path.join(runtime,'backends/common/windows-admin.cjs')).isAdministrator()
    : Promise.resolve(true);
  if (process.platform === 'win32') {
    administrator.then(elevated => {
      if (!elevated) vscode.window.showWarningMessage(
        'VAMP: Local VM MCP requires an administrator VS Code session. Close this window and reopen VS Code using Run as administrator.'
      );
    }).catch(error => output.appendLine('Could not verify Windows administrator status: '+error.message));
  }
  const containersSource=path.join(__dirname,'src/containers-panel.cjs');
  const containersUI=require(fs.existsSync(containersSource)?containersSource:'./dist/containers_panel.cjs');
  // Machine/user value only: workspace folders cannot redirect this privileged config.
  const workspaceConfigPath=()=>config().inspect('podman.workspaceConfigPath')?.globalValue||process.env.VAMP_WORKSPACE_CONFIG||'';
  const createContainersBackend=()=>{
    const development=path.join(__dirname,'../backends/podman/adapter.cjs');
    const adapter=require(fs.existsSync(development)?development:path.join(runtime,'backends/podman/adapter.cjs')).createPodmanAdapter({workspaceConfigPath:workspaceConfigPath(),desktopImageIds:config().get('podman.desktopImageIds')||[]});
    return {workspaceStatus:(name,binding)=>adapter.workspaceStatus(name,binding),workspaceAttach:(name,binding,approvalId)=>adapter.workspaceAttach(name,binding,approvalId),connections:()=>adapter.connections(),status:name=>adapter.check(name),list:name=>adapter.list(name),
      start:(name,id,binding)=>adapter.start(name,id,binding),stop:(name,id,binding)=>adapter.stop(name,id,binding),logs:(name,id,binding)=>adapter.logs(name,id,100,binding),detectLocal:()=>adapter.detectLocal(),capture:(name,id,binding)=>adapter.capture(name,id,binding),openScreenStream:(name,id,binding)=>adapter.openScreenStream(name,id,binding),screenTarget:(name,id,binding)=>adapter.screenTarget(name,id,binding)};
  };
  const openContainerDesktop=options=>{
    const source=path.join(__dirname,'src/container-viewer.cjs');
    const {createContainerViewerBridge}=require('./dist/container_viewer_bridge.cjs');
    return require(fs.existsSync(source)?source:'./dist/container_viewer.cjs').openViewer(vscode,context,{...options,createBridge:createContainerViewerBridge});
  };
  let debianEngineHost;
  const debianHost=()=>{
    if(!debianEngineHost){
      const development=path.join(__dirname,'../backends/podman/debian-host.cjs');
      debianEngineHost=require(fs.existsSync(development)?development:path.join(runtime,'backends/podman/debian-host.cjs')).createDebianHost({runtime,python:pythonPath()});
    }
    return debianEngineHost;
  };
  containersUI.registerContainers(context,{vscode,output,createDebianHost:isActive=>{
    const source=path.join(__dirname,'src/debian-engine-create.cjs');
    return require(fs.existsSync(source)?source:'./dist/debian_engine_create.cjs').createDebianEngine(vscode,{isActive,prepareDebianHost:req=>debianHost().prepareDebianHost(req)});
  },debianHostStatus:id=>debianHost().debianHostStatus(id),createBackend:createContainersBackend,openDesktop:openContainerDesktop,openCapture:result=>{
    const source=path.join(__dirname,'src/container-capture.cjs');
    context.subscriptions.push(require(fs.existsSync(source)?source:'./dist/container_capture.cjs').showCapture(vscode,result));
  }});
  context.subscriptions.push(output, changes);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if(e.affectsConfiguration('vamp')) changes.fire();
  }));
  // One public MCP provider. GUI commands retain their separate, explicit workflows.
  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider('vamp.mcp', {
    onDidChangeMcpServerDefinitions: changes.event,
    async provideMcpServerDefinitions() {
      if (!await administrator.catch(() => false)) return [];
      const env = {
        ELECTRON_RUN_AS_NODE:'1',VBOXMANAGE_DEBUG:'false',
        VAMP_WORKSPACE_CONFIG:workspaceConfigPath(),
        VAMP_DESKTOP_IMAGE_IDS:(config().get('podman.desktopImageIds')||[]).join(','),
        RPA_HOST_PYTHON:pythonPath(),RPA_REPLAY_PYTHON:config().get('mousePythonExecutable')||pythonPath(),
        MOUSE_HELPER_PATH:path.join(runtime,'backends/virtualbox/mouse_click.py'),
        VAMP_RPA_REGISTRY:path.join(context.globalStorageUri.fsPath,'rpa-catalog'),
        VAMP_LIBVIRT_URI:config().get('libvirtUri')||'qemu:///session',
        VAMP_REMOTE_REPO:runtime,VAMP_REMOTE_WORKDIR:context.globalStorageUri.fsPath,
        VAMP_REMOTE_PYTHON:config().get('kvmPythonExecutable')||config().get('pythonExecutable')||'python3'
      };
      if(config().get('vboxManagePath'))env.VBOXMANAGE_PATH=config().get('vboxManagePath');
      if(config().get('mousePythonExecutable'))env.PYTHON_PATH=config().get('mousePythonExecutable');
      const ocrPython=config().inspect('ocrPythonExecutable')?.globalValue||process.env.VAMP_OCR_PYTHON;
      if(ocrPython)env.VAMP_OCR_PYTHON=ocrPython;
      const repository=config().get('kvmRepositoryPath');
      const pythonProfile={enabled:!!(repository&&path.isAbsolute(repository)&&fs.existsSync(path.join(repository,'vm_mcp_server.py')))};
      if(pythonProfile.enabled){
        pythonProfile.repo=repository;
        pythonProfile.python=config().get('kvmPythonExecutable')||path.join(repository,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
        pythonProfile.config=config().get('kvmConfigPath')||path.join(repository,'config/vm-mcp.json');
      }
      env.VAMP_PYTHON_CONFIG_JSON=JSON.stringify(pythonProfile);
      // Credentials remain configured paths; defining the server does not connect.
      const remoteConfig={enabled:Boolean(config().get('remote.enabled'))};
      if(remoteConfig.enabled)for(const key of ['host','port','username','privateKeyPath','backend','libvirtUri','remotePythonPath','remoteNodePath','remoteRepoPath','remoteRegistryPath','remoteVboxManagePath','connectTimeoutSeconds'])remoteConfig[key]=config().get('remote.'+key);
      env.VAMP_REMOTE_CONFIG_JSON=JSON.stringify(remoteConfig);
      try {
        const vault=await vscode.extensions?.getExtension('wayfarer6.vamp-vault')?.activate();
        const bridge=await vault?.replayBridge?.();
        if(bridge){
          env.VAULT_RPA_BRIDGE_SOCKET=bridge.socketPath;
          env.VAULT_RPA_BRIDGE_TOKEN=bridge.token;
        }
      }catch{
        // Vault is optional for workflows that do not deliver credentials.
      }
      return [new vscode.McpStdioServerDefinition('VAMP MCP',process.execPath,
        [path.join(runtime,'backends/unified/server.mjs')],env,version)];
    }
  }));
  const viewerPanels = new Map();
  context.subscriptions.push({dispose(){for(const panel of viewerPanels.values())panel.dispose();viewerPanels.clear();}});
  context.subscriptions.push(vscode.commands.registerCommand('vamp.openKvmViewer', async () => {
    try {
      const repository=config().get('kvmRepositoryPath');
      if(!repository || !fs.existsSync(path.join(repository,'scripts/kvm_view_info.py'))) {
        throw new Error('Set VAMP: Kvm Repository Path to the local VAMP checkout first.');
      }
      const python=config().get('kvmPythonExecutable') || path.join(repository,'.venv',process.platform==='win32' ? 'Scripts/python.exe' : 'bin/python');
      const profile=config().get('kvmConfigPath') || path.join(repository,'config/vm-mcp.json');
      const inspect=async args=>{
        const result=await run(python,[path.join(repository,'scripts/kvm_view_info.py'),'--config',profile,...args],{timeout:30000,maxBuffer:1024*1024});
        const data=JSON.parse(result.stdout);if(data.status==='error')throw new Error(data.error_summary);return data;
      };
      const inventory=await inspect(['--list']);
      const rows=inventory.vms.filter(vm=>vm.exists && ['running','paused'].includes(vm.state) && vm.backend==='vnc')
        .map(vm=>({label:vm.name,description:`${vm.guest_os} · ${vm.state}`,name:vm.name}));
      if(!rows.length)throw new Error('No running VNC VM is configured. Start a KVM VNC guest first.');
      const selected=await vscode.window.showQuickPick(rows,{title:'VAMP: Open KVM Viewer · View only'});if(!selected)return;
      if(viewerPanels.has(selected.name)){viewerPanels.get(selected.name).reveal();return;}
      const info=await inspect(['--vm',selected.name]);
      const {startBridge,viewerHTML}=require('./dist/viewer_bridge.cjs');
      let panel;
      let currentEndpoint=info;
      const bridge=await startBridge({host:info.host,port:info.port,
        resolveTarget:()=>inspect(['--vm',selected.name]),
        onTarget:target=>{currentEndpoint=target;panel?.webview.postMessage({type:'endpointChanged',host:target.host,port:target.port});},
        onError:message=>output.appendLine('VNC viewer: '+message)});
      try {
        panel=vscode.window.createWebviewPanel('vamp.kvmViewer','VAMP · '+selected.name,vscode.ViewColumn.Active,
          {enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'dist/webview')]});
        const scriptUri=panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,'dist/webview/viewer.js'));
        panel.webview.html=viewerHTML({scriptUri:String(scriptUri),wsUrl:bridge.url,cspSource:panel.webview.cspSource,name:selected.name,host:info.host,port:info.port});
        viewerPanels.set(selected.name,panel);
        panel.webview.onDidReceiveMessage(async message=>{
          if(message.type==='copyEndpoint'){await vscode.env.clipboard.writeText(`${currentEndpoint.host}:${currentEndpoint.port}`);panel.webview.postMessage({type:'endpointCopied'});}
          if(['connected','disconnected'].includes(message.type))output.appendLine(`VNC viewer ${selected.name}: ${message.type}; live RFB stream, view only`);
        });
        panel.onDidDispose(()=>{bridge.dispose();viewerPanels.delete(selected.name);});
      } catch(error){bridge.dispose();panel?.dispose();throw error;}
    } catch(error){output.appendLine(String(error));vscode.window.showErrorMessage('VAMP viewer: '+error.message);}
  }));
  let settingUp = false;
  context.subscriptions.push(vscode.commands.registerCommand('vamp.setupPython', async () => {
    if(settingUp) return false;
    settingUp=true;
    try {
      await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'VAMP environment setup'}, async progress => {
        const configured=config().get('pythonExecutable');
        // Any interpreter from 3.11 upward is accepted, including 3.15 and
        // later, because Python compares its own version tuple here.
        const candidates=configured ? [[configured,[]]] : process.platform==='win32' ? [['py',['-3']],['python',[]],['python3',[]]] : [['python3',[]],['python',[]],['/opt/homebrew/bin/python3',[]],['/usr/local/bin/python3',[]]];
        let selected;
        for(const [command,args] of candidates) {
          try { await run(command,[...args,'-c','import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'],{timeout:15000}); selected=[command,args]; break; }
          catch {}
        }
        if(!selected) throw new Error(`Install Python 3.11 or newer (3.11 through 3.15+ all work)${configured?`; VAMP: Python Executable points at "${configured}"`:'; tune it with VAMP: Python Executable'}, then run VAMP setup again.`);
        try { const detected=await run(selected[0],[...selected[1],'-c','import sys; print("%d.%d.%d" % sys.version_info[:3])'],{timeout:15000}); output.appendLine(`Python ${detected.stdout.trim()} (${selected[0]})`); } catch {}
        fs.mkdirSync(context.globalStorageUri.fsPath,{recursive:true});
        progress.report({message:'Creating isolated venv'});
        await run(selected[0],[...selected[1],'-m','venv',path.dirname(path.dirname(pythonPath()))],{timeout:120000});
        progress.report({message:'Installing host packages'});
        const result=await run(pythonPath(),['-m','pip','install','-r',path.join(runtime,'backends/virtualbox/requirements.txt')],{timeout:300000,maxBuffer:4*1024*1024});
        output.appendLine(result.stdout); output.appendLine(result.stderr);
        if(process.platform==='win32') {
          const vbox=config().get('vboxManagePath') || path.join(process.env.ProgramFiles || 'C:\\Program Files','Oracle','VirtualBox','VBoxManage.exe');
          if(fs.existsSync(vbox)) {
            progress.report({message:'Preparing matching VirtualBox mouse SDK'});
            const sdk=await run(pythonPath(),[path.join(runtime,'backends/virtualbox/setup_windows_sdk.py'),'--storage',path.join(context.globalStorageUri.fsPath,'sdk'),'--vboxmanage',vbox],{timeout:420000,maxBuffer:4*1024*1024});
            output.appendLine(sdk.stdout);output.appendLine(sdk.stderr);
          } else output.appendLine('Install VirtualBox and rerun Python setup to prepare its mouse SDK.');
        }
        changes.fire();
        const packer=require('./host-backends').preparePacker;
        if(packer)await packer({runtime,python:pythonPath},context.globalState?.get('vamp.manager.backend')||'virtualbox');
        progress.report({message:'Selecting and installing YOLO and OCR for the host hardware'});
        const visionSetup=path.join(runtime,'scripts/setup_vision.py');
        const visionCandidates=process.env.VAMP_VISION_PYTHON ? [[process.env.VAMP_VISION_PYTHON,[]]]
          : [...(process.platform==='win32' ? [['py',['-3.12']]] : [['python3.12',[]]]), selected];
        let visionPython;
        for(const [command,args] of visionCandidates) {
          try {
            await run(command,[...args,'-c','import sys; raise SystemExit(not (3, 11) <= sys.version_info[:2] <= (3, 13))'],{timeout:15000});
            visionPython=[command,args]; break;
          } catch {}
        }
        if(!visionPython)throw new Error('Install Python 3.12 and rerun VAMP environment setup to install the vision runtimes.');
        const vision=await run(visionPython[0],[...visionPython[1],visionSetup],{timeout:2700000,maxBuffer:8*1024*1024});
        output.appendLine(vision.stdout); output.appendLine(vision.stderr);
        vscode.window.showInformationMessage('VAMP environment ready. Packer and the host OCR and YOLO runtimes are installed. Install the hypervisor and device drivers separately.');
      });
      return true;
    } catch(error) { output.appendLine(String(error)); output.show(); vscode.window.showErrorMessage(`VAMP setup failed: ${error.message}`); return false; }
    finally {settingUp=false;}
  }));
  context.subscriptions.push(vscode.commands.registerCommand('vamp.removePython',async()=>{
    if(settingUp){vscode.window.showWarningMessage('Wait for environment preparation to finish.');return false;}
    const answer=await vscode.window.showWarningMessage('Delete the VAMP Python environment?',{modal:true,detail:'Stop VAMP Python MCP processes first. This removes only the managed Python environment; VM disks, saved RPAs and vault files are kept. Prepare Environment can recreate it.'},'Delete Environment');
    if(answer!=='Delete Environment')return false;
    settingUp=true;
    try{await fs.promises.rm(path.join(context.globalStorageUri.fsPath,'python'),{recursive:true,force:true});changes.fire();return true;}
    catch(error){output.appendLine(error.message);vscode.window.showErrorMessage('Could not delete environment: '+error.message);return false;}
    finally{settingUp=false;}
  }));
  context.subscriptions.push(vscode.commands.registerCommand('vamp.openVault',()=>vscode.extensions.getExtension('wayfarer6.vamp-vault')?vscode.commands.executeCommand('vampVault.openBrowser'):vscode.commands.executeCommand('workbench.extensions.search','@id:wayfarer6.vamp-vault')));
  require('./rpa-library').registerLibrary(context,{runtime,output});
  const remote = require('./remote-backend').registerRemote(context,{runtime,output,version,changes,registerMcp:false});
  require('./vm-manager').registerManager(context,{
    pythonPath,runtime,output,remote,
    setupPython:()=>vscode.commands.executeCommand('vamp.setupPython')
  });
  for(const command of ['vamp.onboard','vamp.createVM']) {
    context.subscriptions.push(vscode.commands.registerCommand(command,()=>vscode.commands.executeCommand('vamp.openManager')));
  }
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('vamp.desktops',{
    resolveWebviewView(view){
      view.webview.options={enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'assets')]};
      const logo=view.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,'assets/sidebar-brand.png'));
      view.webview.html=containersUI.withContainersSidebar(require('./vm-manager').sidebarHTML(String(logo),view.webview.cspSource));
      view.webview.onDidReceiveMessage(async message=>{
        const command={library:'vamp.openRpaLibrary',vault:'vamp.openVault',manager:'vamp.openManager',containers:'vamp.openContainers',screen:'vamp.openVmScreen',guide:'vamp.openGuide',remote:'vamp.remote.openManager'}[message?.type];
        if(command){try{await vscode.commands.executeCommand(command);}catch(error){output.appendLine(error.message);}}
      });
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('vamp.openGuide', () =>
    vscode.commands.executeCommand('markdown.showPreview',vscode.Uri.file(context.asAbsolutePath('USAGE.md')))));
  context.subscriptions.push(vscode.commands.registerCommand('vamp.openResolutionGuide', () =>
    vscode.commands.executeCommand('markdown.showPreview',vscode.Uri.file(context.asAbsolutePath('RESOLUTION.md')))));
}
module.exports={activate};
