// Client side of the VAMP remote backend.
// Starts the remote MCP server through SSH and speaks to it, either one tool at
// a time (--call) or as a long-lived MCP stdio session. Nothing is exposed but
// the SSH connection, and secrets never leave the host filesystem.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';

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

export function sshForwardArgs(config, localPort, remotePort) {
  if (!isConfigured(config)) throw new Error('Remote host is not configured.');
  for (const port of [localPort, remotePort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Forwarding ports must be integers between 1 and 65535.');
  }
  const prefix = sshArgs(config, '', { requireKnownHost: true }).slice(0, -3);
  return [
    '-F', 'none', ...prefix, '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'GatewayPorts=no',
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, '--', remoteTarget(config),
  ];
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

function hostKeyMessage(text) {
  if (/remote host identification has changed|offending .* key in/i.test(text)) {
    return 'The remote SSH host key changed. Verify the new fingerprint through a trusted source before updating known_hosts.';
  }
  if (/host key verification failed/i.test(text)) {
    return 'The remote SSH host key is untrusted. Verify its fingerprint through a trusted source before adding it to known_hosts.';
  }
  return '';
}

function friendly(error, config, stderr) {
  const text = String(stderr || '').trim();
  if (error?.code === 'ENOENT') return 'The ssh command was not found on this computer. Install an OpenSSH client.';
  const keyError = hostKeyMessage(text);
  if (keyError) return keyError;
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
  async upload({ serverFile, setupScript, checkLibvirt = false } = {}) {
    if (!serverFile) throw new Error('The bundled remote server file is missing.');
    if (this.config.backend === 'kvm') {
      const probePlatform = async command => {
        const result = await this.exec(command, { timeoutMs: 60000 });
        if (result.code === 255) {
          throw new RemoteSshError(friendly({ code: result.code }, this.config, result.stderr), { code: result.code, stderr: result.stderr });
        }
        return result;
      };
      const unix = await probePlatform('uname -s');
      let platform = unix.code === 0 ? unix.stdout.trim() : '';
      if (!platform) {
        const windows = await probePlatform('cmd.exe /d /c ver');
        if (windows.code === 0 && /Windows/i.test(windows.stdout)) platform = 'Windows';
      }
      if (platform !== 'Linux') {
        throw new RemoteSshError(`Remote KVM setup requires a Linux host. Detected: ${platform || 'unknown'}.`, {
          code: 'remote_host_unsupported_os',
        });
      }
    }
    await this.probe();
    if (checkLibvirt) {
      const result = await this.exec(`virsh -r -c ${quote(this.config.libvirtUri)} list --name`, { timeoutMs: 30000 });
      if (result.code !== 0) {
        let message = result.stderr.trim() || 'Read-only libvirt probe failed.';
        if (result.code === 255) {
          message = friendly({ code: result.code }, this.config, result.stderr);
        } else if (this.config.libvirtUri === 'qemu:///system' && /permission denied|not authorized|authentication/i.test(message)) {
          const identity = this.config.username ? null : await this.exec('id -un', { timeoutMs: 10000 }).catch(() => null);
          const login = this.config.username || (identity?.code === 0 ? identity.stdout.trim() : '');
          if (USER_PATTERN.test(login)) {
            message += `\nIf this account lacks libvirt group membership, have an administrator run \`sudo usermod -aG libvirt -- ${quote(login)}\` on the remote host, then reconnect.`;
          } else {
            message += '\nHave an administrator check libvirt permissions for the remote SSH account, then reconnect.';
          }
        }
        throw new RemoteSshError(message, { code: result.code, stderr: result.stderr });
      }
    }
    const bytes = await readFile(serverFile);
    if (!bytes.length) throw new Error('The bundled remote server file is empty.');
    const uploadFile = (name, contents, mode) => {
      const target = remoteFile(name);
      const command = `umask 077 && mkdir -p ${REMOTE_DIR} && tmp=$(mktemp ${target}.XXXXXX) && `
        + `trap 'rm -f "$tmp"' EXIT && cat > "$tmp" && test "$(wc -c < "$tmp")" -eq ${contents.length} `
        + `&& chmod ${mode} "$tmp" && mv -f "$tmp" ${target}`;
      return this.exec(command, { stdinText: contents, timeoutMs: 120000 });
    };
    const uploaded = await uploadFile('server.mjs', bytes, '600');
    if (uploaded.code !== 0) throw new RemoteSshError(`Could not upload the remote server: ${friendly({ code: uploaded.code }, this.config, uploaded.stderr)}`, { stderr: uploaded.stderr });
    let script = null;
    if (setupScript) {
      const setupBytes = await readFile(setupScript);
      const result = await uploadFile('remote_host_setup.sh', setupBytes, '700');
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

  async bootstrap(serverFile, { verifySetupServer = false } = {}) {
    if (this.config.backend !== 'kvm') throw new Error('Remote bootstrap requires a Linux KVM host.');
    const upload = await this.upload({ serverFile, checkLibvirt: true });
    const desktops = await this.list();
    if (verifySetupServer) {
      const tunnel = await this.openForward(8421);
      try {
        const response = await fetch(`http://127.0.0.1:${tunnel.localPort}/healthz`, {
          redirect: 'error', signal: AbortSignal.timeout(5000),
        });
        const health = response.ok ? await response.json() : null;
        if (health?.status !== 'ok' || health.service !== 'vamp-script-server' || health.port !== 8421) {
          throw new RemoteSshError('The forwarded port did not report a healthy VAMP script server.');
        }
      } finally {
        tunnel.dispose();
      }
    }
    return { status: 'ready', server_version: upload.server_version, desktop_count: desktops.count };
  }

  async verifyStdio() {
    const requests = [
      { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'vamp-verify', version: '1' } } },
      { method: 'notifications/initialized' },
      { id: 2, method: 'tools/list' },
    ];
    const stdinText = requests.map(request => JSON.stringify({ jsonrpc: '2.0', ...request })).join('\n') + '\n';
    const result = await this.exec(remoteMcpCommand(this.config), { stdinText, timeoutMs: 30000, requireKnownHost: true });
    if (result.code !== 0) throw new RemoteSshError(friendly({ code: result.code }, this.config, result.stderr), { code: result.code });
    let initialized;
    let tools;
    for (const line of result.stdout.trim().split(/\r?\n/)) {
      const response = parseToolOutput(line);
      if (response?.id === 1) initialized = response.result?.serverInfo;
      if (response?.id === 2) tools = response.result?.tools;
    }
    if (!initialized || !Array.isArray(tools)) throw new RemoteSshError('Remote MCP did not complete initialization and tool discovery.');
    return { toolCount: tools.length, serverVersion: initialized.version };
  }

  async checkForwardListener(port) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid remote forwarding port.');
    const command = `LC_ALL=C ss -H -ltn ${quote(`sport = :${port}`)}`;
    const result = await this.exec(command, { timeoutMs: 10000, requireKnownHost: true });
    const listeners = result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => line.trim().split(/\s+/)[3]);
    const ipv4 = `127.0.0.1:${port}`;
    const ipv6 = `[::1]:${port}`;
    if (result.code !== 0 || !listeners.includes(ipv4) || listeners.some(listener => listener !== ipv4 && listener !== ipv6)) {
      throw new RemoteSshError('Remote forwarding requires a listener on 127.0.0.1 with no non-loopback listener on the same port.', { code: 'remote_listener_not_private' });
    }
  }

  async openForward(remotePort) {
    await this.checkForwardListener(remotePort);
    const localPort = await new Promise((resolve, reject) => {
      const reservation = createServer();
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', () => {
        const { port } = reservation.address();
        reservation.close(error => error ? reject(error) : resolve(port));
      });
    });
    const args = sshForwardArgs(this.config, localPort, remotePort);
    const child = this.spawnImpl('ssh', ['-v', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: { ...process.env, LC_ALL: 'C' },
    });
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      child.kill();
    };
    const closed = new Promise(resolve => {
      child.once('close', () => {
        disposed = true;
        resolve();
      });
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail('SSH forwarding did not become ready.'), 15000);
      const fail = message => {
        clearTimeout(timer);
        dispose();
        reject(new RemoteSshError(message, { code: 'remote_forward_failed' }));
      };
      child.once('error', () => fail('Could not start SSH forwarding.'));
      child.once('close', () => fail('SSH forwarding closed.'));
      const ready = `Local forwarding listening on 127.0.0.1 port ${localPort}.`;
      let pending = '';
      let binding = false;
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop().slice(-4096);
        for (const line of lines) {
          if (line.includes(ready)) binding = true;
          if (binding && /channel \d+: new port-listener\b/.test(line)) {
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });
    return { localPort, closed, dispose };
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
    args: sshArgs(normalized, remoteMcpCommand(normalized), { requireKnownHost: true }),
    version,
    label: `VAMP Remote (SSH) · ${remoteTarget(normalized)}`,
  };
}

/** Forward MCP bytes unchanged. A broken session must be initialized again by its client. */
export async function proxyRemoteStdio(config, { input = process.stdin, output = process.stdout, diagnostic = process.stderr, spawnImpl = spawn, expectedVersion } = {}) {
  const normalized = normalizeRemoteConfig(config);
  if (normalized.backend !== 'kvm') throw new Error('The remote proxy requires a Linux KVM host.');
  const definition = remoteStdioDefinition(normalized);
  const child = spawnImpl(definition.command, definition.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let ended = false;
  let shutdownTimer;
  const onEnd = () => {
    ended = true;
    shutdownTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    shutdownTimer.unref();
  };
  if (input.readableEnded) onEnd();
  input.once('end', onEnd);
  child.stdin.on('error', () => {});
  if (expectedVersion) {
    let pending = '';
    const inspectHandshake = chunk => {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        const setup = parseToolOutput(line)?.result;
        if (!setup?.protocolVersion || typeof setup.serverInfo?.version !== 'string') continue;
        child.stdout.off('data', inspectHandshake);
        if (setup.serverInfo.version !== expectedVersion) {
          const user = normalized.username ? ` --user ${normalized.username}` : '';
          const port = normalized.port === 22 ? '' : ` --port ${normalized.port}`;
          diagnostic.write(`Remote VAMP version differs from local VAMP ${expectedVersion}. Run vamp-mcp bootstrap --host ${normalized.host}${user}${port} with the same SSH options.\n`);
        }
        return;
      }
      if (pending.length > 65536) child.stdout.off('data', inspectHandshake);
    };
    child.stdout.on('data', inspectHandshake);
  }
  child.stdout.pipe(output, { end: false });
  let sshDiagnostic = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { sshDiagnostic = (sshDiagnostic + chunk).slice(-4096); });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  input.pipe(child.stdin);
  let code;
  try {
    code = await closed;
  } finally {
    clearTimeout(shutdownTimer);
    input.unpipe(child.stdin);
    input.removeListener('end', onEnd);
    input.pause();
  }
  const keyError = hostKeyMessage(sshDiagnostic);
  if (ended) {
    if (code === 0) return 0;
    diagnostic.write(`remote_session_lost: ${keyError || 'SSH closed without completing the MCP session.'}\n`);
    return 1;
  }
  const retry = new RemoteSshClient(normalized, { spawnImpl });
  try {
    await retry.exec(`exec ${quote(normalized.remoteNodePath)} ${remoteFile('server.mjs')} --version`, { timeoutMs: 15000, requireKnownHost: true });
  } catch {
    // The original MCP session is lost even if the remote host is reachable again.
  }
  diagnostic.write(`remote_session_lost: ${keyError || 'Start a new MCP session to reconnect. Pending requests were not replayed.'}\n`);
  return 1;
}
