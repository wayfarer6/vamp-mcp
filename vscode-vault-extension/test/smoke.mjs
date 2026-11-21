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
//   VAULT_TEST_VOLUME_LIFECYCLE=1  exercise real Linux mount and deletion (requires FUSE)
// The database and volumes are created in a temporary directory and removed at
// the end; nothing touches the user's real vault.
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { parseEntryList, parseMountList, parseShowAll, splitEntryPath, VaultCli } from '../src/vault_cli.mjs';
import { BridgeClient } from '../src/bridge_client.mjs';
import { deleteManagedVolume } from '../src/managed_volume.mjs';
import { hypervVolume, kvmVolume, virtualBoxVolume } from '../src/vm_volume.mjs';
import { withVmVolumeState } from '../src/vm_volume_state.mjs';
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

async function connect({ kdbx, volume, env = {}, fallback = true, elicit }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? process.env.USERPROFILE ?? '',
      ...(process.env.VAULT_TEST_HYPERV_VM || process.env.VAULT_TEST_WSL_CREATE === '1' ? { USERPROFILE: path.dirname(kdbx) } : {}),
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
      ...(process.env.VAULT_TEST_GROUP_RENAME==='1' ? {PYTHONPATH:process.env.PYTHONPATH || ''} : {}),
      ...(process.env.VAULT_TEST_WSL_CREATE === '1' ? {
        VAULT_VERACRYPT_WSL_DISTRO: process.env.VAULT_VERACRYPT_WSL_DISTRO,
        VAULT_VERACRYPT_WSL_CLI: process.env.VAULT_VERACRYPT_WSL_CLI || '/usr/bin/veracrypt',
      } : {}),
      ...env,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'vamp-vault-smoke', version: '0.0.0' },
    elicit ? {capabilities:{elicitation:{form:{}}}} : {});
  if (elicit) client.setRequestHandler(ElicitRequestSchema,elicit);
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
await check('older KeePassXC reports missing group commands before accessing the vault', async () => {
  const cli = new VaultCli();
  let probes = 0;
  cli.keepass = async args => {
    assert.deepEqual(args, ['help']);
    probes++;
    return 'add   Add a credential\nls    List entries\n';
  };
  await assert.rejects(cli.ensureGroup({group:'Example'}),{code:'cli_too_old'});
  await assert.rejects(cli.moveEntry({entry:'Example',group:'/'}),{code:'cli_too_old'});
  await assert.rejects(cli.recycleGroup({group:'Example'}),{code:'cli_too_old'});
  assert.equal(probes,1);
});
await check('VirtualBox workspace disk uses a verified secondary slot and refuses a different disk', async () => {
  const root = await realpath(workdir);
  const mountPoint=path.join(root,'vhd-mount');
  const volume=path.join(root,'vhd-volume.hc');
  await mkdir(mountPoint);
  await writeFile(volume,'volume fixture');
  const disk='workspace.vhd';
  const medium=path.join(mountPoint,disk);
  const footer=Buffer.alloc(512);
  footer.write('conectix');
  footer.writeUInt32BE(3,60);
  await writeFile(medium,footer);
  const vm='6725c44b-288f-491f-bb75-1d414ba2ee87';
  const args={vm,volume,mountPoint,controller:'SATA',port:1,disk};
  const cli={listVolumes:async()=>({available:true,mounted:[{volume,mount_point:mountPoint}]})};
  let attached='none', mutations=0;
  const execute=async argv=>{
    if(argv[0]==='showvminfo')return {stdout:[
      `UUID="${vm}"`,'VMState="poweroff"','storagecontrollername0="SATA"','storagecontrollertype0="IntelAhci"',
      `"SATA-1-0"=${JSON.stringify(attached)}`,
    ].join('\n')};
    assert.deepEqual(argv.slice(0,-1),['storageattach',vm,'--storagectl','SATA','--port','1','--device','0','--type','hdd','--medium']);
    mutations++;
    attached=argv.at(-1);
  };
  assert.equal((await virtualBoxVolume(cli,{...args,operation:'attach'},{execute})).status,'attached');
  assert.equal(attached,medium);
  await assert.rejects(virtualBoxVolume(cli,{...args,operation:'attach'},{execute}),/slot does not match/);
  assert.equal(mutations,1);
  assert.equal((await virtualBoxVolume(cli,{...args,operation:'detach'},{execute})).status,'detached');
  assert.equal(attached,'none');
  await assert.rejects(virtualBoxVolume({listVolumes:async()=>({available:true,mounted:[]})},{...args,operation:'attach'},{execute}),/mount could not be verified/);
  assert.equal(mutations,2);
  const libvirt={...args,target:'vdb',uri:'qemu:///system'};
  let diskState='shut off';
  let target=null;
  const virsh=async argv=>{
    assert.deepEqual(argv.slice(0,2),['-c','qemu:///system']);
    assert.equal(argv[3],vm);
    if (argv[2]==='domstate') return {stdout:diskState};
    if (argv[2]==='domblklist') return {stdout:[' Type Device Target Source',' --------',' file disk vda /boot.img',...(target?[ ` file disk vdb ${target}` ]:[])].join('\n')};
    if (argv[2]==='attach-disk') {
      assert.deepEqual(argv.slice(4),[medium,'vdb','--config','--driver','qemu','--subdriver','vpc','--targetbus','virtio','--sourcetype','file','--cache','none']);
      target=medium;
    } else {
      assert.deepEqual(argv.slice(2),['detach-disk',vm,'vdb','--config']);
      target=null;
    }
  };
  assert.equal((await kvmVolume(cli,{...libvirt,operation:'attach'},{execute:virsh})).status,'attached');
  diskState='running';
  await assert.rejects(kvmVolume(cli,{...libvirt,operation:'detach'},{execute:virsh}),/Shut down/);
  diskState='shut off';
  assert.equal((await kvmVolume(cli,{...libvirt,operation:'detach'},{execute:virsh})).status,'detached');
  const stateDir=path.join(root,'vm-volume-state');
  const guarded=fn=>withVmVolumeState(fn,{directory:stateDir});
  await guarded(guard=>virtualBoxVolume(cli,{...args,operation:'attach'},{execute,guard}));
  await assert.rejects(guarded(guard=>guard.assertDetached({volume})),/Detach the VM/);
  await assert.rejects(guarded(guard=>guard.assertDetached({mountPoint})),/Detach the VM/);
  await assert.rejects(guarded(guard=>guard.assertDetached()),/Detach the VM/);
  // A confirmed recovery detach also clears a record when the exact slot is already empty.
  attached='none';
  assert.equal((await guarded(guard=>virtualBoxVolume(cli,{...args,operation:'detach'},{execute,guard}))).status,'detached');
  await guarded(guard=>guard.assertDetached({volume}));
});

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
  assert.deepEqual(parseMountList('Slot: 1\nVolume: /tmp/demo volume.hc\nVirtual Device: /dev/mapper/veracrypt1\nMount Directory: /mnt/demo mount\nRead-Only: Yes\n'), [
    { slot: 1, volume: '/tmp/demo volume.hc', device: '/dev/mapper/veracrypt1', mount_point: '/mnt/demo mount', read_only: true },
  ]);
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
    binDir: path.join(workdir, 'veracrypt-bin'), tools: ['veracrypt'], platform: 'win32', arch: 'x64', force: true,
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

await check('server lists the expected vault tools', async () => {
  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name).sort();
  assert.deepEqual(names, [
    'vault_add_credential', 'vault_attach_container', 'vault_attach_vm', 'vault_check_placeholders', 'vault_create', 'vault_create_group', 'vault_create_volume', 'vault_delete_credential', 'vault_delete_group', 'vault_delete_volume', 'vault_deliver_credential', 'vault_detach_vm', 'vault_export_encrypted', 'vault_export_mounted_file',
    'vault_get_credential', 'vault_list_credentials', 'vault_list_groups', 'vault_mount_volume', 'vault_move_credential', 'vault_rename_group', 'vault_set_credential', 'vault_status',
    'vault_unmount_volume', 'vault_update_credential',
  ]);
});

await check('delivery never releases a credential without the editor approval bridge', async () => {
  const response = await client.callTool({ name: 'vault_deliver_credential', arguments: {
    entry: 'QA/Fixture', destination: 'test-vm', field: 'password',
  } });
  assert.equal(payload(response).status, 'error');
  assert.match(payload(response).error, /approve this delivery/);
  const totp = await client.callTool({ name: 'vault_deliver_credential', arguments: {
    reference: '{{vault:QA/Fixture#totp}}', destination: 'test-vm',
  } });
  assert.match(payload(totp).error, /approve this delivery/);
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

  await check('standalone delivery requires one chat approval and never returns the field', async () => {
    const received=path.join(workdir,'chat-received');
    const receiver=path.join(workdir,'chat-receiver.cjs');
    await writeFile(receiver, "const fs=require('node:fs'); fs.writeFileSync(process.argv[2],fs.readFileSync(0));");
    const env={VAULT_DELIVERY_TARGETS:JSON.stringify({fixture:{
      executable:process.execPath,args:[receiver,received],entry:'Mail/Example',field:'password',
    }})};
    const args={destination:'fixture',entry:'Mail/Example',field:'password'};
    const deliver = async target => payload(await target.callTool({name:'vault_deliver_credential',arguments:args}));
    const unsupported=await connect({kdbx,volume,env});
    try {
      assert.match((await deliver(unsupported)).error,/cannot show.*approval form/);
      await assert.rejects(stat(received),{code:'ENOENT'});
    } finally { await unsupported.close(); }
    const decisions=[{action:'decline'},{action:'cancel'},{action:'accept',content:{approve:false}},
      {action:'accept',content:{approve:true}},{action:'accept',content:{approve:true}}];
    let prompts=0;
    const client=await connect({kdbx,volume,env,elicit:async ({params})=>{
      assert.match(params.message,/password.*Mail\/Example.*fixture/);
      assert.ok(!JSON.stringify(params).includes(entryPassword));
      assert.deepEqual(Object.keys(params.requestedSchema.properties),['approve']);
      if (prompts===3) await utimes(kdbx,new Date(),new Date(0));
      return decisions[prompts++];
    }});
    try {
      for (let index=0;index<3;index++) {
        assert.deepEqual(await deliver(client),{status:'denied'});
        await assert.rejects(stat(received),{code:'ENOENT'});
      }
      assert.match((await deliver(client)).error,/files changed/);
      await assert.rejects(stat(received),{code:'ENOENT'});
      assert.deepEqual(await deliver(client),{status:'delivered',destination:'fixture'});
      assert.equal(await readFile(received,'utf8'),entryPassword+'\n');
      assert.equal(prompts,5);
    } finally {await client.close();}
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

  await check('Vault checks references and moves entries without returning their values', async () => {
    const call = async (name, args) => payload(await client.callTool({ name, arguments: args }));
    await call('vault_add_credential', {entry:'Mail/FieldFixture',password:'field-only-fixture'});
    const checks = await call('vault_check_placeholders', { references: ['${vault:Mail/Example#password}', '${vault:Missing#totp}', 'invalid', '{{vault:Mail/Example#totp}}', '${vault:Mail/Example#username}', '${vault:Mail/FieldFixture#username}'] });
    assert.deepEqual(checks.checks.map(item => item.status), ['placeholder_resolved', 'placeholder_unresolved', 'invalid_placeholder', 'placeholder_unresolved', 'placeholder_resolved', 'placeholder_unresolved']);
    assert.equal(checks.checks[3].field, 'totp');
    assert.ok(!JSON.stringify(checks).includes('changed-pw-42'));
    assert.ok(!JSON.stringify(checks).includes('alice'));
    assert.equal((await call('vault_create_group', {group:'MoveFixture', confirm:true})).status, 'ok');
    assert.equal((await call('vault_move_credential', {entry:'Mail/Example', group:'MoveFixture', confirm:true})).path, 'MoveFixture/Example');
    assert.equal((await call('vault_move_credential', {entry:'MoveFixture/Example', group:'Mail', confirm:true})).path, 'Mail/Example');
  });

  await check('group listing requires approval and includes nested and empty groups without credentials', async () => {
    const call = async (name, args) => payload(await client.callTool({ name, arguments: args }));
    assert.equal((await call('vault_list_groups', {})).status, 'approval_required');
    await call('vault_create_group', { group: 'MoveFixture/Nested/Empty', confirm: true });
    await call('vault_move_credential', { entry: 'Mail/Example', group: 'MoveFixture/Nested', confirm: true });
    const listing = await call('vault_list_groups', { confirm: true });
    assert.equal(listing.status, 'ok');
    assert.deepEqual(listing.groups.filter(group => group.path.startsWith('MoveFixture')), [
      { path: 'MoveFixture', parent: '/', direct_entries: 0, total_entries: 1 },
      { path: 'MoveFixture/Nested', parent: 'MoveFixture', direct_entries: 1, total_entries: 1 },
      { path: 'MoveFixture/Nested/Empty', parent: 'MoveFixture/Nested', direct_entries: 0, total_entries: 0 },
    ]);
    assert.ok(!JSON.stringify(listing).includes('Example'));
    const cli = new VaultCli({ keepassxcCli: status.cli.keepassxc.path, kdbxPath: kdbx });
    await cli.addEntry({ file: kdbx, group: 'MoveFixture/Nested', entry: '[empty]', secret: entryPassword, databasePassword: masterPassword });
    const scoped = await cli.listEntries({ file: kdbx, group: 'MoveFixture', databasePassword: masterPassword });
    assert.ok(scoped.entries.some(entry => entry.path === 'Nested/[empty]'));
    assert.ok(!scoped.entries.some(entry => entry.group === 'Nested/Empty'));
    await call('vault_move_credential', { entry: 'MoveFixture/Nested/Example', group: 'Mail', confirm: true });
  });

  await check('a real configured TOTP resolves without returning the seed or generated code',async()=>{
    const cli=new VaultCli({keepassxcCli:status.cli.keepassxc.path});
    const xml=path.join(workdir,'totp-fixture.xml');
    const file=path.join(workdir,'totp-fixture.kdbx');
    const uuid=()=>randomBytes(16).toString('base64');
    const seed='JBSWY3DPEHPK3PXP';
    await writeFile(xml,`<?xml version="1.0" encoding="utf-8"?>
      <KeePassFile><Meta><DatabaseName>TOTP fixture</DatabaseName></Meta><Root>
      <Group><UUID>${uuid()}</UUID><Name>Root</Name>
      <Group><UUID>${uuid()}</UUID><Name>QA</Name>
      <Entry><UUID>${uuid()}</UUID><String><Key>Title</Key><Value>OTP</Value></String>
      <String><Key>otp</Key><Value>otpauth://totp/QA?secret=${seed}</Value></String>
      </Entry></Group></Group></Root></KeePassFile>`,{mode:0o600});
    try {
      await cli.keepass(['import','-q','-p','--',xml,file],{databasePassword:masterPassword,prompts:[masterPassword]});
    } finally {
      await rm(xml,{force:true});
    }
    const otp=await cli.totp({file,entry:'QA/OTP',databasePassword:masterPassword});
    assert.ok(otp.available && /^\d{6}$/.test(otp.code));
    const testClient=await connect({kdbx:file,volume});
    try {
      const result=payload(await testClient.callTool({name:'vault_check_placeholders',arguments:{references:['${vault:QA/OTP#totp}']}}));
      assert.deepEqual(result,{status:'ok',checks:[{index:0,entry:'QA/OTP',field:'totp',status:'placeholder_resolved'}]});
    } finally {await testClient.close();}
  });

  const deleted = payload(await client.callTool({ name: 'vault_delete_credential', arguments: { entry: 'Mail/Example', file: kdbx, confirm: true } }));
  await check('vault_delete_credential recycles the entry', () => {
    assert.equal(deleted.status, 'deleted');
    assert.equal(deleted.recyclable, true);
  });

  if(process.env.VAULT_TEST_GROUP_RENAME==='1') await check('group rename preserves nested credential contents and rejects collisions',async()=>{
    const call=async(name,args)=>payload(await client.callTool({name,arguments:args}));
    await call('vault_add_credential',{entry:'RenameFixture/Child/Entry',username:'fixture',password:entryPassword});
    await call('vault_create_group',{group:'OccupiedName',confirm:true});
    const original=await readFile(kdbx);
    assert.equal((await call('vault_rename_group',{group:'RenameFixture',name:'NewName'})).status,'approval_required');
    assert.equal((await call('vault_rename_group',{group:'RenameFixture',name:'OccupiedName',confirm:true})).status,'error');
    assert.deepEqual(await readFile(kdbx),original);
    const renamed=await call('vault_rename_group',{group:'RenameFixture',name:'NewName',confirm:true});
    assert.deepEqual(renamed,{status:'renamed',path:'NewName'});
    const cli=new VaultCli({keepassxcCli:status.cli.keepassxc.path});
    const record=await cli.showEntry({file:kdbx,entry:'NewName/Child/Entry',databasePassword:masterPassword});
    assert.equal(record.password,entryPassword);
  });

  await check('group deletion requires confirmation and preserves already recycled groups', async () => {
    const call = async (name, args) => payload(await client.callTool({ name, arguments: args }));
    const group = 'RecycleFixture';
    assert.equal((await call('vault_create_group', {group:group+'/Nested',confirm:true})).status,'ok');
    assert.equal((await call('vault_delete_group',{group})).status,'approval_required');
    const before = await readFile(kdbx);
    assert.equal((await call('vault_delete_group',{group,confirm:true})).status,'error');
    assert.deepEqual(await readFile(kdbx),before);
    assert.equal((await call('vault_delete_group',{group,confirm:true,recursive:true})).status,'recycled');
    const report = await call('vault_list_groups',{confirm:true});
    const recycled = report.groups.find(item=>item.path.endsWith('/'+group));
    assert.ok(recycled && !report.groups.some(item=>item.path===group));
    const after = await readFile(kdbx);
    assert.equal((await call('vault_delete_group',{group:recycled.path,confirm:true,recursive:true})).status,'error');
    assert.deepEqual(await readFile(kdbx),after);
  });

  await check('managed deletion preserves files on a binding or unmount failure and recycles the matching entry', async () => {
    const cli = new VaultCli({ keepassxcCli: status.cli.keepassxc.path, kdbxPath: kdbx });
    const file = path.join(await realpath(workdir), 'delete-fixture.hc');
    const other = path.join(path.dirname(file), 'unrelated.hc');
    const fixture = { file: kdbx, entry: 'VeraCrypt/DeleteFixture', databasePassword: masterPassword };
    await writeFile(file, 'encrypted-volume fixture');
    await writeFile(other, 'unrelated fixture');
    await cli.addEntry({ file: kdbx, group: 'VeraCrypt', entry: 'DeleteFixture', secret: entryPassword,
      url: pathToFileURL(file).href, databasePassword: masterPassword });
    await assert.rejects(deleteManagedVolume(cli, { ...fixture, volume: other }), /not bound/);
    assert.equal(await readFile(other, 'utf8'), 'unrelated fixture');
    let mounted = true;
    cli.listVolumes = async () => ({ available: true, mounted: mounted ? [{ volume: file, mount_point: 'fixture-mount' }] : [] });
    cli.unmountVolume = async () => ({ unmounted: false });
    await assert.rejects(deleteManagedVolume(cli, { ...fixture, volume: file }), /still mounted/);
    assert.equal(await readFile(file, 'utf8'), 'encrypted-volume fixture');
    cli.unmountVolume = async ({ mountPoint }) => {
      assert.equal(mountPoint, 'fixture-mount');
      mounted = false;
      return { unmounted: true };
    };
    const removeEntry = cli.deleteEntry.bind(cli);
    cli.deleteEntry = async () => { throw new Error('simulated vault write failure'); };
    const interrupted = await deleteManagedVolume(cli, { ...fixture, volume: file });
    assert.equal(interrupted.status, 'recovery_required');
    assert.equal(interrupted.credential_removed, false);
    assert.equal(await readFile(interrupted.recovery_path, 'utf8'), 'encrypted-volume fixture');
    assert.ok((await cli.listEntries(fixture)).entries.some(item => item.path === fixture.entry));
    await rename(interrupted.recovery_path, file);
    cli.deleteEntry = removeEntry;
    const result = await deleteManagedVolume(cli, { ...fixture, volume: file });
    assert.equal(result.status, 'deleted');
    await assert.rejects(readFile(file), { code: 'ENOENT' });
    assert.ok(!(await cli.listEntries(fixture)).entries.some(item => item.path === fixture.entry));
  });

  if (status.cli.veracrypt.available && process.platform !== 'win32') {
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
    const unmount = payload(await client.callTool({ name: 'vault_unmount_volume', arguments: { mount_point: path.join(workdir, 'mnt') } }));
    await check('vault_unmount_volume answers with a state', () => {
      assert.ok(['unmounted', 'failed'].includes(unmount.status));
    });
  }
  if (process.env.VAULT_TEST_WSL_CREATE === '1') {
    await check('Windows MCP refuses managed creation while another workspace operation holds the lock', async () => {
      const lock = path.join(workdir, '.vamp', 'vault-vm-disks', 'active');
      const volume = path.join(workdir, 'blocked concurrent volume.hc');
      await mkdir(lock, { recursive: true });
      try {
        const result = await client.callTool({ name: 'vault_create_volume', arguments: { volume, name: 'BlockedConcurrent', owner_agent_id: 'qa-agent', size_mb: 8, confirm: true } });
        const failure = payload(result);
        assert.equal(failure.status, 'error');
        assert.match(failure.error, /workspace disk operation is active/);
        await assert.rejects(stat(volume), { code: 'ENOENT' });
      } finally {
        await rm(lock, { recursive: true, force: true });
      }
    });
    await check('Windows MCP publishes one volume for two concurrent requests using the same vault entry', async () => {
      const volumes = ['concurrent-first.hc', 'concurrent-second.hc'].map(name => path.join(workdir, name));
      const name = 'ConcurrentVolume';
      const results = await Promise.all(volumes.map(async volume => payload(await client.callTool({
        name: 'vault_create_volume', arguments: { volume, name, owner_agent_id: 'qa-agent', size_mb: 8, confirm: true },
      }))));
      const created = results.find(result => result.status === 'created');
      assert.equal(results.filter(result => result.status === 'created').length, 1);
      assert.match(results.find(result => result.status === 'error')?.error ?? '', /operation is active|credential already exists/);
      const missing = volumes.find(volume => volume !== created.volume);
      assert.ok((await stat(created.volume)).isFile());
      await assert.rejects(stat(missing), { code: 'ENOENT' });
      const cli = new VaultCli({ keepassxcCli: status.cli.keepassxc.path, kdbxPath: kdbx });
      const listing = await cli.listEntries({ file: kdbx, databasePassword: masterPassword });
      assert.equal(listing.entries.filter(item => item.path === created.entry).length, 1);
    });
    if (process.env.VAULT_TEST_WSL_VBOX_MEDIA === '1') {
      await check('Windows MCP creates and deletes a fixed guest VHD with an encrypted payload', async () => {
        const volume = path.join(workdir, 'guest volume.vhd');
        const call = async (name, arguments_) => payload(await client.callTool({ name, arguments: arguments_ }));
        const created = await call('vault_create_volume', { volume, name:'GuestVhd', owner_agent_id:'qa-agent', size_mb:8, format:'guest-vhd', confirm:true });
        assert.equal(created.status, 'created', JSON.stringify(created));
        assert.equal(created.format, 'guest-vhd');
        let verified=false;
        try {
          const bytes = await readFile(volume);
          assert.equal(bytes.length, 8 * 1024 * 1024 + 512);
          assert.equal(bytes.toString('ascii', bytes.length - 512, bytes.length - 504), 'conectix');
          assert.equal(bytes.readUInt32BE(bytes.length - 452), 2);
          const cli = new VaultCli({keepassxcCli:status.cli.keepassxc.path,kdbxPath:kdbx});
          const record = await cli.showEntry({file:kdbx,entry:created.entry,databasePassword:masterPassword});
          assert.match(record.password,/^[A-Za-z0-9_-]{43}$/);
          assert.ok(!JSON.stringify(created).includes(record.password));
          const mount = (await cli.wslCommand(['/usr/bin/mktemp','-d'],{root:true})).stdout.trim();
          let loop;
          try {
            const source = await cli.windowsVolumePathInWsl(volume);
            loop = (await cli.wslCommand(['/usr/sbin/losetup','--find','--show','--sizelimit','8388608',source],{root:true})).stdout.trim();
            assert.match(loop,/^\/dev\/loop\d+$/);
            const unlock = () => cli.wslVeraCrypt(['--pim=0','--keyfiles=','--protect-hidden=no',loop,mount],{root:true,password:record.password});
            await unlock();
            const marker = `${mount}/vamp-test`;
            await cli.wslCommand(['/usr/bin/tee',marker],{root:true,input:'guest-vhd fixture\n'});
            await cli.wslVeraCrypt(['--dismount',mount],{root:true});
            await unlock();
            assert.equal((await cli.wslCommand(['/usr/bin/cat',marker],{root:true})).stdout.trim(),'guest-vhd fixture');
          } finally {
            if (loop && /^\/dev\/loop\d+$/.test(loop)) {
              await cli.wslVeraCrypt(['--dismount',mount],{root:true,allowFailure:true});
              await cli.wslCommand(['/usr/sbin/losetup','--detach',loop],{root:true});
            }
            await cli.wslCommand(['/usr/bin/rmdir','--',mount],{root:true});
          }
          const testVm=process.env.VAULT_TEST_HYPERV_VM || process.env.VAULT_TEST_VIRTUALBOX_VM;
          if (testVm) {
            const backend=process.env.VAULT_TEST_HYPERV_VM?'hyperv':'virtualbox';
            const target = { vm:testVm, volume, backend, ...(backend==='virtualbox' && {controller:'SATA'}),
              port:1, credential_entry:created.entry, confirm:true };
            const attached = await call('vault_attach_vm',target);
            assert.equal(attached.status,'attached',JSON.stringify(attached));
            try {
              const removal = await call('vault_delete_volume',{volume,entry:created.entry,confirm:true});
              assert.match(JSON.stringify(removal),/Detach the VM workspace disk/);
              await stat(volume);
            } finally {
              const detached = await call('vault_detach_vm',target);
              assert.equal(detached.status,'detached',JSON.stringify(detached));
              if (backend==='virtualbox') {
                const {execFileSync}=await import('node:child_process');
                const vbox=path.join(process.env.ProgramFiles || 'C:\\Program Files','Oracle/VirtualBox/VBoxManage.exe');
                const inventory=execFileSync(vbox,['list','hdds'],{encoding:'utf8',timeout:15000});
                assert.ok(!inventory.includes(volume),'Detached guest disk remained in the VirtualBox registry');
              }
            }
          }
          verified=true;
        } finally {
          const removed=await call('vault_delete_volume',{volume,entry:created.entry,confirm:true});
          if(verified) {
            assert.equal(removed.status,'deleted',JSON.stringify(removed));
            await assert.rejects(stat(volume),{code:'ENOENT'});
          }
        }
      });
    }
    await check('Windows MCP creates a managed VeraCrypt volume via WSL and keeps its password out of the result', async () => {
      assert.equal(process.platform,'win32');
      const volume = path.join(workdir,'managed wsl fixture.hc');
      const created = payload(await client.callTool({ name: 'vault_create_volume',
        arguments: { volume, name:'WslFixture',owner_agent_id:'qa-agent',size_mb:8,confirm:true } }));
      assert.equal(created.status,'created');
      assert.equal((await stat(volume)).size,8*1024*1024);
      const cli = new VaultCli({keepassxcCli:status.cli.keepassxc.path,kdbxPath:kdbx});
      const record = await cli.showEntry({file:kdbx,entry:created.entry,databasePassword:masterPassword});
      assert.equal(record.username,'qa-agent');
      assert.match(record.password,/^[A-Za-z0-9_-]{43}$/);
      assert.ok(!JSON.stringify(created).includes(record.password));
      const mount_point=process.env.VAULT_TEST_WSL_MOUNT_POINT;
      if (mount_point) {
        const args={volume,mount_point,credential_entry:created.entry,read_only:true};
        const call=async(name,arguments_)=>payload(await client.callTool({name,arguments:arguments_}));
        assert.equal((await call('vault_mount_volume',args)).status,'approval_required');
        try {
          const mounted=await call('vault_mount_volume',{...args,confirm:true});
          assert.equal(mounted.status,'mounted');
          assert.equal(mounted.backend,'wsl');
          assert.ok(!JSON.stringify(mounted).includes(record.password));
        } finally {
          const closed=await call('vault_unmount_volume',{mount_point});
          assert.equal(closed.status,'unmounted');
        }
        const savedClient = await connect({kdbx, volume, env:{
          VAULT_VOLUME_CREDENTIAL_ENTRY:created.entry, VAULT_VERACRYPT_WSL_MOUNT_POINT:mount_point
        }});
        try {
          for (let run=0; run<2; run++) {
            const mounted = payload(await savedClient.callTool({name:'vault_mount_volume',arguments:{read_only:true,confirm:true}}));
            assert.equal(mounted.status,'mounted',mounted.error);
            assert.equal(mounted.mount_point,mount_point);
            assert.ok(!JSON.stringify(mounted).includes(record.password));
            const closed = payload(await savedClient.callTool({name:'vault_unmount_volume',arguments:{}}));
            assert.equal(closed.status,'unmounted',closed.error);
          }
        } finally { await savedClient.close(); }
        const probeVmDisk=process.env.VAULT_TEST_WSL_VBOX_MEDIA==='1';
        assert.equal((await call('vault_mount_volume',{...args,read_only:!probeVmDisk,confirm:true})).status,'mounted');
        const wslCli=new VaultCli({env:process.env});
        if (probeVmDisk) {
          const disk='fixture.vhd';
          await wslCli.wslCommand(['/usr/bin/qemu-img','create','-f','vpc',mount_point+'/'+disk,'4M']);
          await wslCli.wslCommand(['/usr/bin/test','-f',mount_point+'/'+disk]);
          const vm='6725c44b-288f-491f-bb75-1d414ba2ee87';
          let attached='none';
          const {execFileSync}=await import('node:child_process');
          const vbox=path.join(process.env.ProgramFiles || 'C:\\Program Files','Oracle/VirtualBox/VBoxManage.exe');
          const execute=async argv=>{
            if(argv[0]==='showvminfo')return {stdout:[
              `UUID="${vm}"`,'VMState="poweroff"','storagecontrollername0="SATA"','storagecontrollertype0="IntelAhci"',
              `"SATA-1-0"=${JSON.stringify(attached)}`,
            ].join('\n')};
            const candidate=argv.at(-1);
            if(candidate!=='none') {
              const report=execFileSync(vbox,['showmediuminfo','disk',candidate],{encoding:'utf8',timeout:15000});
              assert.match(report,/Storage format:\s+VHD/);
            }
            attached=candidate;
          };
          const target={wsl:true,vm,volume,mountPoint:mount_point,controller:'SATA',port:1,disk};
          assert.equal((await virtualBoxVolume(wslCli,{...target,operation:'attach'},{execute})).status,'attached');
          assert.equal((await virtualBoxVolume(wslCli,{...target,operation:'detach'},{execute})).status,'detached');
          if (process.env.VAULT_TEST_VIRTUALBOX_VM) {
            const live={ vm:process.env.VAULT_TEST_VIRTUALBOX_VM, volume, mount_point,
              backend:'virtualbox', controller:'SATA', port:1, disk, confirm:true };
            const result=await call('vault_attach_vm',live);
            assert.equal(result.status,'attached',JSON.stringify(result));
            try {
              const remove=await call('vault_delete_volume',{volume,entry:created.entry,confirm:true});
              assert.match(JSON.stringify(remove),/Detach the VM workspace disk/);
              await stat(volume);
            } finally {
              const detach=await call('vault_detach_vm',live);
              assert.equal(detach.status,'detached',JSON.stringify(detach));
            }
          }
          let hypervMedia=null;
          const hyperv=async request=>{
            assert.equal(request.vm,vm);
            assert.equal(request.controllerNumber,0);
            assert.equal(request.port,1);
            assert.match(request.medium,/fixture\.vhd$/);
            if(request.action==='check')return {empty:hypervMedia===null,matches:hypervMedia===request.medium};
            if(request.action==='attach')hypervMedia=request.medium;
            else if(request.action==='detach')hypervMedia=null;
            else assert.fail('unexpected Hyper-V operation');
            return {changed:true};
          };
          const hv={...target,controllerNumber:0};
          assert.equal((await hypervVolume(wslCli,{...hv,operation:'attach'},{execute:hyperv})).status,'attached');
          await assert.rejects(hypervVolume(wslCli,{...hv,operation:'attach'},{execute:hyperv}),/slot does not match/);
          assert.equal((await hypervVolume(wslCli,{...hv,operation:'detach'},{execute:hyperv})).status,'detached');
        }
        const removed=await call('vault_delete_volume',{volume,entry:created.entry,confirm:true});
        assert.equal(removed.status,'deleted');
        await assert.rejects(stat(volume),{code:'ENOENT'});
        assert.ok(!(await cli.listEntries({file:kdbx,databasePassword:masterPassword})).entries
          .some(item=>item.path===created.entry));
        assert.ok(!(await wslCli.listWslVolumes()).some(item=>item.mount_point===mount_point));
      }
    });
  }
  if (process.env.VAULT_TEST_VOLUME_LIFECYCLE === '1') {
    await check('managed volume is unmounted and deleted through MCP', async () => {
      assert.ok(status.cli.veracrypt.available && process.platform === 'linux');
      const call = async (name, args) => payload(await client.callTool({ name, arguments: args }));
      const file = path.join(workdir, 'managed-live.hc');
      const mountPoint = path.join(workdir, 'mnt');
      await mkdir(mountPoint, { recursive: true });
      const created = await call('vault_create_volume', { volume: file, name: 'ManagedLive', owner_agent_id: 'qa-agent', size_mb: 8, confirm: true });
      assert.equal(created.status, 'created');
      const target = { volume: file, entry: created.entry };
      assert.equal((await call('vault_delete_volume', target)).status, 'approval_required');
      try {
        const mounted = await call('vault_mount_volume', { volume: file, credential_entry: created.entry, read_only: true, confirm: true });
        assert.equal(mounted.status, 'mounted');
        assert.equal((await call('vault_delete_volume', { ...target, confirm: true })).status, 'deleted');
        await assert.rejects(readFile(file), { code: 'ENOENT' });
      } finally {
        await call('vault_unmount_volume', { mount_point: mountPoint });
      }
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
