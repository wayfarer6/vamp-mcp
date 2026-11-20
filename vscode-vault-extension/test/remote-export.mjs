import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { RemoteVaultClient } from '../src/remote_vault_client.mjs';
import { exportFromRemoteVault } from '../src/encrypted_export.mjs';

test('remote encrypted export previews locally and streams exact bytes through trusted SSH', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'vault-ssh-export-'));
  const fixture = Buffer.from([0, 127, 138, 254, 255, 0, 1, 2, 3]);
  let spawned = 0;
  const client = new RemoteVaultClient({ host: 'vm.test', username: 'vault', port: 2222,
    privateKeyPath: 'test-key', volumePath: "~/Vault's archive/backup.hc" }, {
    spawnImpl(program, args, options) {
      spawned++;
      assert.equal(program, 'ssh');
      assert.ok(args.includes('StrictHostKeyChecking=yes'));
      assert.ok(args.includes('2222'));
      assert.ok(args.includes('test-key'));
      assert.equal(args.at(-2), 'vault@vm.test');
      assert.ok(args.at(-1).endsWith(`"$HOME"/'Vault'"'"'s archive/backup.hc'`));
      assert.equal(options.stdio[0], 'ignore');
      for (const key of ['VAULT_BRIDGE_SOCKET', 'VAULT_BRIDGE_TOKEN', 'VAULT_MASTER_PASSWORD']) {
        assert.equal(Object.hasOwn(options.env, key), false);
      }
      const ssh = new EventEmitter();
      ssh.stdout = new PassThrough();
      ssh.stderr = new PassThrough();
      ssh.kill = () => {};
      setImmediate(() => {
        ssh.stdout.write('VAMP-');
        ssh.stdout.write(`ENC-1 ${fixture.length}\n`);
        ssh.stdout.end(fixture);
        ssh.emit('close', 0);
      });
      return ssh;
    },
  });
  try {
    const options = { kind: 'volume', destinationFolder: folder };
    const preview = await client.exportEncrypted(options);
    assert.equal(preview.status, 'approval_required');
    await assert.rejects(client.exportEncrypted({ ...options, confirmed: true,
      expectedDestinationPath: path.join(folder, 'another.hc') }), /changed/i);
    assert.equal(spawned, 0);
    const tool = { name: 'vault_export_encrypted', inputSchema: {
      properties: { kind: {}, destination_folder: {}, confirm: {} },
    } };
    const args = { kind: 'volume', destination_folder: folder };
    let approved = false;
    let approvals = 0;
    const approve = async request => {
      approvals++;
      assert.equal(request.entry, preview.destination_path);
      assert.equal(request.always, true);
      assert.match(request.detail, /vault@vm\.test/);
      return { approved };
    };
    const route = (overrides, signal) => exportFromRemoteVault({
      client, approve, tool, args: { ...args, ...overrides }, signal, target: 'vault@vm.test',
    });
    assert.equal((await route({})).status, 'approval_required');
    assert.equal(approvals, 0);
    assert.equal((await route({ confirm: true })).status, 'denied');
    assert.equal(spawned, 0);
    await assert.rejects(route({ source_path: '/unexpected' }), /configured|encrypted file/);
    approved = true;
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(route({ confirm: true }, abort.signal), { name: 'AbortError' });
    assert.equal(spawned, 0);
    const result = await route({ confirm: true });
    assert.equal(result.status, 'exported');
    assert.equal(result.bytes, fixture.length);
    assert.deepEqual(await readFile(result.destination_path), fixture);
    await assert.rejects(client.exportEncrypted({ ...options, confirmed: true }), /already exists/i);
    assert.equal(spawned, 1);
    assert.equal(approvals, 2);
    assert.deepEqual(await readdir(folder), ['backup.hc']);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('partial binary transfer is discarded when trusted SSH exits unsuccessfully', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'vault-ssh-export-'));
  const client = new RemoteVaultClient({ host: 'vm.test' }, {
    spawnImpl() {
      const ssh = new EventEmitter();
      ssh.stdout = new PassThrough();
      ssh.stderr = new PassThrough();
      ssh.kill = () => {};
      setImmediate(() => {
        ssh.stdout.end(Buffer.concat([Buffer.from('VAMP-ENC-1 4\n'), Buffer.from([0, 1, 2, 3])]));
        ssh.stderr.end('transfer interrupted');
        ssh.emit('close', 1);
      });
      return ssh;
    },
  });
  try {
    await assert.rejects(client.exportEncrypted({ kind: 'volume', destinationFolder: folder, confirmed: true }), /transfer interrupted/);
    assert.deepEqual(await readdir(folder), []);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('SSH stdout outside the encrypted file framing is rejected', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'vault-ssh-export-'));
  try {
    for (const bytes of ['Welcome!\nVAMP-ENC-1 4\nfile', 'VAMP-ENC-1 4\nextra data', 'VAMP-ENC-1 5\nfile']) {
      const client = new RemoteVaultClient({ host: 'vm.test' }, {
        spawnImpl() {
          const ssh = new EventEmitter();
          ssh.stdout = new PassThrough();
          ssh.stderr = new PassThrough();
          ssh.kill = () => {};
          setImmediate(() => {
            ssh.stdout.end(bytes);
            ssh.emit('close', 0);
          });
          return ssh;
        },
      });
      await assert.rejects(client.exportEncrypted({ kind: 'volume', destinationFolder: folder, confirmed: true }), /transfer/i);
      assert.deepEqual(await readdir(folder), []);
    }
  } finally { await rm(folder, { recursive: true, force: true }); }
});
