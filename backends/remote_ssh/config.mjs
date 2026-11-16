// Configuration for the remote SSH backend, shared by the server and the CLI client.
import os from 'node:os';
import path from 'node:path';

export const BACKENDS = ['kvm', 'virtualbox'];

/** Parse `--key value` / `--key=value` pairs. Booleans accept bare `--flag`. */
export function parseArgs(argv = []) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const body = token.slice(2);
    const equal = body.indexOf('=');
    if (equal !== -1) {
      args[body.slice(0, equal)] = body.slice(equal + 1);
    } else if (argv[index + 1] !== undefined && !String(argv[index + 1]).startsWith('--')) {
      args[body] = argv[index + 1];
      index += 1;
    } else {
      args[body] = true;
    }
  }
  return args;
}

export function resolveConfig({ argv = [], env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const args = parseArgs(argv);
  const workdir = path.resolve(String(args.workdir || env.VAMP_REMOTE_WORKDIR || path.join(home, '.vamp', 'remote')));
  const backend = String(args.backend || env.VAMP_REMOTE_BACKEND || 'kvm').toLowerCase();
  if (!BACKENDS.includes(backend)) throw new Error(`Unsupported remote backend "${backend}". Use kvm or virtualbox.`);
  const windowsVBox = path.join(env.ProgramFiles || 'C:\\Program Files', 'Oracle', 'VirtualBox', 'VBoxManage.exe');
  return {
    backend,
    libvirtUri: String(args['libvirt-uri'] || env.VAMP_LIBVIRT_URI || 'qemu:///system'),
    python: String(args.python || env.VAMP_REMOTE_PYTHON || (platform === 'win32' ? 'python' : 'python3')),
    node: String(args.node || env.VAMP_REMOTE_NODE || 'node'),
    repo: String(args.repo || env.VAMP_REMOTE_REPO || ''),
    registry: String(args.registry || env.VAMP_RPA_REGISTRY || path.join(workdir, 'rpa-catalog')),
    vboxManage: String(args.vboxmanage || env.VBOXMANAGE_PATH || (platform === 'win32' && !env.VBOXMANAGE_PATH ? windowsVBox : 'VBoxManage')),
    workdir,
    platform,
    home,
    serverFile: path.join(workdir, 'server.mjs'),
    configFile: path.join(workdir, 'config.json'),
    screenshotDir: path.join(workdir, 'screenshots'),
  };
}

export function describeConfig(config) {
  return {
    backend: config.backend,
    libvirt_uri: config.backend === 'kvm' ? config.libvirtUri : undefined,
    vboxmanage: config.backend === 'virtualbox' ? config.vboxManage : undefined,
    python: config.python,
    repo: config.repo || null,
    registry: config.registry,
    workdir: config.workdir,
  };
}
