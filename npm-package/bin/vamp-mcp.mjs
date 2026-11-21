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
  podman-screen  Approved Podman desktop RFB stream over stdin/stdout for host RPA
  assets install <archive> [sha256]  Verify and install an offline provisioning archive
  assets download [sha256]           Verify and cache provisioning assets from this release
  setup                             Detect hardware and install host YOLO and OCR runtimes
  --version    Package version
Python: RPA_HOST_PYTHON (defaults to python3, or python on Windows).
Remote controls the host running this process; use SSH to run it on another host.
No VM, OS, hypervisor or Vault is installed automatically.`);
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
      process.exitCode=await proxyRemoteStdio(config, { expectedVersion:version });
    }
  } catch(error) {
    const code=typeof error.code==='string'&&/^remote_[a-z_]+$/.test(error.code) ? `${error.code}: ` : '';
    console.error(`vamp-mcp ${command}: ${code}${error.message}`);
    process.exitCode=1;
  }
} else if (command==='podman-screen') {
  try {
    const {values}=parseArgs({args,options:{
      connection:{type:'string'}, id:{type:'string'}, binding:{type:'string'}, confirmed:{type:'boolean'},
    }});
    if (!values.confirmed || !values.connection || !/^[a-f0-9]{64}$/.test(values.id||'') ||
        !/^[a-f0-9]{64}$/.test(values.binding||'')) {
      throw new Error('Approve one checked Podman connection, full container ID and binding first.');
    }
    const {default:{createPodmanAdapter}}=await import('../runtime/backends/podman/adapter.cjs');
    const {pipeline}=await import('node:stream/promises');
    const handle=await createPodmanAdapter().openScreenStream(values.connection,values.id,values.binding,{mode:'rpa'});
    const close=()=>handle.close();
    const exit=new Promise(resolve=>{
      handle.child.once('error',()=>resolve(1));
      handle.child.once('close',resolve);
    });
    process.once('SIGTERM',close);
    process.once('SIGINT',close);
    const send=pipeline(process.stdin,handle.child.stdin).catch(close);
    try {
      await pipeline(handle.child.stdout,process.stdout,{end:false});
      const code=await exit;
      if (code!==0 && !process.stdin.readableEnded) throw Error('The Podman desktop stream ended.');
    } finally {
      close();
      process.stdin.destroy();
      await send;
      process.removeListener('SIGTERM',close);
      process.removeListener('SIGINT',close);
    }
  } catch(error) {
    console.error(`vamp-mcp podman-screen: ${error.message}`);
    process.exitCode=1;
  }
} else if (command==='setup') {
  try {
    if (args.length) throw new Error('Usage: vamp-mcp setup');
    const { installAssets } = await import('./assets.mjs');
    const assets = await installAssets(readAssetManifest());
    const { spawnSync } = await import('node:child_process');
    const configured = process.env.VAMP_VISION_PYTHON || process.env.RPA_HOST_PYTHON;
    const candidates = configured ? [[configured, []]]
      : process.platform === 'win32' ? [['py', ['-3.12']], ['python', []]]
        : [['python3.12', []], ['python3', []]];
    const check = 'import sys; raise SystemExit(not (3, 11) <= sys.version_info[:2] <= (3, 13))';
    const selected = candidates.find(([python, options]) =>
      spawnSync(python, [...options, '-c', check], {windowsHide:true, stdio:'ignore'}).status === 0);
    if (!selected) throw new Error('Install Python 3.12 or set VAMP_VISION_PYTHON to a compatible interpreter.');
    const [python, options] = selected;
    const result = spawnSync(python, [...options, path.join(assets,'scripts/setup_vision.py')],
      {windowsHide:true, stdio:'inherit'});
    if (result.error || result.status !== 0) throw new Error(result.error?.message || 'Host vision setup failed.');
  } catch(error) {
    console.error(`vamp-mcp setup: ${error.message}`);
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
  } else if (process.platform==='win32'
      && !await (await import('../runtime/backends/common/windows-admin.cjs')).default.isAdministrator()) {
    try {
      const {elevateMcp}=await import('./windows-mcp-elevation.mjs');
      process.exitCode=await elevateMcp(process.argv.slice(2));
    } catch(error) {
      console.error('vamp-mcp:',error.message);
      process.exitCode=1;
    }
  } else {
    process.env.RPA_HOST_PYTHON ||= process.platform==='win32'?'python':'python3';
    process.env.PYTHON_PATH ||= process.env.RPA_HOST_PYTHON;
    process.env.VAMP_RPA_REGISTRY ||= path.join(os.homedir(),'.vamp','rpa-catalog');
    process.env.VAMP_REMOTE_REPO ||= runtime;
    process.env.VAMP_REMOTE_PYTHON ||= process.env.RPA_HOST_PYTHON;
    if (existsSync(manifestPath)) {
      const manifest=readAssetManifest();
      const {installAssets}=await import('./assets.mjs');
      const cached=await installAssets({...manifest,cacheOnly:true});
      if(cached) process.env.VAMP_PROVISIONING_ASSETS=cached;
      let pending=cached?Promise.resolve(cached):undefined;
      globalThis[Symbol.for('vamp.provisioningAssets')]=(cacheOnly=false) => {
        if (cacheOnly) return pending ?? installAssets({...manifest,cacheOnly});
        pending ??= (async () => {
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
        })().catch(error => {
          pending=undefined;
          throw error;
        });
        return pending;
      };
    }
    // The existing remote server reads argv directly. Strip our subcommand.
    process.argv=[process.argv[0],path.join(runtime,'backends',entries[command],'server.mjs'),...args,...(command==='kvm'?['--backend','kvm']:[])];
    await import(pathToFileURL(process.argv[1]).href);
  }
}
