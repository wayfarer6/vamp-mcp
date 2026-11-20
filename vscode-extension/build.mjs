import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {cp,mkdir,rm,copyFile,readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.dirname(here);
const virtualbox=path.join(root,'third_party/mcp-virtualbox');
execFileSync(process.execPath,[path.join(virtualbox,'node_modules/typescript/bin/tsc')],{cwd:virtualbox,stdio:'inherit'});
const manifest=JSON.parse(await readFile(path.join(here,'package.json'),'utf8'));
if ((await stat(path.join(here,manifest.icon))).size>1024*1024) {
  throw new Error('Marketplace icon must be at most 1024 KB. Resize/compress it before packaging.');
}
const runtime=path.join(here,'dist/runtime');
await rm(path.join(here,'dist'),{recursive:true,force:true});
await mkdir(path.join(runtime,'backends/virtualbox'),{recursive:true});
await mkdir(path.join(here,'dist'),{recursive:true});
await copyFile(path.join(here,'src/containers-panel.cjs'),path.join(here,'dist/containers_panel.cjs'));
await copyFile(path.join(here,'src/debian-engine-create.cjs'),path.join(here,'dist/debian_engine_create.cjs'));
await copyFile(path.join(here,'src/container-capture.cjs'),path.join(here,'dist/container_capture.cjs'));
await copyFile(path.join(here,'src/container-viewer.cjs'),path.join(here,'dist/container_viewer.cjs'));
await mkdir(path.join(runtime,'backends/podman'),{recursive:true});
for(const name of ['backends/podman/adapter.cjs','backends/podman/workspace-runtime.cjs','backends/common/veracrypt-workspace.cjs','backends/podman/debian-host.cjs']){
  await mkdir(path.dirname(path.join(runtime,name)),{recursive:true});
  await copyFile(path.join(root,name),path.join(runtime,name));
}
await mkdir(path.join(runtime,'backends/vagrant'),{recursive:true});
await copyFile(path.join(root,'backends/vagrant/podman_handoff.py'),path.join(runtime,'backends/vagrant/podman_handoff.py'));
await build({entryPoints:[path.join(root,'backends/common/host-backends.cjs')],outfile:path.join(here,'dist/host_backends.cjs'),bundle:true,platform:'node',format:'cjs',target:'node22'});
await build({entryPoints:[path.join(root,'backends/common/guest-bootstrap.cjs')],outfile:path.join(here,'dist/guest_bootstrap.cjs'),bundle:true,platform:'node',format:'cjs',target:'node22'});
const built=await build({metafile:true,entryPoints:[path.join(root,'backends/virtualbox/server.mjs')],
  outfile:path.join(runtime,'backends/virtualbox/server.mjs'),bundle:true,platform:'node',format:'esm',target:'node22',
  banner:{js:"import { createRequire as __vampRequire } from 'node:module'; const require = __vampRequire(import.meta.url);"}});
for(const name of ['backends/packer','backends/common/packer.cjs','backends/common/vision-preload.cjs','backends/common/windows-admin.cjs','scripts/script_server.py','scripts/model_service.py','model_daemon.py','model_server.py','ocr_worker.py','requirements-ocr.txt','inference_device.py','backends/kvm/debian-preseed.cfg','scripts/build_recorder_media.py','backends/common/Test-Environment.ps1','backends/common/host-support.cjs','backends/virtualbox/desktop.cjs','backends/common/guest_install.py','backends/common/guest-install.json','backends/hyperv/scripts/Send-InstallerBoot.ps1','recording_converter.py','guest_keys.py','backends/library/registry.py','backends/library/replay.py','guest_setup','third_party/pyautogui-recorder','backends/virtualbox/setup_windows_sdk.py','backends/hyperv/scripts/Manage-Desktop.ps1','backends/hyperv/uac.cjs',
  'scripts/remote_host_setup.sh','scripts/macos','third_party/mcp-virtualbox/scripts/mouse_click.py','backends/virtualbox/history.py','backends/virtualbox/recording_listener.py','backends/virtualbox/mouse_click.py','backends/virtualbox/mouse_move.py','backends/virtualbox/shares.py','backends/virtualbox/transfers.py','backends/virtualbox/vnc.py','backends/virtualbox/recordings.py','backends/virtualbox/snapshots.py','backends/virtualbox/profiles.json','backends/virtualbox/display.py','backends/virtualbox/provision.py','backends/virtualbox/requirements.txt']) {
  const destination=path.join(runtime,name);
  await mkdir(path.dirname(destination),{recursive:true});
  await cp(path.join(root,name),destination,{recursive:true,filter:source=>!source.includes('__pycache__')});
}
// A VSIX/npm runtime built on Windows must also execute on Linux/macOS.
await copyFile(path.join(root,'backends/library/scratch.py'),path.join(runtime,'backends/library/scratch.py'));
await copyFile(path.join(root,'scripts/download_models.py'),path.join(runtime,'scripts/download_models.py'));
await mkdir(path.join(runtime,'models'),{recursive:true});
await copyFile(path.join(root,'models/manifest.json'),path.join(runtime,'models/manifest.json'));
for(const name of ['vamp-ui-cleanup','vamp-ui-validation','vamp-rpa-ui-checks','vamp-podman']) {
  await cp(path.join(root,'.agents/skills',name),path.join(runtime,'skills',name),{recursive:true});
}
await copyFile(path.join(here,'RESOLUTION.md'),path.join(runtime,'skills/vamp-rpa-ui-checks/references/user-guide.md'));
await copyFile(path.join(here,'CONTAINERS_WSL.md'),path.join(runtime,'skills/vamp-podman/CONTAINERS_WSL.md'));
await copyFile(path.join(root,'docs/CONTAINER_DESKTOP.md'),path.join(runtime,'skills/vamp-podman/CONTAINER_DESKTOP.md'));
const desktopRecipe=path.join(runtime,'containers/debian-desktop');
await mkdir(desktopRecipe,{recursive:true});
for (const name of ['Containerfile','Containerfile.nvidia','Containerfile.amd','Containerfile.recorder','.containerignore','.dockerignore','desktop.py','healthcheck.py','helper_common.py','capture.py','view.py','chromium-launcher.py','chromium.desktop','recorder-launcher.sh','recorder.desktop','README.md','GPU.md']) {
  await copyFile(path.join(root,'containers/debian-desktop',name),path.join(desktopRecipe,name));
}
// Preserve native Windows files; normalize only Unix shell scripts.
async function normalizeUnixScripts(directory){
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const file=path.join(directory,entry.name);
    if(entry.isDirectory())await normalizeUnixScripts(file);
    else if(entry.isFile()&&(entry.name.endsWith('.sh')||entry.name==='vamp-vault-receive')){
      const source=await readFile(file,'utf8');
      if(source.includes('\r\n'))await writeFile(file,source.replaceAll('\r\n','\n'));
    }
  }
}
await normalizeUnixScripts(runtime);
await mkdir(path.join(here,'dist/notices'),{recursive:true});
for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md']) await copyFile(path.join(root,name),path.join(here,name));
await copyFile(path.join(root,'third_party/mcp-virtualbox/LICENSE'),path.join(here,'dist/notices/mcp-virtualbox-LICENSE'));
await copyFile(path.join(root,'third_party/mcp-virtualbox/PROVENANCE.json'),path.join(here,'dist/notices/mcp-virtualbox-PROVENANCE.json'));

const libraryServer=await build({metafile:true,entryPoints:[path.join(root,'backends/library/server.mjs')],outfile:path.join(runtime,'backends/library/server.mjs'),bundle:true,platform:'node',format:'esm',target:'node22',banner:{js:"import { createRequire as __vampRequire } from 'node:module'; const require = __vampRequire(import.meta.url);"}});
const podmanServer=await build({metafile:true,entryPoints:[path.join(root,'backends/podman/server.mjs')],outfile:path.join(runtime,'backends/podman/server.mjs'),bundle:true,platform:'node',format:'esm',target:'node22',banner:{js:"import { createRequire as __vampRequire } from 'node:module'; const require = __vampRequire(import.meta.url);"}});
const unifiedServer=await build({metafile:true,entryPoints:[path.join(root,'backends/unified/server.mjs')],outfile:path.join(runtime,'backends/unified/server.mjs'),bundle:true,platform:'node',format:'esm',target:'node22',banner:{js:"import { createRequire as __vampRequire } from 'node:module'; const require = __vampRequire(import.meta.url);"}});
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
const browsableContainer=await build({metafile:true,entryPoints:[path.join(here,'src/container_browser_web.js')],
  outfile:path.join(runtime,'backends/podman/container-browser.js'),bundle:true,platform:'browser',format:'esm',target:'es2022',minify:true});
const containerViewerHost=await build({metafile:true,entryPoints:[path.join(here,'src/container-viewer-bridge.mjs')],
  outfile:path.join(here,'dist/container_viewer_bridge.cjs'),bundle:true,platform:'node',format:'cjs',target:'node22'});
const containerViewerBrowser=await build({metafile:true,entryPoints:[path.join(here,'src/container_viewer.js')],
  outfile:path.join(here,'dist/webview/container_viewer.js'),bundle:true,platform:'browser',format:'esm',target:'es2022',minify:true});
Object.assign(built.metafile.inputs,libraryServer.metafile.inputs,podmanServer.metafile.inputs,unifiedServer.metafile.inputs,remoteServer.metafile.inputs,remoteClient.metafile.inputs,libraryStore.metafile.inputs,viewerHost.metafile.inputs,viewerBrowser.metafile.inputs,browsableContainer.metafile.inputs,containerViewerHost.metafile.inputs,containerViewerBrowser.metafile.inputs);

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
