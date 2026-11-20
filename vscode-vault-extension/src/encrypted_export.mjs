import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { copyFile, link, lstat, mkdtemp, open, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const KDBX_MAGIC = Buffer.from('03d9a29a67fb4bb5', 'hex');
const UNSUPPORTED_LINK = new Set(['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EPERM']);

export async function exportFromRemoteVault({ client, approve, tool, args, signal, target }) {
  const { kind, destination_folder: destinationFolder, confirm = false } = args;
  if (Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties, key)) ||
      !['kdbx', 'volume'].includes(kind) || typeof destinationFolder !== 'string' ||
      destinationFolder.length === 0 || destinationFolder.length > 4096 || typeof confirm !== 'boolean') {
    throw new Error('Choose an encrypted file and an existing absolute local destination folder.');
  }
  signal?.throwIfAborted();
  const selection = { kind, destinationFolder, signal };
  const preview = await client.exportEncrypted(selection);
  if (!confirm) return preview;
  const detail = `Copy ${target}:${preview.source_path} to ${preview.destination_path}.`;
  const approval = await approve({ tool: tool.name, entry: preview.destination_path, detail, always: true });
  if (approval.unreachable) throw new Error('Open the remote Vault in VS Code to approve this export.');
  if (!approval.approved) return { status: 'denied' };
  signal?.throwIfAborted();
  return client.exportEncrypted({ ...selection, confirmed: true, expectedDestinationPath: preview.destination_path });
}

function validPath(value) {
  return typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}

function assertRegularFile(info) {
  if (!info.isFile()) throw new Error('The encrypted export source must be a regular file.');
}

function matchingFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function assertAbsent(file) {
  try { await lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('A file already exists at the export destination. Choose another folder.');
}

async function openLocal(source, expected) {
  const before = await lstat(source, { bigint: true });
  assertRegularFile(before);
  if (expected && !matchingFile(expected, before)) throw new Error('The export source changed before it could be read.');
  const file = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await file.stat({ bigint: true });
    assertRegularFile(opened);
    if (!matchingFile(before, opened)) throw new Error('The export source changed before it could be read.');
    const stream = file.createReadStream();
    return {
      stream,
      abort: () => stream.destroy(),
      async verify() {
        const after = await lstat(source, { bigint: true });
        if (!matchingFile(before, after)) throw new Error('The export source changed during the copy. Try again once writing has stopped.');
      },
    };
  } catch (error) {
    await file.close();
    throw error;
  }
}

function measureCopy(kind) {
  const hash = createHash('sha256');
  const header = Buffer.alloc(KDBX_MAGIC.length);
  let bytes = 0;
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      if (kind === 'kdbx' && bytes < header.length) {
        chunk.copy(header, bytes, 0, Math.min(chunk.length, header.length - bytes));
        if (bytes + chunk.length >= header.length && !header.equals(KDBX_MAGIC)) {
          callback(new Error('The export source does not have a KeePass KDBX header.'));
          return;
        }
      }
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      if (kind !== 'mounted-file' && (bytes === 0 || (kind === 'kdbx' && bytes < header.length))) {
        callback(new Error('The encrypted export source is empty or incomplete.'));
        return;
      }
      callback();
    },
  });
  return { stream, result: () => ({ bytes, sha256: hash.digest('hex') }) };
}

/** Export the configured encrypted file. A remote reader must reject completion on any transfer error. */
export async function exportEncryptedFile(options) {
  if (!['kdbx', 'volume'].includes(options.kind)) throw new Error('Choose the KeePass database or VeraCrypt volume.');
  return copyVaultFile(options);
}

async function copyVaultFile({ kind, sourcePath, destinationFolder, expectedDestinationPath, confirmed = false, openSource, verifySource, signal }) {
  signal?.throwIfAborted();
  if (!validPath(sourcePath) || (!openSource && !path.isAbsolute(sourcePath))) throw new Error('Configure the encrypted source file first.');
  if (!validPath(destinationFolder) || !path.isAbsolute(destinationFolder)) throw new Error('Choose an existing absolute local destination folder.');
  const folder = await realpath(destinationFolder);
  const folderInfo = await lstat(folder, { bigint: true });
  if (!folderInfo.isDirectory()) throw new Error('The local export destination must be a folder.');
  const name = (openSource && kind !== 'mounted-file' ? path.posix : path).basename(sourcePath);
  if (!name || /[. ]$|[<>:"/\\|?*]|^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) {
    throw new Error('The configured encrypted file name cannot be used at the export destination.');
  }
  const destinationPath = path.join(folder, name);
  if (expectedDestinationPath && destinationPath !== expectedDestinationPath) throw new Error('The export destination changed after confirmation.');
  await assertAbsent(destinationPath);
  if (!openSource) assertRegularFile(await lstat(sourcePath));
  const summary = { kind, source_path: sourcePath, destination_path: destinationPath };
  if (!confirmed) return { status: 'approval_required', ...summary };

  const staging = await mkdtemp(path.join(folder, '.vamp-export-'));
  const copy = path.join(staging, 'copy');
  let source;
  let transfer;
  try {
    source = openSource ? await openSource({ signal }) : await openLocal(sourcePath);
    const completion = Promise.resolve(source.completion);
    const measured = measureCopy(kind);
    const output = createWriteStream(copy, { flags: 'wx', mode: 0o600 });
    transfer = pipeline(source.stream, measured.stream, output, { signal });
    await Promise.all([transfer, completion]);
    await source.verify?.();
    await verifySource?.();
    signal?.throwIfAborted();
    const currentFolder = await lstat(folder, { bigint: true });
    if (!currentFolder.isDirectory() || currentFolder.dev !== folderInfo.dev || currentFolder.ino !== folderInfo.ino) {
      throw new Error('The export destination folder moved or was replaced during the copy.');
    }
    try { await link(copy, destinationPath); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('A file already exists at the export destination. Choose another folder.');
      if (!UNSUPPORTED_LINK.has(error.code)) throw error;
      // Some filesystems, including FAT, cannot publish a hard link. Copy the
      // fully verified staging file with the platform's exclusive-create flag.
      await copyFile(copy, destinationPath, constants.COPYFILE_EXCL);
    }
    return { status: 'exported', ...summary, ...measured.result() };
  } catch (error) {
    source?.stream?.destroy();
    await Promise.allSettled([transfer, Promise.resolve().then(() => source?.abort?.())]);
    throw error;
  } finally {
    await unlink(copy).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(staging);
  }
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export async function mountedExportRoot(cli, volumePath) {
  if (!validPath(volumePath) || !path.isAbsolute(volumePath)) throw new Error('Configure the local VeraCrypt container first.');
  const backing = await realpath(volumePath);
  const { mounted } = await cli.listVolumes({ probeNative: true, requireBackingPaths: true });
  const matches = [];
  for (const item of mounted) {
    if (!item.volume || !item.mount_point) continue;
    const candidate = await realpath(item.volume).catch(() => null);
    if (candidate && path.relative(backing, candidate) === '') matches.push(item);
  }
  if (matches.length !== 1) throw new Error('Mount the configured VeraCrypt container on the local host first.');
  const { mount_point, device } = matches[0];
  const root = await realpath(path.resolve(/^[a-z]:$/i.test(mount_point) ? mount_point + '\\' : mount_point));
  const info = await lstat(root, { bigint: true });
  if (!info.isDirectory()) throw new Error('The verified VeraCrypt mount is unavailable.');
  return { root, device, info };
}

export async function exportMountedFile({ cli, volumePath, relativePath, expectedMount, expectedPreview, ...options }) {
  const parts = validPath(relativePath) ? relativePath.split(/[\\/]/) : [];
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || /[:*?<>|"\\/]|[. ]$/.test(part))) {
    throw new Error('Select a file relative to the root of the mounted container.');
  }
  const mount = await mountedExportRoot(cli, volumePath);
  if (expectedMount && !sameMount(mount, expectedMount)) throw new Error('The VeraCrypt mount changed while selecting the file.');
  const sourcePath = path.join(mount.root, ...parts);
  const resolved = await realpath(sourcePath);
  const info = await lstat(sourcePath, { bigint: true });
  if (!inside(mount.root, resolved) || path.relative(sourcePath, resolved) !== '' ||
      !info.isFile() || info.dev !== mount.info.dev || info.nlink !== 1n) {
    throw new Error('Select a regular file inside the verified VeraCrypt mount.');
  }
  const fingerprint = [sourcePath, mount.device, mount.info.dev, mount.info.ino, info.dev, info.ino,
    info.size, info.mtimeNs, info.ctimeNs].join('\0');
  const sourceRevision = createHash('sha256').update(fingerprint).digest('hex');
  if (options.confirmed && expectedPreview?.source_revision !== sourceRevision) {
    throw new Error('The mounted source changed after confirmation.');
  }
  const verifySource = async () => {
    const current = await mountedExportRoot(cli, volumePath);
    if (!sameMount(current, mount) ||
        path.relative(sourcePath, await realpath(sourcePath)) !== '' ||
        !matchingFile(info, await lstat(sourcePath, { bigint: true }))) {
      throw new Error('The VeraCrypt mount or its file changed during export.');
    }
  };
  const result = await copyVaultFile({ ...options, kind: 'mounted-file', sourcePath,
    expectedDestinationPath: expectedPreview?.destination_path, verifySource,
    openSource: async () => { await verifySource(); return openLocal(sourcePath, info); },
  });
  return { ...result, encrypted: false, source_revision: sourceRevision };
}

function sameMount(a, b) {
  return path.relative(a.root, b.root) === '' && a.device === b.device &&
    a.info.dev === b.info.dev && a.info.ino === b.info.ino;
}
