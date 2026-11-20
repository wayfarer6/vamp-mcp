import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { list, extract } from 'tar';

const required = [
  'backends/hyperv/scripts/Manage-Desktop.ps1',
  'backends/library/registry.py',
  'backends/library/replay.py',
  'backends/library/scratch.py',
  'backends/packer/debian_answer_iso.py',
  'backends/packer/debian-hyperv/debian.pkr.hcl',
  'backends/packer/debian-hyperv/prepare.py',
  'backends/packer/debian-hyperv/package_box.py',
  'backends/packer/debian-hyperv/Vagrantfile',
  'backends/packer/deploy-hyperv.ps1',
  'backends/packer/hyperv_debian.py',
  'backends/packer/podman/provision.sh',
  'backends/packer/podman/host_job.py',
  'backends/packer/runner.py',
  'backends/vagrant/podman_handoff.py',
  'backends/virtualbox/display.py',
  'backends/virtualbox/mouse_click.py',
  'guest_setup/http/debian-preseed.cfg',
  'requirements-ocr.txt',
  'scripts/build_recorder_media.py',
  'scripts/script_server.py',
];
const versionPattern = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const marker = '.vamp-assets.json';

async function validCache(directory, digest, version) {
  try {
    if (!(await lstat(directory)).isDirectory()) return false;
    const record = JSON.parse(await readFile(path.join(directory, marker), 'utf8'));
    if (record.version !== version || record.sha256 !== digest) return false;
    return (await Promise.all(required.map(file => lstat(path.join(directory, file))))).every(file => file.isFile());
  } catch {
    return false;
  }
}

export async function installAssets({ version, sha256, archive, cacheOnly = false, cacheRoot = process.env.VAMP_ASSETS_DIR || path.join(os.homedir(), '.vamp/assets') }) {
  if (!versionPattern.test(version) || !/^[0-9a-f]{64}$/i.test(sha256)) {
    throw new Error('Supply the released version and an independently verified SHA-256 digest.');
  }
  const digest = sha256.toLowerCase();
  cacheRoot = path.resolve(cacheRoot);
  const target = path.join(cacheRoot, `v${version}`);
  if (await validCache(target, digest, version)) return target;
  if (cacheOnly) return null;
  if (await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; })) {
    // Another installer may have published this release after the first lookup.
    if (await validCache(target, digest, version)) return target;
    throw new Error('The target asset cache already exists and does not match this release.');
  }
  await mkdir(cacheRoot, { mode: 0o700, recursive: true });
  const temp = await mkdtemp(path.join(cacheRoot, '.download-'));
  try {
    const stagedArchive = path.join(temp, 'source.tar.gz');
    const stagedAssets = path.join(temp, 'assets');
    let source;
    if (archive) {
      source = createReadStream(archive);
    } else {
      const release = `https://github.com/wayfarer6/vamp-mcp/releases/download/v${version}`;
      const response = await fetch(`${release}/vamp-assets-v${version}.tar.gz`, { signal: AbortSignal.timeout(120000) });
      if (!response.ok || !response.body) throw new Error('The provisioning archive is unavailable for this release.');
      source = Readable.fromWeb(response.body);
    }
    const hash = createHash('sha256');
    let bytes = 0;
    await pipeline(source, new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > 128 * 1024 * 1024) return callback(new Error('The archive exceeds the download limit.'));
        hash.update(chunk);
        callback(null, chunk);
      },
    }), createWriteStream(stagedArchive, { flags: 'wx', mode: 0o600 }));
    if (hash.digest('hex') !== digest) throw new Error('Provisioning archive SHA-256 mismatch.');

    const seen = new Set();
    let total = 0;
    let invalid = false;
    await list({ file: stagedArchive, strict: true, onReadEntry(entry) {
      const name = entry.path.replace(/\/$/, '');
      const key = name.toLowerCase();
      const parts = name.split('/');
      total += entry.size;
      if (seen.has(key) || key === marker || seen.size >= 5000 || total > 512 * 1024 * 1024 ||
        !['File', 'Directory'].includes(entry.type) ||
        parts.some(part => !part || part === '.' || part === '..' || /[\\:\x00-\x1f<>"|?*]/.test(part) ||
          /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) invalid = true;
      seen.add(key);
    } });
    if (invalid || required.some(file => !seen.has(file.toLowerCase()))) throw new Error('Unexpected provisioning archive inventory.');
    await mkdir(stagedAssets, { mode: 0o700 });
    await extract({ file: stagedArchive, cwd: stagedAssets, strict: true, preserveOwner: false, keep: true });
    await writeFile(path.join(stagedAssets, marker), JSON.stringify({ version, sha256: digest }), { flag: 'wx', mode: 0o600 });
    if (!(await validCache(stagedAssets, digest, version))) throw new Error('Required provisioning files were not extracted.');
    try {
      await rename(stagedAssets, target);
    } catch (error) {
      if (!(await validCache(target, digest, version))) throw error;
    }
    return target;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
