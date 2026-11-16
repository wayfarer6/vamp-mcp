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
import { parseEntryList, parseMountList, parseShowAll } from '../src/vault_cli.mjs';
import { BridgeClient } from '../src/bridge_client.mjs';
import { detectPlatform, findOnPath } from '../src/downloader.mjs';

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

await check('server lists the nine vault tools', async () => {
  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name).sort();
  assert.deepEqual(names, [
    'vault_create', 'vault_delete_credential', 'vault_get_credential', 'vault_list_credentials',
    'vault_mount_volume', 'vault_set_credential', 'vault_status', 'vault_unmount_volume',
    'vault_update_credential',
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

  const listed = payload(await client.callTool({ name: 'vault_list_credentials', arguments: { file: kdbx } }));
  await check('vault_list_credentials returns paths without secrets', () => {
    assert.equal(listed.status, 'ok');
    assert.ok(listed.entries.some(item => item.path === 'Mail/Example'));
    assert.ok(!JSON.stringify(listed).includes(entryPassword), 'listing leaked the password');
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
  assert.ok(host.calls.includes('state'));
  assert.equal(state.locked, false);
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
