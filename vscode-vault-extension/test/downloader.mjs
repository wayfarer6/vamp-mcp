// Opt-in check of the real download path (network, ~70 MB on Linux).
//
//   node test/downloader.mjs            # KeePassXC + VeraCrypt for this platform
//   node test/downloader.mjs keepassxc  # one tool only
//
// It resolves the latest official release, downloads the platform asset into a
// temporary directory, verifies the publisher SHA-256, extracts it, writes the
// launcher and runs `--version`. The temporary directory is removed afterwards,
// so a passing run says nothing about the copy in the extension's storage.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { cliStatus, detectPlatform, ensureClis, run } from '../src/downloader.mjs';

const requested = process.argv.slice(2).filter(name => ['keepassxc', 'veracrypt'].includes(name));
const tools = requested.length ? requested : ['keepassxc', 'veracrypt'];
const binDir = await mkdtemp(path.join(os.tmpdir(), 'vamp-vault-bin-'));
const plan = detectPlatform();

console.log(`platform ${process.platform}/${process.arch} (${plan.os}/${plan.cpu})`);
console.log(`bin dir  ${binDir}`);

const report = await ensureClis({
  binDir,
  tools,
  force: true,
  allowDownload: true,
  log: message => console.log(`  · ${message}`),
});

let failures = 0;
for (const tool of tools) {
  const entry = report.tools[tool];
  console.log(`\n${tool}: ${entry.status}`);
  console.log(`  asset:    ${entry.asset ?? '—'}`);
  console.log(`  checksum: ${entry.checksum?.status ?? '—'}${entry.checksum?.source ? ` (${entry.checksum.source})` : ''}`);
  console.log(`  path:     ${entry.path ?? '—'}`);
  console.log(`  version:  ${entry.version ?? '—'}`);
  if (entry.error) console.log(`  error:    ${entry.error}`);
  if (entry.manual_install) console.log(`  install:  ${entry.manual_install}`);

  if (entry.status === 'installed') {
    if (entry.checksum?.status !== 'verified') {
      console.log('  ! checksum was not verified — treat this installation with care');
      failures += 1;
    }
    const version = await run(entry.path, ['--version'], { allowFailure: true });
    assert.equal(version.code, 0, `${tool} did not run after installation`);
    console.log(`  ran:      ${`${version.stdout}${version.stderr}`.split('\n')[0].trim()}`);
    const files = await readdir(binDir);
    console.log(`  storage:  ${files.join(', ')}`);
    const size = (await stat(entry.path)).size;
    assert.ok(size > 0);
  } else if (entry.status === 'manual_install_required') {
    console.log('  (this platform has no portable build; the manual command above is expected)');
  } else {
    failures += 1;
  }
}

const status = await cliStatus({ binDir });
console.log(`\ncliStatus: ${JSON.stringify(Object.fromEntries(Object.entries(status).map(([key, value]) => [key, { available: value.available, source: value.source }])))}`);

await rm(binDir, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} tool(s) need attention`);
  process.exitCode = 1;
} else {
  console.log('\ndownload path verified');
}
