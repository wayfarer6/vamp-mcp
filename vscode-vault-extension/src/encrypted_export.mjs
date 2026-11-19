import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { copyFile, link, lstat, mkdtemp, open, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const KDBX_MAGIC = Buffer.from('03d9a29a67fb4bb5', 'hex');
const UNSUPPORTED_LINK = new Set(['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EPERM']);

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

async function openLocal(source) {
  const before = await lstat(source, { bigint: true });
  assertRegularFile(before);
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
      if (bytes === 0 || (kind === 'kdbx' && bytes < header.length)) {
        callback(new Error('The encrypted export source is empty or incomplete.'));
        return;
      }
      callback();
    },
  });
  return { stream, result: () => ({ bytes, sha256: hash.digest('hex') }) };
}

/** Export the configured encrypted file. A remote reader must reject completion on any transfer error. */
export async function exportEncryptedFile({ kind, sourcePath, destinationFolder, expectedDestinationPath, confirmed = false, openSource, signal }) {
  signal?.throwIfAborted();
  if (!['kdbx', 'volume'].includes(kind)) throw new Error('Choose the KeePass database or VeraCrypt volume.');
  if (!validPath(sourcePath) || (!openSource && !path.isAbsolute(sourcePath))) throw new Error('Configure the encrypted source file first.');
  if (!validPath(destinationFolder) || !path.isAbsolute(destinationFolder)) throw new Error('Choose an existing absolute local destination folder.');
  const folder = await realpath(destinationFolder);
  const folderInfo = await lstat(folder, { bigint: true });
  if (!folderInfo.isDirectory()) throw new Error('The local export destination must be a folder.');
  const name = (openSource ? path.posix : path).basename(sourcePath);
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
