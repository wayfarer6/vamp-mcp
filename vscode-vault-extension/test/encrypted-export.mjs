import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { exportEncryptedFile, exportMountedFile } from '../src/encrypted_export.mjs';

const database = Buffer.concat([Buffer.from('03d9a29a67fb4bb5', 'hex'), Buffer.from('test ciphertext')]);

test('mounted-file export binds approval to the source and rejects traversal and remounts', async t => {
  const { sourcePath: volumePath, destinationFolder } = await fixture(t);
  const root = path.join(path.dirname(volumePath), 'mount');
  const source = path.join(root, '문서.txt');
  await mkdir(root);
  await writeFile(source, 'synthetic export');
  let device = 'fixture-device';
  let probesBeforeRemount = Infinity;
  const cli = { listVolumes: async () => {
    if (--probesBeforeRemount === 0) device = 'different-device';
    return { mounted: [{ volume: volumePath, mount_point: root, device }] };
  } };
  const options = { cli, volumePath, destinationFolder, relativePath: path.basename(source) };
  await assert.rejects(exportMountedFile({ ...options, relativePath: '../outside.txt' }), /relative to the root/);
  const preview = await exportMountedFile(options);
  assert.equal(preview.status, 'approval_required');
  assert.equal(preview.encrypted, false);
  assert.deepEqual(await readdir(destinationFolder), []);
  const confirm = expectedPreview => exportMountedFile({ ...options, confirmed: true, expectedPreview });
  device = 'different-device';
  await assert.rejects(confirm(preview), /changed after confirmation/);
  device = 'fixture-device';
  await writeFile(source, 'replacement content');
  await assert.rejects(confirm(preview), /changed after confirmation/);
  const reviewed = await exportMountedFile(options);
  probesBeforeRemount = 3;
  await assert.rejects(confirm(reviewed), /changed during export/);
  assert.deepEqual(await readdir(destinationFolder), []);
  device = 'fixture-device';
  const result = await confirm(reviewed);
  assert.equal(result.status, 'exported');
  assert.equal(result.sha256, createHash('sha256').update('replacement content').digest('hex'));
  assert.equal(await readFile(result.destination_path, 'utf8'), 'replacement content');
  await assert.rejects(confirm(reviewed), /already exists/);
});

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vamp-vault-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'Example Vault.kdbx');
  const destinationFolder = path.join(directory, 'export here');
  await writeFile(sourcePath, database);
  await mkdir(destinationFolder);
  return { kind: 'kdbx', sourcePath, destinationFolder };
}

test('preview and export exact encrypted bytes without overwriting', async t => {
  const options = await fixture(t);
  const preview = await exportEncryptedFile(options);
  assert.equal(preview.status, 'approval_required');
  assert.deepEqual(await readdir(options.destinationFolder), []);
  const result = await exportEncryptedFile({ ...options, confirmed: true });
  assert.equal(result.status, 'exported');
  assert.equal(result.destination_path, preview.destination_path);
  assert.equal(result.bytes, database.length);
  assert.equal(result.sha256, createHash('sha256').update(database).digest('hex'));
  assert.deepEqual(await readFile(result.destination_path), database);
  if (process.platform !== 'win32') assert.equal((await stat(result.destination_path)).mode & 0o077, 0);
  await assert.rejects(() => exportEncryptedFile({ ...options, confirmed: true }), /already exists/);
  await assert.rejects(() => exportEncryptedFile({ ...options, destinationFolder: path.dirname(options.sourcePath), confirmed: true }), /already exists/);
  assert.deepEqual(await readFile(options.sourcePath), database);
});

test('reject plaintext and invalid paths without publishing a partial copy', async t => {
  const options = await fixture(t);
  await writeFile(options.sourcePath, 'plaintext that is not an encrypted database');
  await assert.rejects(() => exportEncryptedFile({ ...options, confirmed: true }), /KDBX header/);
  assert.deepEqual(await readdir(options.destinationFolder), []);
  await assert.rejects(() => exportEncryptedFile({ ...options, destinationFolder: 'relative' }), /absolute local destination/);
  await assert.rejects(() => exportEncryptedFile({ ...options, expectedDestinationPath: 'different', confirmed: true }), /changed after confirmation/);
});

test('remote preview opens no transport and successful export preserves irregular chunk boundaries', async t => {
  const { destinationFolder } = await fixture(t);
  let opened = 0;
  const options = { kind: 'kdbx', sourcePath: '~/.vamp/vault/Remote Vault.kdbx', destinationFolder, openSource() {
    opened += 1;
    return { stream: Readable.from([database.subarray(0, 3), database.subarray(3, 7), database.subarray(7)]), completion: Promise.resolve() };
  } };
  await exportEncryptedFile(options);
  assert.equal(opened, 0);
  const result = await exportEncryptedFile({ ...options, confirmed: true });
  assert.equal(opened, 1);
  assert.equal(path.basename(result.destination_path), 'Remote Vault.kdbx');
  assert.deepEqual(await readFile(result.destination_path), database);
});

test('remote failures and cancellation remove staging files', async t => {
  const { destinationFolder } = await fixture(t);
  let aborted = 0;
  const options = { kind: 'volume', sourcePath: '/srv/vault/personal.hc', destinationFolder, confirmed: true };
  await assert.rejects(() => exportEncryptedFile({ ...options, openSource() {
    return { stream: Readable.from([database]), completion: Promise.reject(new Error('connection lost')), abort() { aborted += 1; } };
  } }), /connection lost/);
  const controller = new AbortController();
  await assert.rejects(() => exportEncryptedFile({ ...options, signal: controller.signal, openSource() {
    const stream = new Readable({ read() { controller.abort(); } });
    return { stream, abort() { aborted += 1; } };
  } }), /abort/i);
  assert.equal(aborted, 2);
  assert.deepEqual(await readdir(destinationFolder), []);
});

test('local Vault MCP tool requires confirmation even when credential approval is off', async t => {
  const { sourcePath, destinationFolder } = await fixture(t);
  const server = fileURLToPath(new URL('../backends/vault/server.mjs', import.meta.url));
  async function call(confirm) {
    const { stdout } = await promisify(execFile)(process.execPath, [server, '--call', 'vault_export_encrypted', '--args',
      JSON.stringify({ kind: 'kdbx', destination_folder: destinationFolder, confirm })], {
      env: { ...process.env, VAULT_KDBX: sourcePath, VAULT_APPROVAL_MODE: 'off', VAULT_MASTER_PASSWORD: '', VAULT_BRIDGE_SOCKET: '' },
    });
    return JSON.parse(stdout);
  }
  assert.equal((await call(false)).status, 'approval_required');
  assert.deepEqual(await readdir(destinationFolder), []);
  const result = await call(true);
  assert.equal(result.status, 'exported');
  assert.deepEqual(await readFile(result.destination_path), database);
});
