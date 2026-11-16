// VAMP remote desktop support: SSH-based MCP server plus manager commands.
// The remote host keeps its own credentials and hypervisor access; this module
// only starts an SSH client and reads screenshots back.
const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const SETTING_KEYS = {
  host: 'host',
  port: 'port',
  username: 'username',
  privateKeyPath: 'privateKeyPath',
  backend: 'backend',
  libvirtUri: 'libvirtUri',
  remotePythonPath: 'remotePythonPath',
  remoteNodePath: 'remoteNodePath',
  remoteRepoPath: 'remoteRepoPath',
  remoteRegistryPath: 'remoteRegistryPath',
  remoteVboxManagePath: 'remoteVboxManagePath',
  connectTimeoutSeconds: 'connectTimeoutSeconds',
};

function remoteModule() {
  try {
    return require('./dist/remote_client.cjs');
  } catch (error) {
    throw new Error('The remote client bundle is missing. Run the VAMP build (npm run build) and reload the window.');
  }
}

function registerRemote(context, { runtime, output, version, changes }) {
  const cfg = () => vscode.workspace.getConfiguration('vamp');
  const last = { report: null, error: '', checkedAt: null };

  const read = () => {
    const config = cfg();
    const value = { enabled: Boolean(config.get('remote.enabled')), host: '' };
    for (const [key, suffix] of Object.entries(SETTING_KEYS)) value[key] = config.get(`remote.${suffix}`);
    return value;
  };
  const normalize = raw => remoteModule().normalizeRemoteConfig(raw);
  const configured = () => {
    const raw = read();
    if (!raw.enabled || !String(raw.host || '').trim()) return null;
    try {
      normalize(raw);
      return raw;
    } catch {
      return null;
    }
  };
  const clientFor = raw => {
    const module = remoteModule();
    return new module.RemoteSshClient(module.normalizeRemoteConfig(raw));
  };
  const summary = () => {
    const raw = read();
    if (!raw.enabled) return { configured: false, enabled: false, detail: 'Remote server is turned off. Enable “VAMP: Remote Enabled”.' };
    if (!String(raw.host || '').trim()) return { configured: false, enabled: true, detail: 'Set the remote host to connect over SSH.' };
    try {
      const normalized = normalize(raw);
      return {
        configured: true,
        enabled: true,
        host: normalized.host,
        port: normalized.port,
        username: normalized.username,
        backend: normalized.backend,
        libvirtUri: normalized.libvirtUri,
        privateKeyPath: normalized.privateKeyPath,
        target: `${normalized.username ? `${normalized.username}@` : ''}${normalized.host}`,
        detail: `${normalized.username ? `${normalized.username}@` : ''}${normalized.host}:${normalized.port} · ${normalized.backend === 'kvm' ? `KVM ${normalized.libvirtUri}` : 'VirtualBox'}`,
      };
    } catch (error) {
      return { configured: false, enabled: true, detail: error.message };
    }
  };

  async function saveSettings(values = {}) {
    const config = cfg();
    const updates = [];
    const assign = (key, value, target) => {
      if (value === undefined) return;
      updates.push(config.update(`remote.${SETTING_KEYS[key]}`, value, target));
    };
    const target = vscode.ConfigurationTarget.Global;
    if (values.enabled !== undefined) updates.push(config.update('remote.enabled', Boolean(values.enabled), target));
    if (values.host !== undefined) assign('host', String(values.host).trim(), target);
    if (values.port !== undefined) assign('port', Number(values.port) || 22, target);
    if (values.username !== undefined) assign('username', String(values.username).trim(), target);
    if (values.privateKeyPath !== undefined) assign('privateKeyPath', String(values.privateKeyPath).trim(), target);
    if (values.backend !== undefined) assign('backend', values.backend === 'virtualbox' ? 'virtualbox' : 'kvm', target);
    if (values.libvirtUri !== undefined) assign('libvirtUri', String(values.libvirtUri).trim() || 'qemu:///system', target);
    if (values.remotePythonPath !== undefined) assign('remotePythonPath', String(values.remotePythonPath).trim(), target);
    if (values.remoteNodePath !== undefined) assign('remoteNodePath', String(values.remoteNodePath).trim(), target);
    if (values.remoteRepoPath !== undefined) assign('remoteRepoPath', String(values.remoteRepoPath).trim(), target);
    if (values.remoteRegistryPath !== undefined) assign('remoteRegistryPath', String(values.remoteRegistryPath).trim(), target);
    if (values.remoteVboxManagePath !== undefined) assign('remoteVboxManagePath', String(values.remoteVboxManagePath).trim(), target);
    if (values.connectTimeoutSeconds !== undefined) assign('connectTimeoutSeconds', Math.max(3, Math.min(60, Number(values.connectTimeoutSeconds) || 10)), target);
    await Promise.all(updates);
    changes?.fire();
    return read();
  }

  function requireConfigured() {
    const raw = configured();
    if (!raw) throw new Error(summary().detail);
    return normalize(raw);
  }

  function reportLines(report) {
    for (const check of report.checks || []) {
      output.appendLine(`[${check.status}] ${check.label}: ${check.detail || ''}${check.fix ? ` · ${check.fix}` : ''}`);
    }
    for (const step of report.steps || []) {
      output.appendLine(`[${step.status}] ${step.label}${step.command ? ` · ${step.command}` : ''}${step.error ? ` · ${step.error}` : ''}`);
    }
  }

  async function verify({ quiet = false } = {}) {
    const normalized = requireConfigured();
    const client = clientFor(normalized);
    try {
      const report = await client.envCheck();
      last.report = report;
      last.error = '';
      last.checkedAt = new Date();
      reportLines(report);
      if (!quiet) {
        const ready = report.ready;
        const blockers = (report.blockers || []).map(item => `· ${item.detail}`).join('\n');
        const message = ready
          ? `Remote host ready · ${normalized.host} · ${normalized.backend === 'kvm' ? normalized.libvirtUri : 'VirtualBox'}`
          : `Remote host needs attention:\n${blockers}`;
        const actions = ready ? ['List desktops'] : ['Prepare environment', 'Open remote setup guide'];
        const choice = await vscode.window.showInformationMessage(message, ...actions);
        if (choice === 'List desktops') await listVMs();
        if (choice === 'Prepare environment') await vscode.commands.executeCommand('vamp.remote.setupEnvironment');
        if (choice === 'Open remote setup guide') await vscode.commands.executeCommand('vamp.openGuide');
      }
      return report;
    } catch (error) {
      last.error = error.message;
      output.appendLine(`Remote verify failed: ${error.message}`);
      if (!quiet) {
        const choice = await vscode.window.showErrorMessage(`VAMP remote host: ${error.message}`, 'Open setup guide', 'Show settings');
        if (choice === 'Open setup guide') await vscode.commands.executeCommand('vamp.openGuide');
        if (choice === 'Show settings') await vscode.commands.executeCommand('workbench.action.openSettings', 'vamp.remote');
      }
      throw error;
    }
  }

  async function setupRemote() {
    const normalized = requireConfigured();
    const client = clientFor(normalized);
    const serverFile = path.join(runtime, 'backends/remote_ssh/server.mjs');
    const setupScript = path.join(runtime, 'scripts/remote_host_setup.sh');
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `VAMP remote · ${normalized.host}`, cancellable: false },
      async progress => {
        progress.report({ message: 'Checking SSH connection and uploading the remote server…' });
        const upload = await client.upload({ serverFile, setupScript: fs.existsSync(setupScript) ? setupScript : undefined });
        output.appendLine(`Remote server ${upload.server_version} uploaded to ~/.vamp/remote/server.mjs`);
        progress.report({ message: 'Checking Python, hypervisor and VAMP prerequisites…' });
        const before = await client.envCheck();
        reportLines(before);
        progress.report({ message: 'Preparing the remote environment…' });
        const steps = await client.call('remote_env_setup', { install_packages: true, python_venv: true });
        reportLines(steps);
        const after = await client.envCheck();
        reportLines(after);
        last.report = after;
        last.error = '';
        last.checkedAt = new Date();
        const incomplete = steps.status !== 'ok' || !after.ready;
        const message = incomplete
          ? `Remote environment is partly ready. ${(after.blockers || []).map(item => item.detail).join(' · ') || steps.next_step}`
          : `Remote environment ready · ${normalized.host} · ${upload.server_version}`;
        if (incomplete) {
          const choice = await vscode.window.showWarningMessage(message, 'Open setup guide', 'View log');
          if (choice === 'Open setup guide') await vscode.commands.executeCommand('vamp.openGuide');
          if (choice === 'View log') output.show();
        } else {
          vscode.window.showInformationMessage(message);
        }
        return { upload, before, steps, after };
      },
    );
  }

  async function listVMs() {
    const normalized = requireConfigured();
    const client = clientFor(normalized);
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'VAMP remote · listing desktops' },
      () => client.list(),
    );
    output.appendLine(`Remote ${normalized.host}: ${result.count} desktop(s)`);
    return result;
  }

  async function pickVM({ runningOnly = true, title } = {}) {
    const result = await listVMs();
    const rows = (result.vms || []).filter(vm => !runningOnly || ['running', 'paused'].includes(vm.state));
    if (!rows.length) {
      const text = (result.vms || []).length
        ? 'No running remote desktop. Start one first, then take its screenshot.'
        : 'No virtual machines were found on the remote host.';
      vscode.window.showInformationMessage(text);
      return null;
    }
    const picked = await vscode.window.showQuickPick(
      rows.map(vm => ({ label: vm.name || vm.id, description: `${vm.state}${vm.memory_mb ? ` · ${vm.memory_mb} MB` : ''}`, detail: vm.id, vm })),
      { title: title || 'VAMP remote · choose a desktop' },
    );
    return picked?.vm || null;
  }

  const screens = new Map();
  async function openScreen(vm) {
    const normalized = requireConfigured();
    const key = `${normalized.host}:${vm.id || vm.name}`;
    if (screens.has(key)) {
      screens.get(key).reveal();
      return screens.get(key);
    }
    const client = clientFor(normalized);
    const panel = vscode.window.createWebviewPanel(
      'vamp.remoteScreen',
      `VAMP Remote · ${vm.name || vm.id}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'assets')] },
    );
    const logo = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'assets/sidebar-brand.png'));
    panel.webview.html = remoteScreenHTML({
      name: vm.name || vm.id,
      target: `${normalized.username ? `${normalized.username}@` : ''}${normalized.host}`,
      cspSource: panel.webview.cspSource,
      logoUri: String(logo),
    });
    let disposed = false;
    let capturing = false;
    let visible = true;
    let lastImage = null;
    const capture = async () => {
      if (disposed || capturing || !visible) return;
      capturing = true;
      try {
        const shot = await client.screenshot(vm.name || vm.id);
        if (disposed) return;
        lastImage = shot;
        panel.webview.postMessage({
          type: 'frame',
          image: `data:image/png;base64,${shot.png.toString('base64')}`,
          time: new Date().toLocaleTimeString(),
          size: `${shot.width}×${shot.height}`,
        });
      } catch (error) {
        if (!disposed) panel.webview.postMessage({ type: 'screenStatus', message: error.message });
      } finally {
        capturing = false;
      }
    };
    const timer = setInterval(capture, 2500);
    screens.set(key, panel);
    panel.webview.onDidReceiveMessage(async message => {
      if (message?.type === 'ready') await capture();
      if (message?.type === 'refresh') await capture();
      if (message?.type === 'save' && lastImage) {
        const target = await vscode.window.showSaveDialog({
          title: 'Save remote desktop screenshot',
          filters: { 'PNG image': ['png'] },
          saveLabel: 'Save screenshot',
          defaultUri: vscode.Uri.joinPath(context.globalStorageUri, 'screenshots', `${(vm.name || vm.id).replace(/[^\w.-]+/g, '-')}-${Date.now()}.png`),
        });
        if (target) {
          await fs.promises.mkdir(path.dirname(target.fsPath), { recursive: true });
          await fs.promises.writeFile(target.fsPath, lastImage.png);
          panel.webview.postMessage({ type: 'saved', path: target.fsPath });
        }
      }
    });
    panel.onDidChangeViewState(() => {
      visible = Boolean(panel.visible);
      if (visible) capture();
    });
    panel.onDidDispose(() => {
      disposed = true;
      clearInterval(timer);
      screens.delete(key);
    });
    await capture();
    return panel;
  }

  async function captureScreenshot() {
    const vm = await pickVM();
    if (!vm) return null;
    await openScreen(vm);
    return vm;
  }

  async function startVM(vm) {
    const normalized = requireConfigured();
    const result = await clientFor(normalized).start(vm.name || vm.id);
    output.appendLine(`Remote start ${vm.name}: ${result.state || 'requested'}`);
    return result;
  }

  async function stopVM(vm, { force = false } = {}) {
    const normalized = requireConfigured();
    const result = await clientFor(normalized).stop(vm.name || vm.id, { force });
    output.appendLine(`Remote stop ${vm.name}: ${result.status}`);
    return result;
  }

  // MCP server definition: VS Code starts ssh itself, so agents anywhere get the
  // same tools without the extension keeping a session open.
  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider('vamp.remote', {
    onDidChangeMcpServerDefinitions: changes.event,
    provideMcpServerDefinitions() {
      const raw = configured();
      if (!raw) return [];
      try {
        const module = remoteModule();
        const normalized = module.normalizeRemoteConfig(raw);
        return [new vscode.McpStdioServerDefinition(
          `VAMP Remote (SSH) · ${normalized.host}`,
          'ssh',
          module.sshArgs(normalized, module.remoteMcpCommand(normalized)),
          {},
          version,
        )];
      } catch (error) {
        output.appendLine(`Remote MCP server definition: ${error.message}`);
        return [];
      }
    },
  }));

  const commands = {
    'vamp.remote.setupEnvironment': () => setupRemote(),
    'vamp.remote.verifyEnvironment': () => verify(),
    'vamp.remote.listVMs': async () => {
      const result = await listVMs();
      if (!(result.vms || []).length) {
        vscode.window.showInformationMessage('No virtual machines were found on the remote host.');
        return result;
      }
      await vscode.window.showQuickPick(
        result.vms.map(vm => ({
          label: vm.name || vm.id,
          description: `${vm.state}${vm.memory_mb ? ` · ${vm.memory_mb} MB` : ''}${vm.cpus ? ` · ${vm.cpus} CPU` : ''}`,
          detail: vm.id,
        })),
        { title: `VAMP remote · ${result.count} desktop(s) on ${result.connection || summary().host}` },
      );
      return result;
    },
    'vamp.remote.captureScreenshot': () => captureScreenshot(),
    'vamp.remote.openManager': () => vscode.commands.executeCommand('vamp.openManager', 'remote'),
    'vamp.remote.configure': async () => {
      const raw = read();
      const host = await vscode.window.showInputBox({
        title: 'VAMP remote host',
        prompt: 'Host name or address of the machine that runs the virtual desktops',
        value: raw.host || '',
        placeHolder: 'lab-host.local or 100.x.y.z',
        validateInput: value => (!value.trim() ? 'Enter a host name.' : /^[A-Za-z0-9._:-]+$/.test(value.trim()) ? undefined : 'Use only letters, digits, dots, colons, underscores and hyphens.'),
      });
      if (host === undefined) return null;
      const username = await vscode.window.showInputBox({
        title: 'VAMP remote user',
        prompt: 'SSH user on the remote host',
        value: raw.username || '',
        placeHolder: 'your Linux or Windows account',
        validateInput: value => (/^[A-Za-z0-9._-]*$/.test(value.trim()) ? undefined : 'Use only letters, digits, dots, underscores and hyphens.'),
      });
      if (username === undefined) return null;
      const updated = await saveSettings({ enabled: true, host, username });
      const choice = await vscode.window.showInformationMessage('Remote host saved. Prepare the environment on it now?', 'Prepare environment', 'Later');
      if (choice === 'Prepare environment') await setupRemote();
      return updated;
    },
  };
  for (const [id, handler] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, async (...args) => {
      try {
        return await handler(...args);
      } catch (error) {
        output.appendLine(`VAMP remote: ${error.stack || error.message}`);
        vscode.window.showErrorMessage(`VAMP remote: ${error.message}`);
        return undefined;
      }
    }));
  }
  context.subscriptions.push({ dispose() { for (const panel of screens.values()) panel.dispose(); screens.clear(); } });

  return {
    read,
    summary,
    saveSettings,
    verify,
    setup: setupRemote,
    list: listVMs,
    pick: pickVM,
    screenshot: captureScreenshot,
    openScreen,
    start: startVM,
    stop: stopVM,
    state: last,
    isConfigured: () => Boolean(configured()),
  };
}

function remoteScreenHTML({ name, target, cspSource, logoUri } = {}) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${cspSource || ''}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
:root{--vamp-violet:#7c5cff;--vamp-violet-soft:rgba(124,92,255,.16);--vamp-teal:#2ec4b6}
body{margin:0;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)}
header{display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:14px 20px;border-bottom:1px solid var(--vscode-panel-border);background:linear-gradient(120deg,var(--vamp-violet-soft),transparent 60%)}
header img{width:30px;height:30px;object-fit:contain}
header strong{font-size:15px}
.badge{font-size:11px;letter-spacing:.02em;color:#c9bcff;background:var(--vamp-violet-soft);border:1px solid rgba(124,92,255,.5);border-radius:999px;padding:3px 10px}
small{color:var(--vscode-descriptionForeground)}
.actions{margin-left:auto;display:flex;gap:8px}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:4px;padding:8px 12px;cursor:pointer}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button:focus-visible{outline:2px solid var(--vamp-violet);outline-offset:2px}
#status{padding:10px 20px;font-size:12px;color:var(--vscode-descriptionForeground)}
main{display:flex;justify-content:center;align-items:flex-start;padding:8px 20px 24px}
#screen{max-width:100%;max-height:calc(100vh - 130px);object-fit:contain;border:1px solid var(--vscode-panel-border);border-radius:4px;background:#000}
#screen[hidden]{display:none}
footer{padding:0 20px 18px;display:flex;gap:16px;flex-wrap:wrap;align-items:center}
kbd{font-family:var(--vscode-editor-font-family);background:var(--vscode-textBlockQuote-background);border-radius:3px;padding:1px 5px}
</style></head><body>
<header>${logoUri ? `<img src="${logoUri}" alt="VAMP bat and virtual machine">` : ''}<strong>${escape(name)}</strong><span class="badge">SSH · screenshots only</span><span class="actions"><button id="refresh" class="secondary">Refresh now</button><button id="save">Save PNG</button></span></header>
<div id="status" role="status" aria-live="polite">Connecting to ${escape(target)}…</div>
<main><img id="screen" alt="Remote virtual machine screen" hidden></main>
<footer><small>This is the hypervisor’s copy of the guest screen, refreshed every few seconds over SSH. There is no live stream and no remote keyboard or mouse in this window. A frame proves the screen contents, not that the guest finished booting.</small></footer>
<script nonce="${nonce}">
const api=acquireVsCodeApi();
const status=document.getElementById('status');
const image=document.getElementById('screen');
window.addEventListener('message',event=>{const message=event.data;
 if(message.type==='frame'){image.src=message.image;image.hidden=false;status.textContent='Last screenshot '+message.time+' · '+message.size+' · SSH '+${JSON.stringify(escape(target))};}
 if(message.type==='screenStatus'){status.textContent=message.message;}
 if(message.type==='saved'){status.textContent='Saved '+message.path;}
});
document.getElementById('refresh').addEventListener('click',()=>api.postMessage({type:'refresh'}));
document.getElementById('save').addEventListener('click',()=>api.postMessage({type:'save'}));
api.postMessage({type:'ready'});
</script></body></html>`;
}

module.exports = { registerRemote, remoteScreenHTML };
