const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);
const version = require('./package.json').version;

function activate(context) {
  const changes = new vscode.EventEmitter();
  const config = () => vscode.workspace.getConfiguration('vamp');
  const pythonPath = () => path.join(context.globalStorageUri.fsPath,'python',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const runtime = context.asAbsolutePath('dist/runtime');
  const output = vscode.window.createOutputChannel('VAMP');
  context.subscriptions.push(output, changes);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if(e.affectsConfiguration('vamp')) changes.fire();
  }));
  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider('vamp.virtualbox', {
    onDidChangeMcpServerDefinitions: changes.event,
    provideMcpServerDefinitions() {
      const env = {ELECTRON_RUN_AS_NODE:'1',VBOXMANAGE_DEBUG:'false',RPA_HOST_PYTHON:pythonPath(),MOUSE_HELPER_PATH:path.join(runtime,'backends/virtualbox/mouse_click.py')};
      if(config().get('vboxManagePath')) env.VBOXMANAGE_PATH=config().get('vboxManagePath');
      if(config().get('mousePythonExecutable')) env.PYTHON_PATH=config().get('mousePythonExecutable');
      return [new vscode.McpStdioServerDefinition('VAMP VirtualBox',process.execPath,
        [path.join(runtime,'backends/virtualbox/server.mjs')],env,version)];
    }
  }));
  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider('vamp.kvm', {
    onDidChangeMcpServerDefinitions: changes.event,
    provideMcpServerDefinitions() {
      const repository = config().get('kvmRepositoryPath');
      if (!repository || !fs.existsSync(path.join(repository, 'vm_mcp_server.py'))) return [];
      const python = config().get('kvmPythonExecutable') || path.join(repository, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      const profile = config().get('kvmConfigPath') || path.join(repository, 'config/vm-mcp.json');
      return [new vscode.McpStdioServerDefinition('VAMP KVM (VNC)', python,
        [path.join(repository, 'vm_mcp_server.py')], {VM_MCP_CONFIG: profile}, version)];
    }
  }));
  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider('vamp.library',{
    onDidChangeMcpServerDefinitions:changes.event,
    provideMcpServerDefinitions(){
      return [new vscode.McpStdioServerDefinition('VAMP RPA Library',process.execPath,[path.join(runtime,'backends/library/server.mjs')],{
        ELECTRON_RUN_AS_NODE:'1',VAMP_RPA_REGISTRY:path.join(context.globalStorageUri.fsPath,'rpa-catalog'),
        RPA_HOST_PYTHON:pythonPath(),RPA_REPLAY_PYTHON:config().get('mousePythonExecutable')||pythonPath(),
        VBOXMANAGE_PATH:config().get('vboxManagePath')||'',VAMP_LIBVIRT_URI:config().get('libvirtUri')||'qemu:///session'
      },version)];
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
      await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'VAMP Python setup'}, async progress => {
        const configured=config().get('pythonExecutable');
        const candidates=configured ? [[configured,[]]] : process.platform==='win32' ? [['py',['-3']],['python',[]]] : [['python3',[]],['python',[]]];
        let selected;
        for(const [command,args] of candidates) {
          try { await run(command,[...args,'-c','import sys; assert sys.version_info >= (3,11)'],{timeout:15000}); selected=[command,args]; break; }
          catch {}
        }
        if(!selected) throw new Error('Install Python 3.11+ first, then run VAMP setup again.');
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
        vscode.window.showInformationMessage('VAMP Python ready. VirtualBox must be installed separately.');
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
  const remote = require('./remote-backend').registerRemote(context,{runtime,output,version,changes});
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
      view.webview.html=require('./vm-manager').sidebarHTML(String(logo),view.webview.cspSource);
      view.webview.onDidReceiveMessage(async message=>{
        const command={library:'vamp.openRpaLibrary',vault:'vamp.openVault',manager:'vamp.openManager',screen:'vamp.openVmScreen',guide:'vamp.openGuide',remote:'vamp.remote.openManager'}[message?.type];
        if(command){try{await vscode.commands.executeCommand(command);}catch(error){output.appendLine(error.message);}}
      });
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('vamp.openGuide', () =>
    vscode.commands.executeCommand('markdown.showPreview',vscode.Uri.file(context.asAbsolutePath('USAGE.md')))));
}
module.exports={activate};
