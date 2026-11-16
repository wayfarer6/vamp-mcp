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
const version = require('./package.json').version;
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
    // A local and a remote vault can hold an entry with the same path, so the
    // id carries the vault a node belongs to.
    item.id = `${this.kind}:${node.scope ? `${node.scope}/` : ''}${node.path ?? node.id ?? node.label}`;
    if (node.description) item.description = node.description;
    item.tooltip = node.tooltip || node.description || node.label;
    item.iconPath = node.brand && this.brandIcon ? this.brandIcon : new vscode.ThemeIcon(node.icon || 'circle-outline');
    item.contextValue = node.type === 'entry'
      ? 'vampVault.credential'
      : node.type === 'group' ? 'vampVault.group' : `vampVault.${node.type}`;
    if (node.type === 'entry') item.command = {command:'vampVault.openBrowser',title:'View Credential',arguments:[node]};
    if (node.command) item.command = { command: node.command, title: node.label, arguments: [] };
    item.element = node;
    return item;
  }

  async getChildren(node) {
    if (node) return node.children ?? [];
    if (!this.loader) return [];
    const nodes = await this.loader();
    return this.brandIcon ? [{id:'brand',type:'info',label:'VAMP Vault',description:'Encrypted workspace',tooltip:'Encrypted Vault Execution for AI Agents',brand:true,command:'vampVault.status'},...nodes] : nodes;
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
  const stamp = crypto.createHash('sha1').update(context.globalStorageUri.fsPath).digest('hex').slice(0, 8) + '-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
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
      return { unlocked: Boolean(map[request.params?.kdbx ?? kdbx]), stored_databases: Object.keys(map).length, approval_mode:config.get('approvalMode')||'per-session',cache_minutes:Number(config.get('sessionCacheMinutes')??5),revision:state.revision };
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
        ...(config.get('approvalMode')==='each-read'?['Approve once','Cancel']:['Approve once','Approve for this session','Cancel']),
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
  const state = { setup: false, revision: 0, remoteSetup: false };
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

  const approvalNames={'each-read':'Ask every time','per-session':'Ask per entry','off':'No prompts'};
  const approvalItem=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right,89);
  approvalItem.command='vampVault.changeApproval';
  const updateApproval=()=>{const mode=config().get('approvalMode')||'per-session';approvalItem.text=(mode==='off'?'$(warning) ':'$(shield) ')+approvalNames[mode];approvalItem.tooltip='VAMP Vault agent approval level · click to change';approvalItem.show();};
  updateApproval();context.subscriptions.push(approvalItem);
  async function setApproval(mode){
    if(!Object.hasOwn(approvalNames,mode))return;
    if(mode==='off'){
      const answer=await vscode.window.showWarningMessage('Allow agent reads without approval prompts?',{modal:true,detail:'While the vault is unlocked, agents may read credentials without asking. Password reveal/copy buttons still require your action.'},'Disable Approval Prompts');
      if(answer!=='Disable Approval Prompts')return;
    }
    await config().update('approvalMode',mode,vscode.ConfigurationTarget.Global);updateApproval();
  }
  context.subscriptions.push(vscode.commands.registerCommand('vampVault.changeApproval',async()=>{
    const picked=await vscode.window.showQuickPick([
      {label:'1 · Ask every time',description:'Confirm every agent read, including cached values',mode:'each-read'},
      {label:'2 · Ask per entry',description:'Approve once or remember the entry for this session',mode:'per-session'},
      {label:'3 · No prompts',description:'Allow unlocked reads without approval · explicit confirmation required',mode:'off'}
    ],{title:'VAMP Vault · Agent approvals',placeHolder:'Current: '+approvalNames[config().get('approvalMode')||'per-session']});
    if(picked)await setApproval(picked.mode);
  }));
  // ------------------------------------------------------------------ sidebar
  const credentialView = new VaultView('credentials');
  const statusView = new VaultView('status');
  const sidebarBrand = vscode.Uri.file(context.asAbsolutePath('assets/vault-brand.png'));
  statusView.brandIcon = {light:sidebarBrand,dark:sidebarBrand};
  context.subscriptions.push(credentialView, statusView, vscode.window.registerTreeDataProvider('vampVault.views.credentials', credentialView), vscode.window.registerTreeDataProvider('vampVault.views.status', statusView));

  let vaultData = null;      // last read of the credentials view
  let fillToken = 0;         // bumped whenever that read is discarded

  const treeModule = () => loadModule(context, 'dist/runtime/src/tree.mjs');
  const cliReport = () => loadModule(context, 'dist/runtime/src/downloader.mjs')
    .then(({ cliStatus }) => cliStatus({ binDir, overrides: { keepassxc: config().get('keepassxcCliPath') || undefined, veracrypt: config().get('veracryptCliPath') || undefined } }));
  let browser;
  const resetVault = () => { vaultData = null; fillToken += 1; state.revision++; browser?.reset(); };

  const syncContext = async unlocked => {
    await vscode.commands.executeCommand('setContext', 'vampVault.unlocked', Boolean(unlocked));
    await vscode.commands.executeCommand('setContext', 'vampVault.databaseExists', fs.existsSync(kdbxPath()));
  };

  async function credentialData() {
    const generation = fillToken;
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
    if (generation !== fillToken || db !== kdbxPath()) return credentialData();
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

  // ------------------------------------------------------- remote vault (SSH)
  //
  // A remote host owns its own database, its own master password and its own
  // session cache. Nothing below reads the local vault to answer a remote
  // question, and no database is ever copied from one host to another.
  const remoteModule = () => loadModule(context, 'dist/runtime/src/remote_vault_client.mjs');
  const remoteCache = { key: '', at: 0, report: null, error: '', listing: null, listingKey: '', listingAt: 0, listingError: '' };
  const REMOTE_REPORT_TTL = 5 * 60 * 1000;
  const REMOTE_LISTING_TTL = 60 * 1000;

  async function remoteSettings() {
    const module = await remoteModule();
    const vaultConfig = vscode.workspace.getConfiguration('vampVault');
    const sharedConfig = vscode.workspace.getConfiguration('vamp');
    const config = module.resolveRemoteVaultSettings({
      getVault: (key, fallback) => vaultConfig.get(key, fallback),
      getVamp: (key, fallback) => sharedConfig.get(key, fallback),
    });
    return { module, settings: config };
  }

  const remoteKey = (module, settings) => module.remoteVaultId(settings);
  const resetRemote = () => { remoteCache.listing = null; remoteCache.listingAt = 0; remoteCache.at = 0; };

  /**
   * One snapshot of the remote host: settings, the last environment check and
   * whether its master password is held here. Never throws: a broken host is a
   * row in the view, not a failed activation.
   */
  async function remoteEnvironment({ force = false } = {}) {
    let module, settings;
    try {
      ({ module, settings } = await remoteSettings());
    } catch (error) {
      return { enabled: true, configured: false, error: error.message };
    }
    if (!settings.enabled) return { enabled: false };
    const target = settings.host ? module.remoteVaultTarget(settings) : '';
    const state = {
      enabled: true,
      configured: Boolean(settings.host),
      host: settings.host,
      port: settings.port,
      username: settings.username,
      target,
      kdbxPath: settings.kdbxPath,
      volumePath: settings.volumePath,
      mountPoint: settings.mountPoint,
      approvalMode: settings.approvalMode,
      id: remoteKey(module, settings),
      settings,
      checked: false,
      reachable: false,
      error: '',
      databaseExists: false,
      volumeExists: false,
      mounted: [],
      unlocked: false,
      keepassxcAvailable: false,
      keepassxcVersion: null,
      veracryptAvailable: false,
      veracryptVersion: null,
      serverVersion: null,
      nodeVersion: null,
      checkedAt: null,
    };
    if (!state.configured) return state;
    const key = `${module.remoteVaultTarget(settings)}|${settings.kdbxPath}|${settings.port}`;
    state.unlocked = Boolean((await readSecretMap(context))[state.id]);
    const fresh = remoteCache.report && remoteCache.key === key && Date.now() - remoteCache.at < REMOTE_REPORT_TTL;
    if (force || !fresh) {
      // The sidebar must never hang on another machine, so a check that takes
      // longer than a moment finishes in the background and refreshes the views
      // when it arrives.
      await Promise.race([remoteCheck(module, settings, key, target), remoteGrace(VIEW_GRACE_MS)]);
    }
    const report = remoteCache.report;
    state.checked = remoteCache.key === key && remoteCache.at > 0;
    state.error = remoteCache.error;
    if (report) {
      state.reachable = true;
      state.databaseExists = Boolean(report.databaseExists);
      state.volumeExists = Boolean(report.volumeExists);
      state.mounted = report.mounted ?? [];
      state.keepassxcAvailable = Boolean(report.keepassxc?.available);
      state.keepassxcVersion = report.keepassxc?.version ?? null;
      state.veracryptAvailable = Boolean(report.veracrypt?.available);
      state.veracryptVersion = report.veracrypt?.version ?? null;
      state.serverVersion = report.version ?? null;
      state.nodeVersion = report.node ?? null;
      state.checkedAt = new Date(remoteCache.at).toLocaleTimeString();
    }
    return state;
  }

  const VIEW_GRACE_MS = 1500;
  const remoteGrace = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
  let remoteCheckPending = null;

  /** One environment check per host at a time, shared by both views. */
  function remoteCheck(module, settings, key, target) {
    if (remoteCheckPending) return remoteCheckPending;
    remoteCheckPending = (async () => {
      try {
        const client = new module.RemoteVaultClient(settings);
        const report = await client.envCheck();
        remoteCache.report = report;
        remoteCache.key = key;
        remoteCache.at = Date.now();
        remoteCache.error = '';
        output.appendLine(`Remote vault ${target}: ${report.status} · node ${report.node ?? '?'} · keepassxc ${report.keepassxc?.available ? 'ok' : 'missing'} · database ${report.databaseExists ? 'present' : 'missing'}`);
      } catch (error) {
        remoteCache.report = null;
        remoteCache.key = key;
        remoteCache.at = Date.now();
        remoteCache.error = error.message;
        output.appendLine(`Remote vault ${target}: ${error.message}`);
      } finally {
        remoteCheckPending = null;
        credentialView.refresh();
        statusView.refresh();
      }
    })();
    return remoteCheckPending;
  }

  /** The rows of one remote vault, read from that host only when it is unlocked. */
  async function remoteCredentialState() {
    const state = await remoteEnvironment();
    if (!state.enabled) return { enabled: false };
    const view = {
      ...state,
      locked: !state.unlocked,
      listing: null,
      meta: {},
    };
    if (!state.configured || !state.reachable || !state.unlocked) return view;
    const key = state.id;
    if (remoteCache.listingKey !== key) {
      remoteCache.listing = null;
      remoteCache.listingAt = 0;
    }
    // A failed read is cached for the same short window: a host that is down
    // must not cost one SSH timeout on every tree refresh.
    const fresh = remoteCache.listingKey === key && remoteCache.listingAt > 0 && Date.now() - remoteCache.listingAt < REMOTE_LISTING_TTL;
    if (!fresh) {
      const load = async () => {
        try {
          const { module, settings } = await remoteSettings();
          const password = (await readSecretMap(context))[remoteKey(module, settings)];
          const client = new module.RemoteVaultClient(settings);
          const listing = await client.listEntries({ password });
          remoteCache.listing = { entries: listing.entries ?? [], groups: listing.groups ?? [] };
          remoteCache.listingKey = key;
          remoteCache.listingAt = Date.now();
          remoteCache.listingError = '';
        } catch (error) {
          remoteCache.listing = null;
          remoteCache.listingKey = key;
          remoteCache.listingAt = Date.now();
          remoteCache.listingError = error.message;
          output.appendLine(`Remote vault ${state.target}: ${error.message}`);
        } finally {
          credentialView.refresh();
        }
      };
      await Promise.race([load(), remoteGrace(VIEW_GRACE_MS * 2)]);
    }
    if (remoteCache.listing && remoteCache.listingKey === key) view.listing = remoteCache.listing;
    if (remoteCache.listingKey === key && remoteCache.listingError) view.error = view.error || remoteCache.listingError;
    return view;
  }

  credentialView.loader = async () => {
    const { buildCredentialSections } = await treeModule();
    let data;
    try {
      data = await credentialData();
    } catch (error) {
      data = { error: error.message, db: kdbxPath(), exists: false, report: null, unlocked: false, listing: null, meta: {} };
    }
    if (data.listing && !data.filled && !data.error) {
      data.filled = true;
      fillUsernames(data).catch(error => output.appendLine(`username fill stopped: ${error.message}`));
    }
    let remote;
    try {
      remote = await remoteCredentialState();
    } catch (error) {
      remote = { enabled: true, configured: false, error: error.message };
    }
    return buildCredentialSections({
      local: {
        cliAvailable: Boolean(data.report?.keepassxc?.available),
        databaseExists: data.exists,
        locked: !data.unlocked,
        kdbxPath: data.db,
        listing: data.listing,
        meta: data.meta,
        error: data.error,
      },
      remote: remote ?? { enabled: false },
    });
  };

  statusView.loader = async () => {
    const { buildStatusSections } = await treeModule();
    let local;
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
      local = {
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
      };
    } catch (error) {
      local = { databaseExists: false, kdbxPath: kdbxPath(), error: error.message };
    }
    let remote;
    try {
      remote = await remoteEnvironment();
    } catch (error) {
      remote = { enabled: true, configured: false, error: error.message };
    }
    return buildStatusSections({ local, remote: remote ?? { enabled: false } });
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
    if (event.affectsConfiguration('vampVault') || event.affectsConfiguration('vamp.remote')) {
      updateApproval();
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
      return [new vscode.McpStdioServerDefinition('VAMP Vault', process.execPath, [path.join(runtime, 'backends/vault/server.mjs')], environment, version)];
    },
  }));

  // The remote vault is a second, separate MCP server: the agent sees it under
  // its own name and can never mistake one vault's entries for the other's.
  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider('vamp.vault.remote', {
    onDidChangeMcpServerDefinitions: changes.event,
    async provideMcpServerDefinitions() {
      let settings;
      try {
        ({ settings } = await remoteSettings());
      } catch (error) {
        output.appendLine(`Remote vault settings: ${error.message}`);
        return [];
      }
      if (!settings.enabled || !settings.host) return [];
      const environment = {
        ELECTRON_RUN_AS_NODE: '1',
        VAULT_REMOTE_VERSION: version,
        VAULT_REMOTE_MANIFEST: path.join(runtime, 'remote/vault_tools.json'),
      };
      if (bridge.socketPath) {
        environment.VAULT_BRIDGE_SOCKET = bridge.socketPath;
        environment.VAULT_BRIDGE_TOKEN = bridge.token;
      }
      const args = [
        path.join(runtime, 'remote/vault_proxy.mjs'),
        '--host', settings.host,
        '--port', String(settings.port),
        '--node', settings.remoteNodePath,
        '--kdbx', settings.kdbxPath,
        '--volume', settings.volumePath,
        '--mount', settings.mountPoint,
        '--approval-mode', settings.approvalMode,
      ];
      if (settings.username) args.push('--username', settings.username);
      if (settings.privateKeyPath) args.push('--identity', settings.privateKeyPath);
      const label = `VAMP Vault (Remote) · ${settings.username ? `${settings.username}@` : ''}${settings.host}`;
      return [new vscode.McpStdioServerDefinition(label, process.execPath, args, environment, version)];
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
        const line = tool => tool.available || tool.path && ['installed', 'downloaded_present', 'found', 'system_install'].includes(tool.status)
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

  // ------------------------------------------------ remote vault commands

  /**
   * Everything a remote command needs, or null after telling the user what is
   * missing. A remote command never falls back to the local vault: if the host
   * is not usable, nothing is read at all.
   */
  async function requireRemote({ quiet = false } = {}) {
    let module, settings;
    try {
      ({ module, settings } = await remoteSettings());
    } catch (error) {
      if (!quiet) vscode.window.showErrorMessage(`VAMP Vault remote: ${error.message}`);
      return null;
    }
    if (!settings.enabled) {
      if (quiet) return null;
      const choice = await vscode.window.showWarningMessage('VAMP Vault: remote vaults are turned off.', { modal: true }, 'Turn On');
      if (choice !== 'Turn On') return null;
      await config().update('remote.enabled', true, vscode.ConfigurationTarget.Global);
      return requireRemote({ quiet });
    }
    if (!settings.host) {
      if (quiet) return null;
      const choice = await vscode.window.showWarningMessage('VAMP Vault: no remote host is set yet.', { modal: true }, 'Set Up Remote Vault');
      if (choice === 'Set Up Remote Vault') await vscode.commands.executeCommand('vampVault.setupRemote');
      return null;
    }
    const target = `${settings.username ? `${settings.username}@` : ''}${settings.host}`;
    return {
      module,
      settings,
      target,
      id: module.remoteVaultId(settings),
      client: new module.RemoteVaultClient(settings),
    };
  }

  async function remotePassword(opened, { ask = true } = {}) {
    let password = (await readSecretMap(context))[opened.id];
    if (password || !ask) return password ?? null;
    password = await askSecret(`Master password for ${opened.settings.kdbxPath} on ${opened.target} (kept in VS Code secret storage)`);
    if (!password) return null;
    try {
      const check = await opened.client.listEntries({ password });
      if (check.status === 'no_database') {
        const choice = await vscode.window.showWarningMessage(
          `VAMP Vault: ${opened.target} has no database at ${opened.settings.kdbxPath} yet. Nothing was stored.`,
          { modal: true },
          'Create Remote Vault',
        );
        if (choice === 'Create Remote Vault') await vscode.commands.executeCommand('vampVault.createRemoteVault');
        return null;
      }
    } catch (error) {
      output.appendLine(`Remote unlock failed for ${opened.target}: ${error.message}`);
      vscode.window.showErrorMessage(`VAMP Vault: the vault on ${opened.target} could not be opened with that password. Nothing was stored. ${error.message}`);
      return null;
    }
    const map = await readSecretMap(context);
    map[opened.id] = password;
    await writeSecretMap(context, map);
    resetRemote();
    credentialView.refresh();
    statusView.refresh();
    changes.fire();
    return password;
  }

  context.subscriptions.push(vscode.commands.registerCommand('vampVault.setupRemote', async () => {
    if (state.remoteSetup) return;
    state.remoteSetup = true;
    try {
      let module, settings;
      ({ module, settings } = await remoteSettings());
      if (!settings.enabled) {
        await config().update('remote.enabled', true, vscode.ConfigurationTarget.Global);
        ({ module, settings } = await remoteSettings());
      }
      if (!settings.host) {
        const host = await vscode.window.showInputBox({
          prompt: 'SSH host of the remote vault (each host keeps its own vault)',
          placeHolder: 'depot.example.com or 192.0.2.10',
          ignoreFocusOut: true,
        });
        if (!host?.trim()) return;
        await config().update('remote.host', host.trim(), vscode.ConfigurationTarget.Global);
        ({ module, settings } = await remoteSettings());
      }
      const target = module.remoteVaultTarget(settings);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `VAMP Vault: preparing the vault on ${target}` }, async progress => {
        progress.report({ message: 'checking SSH and Node.js on the host' });
        const client = new module.RemoteVaultClient(settings);
        const upload = await client.upload({
          serverFile: path.join(runtime, 'backends/vault/server.mjs'),
          setupScript: path.join(runtime, 'remote/remote_vault_setup.sh'),
        });
        output.appendLine(`Uploaded the vault server ${upload.server_version} to ${target}`);
        progress.report({ message: 'preparing the vault directory and KeePassXC on the host' });
        const report = await client.runSetup({ script: upload.setup_script || undefined });
        output.appendLine(JSON.stringify({ upload, report }, null, 2));
        output.show(true);
        resetRemote();
        changes.fire();
        credentialView.refresh();
        statusView.refresh();
        const marks = { ok: '✓', done: '✓', planned: '·', skipped: '·', pending: '·' };
        const steps = (report.steps ?? []).map(step => `${marks[step.status] ?? '!'} ${step.label}: ${step.status}${step.detail ? ` · ${step.detail}` : ''}`).join('\n');
        const ready = report.status === 'ok';
        const buttons = ['Verify', ...(ready ? [] : ['Open Guide']), 'Close'];
        const choice = await vscode.window.showInformationMessage(
          `Vault host ${target}: ${report.status}\n${steps}\n\nThis host keeps its own database; nothing was copied from this computer.`,
          { modal: true },
          ...buttons,
        );
        if (choice === 'Verify') await vscode.commands.executeCommand('vampVault.verifyRemote');
        if (choice === 'Open Guide') await vscode.commands.executeCommand('vampVault.openGuide');
      });
    } catch (error) {
      output.appendLine(String(error));
      output.show();
      vscode.window.showErrorMessage(`VAMP Vault remote setup failed: ${error.message}`);
    } finally {
      state.remoteSetup = false;
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vampVault.verifyRemote', async () => {
    const opened = await requireRemote();
    if (!opened) return;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `VAMP Vault: checking ${opened.target}` }, async () => {
        const report = await opened.client.envCheck();
        resetRemote();
        credentialView.refresh();
        statusView.refresh();
        const keepass = report.keepassxc;
        const lines = [
          `Host: ${opened.target}`,
          `Node.js on the host: ${report.node ?? 'unknown'}`,
          `Vault server: ${report.version ?? 'unknown'}`,
          `Database: ${opened.settings.kdbxPath} ${report.databaseExists ? '(present)' : '(missing)'}`,
          `KeePassXC: ${keepass.available ? keepass.version ?? 'ready' : `missing · ${keepass.manualInstall}`}`,
          `VeraCrypt: ${report.veracrypt.available ? report.veracrypt.version ?? 'ready' : 'not installed (optional)'}`,
          `Unlocked here: ${(await readSecretMap(context))[opened.id] ? 'yes (this host only)' : 'no'}`,
          '',
          'This vault exists only on the host. The local vault and other hosts keep their own.',
        ];
        output.appendLine(lines.join('\n'));
        const buttons = report.databaseExists ? ['Unlock', 'Close'] : ['Create Remote Vault', 'Close'];
        const choice = await vscode.window.showInformationMessage(lines.join('\n'), { modal: true }, ...buttons);
        if (choice === 'Unlock') await vscode.commands.executeCommand('vampVault.unlockRemote');
        if (choice === 'Create Remote Vault') await vscode.commands.executeCommand('vampVault.createRemoteVault');
      });
    } catch (error) {
      output.appendLine(String(error));
      vscode.window.showErrorMessage(`VAMP Vault: ${opened.target} did not answer. ${error.message}`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vampVault.createRemoteVault', async () => {
    const opened = await requireRemote();
    if (!opened) return;
    try {
      const status = await remoteEnvironment({ force: true });
      if (status.databaseExists) {
        vscode.window.showWarningMessage(`VAMP Vault: ${opened.target} already has a database at ${opened.settings.kdbxPath}. A new one is only created when there is none, so an existing vault is never overwritten.`, { modal: true }, 'Ok');
        return;
      }
      const password = await askPassword(`Master password for the new vault on ${opened.target}`);
      if (!password) return;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `VAMP Vault: creating a database on ${opened.target}` }, async () => {
        const result = await opened.client.call('vault_create', {}, { password });
        const map = await readSecretMap(context);
        map[opened.id] = password;
        await writeSecretMap(context, map);
        resetRemote();
        changes.fire();
        credentialView.refresh();
        statusView.refresh();
        output.appendLine(`Created ${result.file ?? opened.settings.kdbxPath} on ${opened.target}`);
        vscode.window.showInformationMessage(`Vault created on ${opened.target}: ${result.file ?? opened.settings.kdbxPath}. Its master password is kept for this host only; "VAMP Vault: Lock Remote Vault" forgets it.`, 'Ok');
      });
    } catch (error) {
      output.appendLine(String(error));
      output.show();
      vscode.window.showErrorMessage(`Could not create the remote vault: ${error.message}`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vampVault.unlockRemote', async () => {
    const opened = await requireRemote();
    if (!opened) return;
    try {
      const password = await remotePassword(opened, { ask: true });
      if (!password) return;
      const report = await opened.client.listEntries({ password });
      const map = await readSecretMap(context);
      map[opened.id] = password;
      await writeSecretMap(context, map);
      resetRemote();
      credentialView.refresh();
      statusView.refresh();
      changes.fire();
      vscode.window.setStatusBarMessage(`Remote vault on ${opened.target} unlocked · ${(report.entries ?? []).length} entries`, 5000);
    } catch (error) {
      output.appendLine(String(error));
      vscode.window.showErrorMessage(`VAMP Vault: ${error.message}`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vampVault.lockRemote', async () => {
    let module, settings;
    try {
      ({ module, settings } = await remoteSettings());
    } catch (error) {
      vscode.window.showErrorMessage(`VAMP Vault remote: ${error.message}`);
      return;
    }
    const target = settings.host ? module.remoteVaultTarget(settings) : 'the remote host';
    const map = await readSecretMap(context);
    const id = module.remoteVaultId(settings);
    if (map[id]) {
      delete map[id];
      await writeSecretMap(context, map);
    }
    resetRemote();
    credentialView.refresh();
    statusView.refresh();
    changes.fire();
    vscode.window.showInformationMessage(`Remote vault on ${target} locked: its master password is no longer stored. The local vault was not touched.`);
  }));

  /** Read one entry from the remote vault for a sidebar click. */
  async function remoteReadEntry(opened, node, fields) {
    const password = await remotePassword(opened);
    if (!password) return null;
    try {
      return await opened.client.call('vault_get_credential', { entry: node.path, fields, confirm: true }, { password });
    } catch (error) {
      output.appendLine(`Remote read ${node.path} on ${opened.target}: ${error.message}`);
      vscode.window.showErrorMessage(`VAMP Vault: ${error.message}`);
      return null;
    }
  }

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
      let remoteLine = null;
      try {
        const remote = await remoteEnvironment();
        if (remote.enabled && remote.configured) {
          remoteLine = `Remote (${remote.target}): ${remote.databaseExists ? 'database present' : 'no database yet'} · ${(await readSecretMap(context))[remote.id] ? 'unlocked' : 'locked'} · ${remote.reachable ? 'reachable' : remote.error ? 'not reachable' : 'not checked'}`;
          lines.push(remoteLine);
          output.appendLine(remoteLine);
        }
      } catch {}
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

  browser=require('./vault-browser').registerBrowser(context,{
    async load(){
      const data=await credentialData();
      if(data.listing&&!data.filled&&!data.error){data.filled=true;data.usernamesLoading=true;fillUsernames(data).catch(()=>{}).finally(()=>{data.usernamesLoading=false;browser?.refresh();});}
      return {approval_mode:config().get('approvalMode')||'per-session',database:path.basename(data.db),available:data.report.keepassxc.available,exists:data.exists,unlocked:data.unlocked,error:data.error,usernames_loading:!!data.usernamesLoading,
        entries:data.unlocked?(data.listing?.entries||[]).map(e=>({...e,username:data.meta[e.path]?.username||''})):[]};
    },
    async details(entry){
      if(!(await readSecretMap(context))[kdbxPath()])throw Error('The vault is locked. Unlock it to browse.');
      const opened=await openVault();if(!opened)throw Error('Unlock the vault first.');
      return opened.cli.showEntry({file:opened.db,entry,databasePassword:opened.password,showProtected:false});
    },
    setApproval,
    copyUsername:entry=>vscode.commands.executeCommand('vampVault.copyUsername',{type:'entry',path:entry}),
    copyPassword:entry=>vscode.commands.executeCommand('vampVault.copyPassword',{type:'entry',path:entry}),
    async reveal(entry){
      const answer=await vscode.window.showWarningMessage(`Show the password for "${entry}" for 15 seconds?`,{modal:true},'Show Password');
      if(answer!=='Show Password')return;
      if(!(await readSecretMap(context))[kdbxPath()])throw Error('The vault was locked. Unlock it again.');
      const opened=await openVault();if(!opened)return;
      const record=await opened.cli.showEntry({file:opened.db,entry,databasePassword:opened.password,showProtected:true});
      return record.password || '';
    }
  });
  context.subscriptions.push(vscode.commands.registerCommand('vampVault.openDatabase',async()=>{
    const files=await vscode.window.showOpenDialog({canSelectMany:false,filters:{'KeePassXC database':['kdbx']},title:'Open an existing encrypted vault'});
    if(!files?.length)return;
    await config().update('defaultKdbxPath',files[0].fsPath,vscode.ConfigurationTarget.Global);
    resetVault();credentialView.refresh();statusView.refresh();
    await vscode.commands.executeCommand('vampVault.openBrowser');
  }));
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
    if (node?.scope === 'remote') {
      const opened = await requireRemote();
      if (!opened) return;
      const entryPath = node.path;
      const record = await remoteReadEntry(opened, node, ['username']);
      if (!record) return;
      if (!record.username) {
        vscode.window.showWarningMessage(`VAMP Vault: ${entryPath} on ${opened.target} has no username stored.`);
        return;
      }
      await vscode.env.clipboard.writeText(record.username);
      output.appendLine(`Copied the username for ${entryPath} from the vault on ${opened.target}.`);
      vscode.window.setStatusBarMessage(`VAMP Vault: username for ${entryPath} copied from ${opened.target}.`, 5000);
      return;
    }
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
    if (node?.scope === 'remote') {
      const opened = await requireRemote();
      if (!opened) return;
      const entryPath = node.path;
      const choice = await vscode.window.showWarningMessage(
        `Copy the password for "${entryPath}" from the vault on ${opened.target}?`,
        { modal: true, detail: 'Anything running as you can read the clipboard. VAMP Vault clears it 30 seconds later if it still holds the same value.' },
        'Copy Password',
      );
      if (choice !== 'Copy Password') return;
      const record = await remoteReadEntry(opened, node, ['password']);
      if (!record) return;
      if (!record.password) {
        vscode.window.showWarningMessage(`VAMP Vault: ${entryPath} on ${opened.target} has no password stored.`);
        return;
      }
      await vscode.env.clipboard.writeText(record.password);
      scheduleClipboardClear(record.password);
      output.appendLine(`Approved and copied the password for ${entryPath} from ${opened.target}.`);
      vscode.window.setStatusBarMessage('VAMP Vault: password copied; cleared in 30 s if the clipboard still holds it.', 7000);
      return;
    }
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
    if (node?.scope === 'remote') {
      const opened = await requireRemote();
      if (!opened) return;
      const entryPath = node.path;
      const record = await remoteReadEntry(opened, node, ['username', 'url', 'notes']);
      if (!record) return;
      const notes = (record.notes ?? '').trim();
      const lines = [
        `Path: ${entryPath}`,
        `Vault: remote · ${opened.target}`,
        record.username ? `Username: ${record.username}` : 'Username: (none)',
        record.url ? `URL: ${record.url}` : null,
        notes ? `Notes: ${notes.length > 300 ? `${notes.slice(0, 300)}…` : notes}` : null,
        'Password: hidden — copying it asks for approval',
      ].filter(Boolean).join('\n');
      const buttons = [record.username ? 'Copy Username' : null, 'Copy Password', 'Close'].filter(Boolean);
      const choice = await vscode.window.showInformationMessage(lines, { modal: true }, ...buttons);
      if (choice === 'Copy Username') await vscode.commands.executeCommand('vampVault.copyUsername', { type: 'entry', path: entryPath, scope: 'remote' });
      if (choice === 'Copy Password') await vscode.commands.executeCommand('vampVault.copyPassword', { type: 'entry', path: entryPath, scope: 'remote' });
      return;
    }
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
    vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(context.asAbsolutePath('USAGE.md')))));

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
