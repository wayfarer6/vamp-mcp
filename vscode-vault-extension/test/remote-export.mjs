import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { RemoteVaultClient } from '../src/remote_vault_client.mjs';

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
    const result = await client.exportEncrypted({ ...options, confirmed: true, expectedDestinationPath: preview.destination_path });
    assert.equal(result.status, 'exported');
    assert.equal(result.bytes, fixture.length);
    assert.deepEqual(await readFile(result.destination_path), fixture);
    await assert.rejects(client.exportEncrypted({ ...options, confirmed: true }), /already exists/i);
    assert.equal(spawned, 1);
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
