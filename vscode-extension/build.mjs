import {build} from 'esbuild';
import {cp,mkdir,rm,copyFile,readFile,writeFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.dirname(here);
const runtime=path.join(here,'dist/runtime');
await rm(path.join(here,'dist'),{recursive:true,force:true});
await mkdir(path.join(runtime,'backends/virtualbox'),{recursive:true});
const built=await build({metafile:true,entryPoints:[path.join(root,'backends/virtualbox/server.mjs')],
  outfile:path.join(runtime,'backends/virtualbox/server.mjs'),bundle:true,platform:'node',format:'esm',target:'node22',
  banner:{js:"import { createRequire as __vampRequire } from 'node:module'; const require = __vampRequire(import.meta.url);"}});
for(const name of ['scripts/build_recorder_media.py','guest_setup/recorder','third_party/pyautogui-recorder',
  'third_party/mcp-virtualbox/scripts/mouse_click.py','backends/virtualbox/display.py','backends/virtualbox/provision.py','backends/virtualbox/requirements.txt']) {
  const destination=path.join(runtime,name);
  await mkdir(path.dirname(destination),{recursive:true});
  await cp(path.join(root,name),destination,{recursive:true,filter:source=>!source.includes('__pycache__')});
}
await mkdir(path.join(here,'dist/notices'),{recursive:true});
for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md']) await copyFile(path.join(root,name),path.join(here,name));
await copyFile(path.join(root,'third_party/mcp-virtualbox/LICENSE'),path.join(here,'dist/notices/mcp-virtualbox-LICENSE'));
await copyFile(path.join(root,'third_party/mcp-virtualbox/PROVENANCE.json'),path.join(here,'dist/notices/mcp-virtualbox-PROVENANCE.json'));

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
