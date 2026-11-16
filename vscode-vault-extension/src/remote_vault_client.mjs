// VAMP Vault — client for a vault that lives on another machine.
//
// Every remote host keeps its own database under its own home directory. This
// module never copies a database between hosts: it only runs the vault server
// that already lives on that host, one command at a time, over SSH.
//
// The master password is never part of a command line. When a call needs it, it
// is written to the remote process's standard input, which SSH encrypts for the
// whole way and which leaves no trace in `ps` or in a shell history.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const HOST_PATTERN = /^[A-Za-z0-9._:-]+$/;
const USER_PATTERN = /^[A-Za-z0-9._-]+$/;
const PROGRAM_PATTERN = /^(?:[A-Za-z0-9._/-]+|~(?:\/[A-Za-z0-9._/-]+)*)$/;
const TOOL_PATTERN = /^[a-z_]+$/;
const APPROVAL_MODES = ['each-read', 'per-session', 'off'];

export const DEFAULT_REMOTE_KDBX = '~/.vamp/vault/vault.kdbx';
export const DEFAULT_REMOTE_VOLUME = '~/.vamp/vault/vault.hc';
export const DEFAULT_REMOTE_MOUNT = '~/.vamp/vault/mnt';
export const REMOTE_VAULT_DIR = '~/.vamp/vault';

export class RemoteVaultError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RemoteVaultError';
    this.code = details.code;
    this.stderr = details.stderr;
    this.data = details.data;
  }
}

/** Quote one argument for the remote POSIX shell. */
export function quote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

/**
 * A remote path as a shell word. A leading ~ is expanded by the remote shell so
 * the vault stays inside that account's home directory, whatever it is called.
 */
export function remotePathExpression(value, { name = 'remote path' } = {}) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`The ${name} is empty.`);
  if (/[\0\n\r]/.test(text)) throw new Error(`The ${name} must not contain a line break or a null byte.`);
  if (text === '~') return '"$HOME"';
  if (text.startsWith('~/')) {
    const rest = text.slice(2);
    if (!rest) return '"$HOME"';
    return `"$HOME"/${quote(rest)}`;
  }
  return quote(text);
}

function program(value, name) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`The ${name} is empty.`);
  if (!PROGRAM_PATTERN.test(text)) throw new Error(`The ${name} may contain only letters, digits, dots, slashes, underscores and hyphens.`);
  return text;
}

/** Validate and fill in the settings of one remote vault host. */
export function normalizeRemoteVaultConfig(input = {}) {
  const host = String(input.host ?? '').trim();
  const username = String(input.username ?? '').trim();
  if (host && !HOST_PATTERN.test(host)) throw new Error('The remote host may contain only letters, digits, dots, colons, underscores and hyphens.');
  if (username && !USER_PATTERN.test(username)) throw new Error('The remote username may contain only letters, digits, dots, underscores and hyphens.');
  const port = Number(input.port ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The remote SSH port must be a whole number between 1 and 65535.');
  const approvalMode = String(input.approvalMode ?? 'per-session');
  if (!APPROVAL_MODES.includes(approvalMode)) throw new Error('The remote approval mode must be each-read, per-session or off.');
  const kdbxPath = String(input.kdbxPath ?? '').trim() || DEFAULT_REMOTE_KDBX;
  const volumePath = String(input.volumePath ?? '').trim() || DEFAULT_REMOTE_VOLUME;
  const mountPoint = String(input.mountPoint ?? '').trim() || DEFAULT_REMOTE_MOUNT;
  // Reject a bad path now, where the message can name the setting.
  remotePathExpression(kdbxPath, { name: 'remote database path' });
  remotePathExpression(volumePath, { name: 'remote volume path' });
  remotePathExpression(mountPoint, { name: 'remote mount point' });
  const privateKeyPath = String(input.privateKeyPath ?? '').trim();
  if (privateKeyPath && /[\0\n\r]/.test(privateKeyPath)) throw new Error('The private key path must not contain a line break.');
  return {
    enabled: Boolean(input.enabled),
    host,
    port,
    username,
    privateKeyPath,
    remoteNodePath: program(input.remoteNodePath || 'node', 'remote Node.js path'),
    kdbxPath,
    volumePath,
    mountPoint,
    approvalMode,
    connectTimeoutSeconds: Math.max(3, Math.min(60, Number(input.connectTimeoutSeconds) || 10)),
  };
}

/**
 * Settings from both extensions. Connection details may be reused from
 * `vamp.remote.*` when asked for, but the vault paths are never taken from
 * there: a vault path decides which database this host owns.
 */
export function resolveRemoteVaultSettings({ getVault, getVamp = null } = {}) {
  const read = (getter, key, fallback) => {
    if (typeof getter !== 'function') return fallback;
    const value = getter(key, fallback);
    return value === undefined || value === null ? fallback : value;
  };
  const reuse = read(getVault, 'remote.useVampRemoteSettings', true) !== false;
  const pick = (key, fallback) => {
    const own = read(getVault, `remote.${key}`, undefined);
    if (own !== undefined && own !== '') return own;
    if (reuse) {
      const shared = read(getVamp, `remote.${key}`, undefined);
      if (shared !== undefined && shared !== '') return shared;
    }
    return fallback;
  };
  return normalizeRemoteVaultConfig({
    enabled: read(getVault, 'remote.enabled', false),
    host: pick('host', ''),
    port: pick('port', 22),
    username: pick('username', ''),
    privateKeyPath: pick('privateKeyPath', ''),
    remoteNodePath: pick('remoteNodePath', 'node'),
    kdbxPath: read(getVault, 'remote.kdbxPath', '') || DEFAULT_REMOTE_KDBX,
    volumePath: read(getVault, 'remote.volumePath', '') || DEFAULT_REMOTE_VOLUME,
    mountPoint: read(getVault, 'remote.mountPoint', '') || DEFAULT_REMOTE_MOUNT,
    approvalMode: read(getVault, 'remote.approvalMode', 'per-session'),
  });
}

export function remoteVaultTarget(config) {
  return `${config.username ? `${config.username}@` : ''}${config.host}`;
}

/** Where this host's vault sits, as one string that can key secret storage. */
export function remoteVaultId(config) {
  const path = String(config.kdbxPath ?? '').trim();
  return `remote-ssh://${remoteVaultTarget(config)}:${config.port}${path.startsWith('/') ? '' : '/'}${path}`;
}

export function remoteVaultLabel(config) {
  return `VAMP Vault (Remote) · ${remoteVaultTarget(config)}`;
}

export function isRemoteVaultConfigured(config) {
  return Boolean(config?.enabled && config?.host);
}

/** Arguments for ssh; the remote command is always the last item. */
export function sshArgs(config, command) {
  if (!config?.host) throw new Error('No remote host is configured.');
  const args = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${config.connectTimeoutSeconds ?? 10}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
  ];
  if (Number(config.port ?? 22) !== 22) args.push('-p', String(config.port));
  if (config.privateKeyPath) args.push('-i', config.privateKeyPath, '-o', 'IdentitiesOnly=yes');
  args.push('--', remoteVaultTarget(config), command);
  return args;
}

function serverWord(config) {
  return remotePathExpression(`${REMOTE_VAULT_DIR}/server.mjs`, { name: 'remote server path' });
}

/** Shared part of every remote invocation: where node is, and which vault to open. */
function serverArgs(config) {
  const parts = [
    'exec', quote(config.remoteNodePath), serverWord(config),
    '--kdbx', remotePathExpression(config.kdbxPath, { name: 'remote database path' }),
    '--volume', remotePathExpression(config.volumePath, { name: 'remote volume path' }),
    '--mount-point', remotePathExpression(config.mountPoint, { name: 'remote mount point' }),
    '--approval-mode', quote(config.approvalMode),
  ];
  if (config.host) parts.push('--remote-host', quote(config.host));
  return parts;
}

/** Command that runs one vault tool on the remote host. */
export function remoteCallCommand(config, { tool, args = {}, stdinPassword = false } = {}) {
  if (!TOOL_PATTERN.test(String(tool ?? ''))) throw new Error('Invalid remote tool name.');
  const parts = serverArgs(config);
  parts.push('--call', quote(tool), '--args', quote(JSON.stringify(args ?? {})));
  if (stdinPassword) parts.push('--stdin-password');
  return parts.join(' ');
}

export function remoteEnvCheckCommand(config) {
  return [...serverArgs(config), '--env-check'].join(' ');
}

export function remoteListToolsCommand(config) {
  return [...serverArgs(config), '--list-tools'].join(' ');
}

export function remoteVersionCommand(config) {
  return ['exec', quote(config.remoteNodePath), serverWord(config), '--version'].join(' ');
}

export function remoteSetupCommand(config, { script, server } = {}) {
  const scriptPath = remotePathExpression(script || `${REMOTE_VAULT_DIR}/remote_vault_setup.sh`, { name: 'remote setup script path' });
  const parts = [
    'exec', 'sh', scriptPath,
    '--vault-dir', remotePathExpression(REMOTE_VAULT_DIR, { name: 'remote vault directory' }),
    '--kdbx', remotePathExpression(config.kdbxPath, { name: 'remote database path' }),
    '--volume', remotePathExpression(config.volumePath, { name: 'remote volume path' }),
    '--mount-point', remotePathExpression(config.mountPoint, { name: 'remote mount point' }),
  ];
  if (server) parts.push('--server', remotePathExpression(server, { name: 'remote server path' }));
  return parts.join(' ');
}

/** Last JSON object printed by a remote command. */
export function parseRemoteOutput(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch {
      // A progress line can start with { too; keep looking upwards.
    }
  }
  return null;
}

function friendly(error, config, stderr) {
  const text = String(stderr ?? '').trim();
  if (error?.code === 'ENOENT') return 'The ssh command was not found on this computer. Install an OpenSSH client.';
  if (/Host key verification failed/i.test(text)) return 'The remote host key is not trusted yet. Connect once from a terminal, or remove the stale entry from known_hosts.';
  if (/Permission denied \(publickey/i.test(text)) return `SSH authentication failed for ${remoteVaultTarget(config)}. Check the private key and the authorized_keys file on that host.`;
  if (/Connection refused/i.test(text)) return `Nothing is listening on ${remoteVaultTarget(config)}:${config.port}. Check the SSH server and the port.`;
  if (/Could not resolve hostname/i.test(text)) return `The host name ${config.host} could not be resolved.`;
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) return 'The remote host key changed. Check the host before trusting it again.';
  if (/timed out|Connection timed out/i.test(text)) return `Connecting to ${remoteVaultTarget(config)} timed out. Check the network or VPN route.`;
  const tail = text.split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
  return tail || error?.message || 'The SSH command failed.';
}

const CALL_TIMEOUTS = {
  vault_create: 300000,
  vault_get_credential: 180000,
  vault_list_credentials: 180000,
  vault_status: 120000,
  vault_mount_volume: 180000,
};

export class RemoteVaultClient {
  constructor(config, { spawnImpl = spawn, timeoutMs = 120000, sshCommand = 'ssh' } = {}) {
    this.config = normalizeRemoteVaultConfig({ ...config, enabled: true });
    this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs;
    this.sshCommand = sshCommand;
  }

  /** Run one shell command on the remote host through ssh. */
  exec(command, { stdinText, timeoutMs = this.timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      const args = sshArgs(this.config, command);
      // The bridge and any local password must never reach the remote side: the
      // host is headless by design and only ever gets a password on stdin.
      const environment = { ...process.env };
      delete environment.VAULT_BRIDGE_SOCKET;
      delete environment.VAULT_BRIDGE_TOKEN;
      delete environment.VAULT_MASTER_PASSWORD;
      try {
        child = this.spawnImpl(this.sshCommand, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: environment });
      } catch (error) {
        reject(new RemoteVaultError(friendly(error, this.config, ''), { code: error?.code }));
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGTERM'); } catch {}
        reject(new RemoteVaultError(`The remote command did not answer within ${Math.round(timeoutMs / 1000)}s.`, { code: 'ETIMEDOUT', stderr }));
      }, Math.max(5000, timeoutMs));
      child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
      child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
      child.on('error', error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new RemoteVaultError(friendly(error, this.config, stderr), { code: error?.code, stderr }));
      });
      child.on('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      if (child.stdin) {
        child.stdin.on('error', () => {});
        child.stdin.end(stdinText ?? '');
      }
    });
  }

  /** Is ssh able to reach this host, and is there a Node.js to run the vault? */
  async probe() {
    const node = quote(this.config.remoteNodePath);
    const expression = quote('JSON.stringify({node: process.versions.node})');
    const result = await this.exec(`command -v ${node} >/dev/null 2>&1 && exec ${node} -p ${expression}`, { timeoutMs: 45000 });
    const data = parseRemoteOutput(result.stdout);
    if (result.code !== 0 || !data) {
      throw new RemoteVaultError(
        `SSH reached ${remoteVaultTarget(this.config)} but Node.js could not run there. ${friendly({ code: result.code }, this.config, result.stderr)}`.trim(),
        { code: result.code, stderr: result.stderr },
      );
    }
    const major = Number(String(data.node ?? '').split('.')[0]);
    if (Number.isFinite(major) && major > 0 && major < 20) {
      throw new RemoteVaultError(`The remote host runs Node.js ${data.node}; VAMP Vault needs Node.js 20 or newer there.`, { data });
    }
    this.nodeVersion = String(data.node ?? '');
    this.serverVersion = String(data.version ?? '');
    return data;
  }

  /** Environment report: CLIs, paths and whether this host's database exists. */
  async envCheck() {
    const result = await this.exec(remoteEnvCheckCommand(this.config), { timeoutMs: 120000 });
    const data = parseRemoteOutput(result.stdout);
    if (result.code === 255) throw new RemoteVaultError(friendly({ code: result.code }, this.config, result.stderr), { code: 255, stderr: result.stderr });
    if (!data) {
      throw new RemoteVaultError(
        `The vault server on ${remoteVaultTarget(this.config)} did not answer. Run "VAMP Vault: Set Up Remote Vault" to install it. ${friendly({ code: result.code }, this.config, result.stderr)}`.trim(),
        { code: result.code, stderr: result.stderr },
      );
    }
    this.serverVersion = String(data.version ?? this.serverVersion ?? '');
    const keepass = data.cli?.keepassxc ?? {};
    const veracrypt = data.cli?.veracrypt ?? {};
    return {
      ...data,
      ready: Boolean(data.status === 'ok' && keepass.available && data.database?.exists),
      keepassxc: { available: Boolean(keepass.available), version: keepass.version ?? null, path: keepass.path ?? null, manualInstall: keepass.manual_install ?? '' },
      veracrypt: { available: Boolean(veracrypt.available), version: veracrypt.version ?? null, path: veracrypt.path ?? null, manualInstall: veracrypt.manual_install ?? '' },
      databaseExists: Boolean(data.database?.exists),
      volumeExists: Boolean(data.volume?.exists),
      mounted: data.mounted ?? [],
    };
  }

  /** The tool list the remote server offers, so the local proxy can mirror it. */
  async listTools() {
    const result = await this.exec(remoteListToolsCommand(this.config), { timeoutMs: 60000 });
    const data = parseRemoteOutput(result.stdout);
    if (!data?.tools?.length) throw new RemoteVaultError('The remote vault server did not return its tool list.', { code: result.code, stderr: result.stderr });
    return data.tools;
  }

  /**
   * Upload this extension's vault server and setup script into the host's own
   * vault directory. Nothing is read back: the files only go one way.
   */
  async upload({ serverFile, setupScript } = {}) {
    if (!serverFile) throw new Error('The bundled vault server file is missing.');
    const bytes = await readFile(serverFile);
    if (!bytes.length) throw new Error('The bundled vault server file is empty.');
    await this.probe();
    const directory = remotePathExpression(REMOTE_VAULT_DIR, { name: 'remote vault directory' });
    const target = remotePathExpression(`${REMOTE_VAULT_DIR}/server.mjs`);
    const temporary = remotePathExpression(`${REMOTE_VAULT_DIR}/server.mjs.new`);
    // Write beside the old file and move it into place, so a dropped connection
    // can never leave half a server where the next call would run it.
    const command = `umask 077 && mkdir -p ${directory} && chmod 700 ${directory} && cat > ${temporary} && chmod 600 ${temporary} && mv -f ${temporary} ${target}`;
    const uploaded = await this.exec(command, { stdinText: bytes.toString('utf8'), timeoutMs: 180000 });
    if (uploaded.code !== 0) {
      throw new RemoteVaultError(`Could not upload the vault server: ${friendly({ code: uploaded.code }, this.config, uploaded.stderr)}`, { code: uploaded.code, stderr: uploaded.stderr });
    }
    let script = null;
    if (setupScript) {
      const scriptBytes = await readFile(setupScript);
      const scriptTarget = remotePathExpression(`${REMOTE_VAULT_DIR}/remote_vault_setup.sh`);
      const scriptTemp = remotePathExpression(`${REMOTE_VAULT_DIR}/remote_vault_setup.sh.new`);
      const scriptCommand = `umask 077 && mkdir -p ${directory} && cat > ${scriptTemp} && chmod 700 ${scriptTemp} && mv -f ${scriptTemp} ${scriptTarget}`;
      const result = await this.exec(scriptCommand, { stdinText: scriptBytes.toString('utf8'), timeoutMs: 120000 });
      if (result.code === 0) script = `${REMOTE_VAULT_DIR}/remote_vault_setup.sh`;
    }
    const version = await this.exec(remoteVersionCommand(this.config), { timeoutMs: 60000 });
    const data = parseRemoteOutput(version.stdout);
    if (version.code !== 0 || !data) {
      throw new RemoteVaultError(`The uploaded vault server did not start: ${friendly({ code: version.code }, this.config, version.stderr)}`, { code: version.code, stderr: version.stderr });
    }
    this.serverVersion = String(data.version ?? '');
    return { server_version: this.serverVersion, node_version: data.node ?? this.nodeVersion ?? null, setup_script: script };
  }

  /** Run the uploaded setup script on the remote host. */
  async runSetup({ script } = {}) {
    const result = await this.exec(remoteSetupCommand(this.config, { script }), { timeoutMs: 900000 });
    const data = parseRemoteOutput(result.stdout);
    if (!data) {
      throw new RemoteVaultError(result.stderr.trim().split(/\r?\n/).slice(-3).join(' ') || 'The remote setup script produced no result.', { code: result.code, stderr: result.stderr });
    }
    return { ...data, exit_code: result.code };
  }

  /**
   * Run one vault tool on the remote host. `password` is written to the remote
   * process's standard input, never to its command line.
   */
  async call(tool, args = {}, { password, timeoutMs } = {}) {
    const stdinPassword = typeof password === 'string' && password.length > 0;
    const limit = timeoutMs ?? CALL_TIMEOUTS[tool] ?? 180000;
    const result = await this.exec(remoteCallCommand(this.config, { tool, args, stdinPassword }), {
      stdinText: stdinPassword ? `${password}\n` : undefined,
      timeoutMs: limit,
    });
    if (result.code === 255 && !parseRemoteOutput(result.stdout)) {
      throw new RemoteVaultError(friendly({ code: result.code }, this.config, result.stderr), { code: 255, stderr: result.stderr });
    }
    const data = parseRemoteOutput(result.stdout);
    if (!data) {
      throw new RemoteVaultError(
        `The vault server on ${remoteVaultTarget(this.config)} returned no readable result. Run "VAMP Vault: Verify Remote Vault" to check it. ${friendly({ code: result.code }, this.config, result.stderr)}`.trim(),
        { code: result.code, stderr: result.stderr },
      );
    }
    if (data.status === 'error') {
      throw new RemoteVaultError(data.error || data.message || 'The remote vault tool failed.', { code: result.code, stderr: result.stderr, data });
    }
    return data;
  }

  status() {
    return this.call('vault_status');
  }

  listEntries({ password } = {}) {
    return this.call('vault_list_credentials', {}, { password });
  }

  showEntry({ entry, password, fields = ['username', 'url', 'notes'] } = {}) {
    return this.call('vault_get_credential', { entry, fields, confirm: true }, { password });
  }
}
