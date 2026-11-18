// Remote vault (SSH) tests.
//
// Two things are proved here:
//   1. The command building cannot be talked into running something else, and
//      the master password never lands in an argument.
//   2. Each host ends up with its own database. A stand-in `ssh` runs the command
//      locally with a different HOME, which is exactly what SSH would do on the
//      other machine, so the real upload, setup, create, list and read paths run
//      without a network.
//
//   node build.mjs && node test/remote.mjs
//
// VAULT_TEST_KEEPASSXC points at a keepassxc-cli binary; without it the parts
// that open a database are skipped, everything else still runs.
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  normalizeRemoteVaultConfig,
  parseRemoteOutput,
  quote,
  remoteCallCommand,
  remotePathExpression,
  remoteVaultId,
  remoteVaultTarget,
  resolveRemoteVaultSettings,
  RemoteVaultClient,
  sshArgs,
} from '../src/remote_vault_client.mjs';
import { buildCredentialSections, buildStatusSections, findNode } from '../src/tree.mjs';

const here = import.meta.dirname;
const extensionDir = path.join(here, '..');
const remoteRuntime = path.join(extensionDir, 'dist/runtime/remote');
const keepassCli = process.env.VAULT_TEST_KEEPASSXC ?? null;

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

const workdir = await mkdtemp(path.join(os.tmpdir(), 'vamp-vault-remote-'));
const fakeBin = path.join(workdir, 'bin');
await mkdir(fakeBin, { recursive: true });

// Stand-in ssh: run the remote command in a shell whose HOME is the "host".
await writeFile(path.join(fakeBin, 'ssh'), [
  '#!/bin/sh',
  '# test stand-in for ssh: the last argument is the remote shell command',
  'for last do :; done',
  'exec env HOME="$FAKE_REMOTE_HOME" sh -c "$last"',
].join('\n'));
await chmod(path.join(fakeBin, 'ssh'), 0o755);
if (keepassCli) {
  await writeFile(path.join(fakeBin, 'keepassxc-cli'), `#!/bin/sh\nexec ${JSON.stringify(keepassCli)} "$@"\n`);
  await chmod(path.join(fakeBin, 'keepassxc-cli'), 0o755);
}

const makeHost = async (label) => {
  const home = await mkdtemp(path.join(workdir, `${label}-`));
  return {
    label,
    home,
    path: file => path.join(home, '.vamp/vault', file),
    spawnImpl: (command, args, options) => spawn(command, args, {
      ...options,
      env: { ...(options.env ?? process.env), PATH: `${fakeBin}:${process.env.PATH ?? ''}`, FAKE_REMOTE_HOME: home },
    }),
  };
};

console.log('VAMP Vault remote test');
console.log(`  workdir: ${workdir}`);
console.log(`  keepassxc-cli: ${keepassCli ?? 'not given (database checks skipped)'}\n`);

console.log('Command building');

await check('a host with shell metacharacters is refused', () => {
  assert.throws(() => normalizeRemoteVaultConfig({ host: 'example.com; rm -rf ~' }), /remote host/i);
  assert.throws(() => normalizeRemoteVaultConfig({ host: 'example.com && curl x' }), /remote host/i);
  assert.throws(() => normalizeRemoteVaultConfig({ host: '$(id)' }), /remote host/i);
});

await check('the username, port and approval mode are validated', () => {
  assert.throws(() => normalizeRemoteVaultConfig({ host: 'a', username: 'me;reboot' }), /username/i);
  assert.throws(() => normalizeRemoteVaultConfig({ host: 'a', port: 0 }), /port/i);
  assert.throws(() => normalizeRemoteVaultConfig({ host: 'a', port: 'nope' }), /port/i);
  assert.throws(() => normalizeRemoteVaultConfig({ host: 'a', approvalMode: 'sometimes' }), /approval mode/i);
});

await check('the remote Node.js path rejects anything but a path', () => {
  assert.throws(() => normalizeRemoteVaultConfig({ host: 'a', remoteNodePath: 'node --eval x' }), /Node\.js path/i);
  assert.equal(normalizeRemoteVaultConfig({ host: 'a' }).remoteNodePath, 'node');
});

await check('the Node.js probe distinguishes SSH failure from a remote command failure', async () => {
  const client = new RemoteVaultClient({ host: 'host1' });
  client.exec = async () => ({ code: 255, stdout: '', stderr: 'ssh: Could not resolve hostname host1' });
  await assert.rejects(client.probe(), { message: 'The host name host1 could not be resolved.' });
  client.exec = async () => ({ code: 1, stdout: '', stderr: '' });
  await assert.rejects(client.probe(), /Node\.js probe failed on host1/);
});

await check('quote survives a single quote in a value', () => {
  assert.equal(quote("it's"), `'it'"'"'s'`);
});

await check('a ~ path is expanded by the remote shell, not by us', () => {
  assert.equal(remotePathExpression('~/.vamp/vault/vault.kdbx'), `"$HOME"/'.vamp/vault/vault.kdbx'`);
  assert.equal(remotePathExpression('/srv/vault.kdbx'), `'/srv/vault.kdbx'`);
  assert.throws(() => remotePathExpression('a\nb'), /line break/);
});

await check('ssh arguments keep the command last and pass no secret', () => {
  const config = normalizeRemoteVaultConfig({ host: 'depot.example.com', username: 'me', port: 2222, privateKeyPath: '/home/me/.ssh/id_ed25519' });
  const args = sshArgs(config, 'exec node --version');
  assert.equal(args.at(-1), 'exec node --version');
  assert.equal(args.at(-2), 'me@depot.example.com');
  assert.ok(args.includes('-p') && args.includes('2222'));
  assert.ok(args.includes('-i') && args.includes('/home/me/.ssh/id_ed25519'));
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('StrictHostKeyChecking=accept-new'));
  assert.ok(sshArgs(config, 'exec node --version', {requireKnownHost:true}).includes('StrictHostKeyChecking=yes'));
  assert.ok(!args.join(' ').includes('password'));
});

await check('a tool call carries the tool and its arguments, quoted once each', () => {
  const config = normalizeRemoteVaultConfig({ host: 'h' });
  const command = remoteCallCommand(config, { tool: 'vault_get_credential', args: { entry: "Bank'; rm -rf ~; echo '", fields: ['password'] }, stdinPassword: true });
  assert.ok(command.includes(`--call 'vault_get_credential'`));
  assert.ok(command.includes('--stdin-password'));
  assert.ok(command.includes(`'"'"'`), 'the entry must be quoted, not run');
  assert.ok(command.includes(`"$HOME"`), 'the default vault path stays inside the remote home');
  assert.ok(!command.includes('rm -rf ~; echo') || command.includes(`'`), 'the metacharacters stay inside quotes');
});

await check('an unknown tool name is refused before anything runs', () => {
  const config = normalizeRemoteVaultConfig({ host: 'h' });
  assert.throws(() => remoteCallCommand(config, { tool: 'vault; id' }), /tool name/i);
});

await check('connection details may be reused, vault paths never are', () => {
  const vaultValues = { 'remote.enabled': true, 'remote.host': '', 'remote.useVampRemoteSettings': true, 'remote.kdbxPath': '' };
  const vampValues = { 'remote.host': 'shared.example.com', 'remote.port': 2200, 'remote.username': 'shared', 'remote.kdbxPath': '/somewhere/else.kdbx' };
  const getVault = (key, fallback) => (key in vaultValues ? vaultValues[key] : fallback);
  const getVamp = (key, fallback) => (key in vampValues ? vampValues[key] : fallback);
  const settings = resolveRemoteVaultSettings({ getVault, getVamp });
  assert.equal(settings.host, 'shared.example.com');
  assert.equal(settings.port, 2200);
  assert.equal(settings.username, 'shared');
  assert.equal(settings.kdbxPath, '~/.vamp/vault/vault.kdbx', 'the vault path must not come from the other extension');
  const isolated = resolveRemoteVaultSettings({ getVault: (key, fallback) => (key === 'remote.useVampRemoteSettings' ? false : getVault(key, fallback)), getVamp });
  assert.equal(isolated.host, '');
});

await check('the secret of one host is a different key from another host', () => {
  const a = normalizeRemoteVaultConfig({ host: 'a.example.com', username: 'me' });
  const b = normalizeRemoteVaultConfig({ host: 'b.example.com', username: 'me' });
  const local = '/home/me/.config/vault/vault.kdbx';
  assert.notEqual(remoteVaultId(a), remoteVaultId(b));
  assert.notEqual(remoteVaultId(a), local);
  assert.match(remoteVaultId(a), /^remote-ssh:\/\//);
  assert.equal(remoteVaultTarget(a), 'me@a.example.com');
});

await check('only the last JSON line of remote output is read', () => {
  const data = parseRemoteOutput('vamp: working\n{"status":"ok","n":1}\n{"status":"done"}\n');
  assert.deepEqual(data, { status: 'done' });
  assert.equal(parseRemoteOutput('nothing here'), null);
});

console.log('\nSidebar sections');

await check('remote off keeps one flat list', () => {
  const nodes = buildCredentialSections({ local: { cliAvailable: true, databaseExists: false, kdbxPath: '/x/vault.kdbx' }, remote: { enabled: false } });
  assert.ok(!nodes.some(node => node.type === 'section'));
  assert.ok(nodes.some(node => node.id === 'remoteOff'));
});

await check('two vaults become two separate sections', () => {
  const nodes = buildStatusSections({
    local: { databaseExists: true, kdbxPath: '/x/vault.kdbx', keepassxcAvailable: true },
    remote: { enabled: true, configured: true, host: 'srv1', target: 'me@srv1', kdbxPath: '~/.vamp/vault/vault.kdbx', checked: true, reachable: true, databaseExists: true, unlocked: true, keepassxcAvailable: true },
  });
  const labels = nodes.map(node => node.label);
  assert.deepEqual(labels, ['📦 Local Vault', '🌐 Remote Vault · me@srv1']);
  assert.match(nodes[1].description, /\[Remote: me@srv1\]/);
});

await check('the same path in both vaults stays two different rows', () => {
  const listing = { entries: [{ path: 'Mail/Example', title: 'Example', group: 'Mail' }], groups: ['Mail'] };
  const nodes = buildCredentialSections({
    local: { cliAvailable: true, databaseExists: true, locked: false, kdbxPath: '/x/vault.kdbx', listing, meta: {} },
    remote: { enabled: true, configured: true, host: 'srv1', target: 'me@srv1', kdbxPath: '~/.vamp/vault/vault.kdbx', reachable: true, keepassxcAvailable: true, databaseExists: true, locked: false, listing, meta: {} },
  });
  const entry = findNode([nodes[1]], 'Mail/Example');
  assert.equal(entry.scope, 'remote');
  const group = findNode([nodes[1]], node => node.type === 'group' && node.path === 'Mail');
  assert.equal(group.scope, 'remote');
  const localEntry = findNode([nodes[0]], 'Mail/Example');
  assert.equal(localEntry.scope, undefined, 'the local entry must not be marked remote');
});

console.log('\nSetup script');

await check('the setup script is valid shell and reports JSON in a dry run', async () => {
  const script = path.join(extensionDir, 'dist/runtime/remote/remote_vault_setup.sh');
  const run = await new Promise((resolve, reject) => {
    const child = spawn('sh', ['-n', script]);
    child.on('error', reject);
    child.on('close', code => resolve(code));
  });
  assert.equal(run, 0);
  const dryHome = await mkdtemp(path.join(workdir, 'dry-'));
  const output = await new Promise((resolve, reject) => {
    const child = spawn('sh', [script, '--dry-run'], { env: { ...process.env, HOME: dryHome } });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', () => resolve(stdout));
  });
  const report = parseRemoteOutput(output);
  assert.equal(report.dry_run, true);
  assert.ok(report.steps.some(step => step.id === 'vaultdir' && step.status === 'planned'));
  assert.ok(report.steps.some(step => step.id === 'server'));
  await assert.rejects(stat(path.join(dryHome, '.vamp/vault')));
  await rm(dryHome, { recursive: true, force: true });
});

console.log('\nRemote host, over a stand-in ssh');

const hostOne = await makeHost('host1');
const hostTwo = await makeHost('host2');
const passwordOne = 'remote-host-one-master-1234';
const passwordTwo = 'remote-host-two-master-5678';
const entryPassword = 'remote-entry-secret-42';

await check('the server and the setup script upload into the host home', async () => {
  const client = new RemoteVaultClient(normalizeRemoteVaultConfig({ host: 'host1' }), { spawnImpl: hostOne.spawnImpl });
  const report = await client.upload({
    serverFile: path.join(remoteRuntime, 'server.mjs'),
    setupScript: path.join(remoteRuntime, 'remote_vault_setup.sh'),
  });
  assert.match(report.server_version, /^\d+\.\d+\.\d+$/);
  assert.ok(report.setup_script);
  const server = await stat(hostOne.path('server.mjs'));
  const script = await stat(hostOne.path('remote_vault_setup.sh'));
  assert.equal(server.mode & 0o777, 0o600, 'the uploaded server is private');
  assert.equal(script.mode & 0o777, 0o700, 'the uploaded setup script is private');
});

await check('setup makes the host vault directory private and reports each step', async () => {
  const client = new RemoteVaultClient(normalizeRemoteVaultConfig({ host: 'host1' }), { spawnImpl: hostOne.spawnImpl });
  const report = await client.runSetup();
  assert.ok(['ok', 'needs_attention'].includes(report.status), `unexpected status ${report.status}`);
  const dir = await stat(path.join(hostOne.home, '.vamp/vault'));
  assert.equal(dir.mode & 0o777, 0o700);
  assert.ok(report.steps.some(step => step.id === 'node'));
  if (keepassCli) assert.ok(report.steps.some(step => step.id === 'keepassxc' && ['ok', 'needs_manual'].includes(step.status)));
});

await check('the environment check finds the new host before it has a vault', async () => {
  const client = new RemoteVaultClient(normalizeRemoteVaultConfig({ host: 'host1' }), { spawnImpl: hostOne.spawnImpl });
  const report = await client.envCheck();
  assert.equal(report.ready, false, 'no database yet, so not ready');
  assert.equal(report.databaseExists, false);
  if (keepassCli) assert.equal(report.keepassxc.available, true);
  assert.ok(report.node);
});

if (!keepassCli) {
  console.log('\n  keepassxc-cli not given; the database checks are skipped.');
} else {
  await check('each host gets its own database, with its own master password', async () => {
    const client = new RemoteVaultClient(normalizeRemoteVaultConfig({ host: 'host1' }), { spawnImpl: hostOne.spawnImpl });
    const created = await client.call('vault_create', {}, { password: passwordOne });
    assert.equal(created.status, 'created');
    assert.equal(created.file, hostOne.path('vault.kdbx').replace(hostOne.home, hostOne.home));

    const second = new RemoteVaultClient(normalizeRemoteVaultConfig({ host: 'host2' }), { spawnImpl: hostTwo.spawnImpl });
    await second.upload({
      serverFile: path.join(remoteRuntime, 'server.mjs'),
      setupScript: path.join(remoteRuntime, 'remote_vault_setup.sh'),
    });
    await second.runSetup();
    const createdTwo = await second.call('vault_create', {}, { password: passwordTwo });
    assert.equal(createdTwo.status, 'created');

    const one = await readFile(hostOne.path('vault.kdbx'));
    const two = await readFile(hostTwo.path('vault.kdbx'));
    assert.notEqual(createHash('sha256').update(one).digest('hex'), createHash('sha256').update(two).digest('hex'));
  });

  await check('the master password of one host does not open another host', async () => {
    const client = new RemoteVaultClient(normalizeRemoteVaultConfig({ host: 'host2' }), { spawnImpl: hostTwo.spawnImpl });
    await assert.rejects(client.listEntries({ password: passwordOne }), /./);
    const ok = await client.listEntries({ password: passwordTwo });
    assert.equal(ok.status, 'ok');
  });

  await check('the password travels on stdin, never in an argument', async () => {
    const seen = [];
    const recording = (command, args, options) => {
      seen.push(args.join(' '));
      return hostOne.spawnImpl(command, args, options);
    };
    const client = new RemoteVaultClient(normalizeRemoteVaultConfig({ host: 'host1' }), { spawnImpl: recording });
    const listing = await client.listEntries({ password: passwordOne });
    assert.equal(listing.status, 'ok');
    assert.ok(seen.length, 'no command was run');
    for (const line of seen) assert.ok(!line.includes(passwordOne), 'the password appeared in an argument');
    assert.ok(seen.some(line => line.includes('--stdin-password')));
  });

  await check('entries written on one host are invisible on the other', async () => {
    const one = new RemoteVaultClient(normalizeRemoteVaultConfig({ host: 'host1' }), { spawnImpl: hostOne.spawnImpl });
    const two = new RemoteVaultClient(normalizeRemoteVaultConfig({ host: 'host2' }), { spawnImpl: hostTwo.spawnImpl });
    await one.call('vault_set_credential', { entry: 'Example', group: 'Mail', username: 'alice', password: entryPassword }, { password: passwordOne });
    await two.call('vault_set_credential', { entry: 'Card', group: 'Bank', username: 'bob', password: 'other-secret' }, { password: passwordTwo });
    await one.call('vault_set_credential', { entry: 'Other', group: 'Mail', username: 'carol', password: 'second-secret' }, { password: passwordOne });
    const first = await one.listEntries({ password: passwordOne });
    const second = await two.listEntries({ password: passwordTwo });
    assert.deepEqual(first.entries.map(item => item.path), ['Mail/Example', 'Mail/Other']);
    assert.deepEqual(second.entries.map(item => item.path), ['Bank/Card']);
  });

  await check('a read returns the approved field from that host', async () => {
    const client = new RemoteVaultClient(normalizeRemoteVaultConfig({ host: 'host1' }), { spawnImpl: hostOne.spawnImpl });
    const record = await client.call('vault_get_credential', { entry: 'Mail/Example', fields: ['username', 'password'], confirm: true }, { password: passwordOne });
    assert.equal(record.status, 'ok');
    assert.equal(record.username, 'alice');
    assert.equal(record.password, entryPassword);
  });

  await check('nothing was written into this computer\'s vault', async () => {
    const localDefault = path.join(os.homedir(), '.vamp/vault/vault.kdbx');
    const exists = await stat(localDefault).then(() => true).catch(() => false);
    assert.equal(exists, false, 'the remote flow created a local vault');
  });

  console.log('\nMCP proxy (what the agent sees)');

  // Stand-in extension host: secret storage + approval dialogs.
  const socketPath = path.join(workdir, 'bridge.sock');
  const token = 'remote-test-token';
  const bridgeCalls = [];
  let approveNext = true;
  const bridgeServer = net.createServer(socket => {
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
        bridgeCalls.push(request);
        let result;
        if (request.op === 'state') result = { unlocked: true, approval_mode: 'per-session', revision: 1 };
        else if (request.op === 'unlock') result = { password: passwordOne };
        else if (request.op === 'approve') result = { approved: approveNext, remember: false };
        else if (request.op === 'new-password') result = { password: passwordOne };
        else if (request.op === 'notify') result = { shown: true };
        socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => { bridgeServer.once('error', reject); bridgeServer.listen(socketPath, resolve); });

  const startProxy = async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        path.join(remoteRuntime, 'vault_proxy.mjs'),
        '--host', 'host1',
        '--username', 'me',
        '--kdbx', '~/.vamp/vault/vault.kdbx',
        '--volume', '~/.vamp/vault/vault.hc',
        '--mount', '~/.vamp/vault/mnt',
        '--approval-mode', 'per-session',
      ],
      env: {
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        HOME: workdir,
        FAKE_REMOTE_HOME: hostOne.home,
        VAULT_BRIDGE_SOCKET: socketPath,
        VAULT_BRIDGE_TOKEN: token,
        VAULT_REMOTE_MANIFEST: path.join(remoteRuntime, 'vault_tools.json'),
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'vamp-vault-remote-test', version: '0.0.0' });
    await client.connect(transport);
    return client;
  };

  const payload = result => JSON.parse(result.content[0].text);
  const proxy = await startProxy();

  await check('the proxy advertises the host vault tools under its own name', async () => {
    const list = await proxy.listTools();
    const names = list.tools.map(tool => tool.name).sort();
    const manifest=JSON.parse(await readFile(path.join(remoteRuntime,'vault_tools.json'),'utf8'));
    assert.deepEqual(names,manifest.tools.map(tool=>tool.name).filter(name=>name!=='vault_attach_container').sort());
    assert.ok(names.includes('vault_deliver_credential'));
    assert.ok(list.tools.every(tool => tool.inputSchema?.type === 'object'));
  });

  await check('a listing through the proxy only shows this host\'s entries', async () => {
    const result = payload(await proxy.callTool({ name: 'vault_list_credentials', arguments: {} }));
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.entries.map(item => item.path), ['Mail/Example', 'Mail/Other']);
  });

  await check('the proxy asks this computer for the remote vault password', async () => {
    const unlock = bridgeCalls.find(call => call.op === 'unlock');
    assert.ok(unlock, 'the extension was never asked for a password');
    assert.match(unlock.params.kdbx, /^remote-ssh:\/\/me@host1:22\//);
  });

  await check('a read is approved here before it reaches the host', async () => {
    const before = bridgeCalls.filter(call => call.op === 'approve').length;
    const result = payload(await proxy.callTool({ name: 'vault_get_credential', arguments: { entry: 'Mail/Example', fields: ['password'] } }));
    assert.equal(result.status, 'ok');
    assert.equal(bridgeCalls.filter(call => call.op === 'approve').length, before + 1);
  });

  await check('a read approved once is not asked again in the same session', async () => {
    const before = bridgeCalls.filter(call => call.op === 'approve').length;
    const result = payload(await proxy.callTool({ name: 'vault_get_credential', arguments: { entry: 'Mail/Example', fields: ['password'] } }));
    assert.equal(result.status, 'ok');
    assert.equal(bridgeCalls.filter(call => call.op === 'approve').length, before, 'per-session approval should not prompt twice');
  });

  await check('a declined read sends nothing to the host', async () => {
    approveNext = false;
    const result = payload(await proxy.callTool({ name: 'vault_get_credential', arguments: { entry: 'Mail/Other', fields: ['password'] } }));
    assert.equal(result.status, 'denied');
    assert.ok(!('password' in result), 'a declined read returned a secret');
    approveNext = true;
  });

  await check('remote placeholders use approved process stdin and return a receipt only', async () => {
    const program=hostOne.path('stdin-test.mjs');
    const marker=hostOne.path('stdin-test.ok');
    const digest=createHash('sha256').update(entryPassword+'\n').digest('hex');
    await writeFile(program, `import {createHash} from 'node:crypto';
      import {writeFileSync} from 'node:fs';
      const hash=createHash('sha256');
      for await(const chunk of process.stdin) { hash.update(chunk); process.stdout.write(chunk); }
      if(hash.digest('hex')!==${JSON.stringify(digest)} || process.argv.length!==2 || Object.keys(process.env).length) process.exit(2);
      writeFileSync(${JSON.stringify(marker)},'ok');`);
    await writeFile(hostOne.path('credential-delivery.json'), JSON.stringify({probe:{
      executable:process.execPath,args:[program],entry:'Mail/Example',field:'password',
    }}), {mode:0o600});
    const input={name:'vault_deliver_credential',arguments:{destination:'probe',reference:'${vault:Mail/Example#password}'}};
    const count=()=>bridgeCalls.filter(call=>call.op==='approve').length;
    const before=count();
    approveNext=false;
    assert.deepEqual(payload(await proxy.callTool(input)),{status:'denied'});
    await assert.rejects(stat(marker),{code:'ENOENT'});
    approveNext=true;
    assert.deepEqual(payload(await proxy.callTool(input)),{status:'delivered',destination:'probe'});
    assert.equal(count(),before+2);
    assert.equal(await readFile(marker,'utf8'),'ok');
    const audit=await readFile(hostOne.path('credential-delivery.jsonl'),'utf8');
    assert.ok(!audit.includes(entryPassword) && !audit.includes(passwordOne));
    assert.equal(JSON.parse(audit).entry,'Mail/Example');
  });

  await proxy.close();
  await new Promise(resolve => bridgeServer.close(resolve));
}

await rm(workdir, { recursive: true, force: true });
console.log(`\n${passed}/${results.length} checks passed`);
if (results.some(item => item.status === 'fail')) process.exitCode = 1;
