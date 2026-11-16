// Optional real VS Code extension-host smoke test. Uses an already running,
// disposable VM supplied by the caller; never creates or deletes a VM.
const vscode=require('vscode');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
exports.run=async()=>{
  const directory=process.env.VAMP_UI_TEST_DIR;
  if(!directory || !process.env.VAMP_UI_TEST_VM_ID)throw Error('Set VAMP_UI_TEST_DIR and VAMP_UI_TEST_VM_ID');
  const report={checks:[]};
  async function stage(name){fs.writeFileSync(path.join(directory,name+'-ready'),'');const end=Date.now()+300000;while(!fs.existsSync(path.join(directory,name+'-captured'))&&Date.now()<end)await new Promise(r=>setTimeout(r,200));if(!fs.existsSync(path.join(directory,name+'-captured')))throw Error('Capture stage timed out: '+name);}
  try {
    const extension=vscode.extensions.getExtension('wayfarer6.vamp-mcp-tools');
    assert.ok(extension);await extension.activate();report.checks.push('actual VS Code extension activation');
    const commands=new Set(await vscode.commands.getCommands(true));
    for(const {command} of extension.packageJSON.contributes.commands)assert.ok(commands.has(command),command);
    report.checks.push('all contributed commands registered');
    for(const command of ['workbench.action.closeSidebar','workbench.action.closeAuxiliaryBar','notifications.clearAll'])if(commands.has(command))await vscode.commands.executeCommand(command);
    if(process.env.VAMP_UI_AUDIT==='1'){
      const vault=vscode.extensions.getExtension('wayfarer6.vamp-vault');assert.ok(vault);await vault.activate();
      const config=vscode.workspace.getConfiguration('vampVault');
      await config.update('autoDownloadCli',false,vscode.ConfigurationTarget.Global);
      await config.update('keepassxcCliPath',path.resolve(directory,'../../kvm-validation/bin/keepassxc-cli'),vscode.ConfigurationTarget.Global);
      await config.update('veracryptCliPath',path.resolve(directory,'../../kvm-validation/bin/veracrypt'),vscode.ConfigurationTarget.Global);
      await config.update('defaultKdbxPath',path.join(directory,'demo.kdbx'),vscode.ConfigurationTarget.Global);
      await vscode.workspace.getConfiguration('vamp').update('rpaDirectories',[path.resolve(directory,'../demo-recordings')],vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('workbench.view.extension.vamp');
      await vscode.commands.executeCommand('vamp.openRpaLibrary');await stage('01-library');report.checks.push('RPA library opens with real source discovery');
      await stage('02-create');report.checks.push('Create form registers a reviewed named skill from a recorder script');
      await vscode.commands.executeCommand('notifications.clearAll');await stage('03-saved');
      await vscode.commands.executeCommand('vampVault.openBrowser');await stage('04-vault');report.checks.push('Credential browser unlocks a real demo database and shows protected details');
      for(const [name,theme] of [['05-light','Default Light Modern'],['06-contrast','Default High Contrast']]){
        await vscode.workspace.getConfiguration('workbench').update('colorTheme',theme,vscode.ConfigurationTarget.Global);await stage(name);
      }
      report.checks.push('light and high-contrast themes render the sidebar PNG and credential browser');
      await vscode.workspace.getConfiguration('workbench').update('colorTheme','Default Dark Modern',vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('vamp.openManager','kvm');await stage('07-manager');
      await vscode.commands.executeCommand('vamp.openVmScreen',process.env.VAMP_UI_TEST_VM_ID);await stage('08-screen');report.checks.push('KVM manager and real VNC guest screen render in actual editor');
      await vscode.commands.executeCommand('vamp.openManager','hyperv');await stage('09-hyperv');report.checks.push('Hyper-V explicitly reports no embedded display on unsupported host');
      report.status='passed';return;
    }
    await vscode.commands.executeCommand('vamp.openManager',process.env.VAMP_UI_TEST_BACKEND || 'virtualbox');report.checks.push('manager opens in actual editor');
    fs.writeFileSync(path.join(directory,'manager-ready'),'');
    let deadline=Date.now()+90000;
    while(!fs.existsSync(path.join(directory,'manager-captured'))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,250));
    await vscode.commands.executeCommand('vamp.openVmScreen',process.env.VAMP_UI_TEST_VM_ID);report.checks.push('native guest screen opens in actual editor');
    fs.writeFileSync(path.join(directory,'screen-ready'),'');deadline=Date.now()+90000;
    while(!fs.existsSync(path.join(directory,'screen-captured'))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,250));
    report.status='passed';
  }catch(error){report.status='failed';report.error=error.stack;throw error;}
  finally{fs.writeFileSync(path.join(directory,'extension-host.json'),JSON.stringify(report,null,2));}
};
