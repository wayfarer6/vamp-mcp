#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
const here=path.dirname(fileURLToPath(import.meta.url));
const runtime=path.resolve(here,'../runtime');
const [command='virtualbox',...args]=process.argv.slice(2);
if (command==='--version' || command==='-v') {
  console.log(JSON.parse(readFileSync(path.join(here,'../package.json'),'utf8')).version);
} else if (command==='--help' || command==='-h') {
  console.log(`VAMP MCP — independent stdio servers
Usage: vamp-mcp [virtualbox|kvm|library|remote] [remote options]
  virtualbox   Local VirtualBox MCP (default); needs VirtualBox and Python 3.11+
  kvm          KVM/libvirt inventory, creation and control (Debian automatic install)
  library      Reviewed RPA search/replay; VAMP_RPA_REGISTRY selects saved RPAs
  remote       KVM/VirtualBox host MCP; pass --backend kvm or --backend virtualbox
  --version    Package version
Python: RPA_HOST_PYTHON (defaults to python3, or python on Windows).
Remote controls the host running this process; use SSH to run it on another host.
No VM, OS, hypervisor, Python environment or Vault is installed automatically.`);
} else {
  const entries={virtualbox:'virtualbox',library:'library',kvm:'remote_ssh',remote:'remote_ssh'};
  if (!Object.hasOwn(entries,command) || (!['remote','kvm'].includes(command) && args.length)) {
    console.error('Invalid command or arguments. Run vamp-mcp --help.');
    process.exitCode=2;
  } else {
    process.env.RPA_HOST_PYTHON ||= process.platform==='win32'?'python':'python3';
    process.env.PYTHON_PATH ||= process.env.RPA_HOST_PYTHON;
    process.env.VAMP_RPA_REGISTRY ||= path.join(os.homedir(),'.vamp','rpa-catalog');
    process.env.VAMP_REMOTE_REPO ||= runtime;
    process.env.VAMP_REMOTE_PYTHON ||= process.env.RPA_HOST_PYTHON;
    // The existing remote server reads argv directly. Strip our subcommand.
    process.argv=[process.argv[0],path.join(runtime,'backends',entries[command],'server.mjs'),...args,...(command==='kvm'?['--backend','kvm']:[])];
    await import(pathToFileURL(process.argv[1]).href);
  }
}
