import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { create } from 'tar';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const [destination] = process.argv.slice(2);
if (!destination || process.argv.length !== 3) throw new Error('Usage: node build-assets.mjs <new output directory>');
const output = path.resolve(destination);
const version = JSON.parse(await readFile(path.join(here, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Invalid package version');
const archiveName = `vamp-assets-v${version}.tar.gz`;
const runtime = path.join(root, 'vscode-extension/dist/runtime');
const stage = await mkdtemp(path.join(os.tmpdir(), 'vamp-release-assets-'));
const files = [];

async function stageAssets(relative = '') {
  for (const entry of await readdir(path.join(runtime, relative), { withFileTypes: true })) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) await stageAssets(next);
    else if (!entry.isFile()) throw new Error(`Unexpected runtime file type: ${next}`);
    else if (!/\.(?:js|mjs|cjs)$/i.test(entry.name)) {
      const target = path.join(stage, next);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(runtime, next), target);
      files.push(next.split(path.sep).join('/'));
    }
  }
}

try {
  await stageAssets();
  await copyFile(path.join(root,'requirements-mcp.txt'),path.join(stage,'requirements-mcp.txt'));
  files.push('requirements-mcp.txt');
  if (!files.includes('guest_setup/http/debian-preseed.cfg')) throw new Error('Build the extension runtime before creating an asset archive.');
  const archive = path.join(stage, archiveName);
  await create({ cwd: stage, file: archive, gzip: true, portable: true, noMtime: true, strict: true }, files.sort());
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(archive)) digest.update(chunk);
  await mkdir(output);
  await copyFile(archive, path.join(output, archiveName));
  await writeFile(path.join(output, 'SHA256SUMS'), `${digest.digest('hex')}  ${archiveName}\n`, { flag: 'wx' });
  console.log(output);
} finally {
  await rm(stage, { recursive: true, force: true });
}
