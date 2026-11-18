#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {existsSync, readFileSync} from 'node:fs';
import {parseArgs} from 'node:util';
const here=path.dirname(fileURLToPath(import.meta.url));
const runtime=path.resolve(here,'../runtime');
const version=JSON.parse(readFileSync(path.join(here,'../package.json'),'utf8')).version;
const manifestPath=path.join(runtime,'provisioning-assets.json');
function readAssetManifest() {
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  if (manifest?.version!==version || typeof manifest.sha256!=='string' || !/^[0-9a-f]{64}$/.test(manifest.sha256)) {
    throw new Error('Invalid provisioning asset manifest for this package version.');
  }
  return manifest;
}
const [command='unified',...args]=process.argv.slice(2);
if (command==='--version' || command==='-v') {
  console.log(version);
} else if (command==='--help' || command==='-h') {
  console.log(`VAMP MCP — unified VM, RPA and container tool server
Usage: vamp-mcp [unified|virtualbox|kvm|library|remote|podman] [remote options]
  unified      Default MCP registration: VM, RPA and Podman tools
  virtualbox   Legacy standalone local VM server; needs Python 3.11+
  kvm          KVM/libvirt control and Packer OS/post-install setup on Ubuntu
  library      Reviewed RPA search/replay; VAMP_RPA_REGISTRY selects saved RPAs
  remote       KVM/VirtualBox host MCP; pass --backend kvm or --backend virtualbox
  proxy        Connect to a remote Linux KVM MCP server over SSH; pass --host
  bootstrap    Check Linux KVM access and upload the remote server; pass --host
  podman       Legacy standalone container server; no separate registration needed
  assets install <archive> [sha256]  Verify and install an offline provisioning archive
  assets download [sha256]           Verify and cache provisioning assets from this release
  --version    Package version
Python: RPA_HOST_PYTHON (defaults to python3, or python on Windows).
Remote controls the host running this process; use SSH to run it on another host.
No VM, OS, hypervisor, Python environment or Vault is installed automatically.`);
} else if (command==='proxy' || command==='bootstrap') {
  try {
    const {values}=parseArgs({args,options:{
      host:{type:'string'}, port:{type:'string'}, user:{type:'string'}, key:{type:'string'},
      backend:{type:'string'}, 'libvirt-uri':{type:'string'}, node:{type:'string'},
      ...(command==='bootstrap' ? {'verify-setup-server':{type:'boolean'}} : {}),
    }});
    const {proxyRemoteStdio,RemoteSshClient,normalizeRemoteConfig}=await import('../runtime/backends/remote_ssh/client.mjs');
    const config={
      host:values.host, port:values.port, username:values.user, privateKeyPath:values.key,
      backend:values.backend, libvirtUri:values['libvirt-uri'], remoteNodePath:values.node,
    };
    if (command==='bootstrap') {
      const client=new RemoteSshClient(normalizeRemoteConfig(config));
      const result=await client.bootstrap(path.join(runtime,'backends/remote_ssh/server.mjs'), { verifySetupServer: values['verify-setup-server'] });
      console.log(JSON.stringify(result));
    } else {
      process.exitCode=await proxyRemoteStdio(config);
    }
  } catch(error) {
    console.error(`vamp-mcp ${command}: ${error.message}`);
    process.exitCode=1;
  }
} else if (command==='assets') {
  try {
    const [operation, first, second]=args;
    const offline=operation==='install' && (args.length===2 || args.length===3);
    const download=operation==='download' && (args.length===1 || args.length===2);
    if (!offline && !download) {
      throw new Error('Usage: vamp-mcp assets install <archive> [sha256] or assets download [sha256]');
    }
    const manifest=readAssetManifest();
    const supplied=offline?second:first;
    if (supplied!==undefined && supplied.toLowerCase()!==manifest.sha256) {
      throw new Error('SHA-256 mismatch with the digest embedded in this package.');
    }
    const { installAssets }=await import('./assets.mjs');
    const cache=await installAssets({...manifest, archive:offline?first:undefined});
    console.log(cache);
  } catch (error) {
    console.error(`vamp-mcp: ${error.message}`);
    process.exitCode=1;
  }
} else {
  const entries={unified:'unified',virtualbox:'virtualbox',library:'library',kvm:'remote_ssh',remote:'remote_ssh',podman:'podman'};
  if (!Object.hasOwn(entries,command) || (!['remote','kvm'].includes(command) && args.length)) {
    console.error('Invalid command or arguments. Run vamp-mcp --help.');
    process.exitCode=2;
  } else {
    process.env.RPA_HOST_PYTHON ||= process.platform==='win32'?'python':'python3';
    process.env.PYTHON_PATH ||= process.env.RPA_HOST_PYTHON;
    process.env.VAMP_RPA_REGISTRY ||= path.join(os.homedir(),'.vamp','rpa-catalog');
    process.env.VAMP_REMOTE_REPO ||= runtime;
    process.env.VAMP_REMOTE_PYTHON ||= process.env.RPA_HOST_PYTHON;
    if (existsSync(manifestPath)) {
      const manifest=readAssetManifest();
      let pending;
      globalThis[Symbol.for('vamp.provisioningAssets')]=(cacheOnly=false) => {
        if (cacheOnly) return import('./assets.mjs').then(({installAssets}) => installAssets({...manifest,cacheOnly}));
        pending ??= import('./assets.mjs').then(async ({installAssets}) => {
          const assets=await installAssets(manifest);
          process.env.VAMP_PROVISIONING_ASSETS=assets;
          process.env.PYTHONDONTWRITEBYTECODE='1';
          if (command!=='podman') {
            try {
              const vision=(await import(pathToFileURL(path.join(runtime,'backends/common/vision-preload.cjs')).href)).default;
              vision.ensureVisionServices({runtime:assets,logger:message=>process.stderr.write(message+'\n')});
            } catch {
              // Optional worker startup must not affect asset availability.
            }
          }
          return assets;
        }).catch(error => {
          pending=undefined;
          throw error;
        });
        return pending;
      };
    }
    // Keep discovery for the unified server and the container-only server free of worker startup.
    if (command !== 'unified' && command !== 'podman') try {
      const vision = (await import(pathToFileURL(path.join(runtime, 'backends/common/vision-preload.cjs')).href)).default;
      const report = vision.ensureVisionServices({runtime, logger: message => process.stderr.write(message + '\n')});
      if (report.status === 'started') process.stderr.write(`vamp-mcp: vision workers starting (pid ${report.pid})\n`);
      else if (report.status === 'unavailable') process.stderr.write(`vamp-mcp: vision workers unavailable: ${report.reason}\n`);
    } catch (error) {
      process.stderr.write(`vamp-mcp: vision preload skipped: ${error.message}\n`);
    }
    // The existing remote server reads argv directly. Strip our subcommand.
    process.argv=[process.argv[0],path.join(runtime,'backends',entries[command],'server.mjs'),...args,...(command==='kvm'?['--backend','kvm']:[])];
    await import(pathToFileURL(process.argv[1]).href);
  }
}
