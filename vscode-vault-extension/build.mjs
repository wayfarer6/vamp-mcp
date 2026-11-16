import { build } from 'esbuild';
import { cp, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(path.join(here, 'package.json'), 'utf8'));

const icon = path.join(here, manifest.icon);
if ((await stat(icon)).size > 1024 * 1024) {
  throw new Error('Marketplace icon must be at most 1024 KB. Resize/compress it before packaging.');
}

const dist = path.join(here, 'dist');
const runtime = path.join(dist, 'runtime');
await rm(dist, { recursive: true, force: true });
await mkdir(path.join(runtime, 'backends/vault'), { recursive: true });
await mkdir(path.join(runtime, 'src'), { recursive: true });

// The MCP server is bundled so the extension ships without node_modules.
const built = await build({
  metafile: true,
  entryPoints: [path.join(here, 'backends/vault/server.mjs')],
  outfile: path.join(runtime, 'backends/vault/server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'none',
  banner: { js: "import { createRequire as __vampRequire } from 'node:module'; const require = __vampRequire(import.meta.url);" },
});

// The extension host loads these two as modules for its own commands.
for (const name of ['downloader.mjs', 'vault_cli.mjs', 'bridge_client.mjs']) {
  await copyFile(path.join(here, 'src', name), path.join(runtime, 'src', name));
}

await mkdir(path.join(dist, 'notices'), { recursive: true });
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'README.md']) {
  await copyFile(path.join(here, name), path.join(dist, 'notices', name));
}

// Preserve the licenses of every package the bundler inlined.
const packages = new Map();
for (const input of Object.keys(built.metafile.inputs)) {
  let directory = path.dirname(path.resolve(input));
  while (directory !== path.dirname(directory)) {
    try {
      const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (pkg.name) {
        if (directory.includes('node_modules')) packages.set(directory, pkg);
        break;
      }
      directory = path.dirname(directory);
    } catch {
      directory = path.dirname(directory);
    }
  }
}
const notices = [];
for (const [directory, pkg] of packages) {
  const destination = path.join(dist, 'notices', 'dependencies', pkg.name.replaceAll('/', '__'));
  await mkdir(destination, { recursive: true });
  const licenses = (await readdir(directory)).filter(name => /^(licen[sc]e|notice|copying)(\.|$)/i.test(name));
  for (const name of licenses) await copyFile(path.join(directory, name), path.join(destination, name));
  notices.push({ name: pkg.name, version: pkg.version, license: pkg.license, licenseFiles: licenses });
}
await writeFile(path.join(dist, 'notices', 'DEPENDENCIES.json'), `${JSON.stringify(notices, null, 2)}\n`);

const bundle = await stat(path.join(runtime, 'backends/vault/server.mjs'));
console.log(`bundled backends/vault/server.mjs (${(bundle.size / 1024).toFixed(0)} KB) with ${notices.length} bundled package(s)`);
