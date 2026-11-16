const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

const SECRET_KEY = 'vampVault.masterPasswords';
// Reading a username costs one keepassxc-cli call per entry, so a very large
// database is filled in the background only up to this many entries.
const USERNAME_FILL_LIMIT = 200;

/**
 * A view that renders plain nodes from src/tree.mjs. The node is kept on the
 * item (`element`) because a context-menu command receives the TreeItem, not
 * the original element, and the command needs the entry path.
 */
class VaultView {
  constructor(kind) {
    this.kind = kind;
    this.loader = null;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }

  refresh() { this.emitter.fire(undefined); }

  dispose() { this.emitter.dispose(); }

  getTreeItem(node) {
    const collapsible = node.children?.length
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.label, collapsible);
    item.id = `${this.kind}:${node.path ?? node.id ?? node.label}`;
    if (node.description) item.description = node.description;
    item.tooltip = node.tooltip || node.description || node.label;
    item.iconPath = new vscode.ThemeIcon(node.icon || 'circle-outline');
    item.contextValue = node.type === 'entry'
      ? 'vampVault.credential'
      : node.type === 'group' ? 'vampVault.group' : `vampVault.${node.type}`;
    if (node.command) item.command = { command: node.command, title: node.label, arguments: [] };
    item.element = node;
    return item;
  }

  async getChildren(node) {
    if (node) return node.children ?? [];
    if (!this.loader) return [];
    return this.loader();
  }
}

function treeNode(arg) {
  if (!arg) return null;
  if (arg.element) return arg.element;
  return arg.type ? arg : null;
}

/** Empty the clipboard after a copied secret, but only if it still holds it. */
function scheduleClipboardClear(value, seconds = 30) {
  const timer = setTimeout(async () => {
    try {
      const current = await vscode.env.clipboard.readText();
      if (current === value) await vscode.env.clipboard.writeText('');
    } catch {}
  }, seconds * 1000);
  timer.unref?.();
}

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

  // ------------------------------------------------------------------ sidebar
  const credentialView = new VaultView('credentials');
  const statusView = new VaultView('status');
  context.subscriptions.push(credentialView, statusView, vscode.window.registerTreeDataProvider('vampVault.views.credentials', credentialView), vscode.window.registerTreeDataProvider('vampVault.views.status', statusView));

  let vaultData = null;      // last read of the credentials view
  let fillToken = 0;         // bumped whenever that read is discarded

  const treeModule = () => loadModule(context, 'dist/runtime/src/tree.mjs');
  const cliReport = () => loadModule(context, 'dist/runtime/src/downloader.mjs')
    .then(({ cliStatus }) => cliStatus({ binDir, overrides: { keepassxc: config().get('keepassxcCliPath') || undefined, veracrypt: config().get('veracryptCliPath') || undefined } }));
  const resetVault = () => { vaultData = null; fillToken += 1; };

  const syncContext = async unlocked => {
    await vscode.commands.executeCommand('setContext', 'vampVault.unlocked', Boolean(unlocked));
    await vscode.commands.executeCommand('setContext', 'vampVault.databaseExists', fs.existsSync(kdbxPath()));
  };

  async function credentialData() {
    const db = kdbxPath();
    if (vaultData && vaultData.db === db) return vaultData;
    const report = await cliReport();
    const secrets = await readSecretMap(context);
    const unlocked = Boolean(secrets[db]);
    const exists = fs.existsSync(db);
    const data = { db, report, unlocked, exists, listing: null, meta: {}, error: null, filled: false, cli: null };
    if (report.keepassxc.available && exists && unlocked) {
      const { VaultCli } = await loadModule(context, 'dist/runtime/src/vault_cli.mjs');
      data.cli = new VaultCli({ keepassxcCli: report.keepassxc.path, kdbxPath: db, volumePath: volumePath(), mountPoint: mountPoint(), platform: process.platform });
      try {
        data.listing = await data.cli.listEntries({ file: db, databasePassword: secrets[db] });
      } catch (error) {
        data.error = error.code === 'vault_unlock_failed'
          ? 'the stored master password was rejected — unlock again'
          : error.message;
      }
    }
    vaultData = data;
    statusItem.text = unlocked ? '$(shield) Vault' : '$(lock) Vault';
    syncContext(unlocked).catch(() => {});
    return data;
  }

  /**
   * Read usernames for the entry descriptions in the background, four at a
   * time. `keepassxc-cli show` without -s prints "Password: PROTECTED", so no
   * password passes through this path; only a username and a row label do.
   */
  async function fillUsernames(data) {
    const token = fillToken;
    const password = (await readSecretMap(context))[data.db];
    if (!data.cli || !password) return;
    const queue = data.listing.entries.slice(0, USERNAME_FILL_LIMIT);
    let done = 0;
    const worker = async () => {
      while (queue.length) {
        if (token !== fillToken || vaultData !== data) return;
        const entry = queue.shift();
        try {
          const record = await data.cli.showEntry({ file: data.db, entry: entry.path, databasePassword: password, showProtected: false });
          data.meta[entry.path] = { username: record.username ?? '' };
        } catch {
          data.meta[entry.path] = { username: '' };
        }
        done += 1;
        if (done <= 8 || done % 25 === 0) credentialView.refresh();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    credentialView.refresh();
  }

  credentialView.loader = async () => {
    const { buildCredentialTree } = await treeModule();
    let data;
    try {
      data = await credentialData();
    } catch (error) {
      return [{ type: 'info', id: 'loadError', label: 'Could not read the vault', description: error.message, tooltip: String(error.message), icon: 'warning' }];
    }
    const nodes = buildCredentialTree({
      cliAvailable: Boolean(data.report?.keepassxc?.available),
      databaseExists: data.exists,
      locked: !data.unlocked,
      kdbxPath: data.db,
      listing: data.listing,
      meta: data.meta,
      error: data.error,
    });
    if (data.listing && !data.filled && !data.error) {
      data.filled = true;
      fillUsernames(data).catch(error => output.appendLine(`username fill stopped: ${error.message}`));
    }
    return nodes;
  };

  statusView.loader = async () => {
    const { buildStatusTree } = await treeModule();
    try {
      const report = await cliReport();
      const secrets = await readSecretMap(context);
      let mounted = [];
      if (report.veracrypt.available) {
        const { VaultCli } = await loadModule(context, 'dist/runtime/src/vault_cli.mjs');
        try {
          mounted = (await new VaultCli({ veracryptCli: report.veracrypt.path, mountPoint: mountPoint() }).listVolumes()).mounted;
        } catch {}
      }
      return buildStatusTree({
        databaseExists: fs.existsSync(kdbxPath()),
        kdbxPath: kdbxPath(),
        volumeExists: fs.existsSync(volumePath()),
        volumePath: volumePath(),
        mounted,
        unlocked: Boolean(secrets[kdbxPath()]),
        keepassxcAvailable: report.keepassxc.available,
        keepassxcVersion: report.keepassxc.version,
        keepassxcPath: report.keepassxc.path,
        veracryptAvailable: report.veracrypt.available,
        veracryptVersion: report.veracrypt.version,
        veracryptPath: report.veracrypt.path,
        approvalMode: config().get('approvalMode') || 'per-session',
        cacheMinutes: Number(config().get('sessionCacheMinutes') ?? 5),
      });
    } catch (error) {
      return [{ type: 'info', id: 'statusError', label: 'Status unavailable', description: error.message, tooltip: String(error.message), icon: 'warning' }];
    }
  };

  syncContext(false).catch(() => {});

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
    if (event.affectsConfiguration('vampVault')) {
      changes.fire();
      resetVault();
      credentialView.refresh();
      statusView.refresh();
    }
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
        resetVault();
        credentialView.refresh();
        statusView.refresh();
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
        resetVault();
        credentialView.refresh();
        statusView.refresh();
        syncContext(true).catch(() => {});
        statusItem.text = '$(shield) Vault';
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
    resetVault();
    credentialView.refresh();
    statusView.refresh();
    await syncContext(false);
    vscode.window.showInformationMessage('VAMP Vault locked: the master password is no longer stored. The next read asks for it again.');
  }));

  // ---------------------------------------------------- sidebar command support

  /**
   * Resolve everything a sidebar command needs: a CLI, a database and its
   * master password. Missing pieces are offered as the same actions the view
   * shows, so a click on a row always ends in a step the user can take. A
   * password typed here is verified before it reaches secret storage.
   */
  async function openVault() {
    const db = kdbxPath();
    const report = await cliReport();
    if (!report.keepassxc.available) {
      const choice = await vscode.window.showErrorMessage('VAMP Vault: keepassxc-cli is not available yet, so the database cannot be read.', 'Set Up CLI');
      if (choice === 'Set Up CLI') await vscode.commands.executeCommand('vampVault.setupCli');
      return null;
    }
    if (!fs.existsSync(db)) {
      const choice = await vscode.window.showWarningMessage(`VAMP Vault: no database at ${db} yet.`, { modal: true }, 'Create Vault');
      if (choice === 'Create Vault') await vscode.commands.executeCommand('vampVault.createVault');
      return null;
    }
    const { VaultCli } = await loadModule(context, 'dist/runtime/src/vault_cli.mjs');
    let password = (await readSecretMap(context))[db];
    const typed = !password;
    if (!password) password = await askSecret(`Master password for ${path.basename(db)} (stored in VS Code secret storage)`);
    if (!password) return null;
    const cli = new VaultCli({ keepassxcCli: report.keepassxc.path, kdbxPath: db, volumePath: volumePath(), mountPoint: mountPoint(), platform: process.platform });
    if (typed) {
      try {
        await cli.listEntries({ file: db, databasePassword: password });
      } catch (error) {
        if (error.code === 'vault_unlock_failed') vscode.window.showErrorMessage('VAMP Vault: that master password was rejected, so nothing was stored.');
        else vscode.window.showErrorMessage(`VAMP Vault: ${error.message}`);
        return null;
      }
      const map = await readSecretMap(context);
      map[db] = password;
      await writeSecretMap(context, map);
      output.appendLine(`Unlocked ${db} from a typed password; it is held in secret storage until "VAMP Vault: Lock".`);
      statusItem.text = '$(shield) Vault';
      resetVault();
      credentialView.refresh();
      statusView.refresh();
      await syncContext(true);
    }
    return { db, cli, password, report };
  }

  async function handleVaultError(error, db) {
    output.appendLine(`[${new Date().toISOString()}] ${error?.code ?? 'error'}: ${error?.message ?? error}`);
    if (error?.code === 'vault_unlock_failed') {
      const map = await readSecretMap(context);
      if (db && map[db]) {
        delete map[db];
        await writeSecretMap(context, map);
        statusItem.text = '$(lock) Vault';
      }
      resetVault();
      credentialView.refresh();
      statusView.refresh();
      await syncContext(false);
      const choice = await vscode.window.showErrorMessage(`VAMP Vault: the stored master password was rejected for ${path.basename(db ?? kdbxPath())}. It was forgotten; unlock again.`, 'Unlock');
      if (choice === 'Unlock') await vscode.commands.executeCommand('vampVault.unlock');
      return;
    }
    if (error?.code === 'entry_not_found') {
      vscode.window.showWarningMessage(`VAMP Vault: ${error.message} Refresh the view to see the current entries.`);
      resetVault();
      credentialView.refresh();
      return;
    }
    const choice = await vscode.window.showErrorMessage(`VAMP Vault: ${error?.message ?? error}`, 'Show Log');
    if (choice === 'Show Log') output.show();
  }

  async function pickEntryPath(opened, title) {
    let listing;
    try {
      listing = await opened.cli.listEntries({ file: opened.db, databasePassword: opened.password });
    } catch (error) {
      await handleVaultError(error, opened.db);
      return null;
    }
    if (!listing.entries.length) {
      vscode.window.showInformationMessage('VAMP Vault: the vault has no entries yet.');
      return null;
    }
    const picked = await vscode.window.showQuickPick(
      listing.entries.map(entry => ({
        label: entry.title,
        description: entry.group === '/' ? 'top level' : entry.group,
        detail: entry.path,
        entryPath: entry.path,
      })),
      { title, placeHolder: 'Type to filter entries', matchOnDetail: true },
    );
    return picked?.entryPath ?? null;
  }

  context.subscriptions.push(vscode.commands.registerCommand('vampVault.refreshTree', async () => {
    resetVault();
    credentialView.refresh();
    statusView.refresh();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vampVault.unlock', async () => {
    const opened = await openVault();
    if (!opened) return;
    statusItem.text = '$(shield) Vault';
    resetVault();
    credentialView.refresh();
    statusView.refresh();
    await syncContext(true);
    vscode.window.setStatusBarMessage(`VAMP Vault unlocked: ${path.basename(opened.db)}`, 5000);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vampVault.revealKdbx', async () => {
    const db = kdbxPath();
    if (!fs.existsSync(db)) {
      const choice = await vscode.window.showWarningMessage(`VAMP Vault: there is no database file at ${db} yet.`, { modal: true }, 'Create Vault');
      if (choice === 'Create Vault') await vscode.commands.executeCommand('vampVault.createVault');
      return;
    }
    try {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(db));
    } catch (error) {
      vscode.window.showErrorMessage(`VAMP Vault: the file manager could not show ${db} (${error.message}). The path is above; copy it by hand if needed.`);
      output.appendLine(`revealFileInOS failed for ${db}: ${error.message}`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vampVault.exportKdbx', async () => {
    const db = kdbxPath();
    if (!fs.existsSync(db)) {
      const choice = await vscode.window.showWarningMessage(`VAMP Vault: there is no database file at ${db} yet, so there is nothing to export.`, { modal: true }, 'Create Vault');
      if (choice === 'Create Vault') await vscode.commands.executeCommand('vampVault.createVault');
      return;
    }
    const target = await vscode.window.showSaveDialog({
      title: 'Export a copy of the KeePassXC database',
      saveLabel: 'Export Copy',
      defaultUri: vscode.Uri.file(path.join(os.homedir(), path.basename(db))),
      filters: { 'KeePassXC database': ['kdbx'], 'All files': ['*'] },
    });
    if (!target) return;
    if (path.resolve(target.fsPath) === path.resolve(db)) {
      vscode.window.showWarningMessage('VAMP Vault: that is the database itself, not a copy. Pick another folder or name.');
      return;
    }
    try {
      fs.mkdirSync(path.dirname(target.fsPath), { recursive: true });
      fs.copyFileSync(db, target.fsPath);
      output.appendLine(`Exported a copy of ${db} to ${target.fsPath}`);
      const choice = await vscode.window.showInformationMessage(
        `Exported a copy to ${target.fsPath}. It is encrypted with the same master password, so keep it somewhere you would keep the vault and delete it when the copy is no longer needed.`,
        'Reveal Copy',
      );
      if (choice === 'Reveal Copy') await vscode.commands.executeCommand('revealFileInOS', target);
    } catch (error) {
      vscode.window.showErrorMessage(`VAMP Vault: the copy could not be written (${error.message}).`);
      output.appendLine(`export failed: ${error.message}`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vampVault.searchCredentials', async () => {
    const opened = await openVault();
    if (!opened) return;
    const entryPath = await pickEntryPath(opened, 'VAMP Vault — search credentials');
    if (!entryPath) return;
    const action = await vscode.window.showQuickPick([
      { label: '$(person) Copy username', id: 'username' },
      { label: '$(key) Copy password', description: 'asks for approval first', id: 'password' },
      { label: '$(list-unordered) Show details', id: 'details' },
    ], { title: entryPath, placeHolder: 'What should happen with this entry?' });
    if (!action) return;
    const node = { type: 'entry', path: entryPath };
    if (action.id === 'username') await vscode.commands.executeCommand('vampVault.copyUsername', node);
    if (action.id === 'password') await vscode.commands.executeCommand('vampVault.copyPassword', node);
    if (action.id === 'details') await vscode.commands.executeCommand('vampVault.showEntry', node);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vampVault.copyUsername', async arg => {
    const node = treeNode(arg);
    const opened = await openVault();
    if (!opened) return;
    const entryPath = node?.type === 'entry' ? node.path : await pickEntryPath(opened, 'VAMP Vault: copy an entry\'s username');
    if (!entryPath) return;
    try {
      const record = await opened.cli.showEntry({ file: opened.db, entry: entryPath, databasePassword: opened.password, showProtected: false });
      if (!record.username) {
        vscode.window.showWarningMessage(`VAMP Vault: ${entryPath} has no username stored.`);
        return;
      }
      await vscode.env.clipboard.writeText(record.username);
      output.appendLine(`Copied the username for ${entryPath} to the clipboard.`);
      vscode.window.setStatusBarMessage(`VAMP Vault: username for ${entryPath} copied.`, 5000);
    } catch (error) {
      await handleVaultError(error, opened.db);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vampVault.copyPassword', async arg => {
    const node = treeNode(arg);
    const opened = await openVault();
    if (!opened) return;
    const entryPath = node?.type === 'entry' ? node.path : await pickEntryPath(opened, 'VAMP Vault: copy an entry\'s password');
    if (!entryPath) return;
    const choice = await vscode.window.showWarningMessage(
      `Copy the password for "${entryPath}" to the clipboard?`,
      { modal: true, detail: 'Anything running as you can read the clipboard. VAMP Vault clears it 30 seconds later if it still holds the same value.' },
      'Copy Password',
    );
    if (choice !== 'Copy Password') return;
    try {
      const record = await opened.cli.showEntry({ file: opened.db, entry: entryPath, databasePassword: opened.password, showProtected: true });
      if (!record.password) {
        vscode.window.showWarningMessage(`VAMP Vault: ${entryPath} has no password stored.`);
        return;
      }
      await vscode.env.clipboard.writeText(record.password);
      scheduleClipboardClear(record.password);
      output.appendLine(`Approved and copied the password for ${entryPath}.`);
      vscode.window.setStatusBarMessage('VAMP Vault: password copied; cleared in 30 s if the clipboard still holds it.', 7000);
    } catch (error) {
      await handleVaultError(error, opened.db);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vampVault.showEntry', async arg => {
    const node = treeNode(arg);
    const opened = await openVault();
    if (!opened) return;
    const entryPath = node?.type === 'entry' ? node.path : await pickEntryPath(opened, 'VAMP Vault: show an entry');
    if (!entryPath) return;
    try {
      // No -s: the password stays in the CLI as PROTECTED and never reaches this string.
      const record = await opened.cli.showEntry({ file: opened.db, entry: entryPath, databasePassword: opened.password, showProtected: false });
      const notes = (record.notes ?? '').trim();
      const lines = [
        `Path: ${entryPath}`,
        record.username ? `Username: ${record.username}` : 'Username: (none)',
        record.url ? `URL: ${record.url}` : null,
        record.tags?.length ? `Tags: ${record.tags.join(', ')}` : null,
        notes ? `Notes: ${notes.length > 300 ? `${notes.slice(0, 300)}…` : notes}` : null,
        'Password: hidden — copying it asks for approval',
      ].filter(Boolean).join('\n');
      const buttons = [record.username ? 'Copy Username' : null, 'Copy Password', 'Close'].filter(Boolean);
      const choice = await vscode.window.showInformationMessage(lines, { modal: true }, ...buttons);
      if (choice === 'Copy Username') await vscode.commands.executeCommand('vampVault.copyUsername', { type: 'entry', path: entryPath });
      if (choice === 'Copy Password') await vscode.commands.executeCommand('vampVault.copyPassword', { type: 'entry', path: entryPath });
    } catch (error) {
      await handleVaultError(error, opened.db);
    }
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
