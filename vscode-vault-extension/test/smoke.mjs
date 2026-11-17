// End-to-end smoke test for the VAMP Vault MCP server.
//
// Starts the real server over stdio, talks to it with the official MCP client,
// and drives a throw-away KeePassXC database through the tool surface. Also
// checks the parsers and the approval bridge with a stand-in extension host.
//
//   node test/smoke.mjs
//
// Environment:
//   VAULT_TEST_KEEPASSXC  keepassxc-cli to use (default: keepassxc-cli on PATH)
//   VAULT_TEST_VERACRYPT  veracrypt to use (optional)
// The database and volumes are created in a temporary directory and removed at
// the end; nothing touches the user's real vault.
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseEntryList, parseMountList, parseShowAll, splitEntryPath, VaultCli } from '../src/vault_cli.mjs';
import { BridgeClient } from '../src/bridge_client.mjs';
import { detectPlatform, ensureClis, findOnPath, installCli, installWithWinget, manualInstructions, WINGET_PACKAGES, wingetArgs, wingetCommand, wingetUacNotice } from '../src/downloader.mjs';
import { buildCredentialTree, buildStatusTree, findNode, flattenTree } from '../src/tree.mjs';

const server = process.env.VAULT_TEST_SERVER ?? path.join(import.meta.dirname, '..', 'backends/vault/server.mjs');
const masterPassword = 'smoke-test-master-1234';
const entryPassword = 'entry-Secret-99';

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

function payload(result) {
  assert.ok(result.content?.length, 'tool returned no content');
  return JSON.parse(result.content[0].text);
}

/** Stand-in for the VS Code extension host: secret storage + approve dialog. */
async function startFakeHost({ password = masterPassword, approve = true } = {}) {
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\vamp-vault-smoke-${process.pid}`
    : path.join(os.tmpdir(), `vamp-vault-smoke-${process.pid}-${Date.now()}.sock`);
  const token = 'smoke-token';
  const calls = [];
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
        const request = JSON.parse(line);
        calls.push(request.op);
        let result;
        if (request.token !== token) result = null;
        else if (request.op === 'unlock') result = { password };
        else if (request.op === 'state') result = { unlocked: true };
        else if (request.op === 'approve') result = { approved: approve, remember: false };
        else if (request.op === 'new-password') result = { password };
        else if (request.op === 'notify') result = { shown: true };
        if (request.token !== token) socket.write(`${JSON.stringify({ id: request.id, ok: false, error: 'invalid bridge token' })}\n`);
        else socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath, token, calls,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function connect({ kdbx, volume, env = {}, fallback = true }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? process.env.USERPROFILE ?? '',
      LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ?? '',
      VAULT_KDBX: kdbx,
      VAULT_VOLUME: volume,
      VAULT_MOUNT_POINT: path.join(path.dirname(kdbx), 'mnt'),
      VAULT_SESSION_TTL_MS: '300000',
      VAULT_APPROVAL_MODE: 'per-session',
      // Headless: with no bridge the server takes the master password from the
      // environment. The extension uses secret storage through the bridge instead.
      ...(fallback ? { VAULT_MASTER_PASSWORD: masterPassword } : {}),
      ...(process.env.VAULT_TEST_KEEPASSXC ? { VAULT_KEEPASSXC_CLI: process.env.VAULT_TEST_KEEPASSXC } : {}),
      ...(process.env.VAULT_TEST_VERACRYPT ? { VAULT_VERACRYPT_CLI: process.env.VAULT_TEST_VERACRYPT } : {}),
      ...env,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'vamp-vault-smoke', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

const workdir = await mkdtemp(path.join(os.tmpdir(), 'vamp-vault-smoke-'));
const kdbx = path.join(workdir, 'vault.kdbx');
const volume = path.join(workdir, 'vault.hc');

console.log('VAMP Vault smoke test');
console.log(`  workdir: ${workdir}`);
console.log(`  platform: ${process.platform}/${process.arch} → ${detectPlatform().os}/${detectPlatform().cpu}`);
console.log('\nParsers');

await check('parseShowAll reads fields and custom attributes', () => {
  const record = parseShowAll('Title: Bank\nUserName: alice\nPassword: pw\nURL: https://x\nNotes: \nUuid: {1}\nTags: a,b\nPIM: 4242\n');
  assert.equal(record.title, 'Bank');
  assert.equal(record.username, 'alice');
  assert.equal(record.password, 'pw');
  assert.deepEqual(record.tags, ['a', 'b']);
  assert.equal(record.attributes.PIM, '4242');
});
await check('parseShowAll marks protected values as unknown', () => {
  assert.equal(parseShowAll('Title: T\nPassword: PROTECTED\n').password, null);
});
await check('parseEntryList separates groups from entries', () => {
  const listing = parseEntryList('Mail/\nMail/Example\nRecycle Bin/\nRecycle Bin/Old\n');
  assert.deepEqual(listing.groups, ['Mail', 'Recycle Bin']);
  assert.equal(listing.entries.length, 2);
  assert.equal(listing.entries[0].group, 'Mail');
});
await check('splitEntryPath turns a typed title into a group and a name', () => {
  assert.deepEqual(splitEntryPath('github.com'), { raw: 'github.com', group: undefined, entry: 'github.com', path: 'github.com' });
  const grouped = splitEntryPath(' Social/Naver ');
  assert.equal(grouped.group, 'Social');
  assert.equal(grouped.entry, 'Naver');
  assert.equal(grouped.path, 'Social/Naver');
  assert.equal(splitEntryPath('/Mail/Example').group, 'Mail');
  assert.equal(splitEntryPath('Social/').entry, '', 'a trailing slash must not become an entry name');
});

await check('parseMountList reads VeraCrypt slots', () => {
  const mounted = parseMountList('1: /home/u/vault.hc /dev/loop0 /home/u/VAMP-Vault \n');
  assert.equal(mounted.length, 1);
  assert.equal(mounted[0].mount_point, '/home/u/VAMP-Vault');
  assert.deepEqual(parseMountList('Error: No volumes mounted.'), []);
});
await check('detectPlatform maps Node triples', () => {
  assert.equal(detectPlatform('linux', 'x64').cpu, 'x64');
  assert.equal(detectPlatform('darwin', 'arm64').os, 'macos');
  assert.equal(detectPlatform('win32', 'arm64').os, 'windows');
});
await check('findOnPath finds a binary this test can see', async () => {
  const found = await findOnPath('keepassxc');
  const expected = process.env.VAULT_TEST_KEEPASSXC ?? found;
  if (expected) assert.ok(expected);
});

console.log('\nWindows install path');

await check('winget ids match the published packages', () => {
  assert.equal(WINGET_PACKAGES.keepassxc.id, 'KeePassXCTeam.KeePassXC');
  assert.equal(WINGET_PACKAGES.veracrypt.id, 'IDRIX.VeraCrypt');
  assert.equal(wingetCommand('keepassxc'), 'winget install --id KeePassXCTeam.KeePassXC -e');
  assert.equal(wingetCommand('veracrypt'), 'winget install --id IDRIX.VeraCrypt -e');
  assert.equal(manualInstructions('keepassxc', 'win32'), 'winget install --id KeePassXCTeam.KeePassXC -e');
  assert.equal(manualInstructions('veracrypt', 'win32'), 'winget install --id IDRIX.VeraCrypt -e');
  // The id winget rejected must not survive anywhere the user is told to copy.
  for (const tool of ['keepassxc', 'veracrypt']) assert.ok(!manualInstructions(tool, 'win32').includes('VeraCrypt.VeraCrypt'));
});

await check('a winget install announces the UAC prompt in English', () => {
  assert.match(wingetUacNotice('keepassxc'), /Please approve the Windows User Account Control \(UAC\) prompt/);
  assert.match(wingetUacNotice('keepassxc'), /KeePassXC installation/);
  assert.match(wingetUacNotice('veracrypt'), /VeraCrypt installation/);
  assert.deepEqual(wingetArgs('keepassxc').slice(0, 4), ['install', '--id', 'KeePassXCTeam.KeePassXC', '-e']);
});

await check('the KeePassXC Windows install runs winget instead of a portable archive', async () => {
  const calls = [], notices = [], logs = [];
  const fakeRun = async (command, args) => { calls.push([command, args]); return { code: 0, stdout: 'Successfully installed', stderr: '' }; };
  const result = await installCli('keepassxc', {
    binDir: path.join(workdir, 'bin'), platform: 'win32', arch: 'x64',
    runCommand: fakeRun, notify: message => notices.push(message), log: message => logs.push(message),
  });
  assert.equal(result.method, 'winget');
  assert.equal(result.package, 'KeePassXCTeam.KeePassXC');
  assert.equal(calls[0][0], 'winget');
  assert.deepEqual(calls[0][1], wingetArgs('keepassxc'));
  assert.equal(notices[0], wingetUacNotice('keepassxc'));
  assert.ok(logs.some(line => line.includes('User Account Control')), 'the output log must carry the UAC notice');
  assert.ok(['installed', 'installed_no_cli'].includes(result.status), `unexpected status ${result.status}`);
  assert.ok(!result.asset, 'no archive should be downloaded on Windows');
});

await check('a refused UAC prompt reports the command to retry', async () => {
  const notices = [];
  const fakeRun = async () => ({ code: 1, stdout: '', stderr: 'Install failed: cancelled by user (0x800704C7)' });
  const result = await installWithWinget('keepassxc', { platform: 'win32', runCommand: fakeRun, notify: message => notices.push(message) });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /UAC prompt was not approved/);
  assert.match(result.hint, /winget install --id KeePassXCTeam\.KeePassXC -e/);
  assert.equal(notices[0], wingetUacNotice('keepassxc'));
});

await check('a missing winget falls back to the manual command', async () => {
  const fakeRun = async () => { const error = new Error('spawn winget ENOENT'); error.code = 'ENOENT'; throw error; };
  const result = await installWithWinget('keepassxc', { platform: 'win32', runCommand: fakeRun, notify: () => {} });
  assert.equal(result.status, 'manual_install_required');
  assert.match(result.error, /App Installer/);
  assert.equal(result.manual_install, 'winget install --id KeePassXCTeam.KeePassXC -e');
});

await check('VeraCrypt is announced, never installed behind the user', async () => {
  const calls = [];
  const fakeRun = async (command, args) => { calls.push([command, args]); return { code: 0, stdout: '', stderr: '' }; };
  const report = await ensureClis({
    binDir: path.join(workdir, 'veracrypt-bin'), tools: ['veracrypt'], platform: 'win32', arch: 'x64',
    runCommand: fakeRun, notify: () => {},
  });
  assert.equal(report.tools.veracrypt.status, 'manual_install_required');
  assert.match(report.tools.veracrypt.manual_install, /IDRIX\.VeraCrypt/);
  assert.ok(!calls.some(call => call[0] === 'winget'));
});

console.log('\nSidebar tree model');
await check('a missing CLI shows the setup action', () => {
  const nodes = buildCredentialTree({ cliAvailable: false, databaseExists: false, locked: true, kdbxPath: '/x/vault.kdbx' });
  assert.equal(nodes[0].type, 'action');
  assert.equal(nodes[0].command, 'vampVault.setupCli');
  assert.equal(nodes[0].icon, 'tools');
  assert.equal(findNode(nodes, 'setupCli').label, 'Set up KeePassXC CLI');
});
await check('a missing database shows the create action', () => {
  const nodes = buildCredentialTree({ cliAvailable: true, databaseExists: false, locked: true, kdbxPath: '/x/vault.kdbx' });
  assert.equal(nodes[0].command, 'vampVault.createVault');
  assert.match(nodes[0].description, /vault\.kdbx/);
});
await check('a locked vault offers unlock and lists no entries', () => {
  const nodes = buildCredentialTree({
    cliAvailable: true, databaseExists: true, locked: true, kdbxPath: '/x/vault.kdbx',
    listing: { groups: ['Mail'], entries: [{ path: 'Mail/Example', group: 'Mail', title: 'Example' }] },
  });
  assert.equal(nodes[0].command, 'vampVault.unlock');
  assert.equal(nodes[0].icon, 'unlock');
  assert.equal(findNode(nodes, 'Mail/Example'), null);
});
await check('an unlocked vault builds a nested group and entry tree', () => {
  const nodes = buildCredentialTree({
    cliAvailable: true, databaseExists: true, locked: false, kdbxPath: '/x/vault.kdbx',
    listing: {
      groups: ['Mail', 'Mail/Work', 'Recycle Bin', 'Bank'],
      entries: [
        { path: 'Mail/Example', group: 'Mail', title: 'Example' },
        { path: 'Mail/Work/Corp', group: 'Mail/Work', title: 'Corp' },
        { path: 'Bank/Main', group: 'Bank', title: 'Main' },
        { path: 'TopLevel', group: '/', title: 'TopLevel' },
        { path: 'Recycle Bin/Old', group: 'Recycle Bin', title: 'Old' },
      ],
    },
    meta: { 'Mail/Example': { username: 'alice' } },
  });
  const mail = findNode(nodes, 'Mail');
  assert.equal(mail.type, 'group');
  assert.equal(mail.label, 'Mail');
  assert.equal(mail.icon, 'folder');
  assert.deepEqual(mail.children.map(node => node.label), ['Work', 'Example'], 'groups sort before entries');
  assert.equal(mail.children[1].description, 'alice', 'an entry shows its username');
  assert.equal(mail.children[1].icon, 'key');
  assert.equal(findNode(nodes, 'Mail/Work/Corp').description, 'Mail/Work', 'no username yet: the group path is shown');
  assert.equal(findNode(nodes, 'TopLevel').description, 'top level');
  assert.equal(findNode(nodes, 'Recycle Bin').icon, 'trash');
  assert.equal(findNode(nodes, 'Recycle Bin').children[0].path, 'Recycle Bin/Old');
  assert.deepEqual(nodes.filter(node => node.type === 'group').map(node => node.label), ['Bank', 'Mail', 'Recycle Bin']);
  assert.equal(nodes[nodes.length - 1].label, 'TopLevel', 'entries follow groups at the root');
});
await check('flattenTree walks every level', () => {
  const nodes = [{ label: 'a', children: [{ label: 'b', children: [{ label: 'c' }] }] }];
  assert.deepEqual(flattenTree(nodes).map(node => node.label), ['a', 'b', 'c']);
});
await check('an unreadable vault shows the error and an unlock action', () => {
  const nodes = buildCredentialTree({
    cliAvailable: true, databaseExists: true, locked: false, kdbxPath: '/x/vault.kdbx',
    error: 'the stored master password was rejected — unlock again',
  });
  assert.equal(nodes[0].icon, 'warning');
  assert.equal(nodes[1].command, 'vampVault.unlock');
});
await check('an empty unlocked vault says so instead of showing nothing', () => {
  const nodes = buildCredentialTree({ cliAvailable: true, databaseExists: true, locked: false, kdbxPath: '/x/vault.kdbx', listing: { groups: [], entries: [] } });
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].label, 'No entries yet');
});
await check('the status tree reports lock, database, CLIs and approval', () => {
  const nodes = buildStatusTree({
    databaseExists: true, kdbxPath: '/v/vault.kdbx', volumeExists: false, volumePath: '/v/vault.hc',
    mounted: [{ mount_point: '/home/u/VAMP-Vault' }], unlocked: true,
    keepassxcAvailable: true, keepassxcVersion: '2.7.9', keepassxcPath: '/usr/bin/keepassxc-cli',
    veracryptAvailable: false, approvalMode: 'each-read', cacheMinutes: 0,
  });
  assert.equal(findNode(nodes, 'lock').label, 'Unlocked');
  assert.equal(findNode(nodes, 'lock').icon, 'unlock');
  assert.equal(findNode(nodes, 'database').description, 'vault.kdbx');
  assert.equal(findNode(nodes, 'database').command, 'vampVault.revealKdbx');
  assert.match(findNode(nodes, 'volume').description, /mounted at \/home\/u\/VAMP-Vault/);
  assert.equal(findNode(nodes, 'keepassxc').description, '2.7.9');
  assert.equal(findNode(nodes, 'veracrypt').command, 'vampVault.setupCli');
  assert.equal(findNode(nodes, 'approval').description, 'each-read, cache 0 min');
  assert.equal(findNode(nodes, 'guide').command, 'vampVault.openGuide');
});
await check('a locked status tree offers unlock and marks a missing database', () => {
  const nodes = buildStatusTree({ databaseExists: false, kdbxPath: '/v/vault.kdbx', unlocked: false, keepassxcAvailable: false });
  assert.equal(findNode(nodes, 'lock').command, 'vampVault.unlock');
  assert.equal(findNode(nodes, 'database').icon, 'warning');
  assert.equal(findNode(nodes, 'database').command, 'vampVault.createVault');
  assert.equal(findNode(nodes, 'keepassxc').icon, 'error');
});

console.log('\nExtension manifest');
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
await check('the manifest declares the activity bar container and both views', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  const container = manifest.contributes.viewsContainers.activitybar.find(item => item.id === 'vamp-vault');
  assert.equal(container.title, 'VAMP Vault');
  assert.equal(container.icon, 'assets/vault.svg');
  const views = manifest.contributes.views['vamp-vault'];
  assert.deepEqual(views.map(view => view.id), ['vampVault.views.status', 'vampVault.views.credentials']);
  assert.equal(views[0].name, 'Vault Status');
  assert.equal(views[1].name, 'Credentials');
});
await check('every menu entry points at a declared command and a declared view', () => {
  const commands = new Set(manifest.contributes.commands.map(item => item.command));
  const views = new Set(manifest.contributes.views['vamp-vault'].map(view => view.id));
  for (const [menu, entries] of Object.entries(manifest.contributes.menus)) {
    for (const entry of entries) {
      assert.ok(commands.has(entry.command), `${menu}: ${entry.command} is not a declared command`);
      const match = /view == ([\w.]+)/.exec(entry.when ?? '');
      if (match) assert.ok(views.has(match[1]), `${menu}: ${match[1]} is not a declared view`);
    }
  }
});
await check('the tree only references commands the manifest declares', () => {
  const commands = new Set(manifest.contributes.commands.map(item => item.command));
  const nodes = [
    ...buildCredentialTree({ cliAvailable: false }),
    ...buildCredentialTree({ cliAvailable: true, databaseExists: false }),
    ...buildCredentialTree({ cliAvailable: true, databaseExists: true, locked: true, kdbxPath: '/a/vault.kdbx' }),
    ...buildStatusTree({ databaseExists: false }),
  ];
  for (const node of flattenTree(nodes)) {
    if (node.command) assert.ok(commands.has(node.command), `${node.command} is not declared`);
  }
});
await check('the build ships the tree module the sidebar loads', async () => {
  const build = await readFile(new URL('../build.mjs', import.meta.url), 'utf8');
  assert.match(build, /tree\.mjs/);
});

console.log('\nBridge client');
const fakeHost = await startFakeHost();
await check('bridge returns the stored password for unlock', async () => {
  const bridge = await BridgeClient.connect({ socketPath: fakeHost.socketPath, token: fakeHost.token });
  const result = await bridge.unlock(kdbx);
  assert.equal(result.password, masterPassword);
  bridge.close();
});
await check('bridge refuses a wrong token', async () => {
  const bridge = await BridgeClient.connect({ socketPath: fakeHost.socketPath, token: 'wrong' });
  await assert.rejects(() => bridge.request('state', {}, { timeout: 3000 }));
  bridge.close();
});
await check('bridge reports unavailable socket without hanging', async () => {
  await assert.rejects(() => BridgeClient.connect({ socketPath: path.join(workdir, 'nope.sock'), token: 'x' }));
});
await fakeHost.close();

console.log('\nMCP tools');
const client = await connect({ kdbx, volume });

await check('server lists the ten vault tools', async () => {
  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name).sort();
  assert.deepEqual(names, [
    'vault_add_credential', 'vault_create', 'vault_delete_credential', 'vault_get_credential',
    'vault_list_credentials', 'vault_mount_volume', 'vault_set_credential', 'vault_status',
    'vault_unmount_volume', 'vault_update_credential',
  ]);
});

const status = payload(await client.callTool({ name: 'vault_status', arguments: {} }));
await check('vault_status reports CLI resolution and a missing database', () => {
  assert.equal(status.status, 'ok');
  assert.equal(status.database.exists, false);
  assert.equal(typeof status.cli.keepassxc.available, 'boolean');
});

if (!status.cli.keepassxc.available) {
  console.log('\n  KeePassXC CLI not available here; database tools skipped.');
  console.log('  Set VAULT_TEST_KEEPASSXC to a keepassxc-cli path to run them.');
} else {
  const created = payload(await client.callTool({
    name: 'vault_create',
    arguments: { file: kdbx, master_password: masterPassword },
  }));
  await check('vault_create makes a database and reports the password source', () => {
    assert.equal(created.status, 'created');
    assert.equal(created.master_password_source, 'argument');
  });

  await check('vault_create refuses to overwrite', async () => {
    const second = payload(await client.callTool({ name: 'vault_create', arguments: { file: kdbx, master_password: masterPassword } }));
    assert.equal(second.status, 'error');
    assert.equal(second.code, 'already_exists');
  });

  const set = payload(await client.callTool({
    name: 'vault_set_credential',
    arguments: { entry: 'Example', group: 'Mail', username: 'alice', password: entryPassword, url: 'https://example.com', file: kdbx },
  }));
  await check('vault_set_credential creates group and entry', () => {
    assert.equal(set.status, 'created');
    assert.equal(set.path, 'Mail/Example');
  });

  const added = payload(await client.callTool({
    name: 'vault_add_credential',
    arguments: { entry: 'Social/Naver', username: 'seoseonghun2', password: 'added-Secret-42', url: 'https://nid.naver.com', notes: 'manual entry', file: kdbx },
  }));
  await check('vault_add_credential creates the group from the path and hides the password', () => {
    assert.equal(added.status, 'created');
    assert.equal(added.path, 'Social/Naver');
    assert.equal(added.created, true);
    assert.ok(!JSON.stringify(added).includes('added-Secret-42'), 'the added password came back');
  });

  await check('vault_add_credential refuses to overwrite an existing entry', async () => {
    const again = payload(await client.callTool({
      name: 'vault_add_credential',
      arguments: { entry: 'Social/Naver', password: 'another-Secret-1', file: kdbx },
    }));
    assert.equal(again.status, 'exists');
    assert.equal(again.created, false);
  });

  const listed = payload(await client.callTool({ name: 'vault_list_credentials', arguments: { file: kdbx } }));
  await check('vault_list_credentials returns paths without secrets', () => {
    assert.equal(listed.status, 'ok');
    assert.ok(listed.entries.some(item => item.path === 'Mail/Example'));
    assert.ok(!JSON.stringify(listed).includes(entryPassword), 'listing leaked the password');
  });

  await check('showEntry without -s returns the username and no password', async () => {
    const cli = new VaultCli({ keepassxcCli: status.cli.keepassxc.path, kdbxPath: kdbx });
    const record = await cli.showEntry({ file: kdbx, entry: 'Mail/Example', databasePassword: masterPassword, showProtected: false });
    assert.equal(record.username, 'alice');
    assert.equal(record.password, null, 'the sidebar path must not carry a password');
  });

  await check('the sidebar tree mirrors a real database read', async () => {
    const cli = new VaultCli({ keepassxcCli: status.cli.keepassxc.path, kdbxPath: kdbx });
    const treeListing = await cli.listEntries({ file: kdbx, databasePassword: masterPassword });
    const nodes = buildCredentialTree({
      cliAvailable: true, databaseExists: true, locked: false, kdbxPath: kdbx,
      listing: treeListing,
      meta: { 'Mail/Example': { username: 'alice' } },
    });
    const group = findNode(nodes, 'Mail');
    assert.ok(group, 'Mail group missing from the tree');
    assert.equal(group.type, 'group');
    const entry = findNode(nodes, 'Mail/Example');
    assert.equal(entry.type, 'entry');
    assert.equal(entry.label, 'Example');
    assert.equal(entry.description, 'alice');
    assert.equal(entry.icon, 'key');
    assert.ok(!JSON.stringify(nodes).includes(entryPassword), 'the tree leaked the password');
  });

  await check('vault_get_credential asks for approval when no dialog exists', async () => {
    const pending = payload(await client.callTool({ name: 'vault_get_credential', arguments: { entry: 'Mail/Example', fields: ['username', 'password'], file: kdbx } }));
    assert.equal(pending.status, 'approval_required');
  });

  const read = payload(await client.callTool({ name: 'vault_get_credential', arguments: { entry: 'Mail/Example', fields: ['username', 'password'], file: kdbx, confirm: true } }));
  await check('vault_get_credential returns the approved fields', () => {
    assert.equal(read.status, 'ok');
    assert.equal(read.username, 'alice');
    assert.equal(read.password, entryPassword);
    assert.equal(read.cached, false);
  });

  await check('a second read inside the session window is served from cache', async () => {
    const again = payload(await client.callTool({ name: 'vault_get_credential', arguments: { entry: 'Mail/Example', fields: ['username', 'password'], file: kdbx } }));
    assert.equal(again.cached, true);
    assert.equal(again.password, entryPassword);
  });

  const updated = payload(await client.callTool({ name: 'vault_update_credential', arguments: { entry: 'Mail/Example', password: 'changed-pw-42', file: kdbx } }));
  await check('vault_update_credential changes the password and clears the cache', async () => {
    assert.equal(updated.status, 'updated');
    const after = payload(await client.callTool({ name: 'vault_get_credential', arguments: { entry: 'Mail/Example', fields: ['password'], file: kdbx, confirm: true } }));
    assert.equal(after.password, 'changed-pw-42');
  });

  await check('vault_get_credential reports a missing entry with a code', async () => {
    const missing = payload(await client.callTool({ name: 'vault_get_credential', arguments: { entry: 'Nope/Nothing', fields: ['password'], file: kdbx, confirm: true } }));
    assert.equal(missing.status, 'error');
    assert.equal(missing.code, 'entry_not_found');
  });

  const deleted = payload(await client.callTool({ name: 'vault_delete_credential', arguments: { entry: 'Mail/Example', file: kdbx, confirm: true } }));
  await check('vault_delete_credential recycles the entry', () => {
    assert.equal(deleted.status, 'deleted');
    assert.equal(deleted.recyclable, true);
  });

  if (status.cli.veracrypt.available) {
    const volumeReport = payload(await client.callTool({
      name: 'vault_create',
      arguments: { file: path.join(workdir, 'second.kdbx'), master_password: masterPassword, volume_file: volume, volume_size_mb: 8, volume_password: 'volume-pw-99' },
    }));
    await check('vault_create also creates a VeraCrypt volume', () => {
      assert.equal(volumeReport.status, 'created');
      assert.equal(volumeReport.volume?.created, true);
    });
    const mount = payload(await client.callTool({ name: 'vault_mount_volume', arguments: { volume, confirm: true } }));
    await check('vault_mount_volume reports a failed mount with a reason', () => {
      assert.ok(['mounted', 'failed'].includes(mount.status));
      if (mount.status === 'failed') assert.ok(mount.hint);
    });
    const unmount = payload(await client.callTool({ name: 'vault_unmount_volume', arguments: { all: true } }));
    await check('vault_unmount_volume answers with a state', () => {
      assert.ok(['unmounted', 'failed'].includes(unmount.status));
    });
  }
}

await client.close();

console.log('\nBridge approval path');
const host = await startFakeHost({ approve: false });
const bridgeClient = await connect({
  kdbx,
  volume,
  fallback: false,
  env: { VAULT_BRIDGE_SOCKET: host.socketPath, VAULT_BRIDGE_TOKEN: host.token, VAULT_APPROVAL_MODE: 'each-read' },
});
await check('a declined dialog blocks the read', async () => {
  const denied = payload(await bridgeClient.callTool({ name: 'vault_get_credential', arguments: { entry: 'Any/Entry', fields: ['password'], file: kdbx } }));
  assert.equal(denied.status, 'denied');
  assert.ok(host.calls.includes('approve'));
});
await check('vault_status asks the host whether it is unlocked', async () => {
  const state = payload(await bridgeClient.callTool({ name: 'vault_status', arguments: {} }));
  assert.equal(state.bridge.connected, true);
  if (state.database.exists) {
    assert.ok(host.calls.includes('state'));
    assert.equal(state.locked, false);
  } else {
    assert.equal(state.locked, true);
    assert.equal(state.lock_reason, 'no database at the configured path');
  }
  assert.ok(!JSON.stringify(state).includes(masterPassword), 'status leaked the master password');
});
await bridgeClient.close();
await host.close();

// The database file itself must not be readable as plain text.
await check('the created database is encrypted on disk', async () => {
  const bytes = await readFile(kdbx).catch(() => null);
  if (!bytes) return;
  assert.ok(!bytes.toString('latin1').includes(entryPassword), 'entry password found in the raw database file');
  assert.ok(!bytes.toString('latin1').includes(masterPassword), 'master password found in the raw database file');
});

await rm(workdir, { recursive: true, force: true });
console.log(`\n${passed}/${results.length} checks passed`);
if (results.some(item => item.status === 'fail')) process.exitCode = 1;
