const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);

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
        [path.join(runtime,'backends/virtualbox/server.mjs')],env,'0.1.2')];
    }
  }));
  let settingUp = false;
  context.subscriptions.push(vscode.commands.registerCommand('vamp.setupPython', async () => {
    if(settingUp) return;
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
        changes.fire();
        vscode.window.showInformationMessage('VAMP Python ready. VirtualBox must be installed separately.');
      });
    } catch(error) { output.appendLine(String(error)); output.show(); vscode.window.showErrorMessage(`VAMP setup failed: ${error.message}`); }
    finally {settingUp=false;}
  }));
  context.subscriptions.push(vscode.commands.registerCommand('vamp.onboard',async()=>{
    const exe=config().get('vboxManagePath') || (process.platform==='win32' ? path.join(process.env.ProgramFiles || 'C:/Program Files','Oracle/VirtualBox/VBoxManage.exe') : 'VBoxManage');
    try {await run(exe,['--version'],{timeout:15000});}
    catch {
      const selected=await vscode.window.showInformationMessage('Install VirtualBox on this host first. VAMP can guide you; host drivers may require administrator access.','Open Official Downloads','Later');
      if(selected==='Open Official Downloads') await vscode.env.openExternal(vscode.Uri.parse('https://www.virtualbox.org/wiki/Downloads'));
      return;
    }
    if(!fs.existsSync(pythonPath())) await vscode.commands.executeCommand('vamp.setupPython');
    if(fs.existsSync(pythonPath())) await vscode.commands.executeCommand('vamp.createVM');
  }));
  if(!context.globalState.get('vamp.onboardSeen')) {
    context.globalState.update('vamp.onboardSeen',true);
    vscode.window.showInformationMessage('Set up VAMP VM environment? Debian is the default. Windows is optional for Windows-only certificate/security software.','Set Up','Later')
      .then(choice=>{if(choice==='Set Up')vscode.commands.executeCommand('vamp.onboard');});
  }
  let creatingVM = false;
  context.subscriptions.push(vscode.commands.registerCommand('vamp.createVM', async () => {
    if(creatingVM) return;
    if(!fs.existsSync(pythonPath())) {
      vscode.window.showErrorMessage('Run VAMP: Set Up Python Environment first.'); return;
    }
    const os=await vscode.window.showQuickPick([
      {label:'Debian GNOME (recommended default)',id:'debian'},
      {label:'Windows 11 (optional, license required)',id:'windows11'},
      {label:'Ubuntu GNOME (experimental unattended profile)',id:'ubuntu'}
    ],{title:'Choose guest OS; Windows is optional'});
    if(!os)return;
    const profiles=JSON.parse(fs.readFileSync(path.join(runtime,'backends/virtualbox/profiles.json'),'utf8')).profiles;
    const profile=profiles[os.id];
    const confirm=await vscode.window.showInformationMessage(
      `${os.label}: ${profile.memory_mb} MB RAM, ${profile.cpus} CPUs, ${profile.disk_mb/1024} GiB dynamic disk, 1920x1080. Public login vboxuser/password123!. ${os.id==='windows11' ? 'Windows requires your own valid license; activate it after installation.' : 'Installation proceeds automatically after selecting a supported ISO.'}`,
      {modal:true},'Select ISO and Create');
    if(confirm!=='Select ISO and Create')return;
    const files=await vscode.window.showOpenDialog({canSelectMany:false,filters:{'OS installation ISO':['iso']},
      title:'VAMP sandbox VM: public account vboxuser / password123!'});
    if(!files || !files.length) return;
    creatingVM=true;
    try {
      await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'VAMP: Preparing unattended VM installation'}, async () => {
        const env={...process.env};
        if(config().get('vboxManagePath')) env.VBOXMANAGE_PATH=config().get('vboxManagePath');
        const result=await new Promise((resolve,reject) => {
          const child=execFile(pythonPath(),[path.join(runtime,'backends/virtualbox/provision.py'),'--json-stdin'],
            {timeout:420000,env},(error,stdout,stderr)=>error ? reject(new Error(stdout || stderr || error.message)) : resolve(stdout));
          child.stdin.end(JSON.stringify({iso_path:files[0].fsPath,guest_os:os.id,windows_confirmed:os.id==='windows11'}));
        });
        output.appendLine(result); output.show();
        const details=JSON.parse(result);
        if(details.guest_additions) vscode.window.showInformationMessage(details.guest_additions.status==='media_inserted'
          ? 'After Windows installation: open the Guest Additions CD, run VBoxWindowsAdditions.exe, approve UAC and reboot. Then set 1920x1080, Scale 100%.'
          : 'Windows Guest Additions ISO was not found. Supply a matching ISO through vm_insert_guest_additions, then install it manually.');
        if(details.status!=='installation_started') {vscode.window.showWarningMessage(details.action_required || details.status);return;}
        vscode.window.showInformationMessage('VAMP installation started. Public guest login: vboxuser / password123!. Guest installation completion is not yet verified.');
      });
    } catch(error) {output.appendLine(String(error));output.show();vscode.window.showErrorMessage(`VAMP creation failed: ${error.message}`);}
    finally {creatingVM=false;}
  }));
  context.subscriptions.push(vscode.commands.registerCommand('vamp.openGuide', () =>
    vscode.commands.executeCommand('markdown.showPreview',vscode.Uri.file(context.asAbsolutePath('README.md')))));
}
module.exports={activate};
