// Loads the real extension.js against a stand-in `vscode` module, so the
// sidebar wiring — view registration, tree items, the command table, copy,
// export and lock — runs without launching VS Code.
//
//   node build.mjs && node test/extension-host.mjs
//
// It uses a temporary database and temporary storage; nothing touches the
// user's configured vault. Set VAULT_TEST_KEEPASSXC to a keepassxc-cli path to
// run the parts that read a database, otherwise they are skipped.
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const here = import.meta.dirname;
const extensionDir = path.join(here, '..');
const keepassCli = process.env.VAULT_TEST_KEEPASSXC ?? null;
const masterPassword = 'extension-host-master-1234';
const entryPassword = 'extension-host-secret-99';

let passed = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    results.push({ name, status: 'pass' });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, status: 'fail', error: error.message });
    console.log(`  FAIL ${name}\n       ${error.message}`);
    throw error;
  }
}

const workdir = await mkdtemp(path.join(os.tmpdir(), 'vamp-vault-host-'));
const storage = path.join(workdir, 'storage');
const kdbx = path.join(workdir, 'vault.kdbx');

// ------------------------------------------------------------ stand-in vscode
const messages = [];
const answers = { info: [], warning: [], error: [], input: [], quickPick: [], save: [] };
const next = kind => (answers[kind].length ? answers[kind].shift() : undefined);
const answer = (kind, args) => {
  const value = next(kind);
  return typeof value === 'function' ? value(...args) : value;
};

class FakeEventEmitter {
  constructor() { this.fns = new Set(); }
  get event() { return fn => { this.fns.add(fn); return { dispose: () => this.fns.delete(fn) }; }; }
  fire(value) { for (const fn of [...this.fns]) fn(value); }
  dispose() { this.fns.clear(); }
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class ThemeIcon {
  constructor(id) { this.id = id; }
}

const views = new Map();
const commandHandlers = new Map();
const executed = [];
const contextKeys = new Map();
const clipboard = { value: '' };
let mcpProvider;
const configValues = {
  keepassxcCliPath: keepassCli ?? '',
  veracryptCliPath: process.env.VAULT_TEST_VERACRYPT ?? '',
  defaultKdbxPath: kdbx,
  defaultVolumePath: path.join(workdir, 'vault.hc'),
  mountPoint: path.join(workdir, 'mnt'),
  sessionCacheMinutes: 5,
  autoDownloadCli: false,
  approvalMode: 'per-session',
};

const vscode = {
  EventEmitter: FakeEventEmitter,
  TreeItem,
  ThemeIcon,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15 },
  commands: {
    registerCommand(id, handler) {
      commandHandlers.set(id, handler);
      return { dispose: () => commandHandlers.delete(id) };
    },
    async executeCommand(id, ...args) {
      executed.push(id);
      if (id === 'setContext') { contextKeys.set(args[0], args[1]); return; }
      const handler = commandHandlers.get(id);
      if (!handler) throw new Error(`command not registered: ${id}`);
      return handler(...args);
    },
  },
  env: {
    clipboard: {
      async writeText(value) { clipboard.value = value; },
      async readText() { return clipboard.value; },
    },
  },
  McpStdioServerDefinition: class { constructor(_label, _command, _args, env) { this.env = env; } },
  lm: {
    registerMcpServerDefinitionProvider: (_, provider) => { mcpProvider = provider; return { dispose() {} }; },
    McpStdioServerDefinition: class { constructor(_label, _command, _args, env) { this.env = env; } },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => (key in configValues ? configValues[key] : fallback),
      inspect: key => ({ globalValue: configValues[key] }),
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
    createOutputChannel: name => {
      const lines = [];
      return { name, lines, appendLine: line => lines.push(line), append: line => lines.push(line), show() {}, hide() {}, dispose() {} };
    },
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    registerTreeDataProvider: (id, provider) => {
      views.set(id, provider);
      return { dispose: () => views.delete(id) };
    },
    showInformationMessage: async (message, ...rest) => {
      messages.push({ level: 'info', message, rest });
      return answer('info', rest);
    },
    showWarningMessage: async (message, ...rest) => {
      messages.push({ level: 'warning', message, rest });
      return answer('warning', rest);
    },
    showErrorMessage: async (message, ...rest) => {
      messages.push({ level: 'error', message, rest });
      return answer('error', rest);
    },
    showInputBox: async options => answer('input', [options]),
    showQuickPick: async (items, options) => answer('quickPick', [items, options]),
    showSaveDialog: async options => answer('save', [options]),
    withProgress: async (options, task) => task({ report() {} }, { isCancellationRequested: false }),
    setStatusBarMessage: () => ({ dispose() {} }),
  },
};

const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return load.call(this, request, parent, isMain);
};

// ---------------------------------------------------------------- the extension
const secrets = new Map();
const context = {
  subscriptions: [],
  globalStorageUri: { fsPath: storage },
  globalState: { get: () => true, update: async () => {} },
  asAbsolutePath: relative => path.join(extensionDir, relative),
  secrets: {
    get: async key => secrets.get(key),
    store: async (key, value) => { secrets.set(key, value); },
    delete: async key => { secrets.delete(key); },
  },
};

const extension = require(path.join(extensionDir, 'extension.js'));

console.log('VAMP Vault extension host (stand-in vscode)');
console.log(`  workdir: ${workdir}`);
console.log(`  keepassxc-cli: ${keepassCli ?? 'not given (database checks skipped)'}\n`);
console.log('Activation');

const publishReplay=process.platform==='linux' && process.env.VAULT_TEST_REMOTE_REPLAY_BRIDGE==='1';
if (publishReplay) configValues.remoteReplayBridge=true;
const vaultApi=extension.activate(context);

if (publishReplay) await check('remote replay publishes a restricted endpoint for the current Linux user',async()=>{
  await vaultApi.replayBridge();
  const {remoteReplayEndpoint}=await import('../../backends/library/vault-replay.mjs');
  const {BridgeClient}=await import('../src/bridge_client.mjs');
  const endpoint=await remoteReplayEndpoint();
  assert.ok(endpoint);
  const remote=await BridgeClient.connect(endpoint);
  try {
    await assert.rejects(remote.request('unlock',{kdbx}),/invalid bridge token/);
    await assert.rejects(remote.request('mount-podman-workspace',{}),/invalid bridge token/);
  } finally { remote.close(); }
});

await check('both sidebar views are registered', () => {
  assert.deepEqual([...views.keys()].sort(), ['vampVault.views.credentials', 'vampVault.views.status']);
});

await check('every sidebar command is registered', () => {
  for (const id of [
    'vampVault.refreshTree', 'vampVault.unlock', 'vampVault.lock', 'vampVault.revealKdbx',
    'vampVault.exportKdbx', 'vampVault.searchCredentials', 'vampVault.copyUsername',
    'vampVault.copyPassword', 'vampVault.showEntry', 'vampVault.addCredential',
  ]) {
    assert.ok(commandHandlers.has(id), `${id} is not registered`);
  }
});

console.log('\nLocked and empty vault');

const credentials = views.get('vampVault.views.credentials');
const statusView = views.get('vampVault.views.status');

await check('a fresh install shows the first action and no entries', async () => {
  const nodes = await credentials.getChildren();
  assert.ok(nodes.length >= 1);
  const cliStatus = (await statusView.getChildren()).find(node => node.id === 'keepassxc');
  if (keepassCli) assert.equal(cliStatus.icon, 'pass-filled');
  const expected = cliStatus.icon === 'pass-filled' ? 'vampVault.createVault' : 'vampVault.setupCli';
  assert.equal(nodes[0].command, expected);
});

await check('tree items carry an id, a theme icon and a context value', async () => {
  const nodes = await credentials.getChildren();
  const item = credentials.getTreeItem(nodes[0]);
  assert.equal(item.contextValue, 'vampVault.action');
  assert.equal(item.iconPath.id, nodes[0].icon);
  assert.equal(JSON.parse(item.id)[0], 'credentials');
  assert.equal(typeof item.tooltip, 'string');
});

await check('tree refresh keeps a stable folder identity distinct from entries and remote folders', () => {
  const group = { type: 'group', label: 'Mail', path: 'Personal/Mail', children: [] };
  const getId = node => credentials.getTreeItem(node).id;
  const id = getId(group);
  assert.equal(getId({ ...group, description: '2 entries' }), id);
  assert.notEqual(getId({ ...group, type: 'entry' }), id);
  assert.notEqual(getId({ ...group, scope: 'remote' }), id);
});

await check('an entry without children is not expandable', async () => {
  const item = credentials.getTreeItem({ type: 'entry', label: 'Example', path: 'Mail/Example', children: [], description: 'alice', icon: 'key' });
  assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
  assert.equal(item.contextValue, 'vampVault.credential');
  assert.equal(item.description, 'alice');
});

await check('the status view reports the database and both CLIs', async () => {
  const nodes = await statusView.getChildren();
  const ids = nodes.map(node => node.id);
  assert.ok(ids.includes('lock') && ids.includes('database') && ids.includes('keepassxc') && ids.includes('veracrypt'));
  assert.equal(nodes.find(node => node.id === 'database').icon, 'warning');
});

await check('the status view asks the host to refresh without throwing', async () => {
  await commandHandlers.get('vampVault.refreshTree')();


});

if (!keepassCli) {
  console.log('\n  keepassxc-cli not given; database-backed checks skipped.');
} else {
  console.log('\nUnlocked vault');

  const { VaultCli } = await import('../src/vault_cli.mjs');
  const cli = new VaultCli({ keepassxcCli: keepassCli, kdbxPath: kdbx });
  await cli.createDatabase({ file: kdbx, password: masterPassword });
  await cli.addEntry({ file: kdbx, entry: 'Example', group: 'Mail', username: 'alice', secret: entryPassword, url: 'https://example.com', databasePassword: masterPassword });
  secrets.set('vampVault.masterPasswords', JSON.stringify({ [kdbx]: masterPassword }));

  await check('approved resolution audits metadata only even when the destination is unavailable', async () => {
    const { BridgeClient } = await import('../src/bridge_client.mjs');
    const [definition] = await mcpProvider.provideMcpServerDefinitions();
    const bridge = await BridgeClient.connect({ socketPath: definition.env.VAULT_BRIDGE_SOCKET, token: definition.env.VAULT_BRIDGE_TOKEN });
    const vmId = '6725c44b-288f-491f-bb75-1d414ba2ee87';
    configValues.deliveryTargets = { fixture: {
      host: '127.0.0.1', user: 'desktop', identityFile: path.join(workdir, 'missing-identity'),
      knownHostsFile: path.join(workdir, 'missing-known-hosts'), vmId,
    } };
    const args = { entry: 'Mail/Example', field: 'password', destination: 'fixture' };
    const auditPath = path.join(storage, 'credential-delivery.jsonl');
    const replayBridge=await BridgeClient.connect(await vaultApi.replayBridge());
    try {
      await assert.rejects(replayBridge.request('unlock', {kdbx}), /invalid bridge token/);
      const preflight={destination:'fixture',vmId,references:[{entry:args.entry,field:args.field}]};
      assert.deepEqual(await replayBridge.request('check-replay-destination',preflight),{status:'ready'});
      assert.deepEqual(await replayBridge.request('check-replay-destination',{...preflight,references:[{entry:'Missing',field:'password'}]}),{status:'placeholder_unresolved'});
      const prompts = messages.length;
      await assert.rejects(bridge.request('deliver-credential', {...args,vmId:'9725c44b-288f-491f-bb75-1d414ba2ee87'}), /does not match the requested VM UUID/);
      assert.equal(messages.length,prompts);
      assert.deepEqual(await bridge.request('deliver-credential', args), { status: 'denied' });
      await assert.rejects(readFile(auditPath), { code: 'ENOENT' });
      answers.warning.push('Send Credential');
      await assert.rejects(bridge.request('deliver-credential', {...args,vmId:vmId.toUpperCase()}), /known-hosts file is unavailable/);
      const raw = (await readFile(auditPath, 'utf8')).trim();
      assert.ok(!raw.includes(entryPassword) && !raw.includes(masterPassword));
      const { at, ...metadata } = JSON.parse(raw);
      assert.ok(Number.isFinite(Date.parse(at)));
      assert.deepEqual(metadata, { action: 'credential_resolved', caller: 'vault_deliver_credential', ...args,vm_id:vmId });
      const program=path.join(workdir,'stdin-fixture.mjs');
      const expected=createHash('sha256').update(entryPassword+'\n').digest('hex');
      await writeFile(program,`
        import {createHash} from 'node:crypto';
        const hash=createHash('sha256');
        for await(const chunk of process.stdin){hash.update(chunk);process.stdout.write(chunk);}
        if(hash.digest('hex')!==process.argv[2]||process.argv.length!==3||Object.keys(process.env).some(key=>key.startsWith('VAULT_')))process.exit(2);
      `);
      configValues.deliveryTargets.program={executable:process.execPath,args:[program,expected]};
      await assert.rejects(replayBridge.request('deliver-credential',{...args,destination:'program',vmId}),/cannot be used as a VM destination/);
      answers.warning.push('Send Credential');
      const delivered=await bridge.request('deliver-credential',{...args,destination:'program'});
      assert.deepEqual(delivered,{status:'delivered',destination:'program'});
      const audit=await readFile(auditPath,'utf8');
      assert.equal(audit.trim().split('\n').length,2);
      assert.ok(!audit.includes(entryPassword));
      let finishDialog;
      const shown=new Promise(resolve=>answers.warning.push(()=>{
        resolve();
        return new Promise(finish=>{finishDialog=finish;});
      }));
      const pending=replayBridge.request('deliver-credential',{...args,vmId});
      const cancelled=assert.rejects(pending,/bridge closed/);
      await shown;
      replayBridge.close();
      await cancelled;
      await new Promise(resolve=>setTimeout(resolve,100));
      finishDialog('Send Credential');
      await new Promise(resolve=>setTimeout(resolve,100));
      assert.equal(await readFile(auditPath,'utf8'),audit);
      configValues.deliveryTargets.workspace={...configValues.deliveryTargets.fixture,
        guestVolume:{entry:'VeraCrypt/Fixture',device:'/dev/disk/by-path/platform-test-scsi-0:0:0:1',mountPoint:'/mnt/vamp-qa'}};
      const workspace={entry:'VeraCrypt/Fixture',field:'password',destination:'workspace',vmId};
      const beforeWorkspace=messages.length;
      await assert.rejects(bridge.request('deliver-credential',{...workspace,vmId:undefined}),/VM UUID/);
      await assert.rejects(bridge.request('deliver-credential',{...workspace,entry:'Mail/Example'}),/guest volume password/);
      assert.equal(messages.length,beforeWorkspace);
      assert.deepEqual(await bridge.request('deliver-credential',workspace),{status:'denied'});
      assert.equal(await readFile(auditPath,'utf8'),audit);
    } finally {
      delete configValues.deliveryTargets;
      bridge.close();
      replayBridge.close();
    }
  });
  await commandHandlers.get('vampVault.refreshTree')();

  if (process.env.VAULT_TEST_GUEST_VOLUME_CONFIG) {
    await check('approved Vault delivery unlocks a real guest VeraCrypt volume', async () => {
      const fixturePath = process.env.VAULT_TEST_GUEST_VOLUME_CONFIG;
      const target = JSON.parse(await readFile(fixturePath,'utf8'));
      const password = (await readFile(path.join(path.dirname(fixturePath),'volume-key'),'utf8')).trim();
      const entry = 'VeraCrypt/GuestFixture';
      await cli.addEntry({file:kdbx,entry:'GuestFixture',group:'VeraCrypt',secret:password,
        notes:'VAMP format: guest-vhd',databasePassword:masterPassword});
      const { BridgeClient } = await import('../src/bridge_client.mjs');
      const [definition] = await mcpProvider.provideMcpServerDefinitions();
      const bridge = await BridgeClient.connect({socketPath:definition.env.VAULT_BRIDGE_SOCKET,token:definition.env.VAULT_BRIDGE_TOKEN});
      configValues.deliveryTargets={workspace:{...target,guestVolume:{...target.guestVolume,entry}}};
      try {
        const args={entry,field:'password',destination:'workspace',vmId:target.vmId};
        assert.deepEqual(await bridge.request('deliver-credential',args),{status:'denied'});
        answers.warning.push('Send Credential');
        const result=await bridge.request('deliver-credential',args);
        assert.deepEqual(result,{status:'delivered',destination:'workspace'});
        assert.ok(!(await readFile(path.join(storage,'credential-delivery.jsonl'),'utf8')).includes(password));
      } finally {
        delete configValues.deliveryTargets;
        bridge.close();
        await cli.deleteEntry({file:kdbx,entry,databasePassword:masterPassword});
      }
    });
  }
  await check('an unlocked vault lists its group and entry', async () => {
    const deadline = Date.now() + 10000;
    let entry = null;
    let group = null;
    while (Date.now() < deadline) {
      const nodes = await credentials.getChildren();
      group = nodes.find(node => node.label === 'Mail') ?? null;
      entry = group?.children?.[0] ?? null;
      if (entry?.description === 'alice') break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.ok(group, 'the Mail group is missing');
    assert.equal(group.type, 'group');
    assert.equal(entry.path, 'Mail/Example');
    assert.equal(entry.description, 'alice', 'the username fills the entry description');
    assert.equal(entry.icon, 'key');
  });

  await check('the entry tree item is a credential with a selection command', async () => {
    const nodes = await credentials.getChildren();
    const group = nodes.find(node => node.label === 'Mail');
    const item = credentials.getTreeItem(group);
    assert.equal(item.contextValue, 'vampVault.group');
    assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    const entryItem = credentials.getTreeItem(group.children[0]);
    assert.equal(entryItem.contextValue, 'vampVault.credential');
    assert.deepEqual(JSON.parse(entryItem.id), ['credentials', 'local', 'entry', 'Mail/Example']);
  });

  await check('copy username needs no approval', async () => {
    clipboard.value = '';
    await commandHandlers.get('vampVault.copyUsername')({ type: 'entry', path: 'Mail/Example' });
    assert.equal(clipboard.value, 'alice');
  });

  await check('copy password asks first and then copies it', async () => {
    clipboard.value = '';
    answers.warning.push('Copy Password');
    await commandHandlers.get('vampVault.copyPassword')({ type: 'entry', path: 'Mail/Example' });
    assert.equal(clipboard.value, entryPassword);
    const asked = messages.filter(message => message.level === 'warning' && /Copy the password/.test(message.message));
    assert.equal(asked.length, 1, 'the approval dialog was not shown');
  });

  await check('a declined copy leaves the clipboard alone', async () => {
    clipboard.value = 'untouched';
    await commandHandlers.get('vampVault.copyPassword')({ type: 'entry', path: 'Mail/Example' });
    assert.equal(clipboard.value, 'untouched');
  });

  await check('show entry opens details without the password', async () => {
    answers.info.push('Close');
    messages.length = 0;
    await commandHandlers.get('vampVault.showEntry')({ type: 'entry', path: 'Mail/Example' });
    const detail = messages.find(message => /Path: Mail\/Example/.test(message.message));
    assert.ok(detail, 'no detail dialog');
    assert.match(detail.message, /Username: alice/);
    assert.ok(!detail.message.includes(entryPassword), 'the detail dialog leaked the password');
  });

  await check('reveal kdbx hands the file path to the OS file manager', async () => {
    executed.length = 0;
    await commandHandlers.get('vampVault.revealKdbx')();
    assert.ok(executed.includes('revealFileInOS'));
  });

  await check('export copies the database to the chosen path', async () => {
    const target = path.join(workdir, 'exported', 'vault-copy.kdbx');
    answers.save.push({ fsPath: target, scheme: 'file' });
    answers.info.push(undefined);
    await commandHandlers.get('vampVault.exportKdbx')();
    const [original, copy] = await Promise.all([readFile(kdbx), readFile(target)]);
    assert.ok(copy.equals(original), 'the exported copy differs from the database');
  });

  await check('search picks an entry and copies its username', async () => {
    clipboard.value = '';
    answers.quickPick.push(items => items.find(item => item.entryPath === 'Mail/Example'));
    answers.quickPick.push(items => items.find(item => item.id === 'username'));
    await commandHandlers.get('vampVault.searchCredentials')();
    assert.equal(clipboard.value, 'alice');
  });

  await check('lock clears the stored password and the tree asks to unlock', async () => {
    await commandHandlers.get('vampVault.lock')();
    assert.equal(secrets.has('vampVault.masterPasswords'), false);
    const nodes = await credentials.getChildren();
    assert.equal(nodes[0].command, 'vampVault.unlock');
  });

  await check('unlock verifies a typed password before storing it', async () => {
    answers.input.push('wrong-password-here');
    answers.error.push(undefined);
    await commandHandlers.get('vampVault.unlock')();
    assert.equal(secrets.has('vampVault.masterPasswords'), false, 'a rejected password was stored');

    answers.input.push(masterPassword);
    await commandHandlers.get('vampVault.unlock')();
    const stored = JSON.parse(secrets.get('vampVault.masterPasswords'));
    assert.equal(stored[kdbx], masterPassword);
  });
}

console.log('\nRemote vault commands');

await check('the remote vault commands are registered', () => {
  for (const id of ['vampVault.setupRemote', 'vampVault.verifyRemote', 'vampVault.createRemoteVault', 'vampVault.unlockRemote', 'vampVault.lockRemote']) {
    assert.ok(commandHandlers.has(id), `${id} is not registered`);
  }
});

await check('a remote host adds its own section beside the local vault', async () => {
  configValues['remote.enabled'] = true;
  configValues['remote.useVampRemoteSettings'] = false;
  configValues['remote.host'] = '127.0.0.1';
  configValues['remote.port'] = 1;
  configValues['remote.kdbxPath'] = '~/.vamp/vault/vault.kdbx';
  configValues['remote.approvalMode'] = 'per-session';
  await commandHandlers.get('vampVault.refreshTree')();
  const nodes = await statusView.getChildren();
  assert.deepEqual(nodes.filter(node => node.type === 'section').map(node => node.label), ['📦 Local Vault', '🌐 Remote Vault · 127.0.0.1']);
  const remoteRows = nodes.find(node => node.type === 'section' && node.id === 'remote').children.map(node => node.id);
  assert.ok(remoteRows.includes('remoteConnection'));
  assert.ok(remoteRows.includes('remoteLock'));
  const credentialNodes = await credentials.getChildren();
  assert.ok(credentialNodes.some(node => node.label === '🌐 Remote Vault · 127.0.0.1'));
  delete configValues['remote.enabled'];
  delete configValues['remote.host'];
  await commandHandlers.get('vampVault.refreshTree')();
});

await check('locking a remote vault leaves the local password alone', async () => {
  const localMap = { [kdbx]: masterPassword, 'remote-ssh://me@127.0.0.1:1/~/.vamp/vault/vault.kdbx': 'remote-password-1234' };
  secrets.set('vampVault.masterPasswords', JSON.stringify(localMap));
  configValues['remote.host'] = '127.0.0.1';
  configValues['remote.port'] = 1;
  configValues['remote.username'] = 'me';
  configValues['remote.kdbxPath'] = '~/.vamp/vault/vault.kdbx';
  configValues['remote.useVampRemoteSettings'] = false;
  await commandHandlers.get('vampVault.lockRemote')();
  const stored = JSON.parse(secrets.get('vampVault.masterPasswords'));
  assert.equal(stored[kdbx], masterPassword, 'the local password must survive locking a remote vault');
  assert.equal(stored['remote-ssh://me@127.0.0.1:1/~/.vamp/vault/vault.kdbx'], undefined);
  delete configValues['remote.host'];
});

for (const disposable of context.subscriptions) {
  try { disposable?.dispose?.(); } catch {}
}
extension.deactivate?.();
if (publishReplay) {
  const {remoteReplayEndpoint}=await import('../../backends/library/vault-replay.mjs');
  assert.equal(await remoteReplayEndpoint(),null);
}
await rm(workdir, { recursive: true, force: true });

console.log(`\n${passed}/${results.length} checks passed`);
process.exit(results.some(item => item.status === 'fail') ? 1 : 0);
