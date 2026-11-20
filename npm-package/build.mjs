// Reuse the VSIX's shared runtime and dependency-license bundle; no UI ships here.
import {execFileSync} from 'node:child_process';
import {cp, rm, copyFile, readFile, writeFile, lstat, mkdtemp} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.dirname(here);
execFileSync(process.execPath,[path.join(root,'vscode-extension/build.mjs')],{cwd:root,stdio:'inherit'});
const dist=path.join(root,'vscode-extension/dist');
const assetsOutput=process.env.VAMP_RELEASE_ASSETS_OUTPUT ||
  path.join(await mkdtemp(path.join(os.tmpdir(),'vamp-release-')),'assets');
const runtimeMetadata=new Set(['backends/common/guest-install.json','backends/virtualbox/profiles.json',
  'scripts/download_models.py','models/manifest.json']);
execFileSync(process.execPath,[path.join(here,'build-assets.mjs'),assetsOutput],{cwd:here,stdio:'inherit'});
for (const name of ['runtime','notices']) {
  await rm(path.join(here,name),{recursive:true,force:true});
  const source=path.join(dist,name);
  await cp(source,path.join(here,name),{
    recursive:true,
    filter: async file => {
      if (name!=='runtime') return true;
      const relative=path.relative(source,file).split(path.sep).join('/');
      const entry=await lstat(file);
      return entry.isDirectory() || (entry.isFile() && (/\.(?:js|cjs|mjs)$/i.test(file) || runtimeMetadata.has(relative)));
    },
  });
}
const version=JSON.parse(await readFile(path.join(here,'package.json'),'utf8')).version;
await copyFile(path.join(root,'backends/remote_ssh/client.mjs'),path.join(here,'runtime/backends/remote_ssh/client.mjs'));
const checksums=await readFile(path.join(assetsOutput,'SHA256SUMS'),'utf8');
const [sha256]=checksums.trim().split(/\s+/);
await writeFile(path.join(here,'runtime/provisioning-assets.json'),JSON.stringify({version,sha256})+'\n');
for (const name of ['LICENSE','THIRD_PARTY_NOTICES.md']) {
  await copyFile(path.join(root,name),path.join(here,name));
}
