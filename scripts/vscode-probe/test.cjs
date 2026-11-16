const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
exports.run = async function () {
  const root = 'C:\\VAMP-Lab';
  const report = {status: 'running', checks: []};
  const destination = path.join(root, 'vscode-native-result.json');
  try {
    const config = vscode.workspace.getConfiguration('vampVault');
    for (const [key, value] of Object.entries({keepassxcCliPath: 'C:\\Program Files\\KeePassXC\\keepassxc-cli.exe', veracryptCliPath: 'C:\\Program Files\\VeraCrypt\\VeraCrypt.exe', defaultKdbxPath: path.join(root,'ui-vault.kdbx'), autoDownloadCli: false})) {
      await config.update(key, value, vscode.ConfigurationTarget.Global);
    }
    await vscode.workspace.getConfiguration('vamp').update('pythonExecutable', 'C:\\ProgramData\\VAMP\\Python312\\python.exe', vscode.ConfigurationTarget.Global);
    for (const id of ['wayfarer6.vamp-mcp', 'wayfarer6.vamp-vault']) {
      const extension = vscode.extensions.getExtension(id);
      assert.ok(extension, `${id} installed`);
      await extension.activate();
      assert.equal(extension.isActive, true);
      report.checks.push(`${id} activates in real Windows extension host`);
      const commands = new Set(await vscode.commands.getCommands(true));
      for (const {command} of extension.packageJSON.contributes.commands) assert.ok(commands.has(command), `registered command ${command}`);
      report.checks.push(`${id} declared commands registered`);
    }
    await vscode.commands.executeCommand('vamp.openGuide');
    report.checks.push('VAMP guide command executes');
    await vscode.commands.executeCommand('vampVault.refreshTree');
    await vscode.commands.executeCommand('workbench.view.extension.vamp-vault');
    report.checks.push('Vault sidebar opens and refreshes');
    await vscode.commands.executeCommand('vampVault.lock');
    report.checks.push('Vault lock command completes');
    await vscode.commands.executeCommand('vamp.setupPython');
    const managed=path.join(root,'vscode-profile','User','globalStorage','wayfarer6.vamp-mcp','python','Scripts','python.exe');
    assert.ok(fs.existsSync(managed),'managed Python created by the actual setup command');
    const sdk=await promisify(execFile)(managed,['-c','from vboxapi import VirtualBoxManager; m=VirtualBoxManager(None,None); print(m.getVirtualBox().version)'],{timeout:30000});
    assert.match(sdk.stdout,/7\.2\.22/);
    report.checks.push('actual Python setup command installs matching Windows SDK and COM works');
    report.status = 'passed';
  } catch(error) {report.status='failed';report.error=error.stack;throw error;}
  finally {fs.writeFileSync(destination, JSON.stringify(report,null,2));}
};
