import {build} from 'esbuild';
import {cp,mkdir,rm,copyFile,readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.dirname(here);
const manifest=JSON.parse(await readFile(path.join(here,'package.json'),'utf8'));
if ((await stat(path.join(here,manifest.icon))).size>1024*1024) {
  throw new Error('Marketplace icon must be at most 1024 KB. Resize/compress it before packaging.');
}
const runtime=path.join(here,'dist/runtime');
await rm(path.join(here,'dist'),{recursive:true,force:true});
await mkdir(path.join(runtime,'backends/virtualbox'),{recursive:true});
await mkdir(path.join(here,'dist'),{recursive:true});
await build({entryPoints:[path.join(root,'backends/common/host-backends.cjs')],outfile:path.join(here,'dist/host_backends.cjs'),bundle:true,platform:'node',format:'cjs',target:'node22'});
const built=await build({metafile:true,entryPoints:[path.join(root,'backends/virtualbox/server.mjs')],
  outfile:path.join(runtime,'backends/virtualbox/server.mjs'),bundle:true,platform:'node',format:'esm',target:'node22',
  banner:{js:"import { createRequire as __vampRequire } from 'node:module'; const require = __vampRequire(import.meta.url);"}});
for(const name of ['scripts/script_server.py','backends/kvm/debian-preseed.cfg','scripts/build_recorder_media.py','rpas','backends/common/Test-Environment.ps1','recording_converter.py','guest_keys.py','backends/library/registry.py','backends/library/replay.py','guest_setup','third_party/pyautogui-recorder','backends/virtualbox/setup_windows_sdk.py','backends/hyperv/scripts/Manage-Desktop.ps1',
  'scripts/remote_host_setup.sh','scripts/macos','third_party/mcp-virtualbox/scripts/mouse_click.py','backends/virtualbox/rpas','backends/virtualbox/history.py','backends/virtualbox/recording_listener.py','backends/virtualbox/mouse_click.py','backends/virtualbox/mouse_move.py','backends/virtualbox/shares.py','backends/virtualbox/transfers.py','backends/virtualbox/vnc.py','backends/virtualbox/recordings.py','backends/virtualbox/snapshots.py','backends/virtualbox/profiles.json','backends/virtualbox/display.py','backends/virtualbox/provision.py','backends/virtualbox/requirements.txt']) {
  const destination=path.join(runtime,name);
  await mkdir(path.dirname(destination),{recursive:true});
  await cp(path.join(root,name),destination,{recursive:true,filter:source=>!source.includes('__pycache__') && source!==path.join(root,'backends/virtualbox/rpas/demos') && source!==path.join(root,'rpas/windows_print_pdf') && source!==path.join(root,'rpas/remote_host_validation')});
}
await mkdir(path.join(here,'dist/notices'),{recursive:true});
for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md']) await copyFile(path.join(root,name),path.join(here,name));
await copyFile(path.join(root,'third_party/mcp-virtualbox/LICENSE'),path.join(here,'dist/notices/mcp-virtualbox-LICENSE'));
await copyFile(path.join(root,'third_party/mcp-virtualbox/PROVENANCE.json'),path.join(here,'dist/notices/mcp-virtualbox-PROVENANCE.json'));

const libraryServer=await build({metafile:true,entryPoints:[path.join(root,'backends/library/server.mjs')],outfile:path.join(runtime,'backends/library/server.mjs'),bundle:true,platform:'node',format:'esm',target:'node22',banner:{js:"import { createRequire as __vampRequire } from 'node:module'; const require = __vampRequire(import.meta.url);"}});
const remoteServer=await build({metafile:true,entryPoints:[path.join(root,'backends/remote_ssh/server.mjs')],
  outfile:path.join(runtime,'backends/remote_ssh/server.mjs'),bundle:true,platform:'node',format:'esm',target:'node20',
  banner:{js:"import { createRequire as __vampRequire } from 'node:module'; const require = __vampRequire(import.meta.url);"}});
const remoteClient=await build({metafile:true,entryPoints:[path.join(root,'backends/remote_ssh/client.mjs')],
  outfile:path.join(here,'dist/remote_client.cjs'),bundle:true,platform:'node',format:'cjs',target:'node20'});
const libraryStore=await build({metafile:true,entryPoints:[path.join(here,'src/library-store.cjs')],outfile:path.join(here,'dist/library_store.cjs'),bundle:true,platform:'node',format:'cjs',target:'node22'});
const viewerHost=await build({metafile:true,entryPoints:[path.join(here,'src/viewer_bridge.mjs')],
  outfile:path.join(here,'dist/viewer_bridge.cjs'),bundle:true,platform:'node',format:'cjs',target:'node22'});
const viewerBrowser=await build({metafile:true,entryPoints:[path.join(here,'src/viewer_webview.js')],
  outfile:path.join(here,'dist/webview/viewer.js'),bundle:true,platform:'browser',format:'esm',target:'es2022',minify:true});
Object.assign(built.metafile.inputs,libraryServer.metafile.inputs,remoteServer.metafile.inputs,remoteClient.metafile.inputs,libraryStore.metafile.inputs,viewerHost.metafile.inputs,viewerBrowser.metafile.inputs);

// Preserve licenses of dependencies included by the bundler.
const packages=new Map();
for(const input of Object.keys(built.metafile.inputs)) {
  let directory=path.dirname(path.resolve(input));
  while(directory!==path.dirname(directory)) {
    try {
      const pkg=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'));
      if(pkg.name) {
        if(directory.includes('node_modules')) packages.set(directory,pkg);
        break;
      }
      directory=path.dirname(directory);
    } catch {directory=path.dirname(directory);}
  }
}
const notices=[];
for(const [directory,pkg] of packages) {
  const destination=path.join(here,'dist/notices/dependencies',pkg.name.replaceAll('/','__'));
  await mkdir(destination,{recursive:true});
  const licenses=(await readdir(directory)).filter(name=>/^(licen[sc]e|notice|copying)(\.|$)/i.test(name));
  for(const name of licenses) await copyFile(path.join(directory,name),path.join(destination,name));
  notices.push({name:pkg.name,version:pkg.version,license:pkg.license,licenseFiles:licenses});
}
await writeFile(path.join(here,'dist/notices/DEPENDENCIES.json'),JSON.stringify(notices,null,2)+'\n');
