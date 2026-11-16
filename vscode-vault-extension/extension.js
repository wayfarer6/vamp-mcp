const vscode = require('vscode');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

const SECRET_KEY = 'vampVault.masterPasswords';

function loadModule(context, relative) {
  return import(pathToFileURL(context.asAbsolutePath(relative)).href);
}

function bridgeSocketPath(context) {
  const stamp = crypto.createHash('sha1').update(context.globalStorageUri.fsPath).digest('hex').slice(0, 12);
  if (process.platform === 'win32') return `\\\\.\\pipe\\vamp-vault-${stamp}`;
  const user = typeof process.getuid === 'function' ? process.getuid() : 'u';
  return path.join(os.tmpdir(), `vampvault-${user}-${stamp}.sock`);
}

async function readSecretMap(context) {
  try {
    const raw = await context.secrets.get(SECRET_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function writeSecretMap(context, map) {
  if (!Object.keys(map).length) await context.secrets.delete(SECRET_KEY);
  else await context.secrets.store(SECRET_KEY, JSON.stringify(map));
}

async function askSecret(prompt) {
  const value = await vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true });
  return value === undefined ? null : value;
}

async function askPassword(prompt) {
  const first = await vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true, validateInput: value => (value && value.length >= 8 ? null : 'Use at least 8 characters.') });
  if (first === undefined) return null;
  const second = await vscode.window.showInputBox({ prompt: `${prompt} (again)`, password: true, ignoreFocusOut: true, validateInput: value => (value === first ? null : 'The two entries do not match.') });
  if (second === undefined) return null;
  return first === second ? first : null;
}

/**
 * Local bridge for the MCP server process: it can ask for the master password
 * (kept in VS Code secret storage, never in an environment variable), ask the
 * user to approve a read, and post notifications. Bound to a per-user socket
 * plus a random token issued in this session.
 */
function startBridge(context, state, output) {
  const token = crypto.randomBytes(32).toString('hex');
  const socketPath = bridgeSocketPath(context);
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', async chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let request;
        try { request = JSON.parse(line); } catch { continue; }
        const reply = payload => { try { socket.write(`${JSON.stringify({ id: request.id, ...payload })}\n`); } catch {} };
        if (!request.token || request.token !== token) { reply({ ok: false, error: 'invalid bridge token' }); continue; }
        try {
          reply({ ok: true, result: await handle(request, context, state, output) });
        } catch (error) {
          reply({ ok: false, error: error?.message ?? String(error) });
        }
      }
    });
    socket.on('error', () => {});
  });
  const cleanup = () => {
    try { server.close(); } catch {}
    if (process.platform !== 'win32') { try { require('node:fs').unlinkSync(socketPath); } catch {} }
  };
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      if (process.platform !== 'win32') { try { require('node:fs').chmodSync(socketPath, 0o600); } catch {} }
      context.subscriptions.push({ dispose: cleanup });
      resolve({ socketPath, token });
    });
  });
}

async function unlockMasterPassword(context, kdbxPath, output) {
  const map = await readSecretMap(context);
  if (map[kdbxPath]) return { password: map[kdbxPath], source: 'vscode_secret_storage' };
  // Unlocking asks once and accepts any length: an existing database may have a
  // password shorter than the rule we apply to new ones.
  const password = await askSecret(`Master password for ${path.basename(kdbxPath)} (stored in VS Code secret storage)`);
  if (!password) return { cancelled: true };
  map[kdbxPath] = password;
  await writeSecretMap(context, map);
  output?.appendLine(`Unlocked ${kdbxPath} (master password held in secret storage until "VAMP Vault: Lock").`);
  return { password, source: 'vscode_secret_storage' };
}

async function handle(request, context, state, output) {
  const config = vscode.workspace.getConfiguration('vampVault');
  const globalStorage = context.globalStorageUri.fsPath;
  const kdbx = config.get('defaultKdbxPath') || path.join(globalStorage, 'vault.kdbx');

  switch (request.op) {
    case 'state': {
      const map = await readSecretMap(context);
      return { unlocked: Boolean(map[request.params?.kdbx ?? kdbx]), stored_databases: Object.keys(map).length };
    }
    case 'unlock': {
      const target = request.params?.kdbx || kdbx;
      const result = await unlockMasterPassword(context, target, output);
      return result.cancelled ? { cancelled: true, password: null } : { password: result.password, source: result.source };
    }
    case 'new-password': {
      const label = request.params?.label || 'VAMP Vault master password';
      const password = await askPassword(label);
      if (!password) return { cancelled: true, password: null };
      if (request.params?.purpose === 'master') {
        const map = await readSecretMap(context);
        map[request.params?.kdbx || kdbx] = password;
        await writeSecretMap(context, map);
      }
      return { password, source: 'vscode_input_box' };
    }
    case 'approve': {
      const detail = request.params?.detail || 'Release a secret to the AI agent?';
      const entry = request.params?.entry ? `"${request.params.entry}"` : 'this entry';
      const choice = await vscode.window.showWarningMessage(
        `VAMP Vault: ${detail}`,
        { modal: true, detail: `The AI agent asked for ${entry}. Approving sends the value to the running MCP server process.` },
        'Approve once', 'Approve for this session', 'Cancel',
      );
      if (choice === 'Approve once') return { approved: true, remember: false };
      if (choice === 'Approve for this session') return { approved: true, remember: true };
      return { approved: false, remember: false };
    }
    case 'notify': {
      const message = request.params?.message || 'VAMP Vault';
      if (request.params?.level === 'error') vscode.window.showErrorMessage(message);
      else if (request.params?.level === 'warning') vscode.window.showWarningMessage(message);
      else vscode.window.showInformationMessage(message);
      return { shown: true };
    }
    default:
      throw new Error(`unknown bridge operation: ${request.op}`);
  }
}

function activate(context) {
  const output = vscode.window.createOutputChannel('VAMP Vault');
  const changes = new vscode.EventEmitter();
  const state = { setup: false };
  const config = () => vscode.workspace.getConfiguration('vampVault');
  const globalStorage = context.globalStorageUri.fsPath;
  const binDir = path.join(globalStorage, 'bin');
  const runtime = context.asAbsolutePath('dist/runtime');
  const kdbxPath = () => config().get('defaultKdbxPath') || path.join(globalStorage, 'vault.kdbx');
  const volumePath = () => config().get('defaultVolumePath') || path.join(globalStorage, 'vault.hc');
  const mountPoint = () => config().get('mountPoint') || (process.platform === 'win32' ? 'V:' : path.join(os.homedir(), 'VAMP-Vault'));

  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusItem.text = '$(shield) Vault';
  statusItem.tooltip = 'VAMP Vault — click for status';
  statusItem.command = 'vampVault.status';
  statusItem.show();
  context.subscriptions.push(output, changes, statusItem);

  readSecretMap(context).then(map => { statusItem.text = map[kdbxPath()] ? '$(shield) Vault' : '$(lock) Vault'; }).catch(() => {});

  let bridge = { socketPath: '', token: '' };
  startBridge(context, state, output)
    .then(value => {
      bridge = value;
      output.appendLine(`Approval bridge listening on ${value.socketPath}`);
      // Re-announce the server so a definition created before the socket was
      // listening is replaced by one that carries the bridge token.
      changes.fire();
    })
    .catch(error => { output.appendLine(`Approval bridge unavailable: ${error.message}`); vscode.window.showErrorMessage(`VAMP Vault: approval bridge failed (${error.message}). Credentials can only be released with an explicit confirm:true.`); });

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('vampVault')) changes.fire();
  }));

  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider('vamp.vault', {
    onDidChangeMcpServerDefinitions: changes.event,
    provideMcpServerDefinitions() {
      const environment = {
        ELECTRON_RUN_AS_NODE: '1',
        VAULT_BIN_DIR: binDir,
        VAULT_KDBX: kdbxPath(),
        VAULT_VOLUME: volumePath(),
        VAULT_MOUNT_POINT: mountPoint(),
        VAULT_SESSION_TTL_MS: String(Math.round(Number(config().get('sessionCacheMinutes') ?? 5) * 60000)),
        VAULT_APPROVAL_MODE: config().get('approvalMode') || 'per-session',
        VAULT_AUTO_DOWNLOAD: config().get('autoDownloadCli') ? '1' : '0',
      };
      if (config().get('keepassxcCliPath')) environment.VAULT_KEEPASSXC_CLI = config().get('keepassxcCliPath');
      if (config().get('veracryptCliPath')) environment.VAULT_VERACRYPT_CLI = config().get('veracryptCliPath');
      if (bridge.socketPath) {
        environment.VAULT_BRIDGE_SOCKET = bridge.socketPath;
        environment.VAULT_BRIDGE_TOKEN = bridge.token;
      }
      return [new vscode.McpStdioServerDefinition('VAMP Vault', process.execPath, [path.join(runtime, 'backends/vault/server.mjs')], environment, '0.1.0')];
    },
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vampVault.setupCli', async () => {
    if (state.setup) return;
    state.setup = true;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'VAMP Vault: preparing KeePassXC and VeraCrypt' }, async progress => {
        const { ensureClis } = await loadModule(context, 'dist/runtime/src/downloader.mjs');
        const report = await ensureClis({
          binDir,
          overrides: { keepassxc: config().get('keepassxcCliPath') || undefined, veracrypt: config().get('veracryptCliPath') || undefined },
          allowDownload: config().get('autoDownloadCli') !== false,
          log: message => { progress.report({ message }); output.appendLine(message); },
        });
        output.appendLine(JSON.stringify(report, null, 2));
        output.show(true);
        const keepassxc = report.tools.keepassxc ?? {};
        const veracrypt = report.tools.veracrypt ?? {};
        const line = tool => tool.available
          ? `${tool.label ?? 'CLI'}: ${tool.version ?? 'ready'} — ${tool.path}`
          : `${tool.label ?? 'CLI'}: not available (${tool.status ?? 'unknown'}) ${tool.manual_install ? `· ${tool.manual_install}` : ''}`;
        const summary = [line({ ...keepassxc, label: 'KeePassXC' }), line({ ...veracrypt, label: 'VeraCrypt' })].join('\n');
        changes.fire();
        const choice = await vscode.window.showInformationMessage(summary, { modal: true }, 'Open Guide');
        if (choice === 'Open Guide') await vscode.commands.executeCommand('vampVault.openGuide');
      });
    } catch (error) {
      output.appendLine(String(error));
      output.show();
      vscode.window.showErrorMessage(`VAMP Vault setup failed: ${error.message}`);
    } finally {
      state.setup = false;
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vampVault.createVault', async () => {
    try {
      const file = await vscode.window.showInputBox({ prompt: 'Where should the KeePassXC database live?', value: kdbxPath(), ignoreFocusOut: true });
      if (!file) return;
      if (require('node:fs').existsSync(file)) {
        const replace = await vscode.window.showWarningMessage(`${path.basename(file)} already exists. Creating a new vault at this path is refused; pick another path.`, { modal: true }, 'Choose another path');
        if (replace === 'Choose another path') return vscode.commands.executeCommand('vampVault.createVault');
        return;
      }
      const password = await askPassword(`Master password for the new vault ${path.basename(file)}`);
      if (!password) return;
      const { VaultCli } = await loadModule(context, 'dist/runtime/src/vault_cli.mjs');
      const { resolveCli } = await loadModule(context, 'dist/runtime/src/downloader.mjs');
      const keepass = await resolveCli('keepassxc', { binDir, override: config().get('keepassxcCliPath') || undefined });
      if (!keepass.available) {
        const choice = await vscode.window.showErrorMessage('KeePassXC CLI is not available yet. Set it up first.', 'Set Up CLI');
        if (choice === 'Set Up CLI') await vscode.commands.executeCommand('vampVault.setupCli');
        return;
      }
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'VAMP Vault: creating database' }, async () => {
        const cli = new VaultCli({ keepassxcCli: keepass.path, kdbxPath: file, volumePath: volumePath(), mountPoint: mountPoint(), platform: process.platform });
        await cli.createDatabase({ file, password });
        const map = await readSecretMap(context);
        map[file] = password;
        await writeSecretMap(context, map);
        changes.fire();
        vscode.window.showInformationMessage(`Vault created: ${file}. The master password is in VS Code secret storage; "VAMP Vault: Lock" forgets it.`, 'Ok');
      });
    } catch (error) {
      output.appendLine(String(error));
      output.show();
      vscode.window.showErrorMessage(`Could not create the vault: ${error.message}`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vampVault.status', async () => {
    try {
      const { cliStatus } = await loadModule(context, 'dist/runtime/src/downloader.mjs');
      const { VaultCli } = await loadModule(context, 'dist/runtime/src/vault_cli.mjs');
      const report = await cliStatus({ binDir, overrides: { keepassxc: config().get('keepassxcCliPath') || undefined, veracrypt: config().get('veracryptCliPath') || undefined } });
      const secrets = await readSecretMap(context);
      const db = kdbxPath();
      const volume = volumePath();
      const cli = new VaultCli({ veracryptCli: report.veracrypt.available ? report.veracrypt.path : null, mountPoint: mountPoint() });
      const mounted = report.veracrypt.available ? (await cli.listVolumes()).mounted : [];
      const lines = [
        `Database: ${db} ${require('node:fs').existsSync(db) ? '(present)' : '(missing)'}`,
        `Volume: ${volume} ${require('node:fs').existsSync(volume) ? '(present)' : '(missing)'}`,
        `Mount point: ${mountPoint()}`,
        `Unlocked: ${secrets[db] ? 'yes (master password in secret storage)' : 'no'}`,
        `KeePassXC: ${report.keepassxc.available ? `${report.keepassxc.version ?? 'ready'} · ${report.keepassxc.path}` : `missing · ${report.keepassxc.manual_install}`}`,
        `VeraCrypt: ${report.veracrypt.available ? `${report.veracrypt.version ?? 'ready'} · ${report.veracrypt.path}` : `missing · ${report.veracrypt.manual_install}`}`,
        `Mounted volumes: ${mounted.length ? mounted.map(item => item.mount_point).join(', ') : 'none'}`,
        `Approval: ${config().get('approvalMode')}, cache ${config().get('sessionCacheMinutes')} min`,
      ];
      output.appendLine(lines.join('\n'));
      const choice = await vscode.window.showInformationMessage(lines.join('\n'), { modal: true }, secrets[db] ? 'Lock' : 'Set Up CLI', 'Open Guide');
      if (choice === 'Lock') await vscode.commands.executeCommand('vampVault.lock');
      if (choice === 'Set Up CLI') await vscode.commands.executeCommand('vampVault.setupCli');
      if (choice === 'Open Guide') await vscode.commands.executeCommand('vampVault.openGuide');
    } catch (error) {
      vscode.window.showErrorMessage(`VAMP Vault status failed: ${error.message}`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vampVault.lock', async () => {
    await context.secrets.delete(SECRET_KEY);
    statusItem.text = '$(lock) Vault';
    vscode.window.showInformationMessage('VAMP Vault locked: the master password is no longer stored. The next read asks for it again.');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vampVault.openGuide', () =>
    vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(context.asAbsolutePath('README.md')))));

  if (!context.globalState.get('vampVault.onboardSeen')) {
    context.globalState.update('vampVault.onboardSeen', true);
    vscode.window.showInformationMessage(
      'VAMP Vault keeps your credentials and certificates away from the AI agent until you approve each read. Set it up now?',
      'Set Up', 'Later',
    ).then(choice => { if (choice === 'Set Up') vscode.commands.executeCommand('vampVault.setupCli'); });
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
