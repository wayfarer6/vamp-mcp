// Client side of the VAMP remote backend.
// Starts the remote MCP server through SSH and speaks to it, either one tool at
// a time (--call) or as a long-lived MCP stdio session. Nothing is exposed but
// the SSH connection, and secrets never leave the host filesystem.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const HOST_PATTERN = /^[A-Za-z0-9._:-]+$/;
const USER_PATTERN = /^[A-Za-z0-9._-]+$/;
const TOOL_PATTERN = /^[a-z_]+$/;

export class RemoteSshError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RemoteSshError';
    this.code = details.code;
    this.stderr = details.stderr;
    this.data = details.data;
  }
}

/** Shell-quote a single argument for the remote POSIX shell. */
export function quote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function normalizeRemoteConfig(input = {}) {
  const host = String(input.host || '').trim();
  const username = String(input.username || '').trim();
  if (host && !HOST_PATTERN.test(host)) throw new Error('Remote host may contain only letters, digits, dots, colons, underscores and hyphens.');
  if (username && !USER_PATTERN.test(username)) throw new Error('Remote username may contain only letters, digits, dots, underscores and hyphens.');
  const port = Number(input.port || 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Remote SSH port must be between 1 and 65535.');
  const backend = String(input.backend || 'kvm').toLowerCase();
  if (!['kvm', 'virtualbox'].includes(backend)) throw new Error('Remote backend must be kvm or virtualbox.');
  return {
    host,
    port,
    username,
    privateKeyPath: String(input.privateKeyPath || ''),
    backend,
    libvirtUri: String(input.libvirtUri || 'qemu:///system'),
    remotePythonPath: String(input.remotePythonPath || '').trim() || 'python3',
    remoteNodePath: String(input.remoteNodePath || '').trim() || 'node',
    remoteRepoPath: String(input.remoteRepoPath || '').trim(),
    remoteRegistryPath: String(input.remoteRegistryPath || '').trim(),
    remoteVboxManagePath: String(input.remoteVboxManagePath || '').trim(),
    connectTimeoutSeconds: Math.max(3, Math.min(60, Number(input.connectTimeoutSeconds) || 10)),
  };
}

export function remoteTarget(config) {
  return `${config.username ? `${config.username}@` : ''}${config.host}`;
}

export function isConfigured(config) {
  return Boolean(config?.host);
}

/** Arguments for the ssh binary. The remote command is always the last item. */
export function sshArgs(config, command, { requireKnownHost = false } = {}) {
  if (!isConfigured(config)) throw new Error('Remote host is not configured.');
  const args = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${config.connectTimeoutSeconds}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', `StrictHostKeyChecking=${requireKnownHost ? 'yes' : 'accept-new'}`,
  ];
  if (config.port !== 22) args.push('-p', String(config.port));
  if (config.privateKeyPath) args.push('-i', config.privateKeyPath, '-o', 'IdentitiesOnly=yes');
  args.push('--', remoteTarget(config), command);
  return args;
}

const REMOTE_SEGMENT = /^[A-Za-z0-9._-]+$/;
export const REMOTE_DIR = '"$HOME/.vamp/remote"';

/** Path inside the remote work directory, quoted so the remote shell expands $HOME. */
export function remoteFile(name) {
  if (!REMOTE_SEGMENT.test(String(name))) throw new Error('Invalid remote file name.');
  return `"$HOME/.vamp/remote/${name}"`;
}

/** Command that starts the remote server for one tool call. */
export function remoteCommand(config, { tool, args = {} } = {}) {
  if (!TOOL_PATTERN.test(String(tool))) throw new Error('Invalid remote tool name.');
  const parts = [
    'exec', quote(config.remoteNodePath), remoteFile('server.mjs'),
    '--backend', quote(config.backend),
    '--libvirt-uri', quote(config.libvirtUri),
    '--python', quote(config.remotePythonPath),
    '--node', quote(config.remoteNodePath),
  ];
  if (config.remoteRepoPath) parts.push('--repo', quote(config.remoteRepoPath));
  if (config.remoteRegistryPath) parts.push('--registry', quote(config.remoteRegistryPath));
  if (config.remoteVboxManagePath) parts.push('--vboxmanage', quote(config.remoteVboxManagePath));
  parts.push('--call', quote(tool), '--args', quote(JSON.stringify(args ?? {})));
  return parts.join(' ');
}

/** Command for an interactive MCP stdio session over SSH (used by MCP clients). */
export function remoteMcpCommand(config) {
  const parts = [
    'exec', quote(config.remoteNodePath), remoteFile('server.mjs'),
    '--backend', quote(config.backend),
    '--libvirt-uri', quote(config.libvirtUri),
    '--python', quote(config.remotePythonPath),
    '--node', quote(config.remoteNodePath),
  ];
  if (config.remoteRepoPath) parts.push('--repo', quote(config.remoteRepoPath));
  if (config.remoteRegistryPath) parts.push('--registry', quote(config.remoteRegistryPath));
  if (config.remoteVboxManagePath) parts.push('--vboxmanage', quote(config.remoteVboxManagePath));
  return parts.join(' ');
}

export function parseToolOutput(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).filter(line => line.trim().startsWith('{'));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // keep looking at earlier lines
    }
  }
  return null;
}

function friendly(error, config, stderr) {
  const text = String(stderr || '').trim();
  if (error?.code === 'ENOENT') return 'The ssh command was not found on this computer. Install an OpenSSH client.';
  if (/Host key verification failed/i.test(text)) return 'The remote host key is not trusted yet. Connect once from a terminal, or remove the stale key from known_hosts.';
  if (/Permission denied \(publickey/i.test(text)) return `SSH authentication failed for ${remoteTarget(config)}. Check the private key and the authorized_keys file on the remote host.`;
  if (/Connection refused/i.test(text)) return `Nothing is listening on ${remoteTarget(config)}:${config.port}. Check the SSH server and port.`;
  if (/Could not resolve hostname/i.test(text)) return `The host name ${config.host} could not be resolved.`;
  if (/timed out|Connection timed out/i.test(text)) return `Connecting to ${remoteTarget(config)} timed out. Check the network, VPN or Tailscale route.`;
  const tail = text.split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
  return tail ? `${tail}` : (error?.message || 'SSH command failed.');
}

export class RemoteSshClient {
  constructor(config, { spawnImpl = spawn, timeoutMs = 120000 } = {}) {
    this.config = config;
    this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs;
  }

  /** Run a shell command on the remote host through ssh. */
  exec(command, { stdinText, timeoutMs = this.timeoutMs, requireKnownHost = false } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnImpl('ssh', sshArgs(this.config, command, { requireKnownHost }), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (error) {
        reject(new RemoteSshError(friendly(error, this.config, ''), { code: error?.code }));
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGTERM'); } catch {}
        reject(new RemoteSshError(`The remote command did not finish within ${Math.round(timeoutMs / 1000)}s.`, { code: 'ETIMEDOUT', stderr }));
      }, Math.max(5000, timeoutMs));
      child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
      child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
      child.on('error', error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new RemoteSshError(friendly(error, this.config, stderr), { code: error?.code, stderr }));
      });
      child.on('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      if (child.stdin) {
        child.stdin.on('error', () => {});
        if (stdinText !== undefined) child.stdin.end(stdinText);
        else child.stdin.end();
      }
    });
  }

  /** Check that Node.js exists on the remote host before anything is uploaded. */
  async probe() {
    const node = this.config.remoteNodePath;
    const result = await this.exec(`command -v ${quote(node)} >/dev/null 2>&1 && exec ${quote(node)} --version`, { timeoutMs: 60000 });
    if (result.code !== 0) {
      const major = /^v?(\d+)/.exec(String(result.stdout).trim())?.[1];
      throw new RemoteSshError(
        `Node.js was not found at "${node}" on the remote host, so the VAMP remote server cannot start. `
        + `Install Node.js 20 or newer there, or set vamp.remote.remoteNodePath. ${friendly({ code: result.code }, this.config, result.stderr)}`.trim(),
        { code: result.code, stderr: result.stderr },
      );
    }
    const version = String(result.stdout).trim();
    this.nodeVersion = version;
    return version;
  }

  /** Call one remote MCP tool and return its JSON result. */
  async call(tool, args = {}, { timeoutMs } = {}) {
    const limits = { remote_vm_create: 900000, remote_env_setup: 900000, remote_rpa_run: 900000, remote_env_check: 300000, remote_vm_list: 300000 };
    const limit = timeoutMs || limits[tool] || 180000;
    const requireKnownHost = tool === 'remote_rpa_run' && Boolean(args.vault_destination) && args.dry_run !== true;
    const result = await this.exec(remoteCommand(this.config, { tool, args }), { timeoutMs: limit, requireKnownHost });
    const data = parseToolOutput(result.stdout);
    if (result.code === 255 || (!data && result.code !== 0)) {
      throw new RemoteSshError(friendly({ code: result.code }, this.config, result.stderr), { code: result.code, stderr: result.stderr, data });
    }
    if (!data) {
      throw new RemoteSshError('The remote server returned no readable result. Run Verify Environment to repair the remote server file.', { code: result.code, stderr: result.stderr });
    }
    if (data.status === 'error' || result.code !== 0) {
      throw new RemoteSshError(data.message || 'The remote tool failed.', { code: result.code, stderr: result.stderr, data });
    }
    return data;
  }

  /** Upload this extension's remote server file and setup script to the remote host. */
  async upload({ serverFile, setupScript } = {}) {
    if (!serverFile) throw new Error('The bundled remote server file is missing.');
    await this.probe();
    const bytes = await readFile(serverFile);
    if (!bytes.length) throw new Error('The bundled remote server file is empty.');
    const command = `umask 077 && mkdir -p ${REMOTE_DIR} && cat > ${remoteFile('server.mjs')} && chmod 600 ${remoteFile('server.mjs')}`;
    const uploaded = await this.exec(command, { stdinText: bytes.toString('utf8'), timeoutMs: 120000 });
    if (uploaded.code !== 0) throw new RemoteSshError(`Could not upload the remote server: ${friendly({ code: uploaded.code }, this.config, uploaded.stderr)}`, { stderr: uploaded.stderr });
    let script = null;
    if (setupScript) {
      const setupBytes = await readFile(setupScript);
      const setupCommand = `umask 077 && mkdir -p ${REMOTE_DIR} && cat > ${remoteFile('remote_host_setup.sh')} && chmod 700 ${remoteFile('remote_host_setup.sh')}`;
      const result = await this.exec(setupCommand, { stdinText: setupBytes.toString('utf8'), timeoutMs: 120000 });
      if (result.code === 0) script = remoteFile('remote_host_setup.sh');
    }
    const version = await this.exec(`exec ${quote(this.config.remoteNodePath)} ${remoteFile('server.mjs')} --version`, { timeoutMs: 60000 });
    if (version.code !== 0) {
      throw new RemoteSshError(`The remote server could not start: ${friendly({ code: version.code }, this.config, version.stderr)}`, { stderr: version.stderr });
    }
    return { server_version: String(version.stdout || '').trim(), setup_script: script };
  }

  /** Run the uploaded setup shell script on the remote host. */
  async runSetup({ backend, repo, registry } = {}) {
    const args = ['--backend', quote(backend || this.config.backend)];
    if (repo || this.config.remoteRepoPath) args.push('--repo', quote(repo || this.config.remoteRepoPath));
    if (registry || this.config.remoteRegistryPath) args.push('--registry', quote(registry || this.config.remoteRegistryPath));
    const command = `exec sh ${remoteFile('remote_host_setup.sh')} ${args.join(' ')}`;
    const result = await this.exec(command, { timeoutMs: 900000 });
    const parsed = parseToolOutput(result.stdout);
    if (!parsed) {
      throw new RemoteSshError(result.stderr.trim().split(/\r?\n/).slice(-4).join(' ') || 'The remote setup script produced no result.', { code: result.code, stderr: result.stderr });
    }
    return { ...parsed, exit_code: result.code };
  }

  async list() {
    return this.call('remote_vm_list');
  }

  async envCheck() {
    return this.call('remote_env_check');
  }

  async status(vm) {
    return this.call('remote_vm_status', { vm });
  }

  async start(vm) {
    return this.call('remote_vm_start', { vm });
  }

  async stop(vm, { force = false } = {}) {
    return this.call('remote_vm_stop', { vm, force });
  }

  async screenshot(vm, { screen = 0 } = {}) {
    const result = await this.call('remote_vm_screenshot', { vm, screen }, { timeoutMs: 180000 });
    const image = result.images?.[0];
    if (!image?.data) throw new RemoteSshError('The remote host returned no screenshot data.');
    return { ...result, png: Buffer.from(image.data, 'base64') };
  }

  async sendKeys(vm, { text, keys } = {}) {
    return this.call('remote_vm_send_keys', { vm, ...(text !== undefined ? { text } : {}), ...(keys ? { keys } : {}) });
  }

  async mouseClick(vm, options = {}) {
    return this.call('remote_vm_mouse_click', { vm, ...options });
  }
}

/** MCP stdio definition helper for hosts that start ssh themselves. */
export function remoteStdioDefinition(config, { version = '0.1.7' } = {}) {
  const normalized = normalizeRemoteConfig(config);
  return {
    name: 'VAMP Remote (SSH)',
    command: 'ssh',
    args: sshArgs(normalized, remoteMcpCommand(normalized)),
    version,
    label: `VAMP Remote (SSH) · ${remoteTarget(normalized)}`,
  };
}
