#!/usr/bin/env node
// VAMP Vault — Model Context Protocol (stdio) server.
//
// Owns exactly two things: a KeePassXC database and optional VeraCrypt
// volumes. Secrets leave this process only as the answer to one approved tool
// call, and they are cached for a short, configurable window so a workflow
// does not have to re-approve every field.
//
// Environment (set by the VS Code extension):
//   VAULT_KEEPASSXC_CLI   explicit keepassxc-cli path
//   VAULT_VERACRYPT_CLI   explicit veracrypt path
//   VAULT_KDBX            default .kdbx file
//   VAULT_VOLUME          default VeraCrypt volume
//   VAULT_MOUNT_POINT     default mount point
//   VAULT_BIN_DIR         where downloaded CLIs live
//   VAULT_SESSION_TTL_MS  credential cache lifetime (0 disables)
//   VAULT_APPROVAL_MODE   each-read | per-session | off
//   VAULT_BRIDGE_SOCKET   extension bridge socket (approval dialogs, secret storage)
//   VAULT_BRIDGE_TOKEN    shared token for that socket
//   VAULT_MASTER_PASSWORD headless fallback only; prefer VS Code secret storage
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { access } from 'node:fs/promises';
import { sep } from 'node:path';
import { BridgeClient, BridgeUnavailable } from '../../src/bridge_client.mjs';
import { cliStatus, resolveCli } from '../../src/downloader.mjs';
import { VaultCli } from '../../src/vault_cli.mjs';

const VERSION = '0.1.4';

const USAGE = [
  'usage: server.mjs [ --version | --list-tools | --env-check',
  '                  | --call TOOL [--args JSON] [--stdin-password] ]',
  '                  [--kdbx PATH] [--volume PATH] [--mount-point PATH]',
  '                  [--keepassxc-cli PATH] [--veracrypt-cli PATH] [--bin-dir PATH]',
  '                  [--approval-mode each-read|per-session|off] [--session-ttl-minutes N]',
  '                  [--remote-host HOST]',
  '',
  'With no mode flag it speaks MCP over stdio (how VS Code starts it).',
  '--call runs exactly one tool and prints its JSON result: the mode the VAMP Vault',
  'extension uses for a vault that lives on another machine, reached over SSH.',
].join('\n');

/**
 * Command line for the modes used over SSH. Nothing here changes the stdio
 * MCP behaviour: without a mode flag this file behaves exactly as before.
 */
function parseArgv(argv) {
  const parsed = { mode: 'stdio', tool: '', args: '', stdinPassword: false, flags: {} };
  const value = (index, name) => {
    const next = argv[index + 1];
    if (next === undefined) throw new Error(`${name} needs a value`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--version': parsed.mode = 'version'; break;
      case '--list-tools': parsed.mode = 'list-tools'; break;
      case '--env-check': parsed.mode = 'env-check'; break;
      case '--call': parsed.mode = 'call'; parsed.tool = value(index, arg); index += 1; break;
      case '--args': parsed.args = value(index, arg); index += 1; break;
      case '--stdin-password': parsed.stdinPassword = true; break;
      case '--kdbx': parsed.flags.kdbx = value(index, arg); index += 1; break;
      case '--volume': parsed.flags.volume = value(index, arg); index += 1; break;
      case '--mount-point': parsed.flags.mountPoint = value(index, arg); index += 1; break;
      case '--keepassxc-cli': parsed.flags.keepassxc = value(index, arg); index += 1; break;
      case '--veracrypt-cli': parsed.flags.veracrypt = value(index, arg); index += 1; break;
      case '--bin-dir': parsed.flags.binDir = value(index, arg); index += 1; break;
      case '--approval-mode': parsed.flags.approvalMode = value(index, arg); index += 1; break;
      case '--session-ttl-minutes': parsed.flags.ttlMinutes = value(index, arg); index += 1; break;
      case '--remote-host': parsed.flags.remoteHost = value(index, arg); index += 1; break;
      case '-h': case '--help': parsed.mode = 'help'; break;
      default: throw new Error(`unknown option: ${arg}`);
    }
  }
  return parsed;
}

let cli;
try {
  cli = parseArgv(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n${USAGE}\n`);
  process.exit(2);
}

const env = process.env;
const ttlMinutes = Number(cli.flags.ttlMinutes);
const settings = {
  keepassxc: cli.flags.keepassxc?.trim() || env.VAULT_KEEPASSXC_CLI?.trim() || '',
  veracrypt: cli.flags.veracrypt?.trim() || env.VAULT_VERACRYPT_CLI?.trim() || '',
  kdbx: cli.flags.kdbx?.trim() || env.VAULT_KDBX?.trim() || '',
  volume: cli.flags.volume?.trim() || env.VAULT_VOLUME?.trim() || '',
  mountPoint: cli.flags.mountPoint?.trim() || env.VAULT_MOUNT_POINT?.trim() || '',
  binDir: cli.flags.binDir?.trim() || env.VAULT_BIN_DIR?.trim() || '',
  ttlMs: Number.isFinite(ttlMinutes) ? Math.max(0, ttlMinutes) * 60000 : Number(env.VAULT_SESSION_TTL_MS ?? 300000),
  approvalMode: ['each-read', 'per-session', 'off'].includes(cli.flags.approvalMode)
    ? cli.flags.approvalMode
    : ['each-read', 'per-session', 'off'].includes(env.VAULT_APPROVAL_MODE) ? env.VAULT_APPROVAL_MODE : 'per-session',
  bridgeSocket: env.VAULT_BRIDGE_SOCKET?.trim() || '',
  bridgeToken: env.VAULT_BRIDGE_TOKEN?.trim() || '',
  fallbackPassword: env.VAULT_MASTER_PASSWORD ?? '',
  remoteHost: cli.flags.remoteHost?.trim() || '',
};

const instructionLines = [
  'VAMP Vault holds the user\'s credentials and the encrypted volume that carries their certificates.',
  'Read a secret only when the current step of the task needs it, one entry at a time, and never repeat a secret in a summary, log or file.',
];
if (settings.remoteHost) {
  instructionLines.push(
    `This vault belongs to the remote host "${settings.remoteHost}" and is separate from the vault on the user\'s own computer: entries here exist only on that host, and nothing is copied or synced between them.`,
    'The user approves each read on their own computer before the request reaches this host.',
  );
} else {
  instructionLines.push('The user sees and approves each read in VS Code (or must pass confirm:true where no dialog is available).');
}
instructionLines.push(
  'Prefer vault_list_credentials to find an entry before asking the user which one to use.',
  'Never put a password into a shell command, a URL, a commit or a chat message; type it into the target page or application directly.',
  'Mount a volume only when a certificate or signing step actually requires it, and unmount it when that step is finished.',
);

const server = new McpServer({ name: settings.remoteHost ? `VAMP Vault (Remote) · ${settings.remoteHost}` : 'VAMP Vault', version: VERSION }, {
  instructions: instructionLines.join(' '),
});

/** Tool table: registered on the MCP server and runnable one at a time by --call. */
const tools = [];
function tool(name, definition, handler) {
  tools.push({ name, title: definition.title, description: definition.description, inputSchema: definition.inputSchema, handler });
}

const scope = {
  cli: null,
  bridge: null,
  bridgeTried: false,
  approvedThisSession: new Set(),
  cache: new Map(),
  policyRevision:null,
};

const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

function failure(error, extra = {}) {
  return text({
    status: 'error',
    error: error?.message ?? String(error),
    code: error?.code ?? null,
    ...extra,
  });
}

async function fileExists(file) {
  if (!file) return false;
  try { await access(file); return true; } catch { return false; }
}

async function getBridge() {
  if (scope.bridge) return scope.bridge;
  if (scope.bridgeTried) return null;
  scope.bridgeTried = true;
  try {
    scope.bridge = await BridgeClient.connect({ socketPath: settings.bridgeSocket, token: settings.bridgeToken });
    return scope.bridge;
  } catch (error) {
    if (!(error instanceof BridgeUnavailable)) console.error(`vault bridge: ${error.message}`);
    return null;
  }
}

async function getCli() {
  if (scope.cli) return scope.cli;
  const [keepass, veracrypt] = await Promise.all([
    resolveCli('keepassxc', { binDir: settings.binDir || undefined, override: settings.keepassxc || undefined }),
    resolveCli('veracrypt', { binDir: settings.binDir || undefined, override: settings.veracrypt || undefined }),
  ]);
  scope.cli = new VaultCli({
    keepassxcCli: keepass.available ? keepass.path : null,
    veracryptCli: veracrypt.available ? veracrypt.path : null,
    kdbxPath: settings.kdbx,
    volumePath: settings.volume,
    mountPoint: settings.mountPoint,
    resolution: { keepassxc: keepass, veracrypt },
  });
  return scope.cli;
}

/** Master password: VS Code secret storage first, headless environment variable second. */
async function masterPassword({ create = false, file = '', label = 'VAMP Vault master password' } = {}) {
  const bridge = await getBridge();
  if (bridge) {
    try {
      const result = create ? await bridge.newPassword({ purpose: 'master', label }) : await bridge.unlock(file || settings.kdbx);
      if (result.password) return { password: result.password, source: 'vscode_secret_storage' };
      if (result.cancelled) {
        const error = new Error('The user cancelled the unlock prompt in VS Code.');
        error.code = 'user_cancelled';
        throw error;
      }
    } catch (error) {
      if (error.code === 'user_cancelled') throw error;
      if (!(error instanceof BridgeUnavailable)) throw error;
      scope.bridge = null;
    }
  }
  if (settings.fallbackPassword) return { password: settings.fallbackPassword, source: 'environment' };
  if (create) {
    const error = new Error('A master password for the new database must come from the user. Ask them to run "VAMP Vault: Create Vault" in VS Code, or pass master_password in this call.');
    error.code = 'password_required';
    throw error;
  }
  const error = new Error('The vault is locked. Ask the user to run "VAMP Vault: Set Up KeePassXC & VeraCrypt CLI" or unlock it in VS Code, then try again.');
  error.code = 'vault_locked';
  throw error;
}

function cacheKey(file, entry, field) {
  return `${file}|${entry}|${field}`;
}

function cacheGet(file, entry, field) {
  if (settings.ttlMs <= 0) return null;
  const hit = scope.cache.get(cacheKey(file, entry, field));
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    scope.cache.delete(cacheKey(file, entry, field));
    return null;
  }
  return hit.value;
}

function cacheSet(file, entry, field, value) {
  if (settings.ttlMs <= 0) return;
  scope.cache.set(cacheKey(file, entry, field), { value, expiresAt: Date.now() + settings.ttlMs });
}

function cacheForget(entry) {
  for (const key of [...scope.cache.keys()]) {
    if (key.includes(`|${entry}|`)) scope.cache.delete(key);
  }
}

/**
 * Ask the user before a secret leaves the vault.
 * Returns {approved, how} or {pending:true} when neither a dialog nor an
 * explicit confirmation is available.
 */
async function refreshPolicy(file=settings.kdbx){
  const bridge=await getBridge();
  if(!settings.bridgeSocket)return;
  if(!bridge)throw new Error('Vault approval bridge is unavailable. Reopen VS Code before reading secrets.');
  let live;
  try{live=await bridge.request('state',{kdbx:file},{timeout:5000});}
  catch{throw new Error('Vault approval bridge is unavailable. Reopen VS Code before reading secrets.');}
  const mode=['each-read','per-session','off'].includes(live.approval_mode)?live.approval_mode:'each-read';
  if(scope.policyRevision!==live.revision||settings.approvalMode!==mode||!live.unlocked){scope.cache.clear();scope.approvedThisSession.clear();}
  scope.policyRevision=live.revision;settings.approvalMode=mode;settings.ttlMs=Math.max(0,Math.min(120,Number(live.cache_minutes)||0))*60000;
}

async function approve({ action, entry, detail, confirm = false,file=settings.kdbx }) {
  await refreshPolicy(file);
  if (settings.approvalMode === 'off') return { approved: true, how: 'approval disabled by configuration' };
  const key = `${file}|${action}|${entry}`;
  if (settings.approvalMode === 'per-session' && scope.approvedThisSession.has(key)) {
    return { approved: true, how: 'already approved in this session' };
  }
  const bridge = await getBridge();
  if (bridge) {
    try {
      const result = await bridge.approve({ action, entry, detail });
      if (result.approved && result.remember) scope.approvedThisSession.add(key);
      return result.approved
        ? { approved: true, how: 'approved in VS Code' }
        : { approved: false, how: 'the user declined in VS Code' };
    } catch (error) {
      if (!(error instanceof BridgeUnavailable)) throw error;
      scope.bridge = null;
    }
  }
  if (confirm) {
    scope.approvedThisSession.add(key);
    return { approved: true, how: 'confirmed by the calling agent (no dialog available)' };
  }
  return { pending: true };
}

const approvalNotice = (entry, detail) => text({
  status: 'approval_required',
  entry,
  detail,
  how_to_approve: [
    'No VS Code dialog is reachable from this server process.',
    'Ask the user to confirm, then repeat the same call with confirm: true.',
    'Alternatively open VS Code and run "VAMP Vault: Show Status" so the extension bridge is available.',
  ],
});

// --------------------------------------------------------------------- tools

tool('vault_create', {
  title: 'Create vault',
  description: 'Create a new KeePassXC .kdbx database and, optionally, an encrypted VeraCrypt volume beside it. Never overwrites an existing file unless overwrite:true. The master password comes from the user in VS Code, or from master_password when no dialog is available.',
  inputSchema: {
    file: z.string().optional().describe('Path of the .kdbx to create. Defaults to the configured vault.'),
    master_password: z.string().min(1).optional().describe('Only when no VS Code prompt is available. It is visible to the caller.'),
    key_file: z.string().optional().describe('Optional key file to require together with the password.'),
    overwrite: z.boolean().default(false),
    volume_file: z.string().optional().describe('Also create a VeraCrypt volume at this path.'),
    volume_size_mb: z.number().int().min(1).default(512),
    volume_filesystem: z.enum(['fat', 'exfat', 'ntfs']).default('fat'),
    volume_password: z.string().min(1).optional().describe('Only when no VS Code prompt is available.'),
  },
}, async args => {
  try {
    const cli = await getCli();
    if (!cli.hasKeepass) {
      return failure(new Error('keepassxc-cli is not installed or was not found. Run "VAMP Vault: Set Up KeePassXC & VeraCrypt CLI" in VS Code.'), { code: 'keepassxc_missing' });
    }
    const file = args.file || settings.kdbx;
    if (!file) return failure(new Error('No database path given and no default configured.'), { code: 'path_required' });
    let password = args.master_password;
    let source = 'argument';
    if (!password) {
      const resolved = await masterPassword({ create: true, file, label: `New master password for ${file}` });
      password = resolved.password;
      source = resolved.source;
    }
    const result = await cli.createDatabase({ file, password, keyFile: args.key_file, overwrite: args.overwrite });
    const created = { status: 'created', file, master_password_source: source, key_file: args.key_file ?? null, ...result };

    if (args.volume_file) {
      if (!cli.hasVeracrypt) {
        created.volume = { status: 'veracrypt_missing', hint: 'Install VeraCrypt to create encrypted volumes.' };
        return text(created);
      }
      let volumePassword = args.volume_password;
      if (!volumePassword && process.platform !== 'win32') {
        const resolved = await masterPassword({ create: true, file: args.volume_file, label: `New VeraCrypt password for ${args.volume_file}` });
        volumePassword = resolved.password;
      }
      created.volume = await cli.createVolume({
        file: args.volume_file,
        password: volumePassword,
        sizeBytes: args.volume_size_mb * 1024 * 1024,
        filesystem: args.volume_filesystem,
      });
    }
    return text(created);
  } catch (error) {
    return failure(error, { file: args.file ?? settings.kdbx });
  }
});

tool('vault_get_credential', {
  title: 'Read one credential',
  description: 'Return the username, password, TOTP code and custom attributes (for example PIM) of a single entry after the user approves the read. Values are cached only for the configured session window. Never echo the result into a chat message, log or file.',
  inputSchema: {
    entry: z.string().min(1).describe('Entry path inside the database, e.g. "Bank/Example" or "Example".'),
    fields: z.array(z.enum(['username', 'password', 'totp', 'url', 'notes', 'attributes'])).default(['username', 'password']),
    file: z.string().optional().describe('Database path. Defaults to the configured vault.'),
    confirm: z.boolean().default(false).describe('Explicit user confirmation, used only when no VS Code dialog is available.'),
  },
}, async args => {
  try {
    const cli = await getCli();
    const file = args.file || settings.kdbx;
    if (!file) return failure(new Error('No database path configured.'), { code: 'path_required' });
    const wanted = new Set(args.fields);
    const decision = await approve({
      file,action: 'read_credential',
      entry: args.entry,
      confirm: args.confirm,
      detail: `Release ${[...wanted].join(', ')} for "${args.entry}" to the AI agent.`,
    });
    if (decision.pending) return approvalNotice(args.entry, `Release ${[...wanted].join(', ')} to the AI agent.`);
    if (!decision.approved) return text({ status: 'denied', entry: args.entry, reason: decision.how });

    const cached = [...wanted].map(field => [field, cacheGet(file, args.entry, field)]).filter(([, value]) => value !== null);
    if (cached.length === wanted.size) {
      const value = Object.fromEntries(cached);
      return text({ status: 'ok', entry: args.entry, cached: true, expires_in_ms: settings.ttlMs, ...value });
    }

    const password = await masterPassword({ file });
    const record = await cli.showEntry({ file, entry: args.entry, databasePassword: password.password });
    const result = { status: 'ok', entry: args.entry, cached: false, approved_by: decision.how };
    if (wanted.has('username')) result.username = record.username ?? null;
    if (wanted.has('password')) result.password = record.password ?? null;
    if (wanted.has('url')) result.url = record.url ?? null;
    if (wanted.has('notes')) result.notes = record.notes || null;
    if (wanted.has('attributes')) result.attributes = record.attributes ?? {};
    if (wanted.has('totp')) {
      const totp = await cli.totp({ file, entry: args.entry, databasePassword: password.password });
      result.totp = totp.code;
      if (!totp.available) result.totp_note = 'This entry has no TOTP set up. Add the otpauth:// URI in the KeePassXC application.';
    }
    if (wanted.has('attributes') && record.attributes?.PIM) result.pim = record.attributes.PIM;

    for (const [field, value] of Object.entries(result)) {
      if (['username', 'password', 'totp', 'pim'].includes(field) && value !== null) cacheSet(file, args.entry, field, value);
    }
    return text(result);
  } catch (error) {
    if (error.code === 'entry_not_found') {
      return failure(error, { hint: 'Call vault_list_credentials to see the exact entry paths.' });
    }
    return failure(error, { entry: args.entry });
  }
});

tool('vault_set_credential', {
  title: 'Add credential',
  description: 'Add a new entry (username, password, URL, notes) to the database, creating its group when needed. Does not overwrite an existing entry; use vault_update_credential for that. TOTP seeds are added in the KeePassXC application, not here.',
  inputSchema: {
    entry: z.string().min(1).describe('Entry title, or full path including the group.'),
    group: z.string().optional().describe('Group to place the entry in, e.g. "Bank".'),
    username: z.string().optional(),
    password: z.string().optional().describe('The secret to store. It is written to the database and never returned.'),
    url: z.string().optional(),
    notes: z.string().optional(),
    file: z.string().optional(),
    overwrite: z.boolean().default(false).describe('Replace the password if the entry already exists.'),
  },
}, async args => {
  try {
    const cli = await getCli();
    const file = args.file || settings.kdbx;
    if (!file) return failure(new Error('No database path configured.'), { code: 'path_required' });
    const master = await masterPassword({ file });
    const existing = await cli.listEntries({ file, databasePassword: master.password });
    const target = args.group && args.group !== '/' ? `${args.group.replace(/\/+$/, '')}/${args.entry}` : args.entry;
    if (existing.entries.some(item => item.path === target)) {
      if (!args.overwrite) {
        return text({ status: 'exists', entry: target, hint: 'Use vault_update_credential with the fields to change, or pass overwrite:true to replace the password.' });
      }
      const updated = await cli.updateEntry({ file, entry: target, password: args.password, username: args.username, url: args.url, notes: args.notes, databasePassword: master.password });
      cacheForget(target);
      return text({ status: 'updated', ...updated });
    }
    const created = await cli.addEntry({ file, entry: args.entry, group: args.group, username: args.username, secret: args.password, url: args.url, notes: args.notes, databasePassword: master.password });
    return text({ status: 'created', ...created });
  } catch (error) {
    return failure(error);
  }
});

tool('vault_update_credential', {
  title: 'Update credential',
  description: 'Change the username, password, URL or notes of an existing entry. Omitted fields are left untouched.',
  inputSchema: {
    entry: z.string().min(1),
    username: z.string().optional(),
    password: z.string().optional(),
    url: z.string().optional(),
    notes: z.string().optional(),
    file: z.string().optional(),
  },
}, async args => {
  try {
    const cli = await getCli();
    const file = args.file || settings.kdbx;
    const master = await masterPassword({ file });
    const updated = await cli.updateEntry({
      file, entry: args.entry, username: args.username, secret: args.password, url: args.url, notes: args.notes,
      databasePassword: master.password,
    });
    cacheForget(args.entry);
    return text({ status: 'updated', ...updated });
  } catch (error) {
    return failure(error);
  }
});

tool('vault_delete_credential', {
  title: 'Delete credential',
  description: 'Remove an entry. KeePassXC moves it to the recycle bin, so the user can still restore it from the application. Requires the user to approve the deletion.',
  inputSchema: {
    entry: z.string().min(1),
    file: z.string().optional(),
    confirm: z.boolean().default(false).describe('Explicit user confirmation when no VS Code dialog is available.'),
  },
}, async args => {
  try {
    const cli = await getCli();
    const file = args.file || settings.kdbx;
    const decision = await approve({ action: 'delete_credential', entry: args.entry, confirm: args.confirm, detail: `Move "${args.entry}" to the KeePassXC recycle bin.` });
    if (decision.pending) return approvalNotice(args.entry, 'Delete this entry (moved to the recycle bin).');
    if (!decision.approved) return text({ status: 'denied', entry: args.entry, reason: decision.how });
    const master = await masterPassword({ file });
    const result = await cli.deleteEntry({ file, entry: args.entry, databasePassword: master.password });
    cacheForget(args.entry);
    return text({ status: 'deleted', approved_by: decision.how, ...result });
  } catch (error) {
    return failure(error);
  }
});

tool('vault_list_credentials', {
  title: 'List credentials',
  description: 'List entry and group paths without any password. Use this to find the exact entry path before reading a secret.',
  inputSchema: {
    group: z.string().default('/'),
    recursive: z.boolean().default(true),
    file: z.string().optional(),
  },
}, async args => {
  try {
    const cli = await getCli();
    const file = args.file || settings.kdbx;
    if (!(await fileExists(file))) return text({ status: 'no_database', file, hint: 'Create a vault first with vault_create or "VAMP Vault: Create Vault".' });
    const master = await masterPassword({ file });
    const listing = await cli.listEntries({ file, group: args.group, recursive: args.recursive, databasePassword: master.password });
    return text({
      status: 'ok',
      file: args.file ? 'explicit' : 'default',
      groups: listing.groups,
      entries: listing.entries.map(item => ({ path: item.path, title: item.title, group: item.group })),
      count: listing.entries.length,
      note: 'Passwords are not included in this listing.',
    });
  } catch (error) {
    return failure(error);
  }
});

tool('vault_mount_volume', {
  title: 'Mount encrypted volume',
  description: 'Mount a VeraCrypt volume so its certificates and credentials appear as a normal folder or virtual USB drive. Mounting needs the VeraCrypt driver on Windows/macOS or FUSE on Linux, and the user must approve the mount.',
  inputSchema: {
    volume: z.string().optional().describe('Volume file or device. Defaults to the configured volume.'),
    mount_point: z.string().optional().describe('Where to mount. Defaults to the configured mount point.'),
    pim: z.string().optional().describe('VeraCrypt PIM when the volume uses one.'),
    key_files: z.array(z.string()).optional(),
    read_only: z.boolean().default(false),
    slot: z.number().int().min(1).optional(),
    confirm: z.boolean().default(false),
  },
}, async args => {
  try {
    const cli = await getCli();
    if (!cli.hasVeracrypt) return failure(new Error('The VeraCrypt CLI is not installed.'), { code: 'veracrypt_missing' });
    const volume = args.volume || settings.volume;
    if (!volume) return failure(new Error('No volume path configured.'), { code: 'path_required' });
    if (!(await fileExists(volume))) return text({ status: 'volume_missing', volume, hint: 'Create it with vault_create (volume_file) or the VeraCrypt application.' });
    const decision = await approve({ action: 'mount_volume', entry: volume, confirm: args.confirm, detail: `Mount ${volume}${args.read_only ? ' read-only' : ''} so the agent can use the certificates inside.` });
    if (decision.pending) return approvalNotice(volume, 'Mount this encrypted volume.');
    if (!decision.approved) return text({ status: 'denied', volume, reason: decision.how });
    const password = process.platform === 'win32' ? {} : await masterPassword({ file: volume, label: 'VeraCrypt volume password' });
    const result = await cli.mountVolume({
      file: volume,
      mountPoint: args.mount_point || settings.mountPoint,
      password: password.password,
      pim: args.pim,
      keyFiles: args.key_files,
      readOnly: args.read_only,
      slot: args.slot,
    });
    return text({ status: result.mounted ? 'mounted' : 'failed', approved_by: decision.how, ...result });
  } catch (error) {
    return failure(error);
  }
});

tool('vault_unmount_volume', {
  title: 'Unmount encrypted volume',
  description: 'Safely unmount a VeraCrypt volume (or all of them) and make sure buffered writes are flushed.',
  inputSchema: {
    mount_point: z.string().optional(),
    all: z.boolean().default(false),
  },
}, async args => {
  try {
    const cli = await getCli();
    if (!cli.hasVeracrypt) return failure(new Error('The VeraCrypt CLI is not installed.'), { code: 'veracrypt_missing' });
    const result = await cli.unmountVolume({ mountPoint: args.mount_point || (args.all ? null : settings.mountPoint), all: args.all });
    return text({ status: result.unmounted ? 'unmounted' : 'failed', ...result });
  } catch (error) {
    return failure(error);
  }
});

tool('vault_status', {
  title: 'Vault status',
  description: 'Report CLI availability and paths, whether a database exists and whether the vault is unlocked, which volumes are mounted, the session cache window and platform hints. Reads nothing secret.',
  inputSchema: {
    refresh_cli: z.boolean().default(false).describe('Re-detect the CLI binaries instead of using the cached result.'),
  },
}, async args => {
  try {
    if (args.refresh_cli) scope.cli = null;
    const cli = await getCli();
    const status = {
      status: 'ok',
      version: VERSION,
      platform: `${process.platform}/${process.arch}`,
      cli: await cliStatus({ binDir: settings.binDir || undefined, overrides: { keepassxc: settings.keepassxc || undefined, veracrypt: settings.veracrypt || undefined } }),
      database: {
        path: settings.kdbx || null,
        exists: await fileExists(settings.kdbx),
      },
      volume: {
        path: settings.volume || null,
        exists: await fileExists(settings.volume),
        mount_point: settings.mountPoint || null,
      },
      locked: false,
      lock_reason: null,
      session_cache: {
        ttl_ms: settings.ttlMs,
        entries: scope.cache.size,
        approval_mode: settings.approvalMode,
        approved_this_session: scope.approvedThisSession.size,
      },
      bridge: { configured: Boolean(settings.bridgeSocket), connected: Boolean(scope.bridge) },
    };
    if (!status.database.exists) {
      status.locked = true;
      status.lock_reason = 'no database at the configured path';
    } else if (!settings.fallbackPassword) {
      const bridge = await getBridge();
      if (bridge) {
        try {
          const probe = await bridge.request('state', {}, { timeout: 4000 });
          status.locked = !probe.unlocked;
          status.lock_reason = probe.unlocked ? null : 'master password is not in VS Code secret storage';
        } catch {
          status.locked = true;
          status.lock_reason = 'the extension bridge did not answer';
        }
      } else {
        status.locked = true;
        status.lock_reason = 'no bridge and no VAULT_MASTER_PASSWORD';
      }
    }
    if (cli.hasVeracrypt) {
      status.mounted_volumes = (await cli.listVolumes()).mounted;
    }
    if (!cli.hasKeepass) status.next_action = 'Run "VAMP Vault: Set Up KeePassXC & VeraCrypt CLI" in VS Code, or install KeePassXC manually.';
    else if (!status.database.exists) status.next_action = 'Create a vault with vault_create, or "VAMP Vault: Create Vault" in VS Code.';
    else if (status.locked) status.next_action = 'Unlock in VS Code (the master password is asked once and kept in secret storage).';
    return text(status);
  } catch (error) {
    return failure(error);
  }
});

for (const entry of tools) {
  server.registerTool(entry.name, {
    title: entry.title,
    description: entry.description,
    inputSchema: entry.inputSchema,
  }, entry.handler);
}

// -------------------------------------------------------------------- modes

function emit(value) {
  return new Promise(resolve => {
    process.stdout.write(`${JSON.stringify(value)}\n`, () => resolve());
  });
}

/** First line of stdin, used to carry a master password without putting it on a command line. */
async function readStdinLine(limit = 4096) {
  return await new Promise(resolve => {
    let data = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      process.stdin.pause();
      resolve(data.split('\n')[0].replace(/\r$/, ''));
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      data += chunk;
      if (data.includes('\n') || data.length >= limit) finish();
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    process.stdin.resume();
  });
}

/**
 * JSON Schema for one tool's input. Zod 4 can do this itself; on Zod 3 the
 * converter next to it does, so the server reports a usable tool list either way.
 */
async function jsonSchemaFor(shape) {
  const object = z.object(shape);
  let schema;
  if (typeof z.toJSONSchema === 'function') {
    schema = z.toJSONSchema(object, { io: 'input' });
  } else {
    const { default: zodToJsonSchema } = await import('zod-to-json-schema');
    schema = zodToJsonSchema(object, { target: 'jsonSchema7', $refStrategy: 'none' });
  }
  delete schema.$schema;
  return schema;
}

async function toolManifest() {
  const manifest = [];
  for (const entry of tools) {
    let schema;
    try {
      schema = await jsonSchemaFor(entry.inputSchema);
    } catch {
      schema = { type: 'object' };
    }
    manifest.push({ name: entry.name, title: entry.title, description: entry.description, inputSchema: schema });
  }
  return manifest;
}

async function envCheck() {
  const report = {
    status: 'ok',
    version: VERSION,
    node: process.versions.node,
    platform: `${process.platform}/${process.arch}`,
    home: process.env.HOME || process.env.USERPROFILE || '',
    remote_host: settings.remoteHost || null,
    kdbx: { path: settings.kdbx || null, exists: await fileExists(settings.kdbx) },
    volume: { path: settings.volume || null, exists: await fileExists(settings.volume) },
    mount_point: settings.mountPoint || null,
  };
  try {
    const cli = await getCli();
    report.cli = await cliStatus({ binDir: settings.binDir || undefined, overrides: { keepassxc: settings.keepassxc || undefined, veracrypt: settings.veracrypt || undefined } });
    report.mounted = cli.hasVeracrypt ? (await cli.listVolumes()).mounted : [];
  } catch (error) {
    report.status = 'incomplete';
    report.error = error?.message ?? String(error);
  }
  const dir = settings.kdbx && settings.kdbx.includes(sep) ? settings.kdbx.slice(0, settings.kdbx.lastIndexOf(sep)) : '';
  if (dir) {
    try {
      const { stat } = await import('node:fs/promises');
      const info = await stat(dir);
      report.directory = { path: dir, mode: (info.mode & 0o777).toString(8), owner_only: (info.mode & 0o077) === 0 };
    } catch {
      report.directory = { path: dir, exists: false };
    }
  }
  return report;
}

async function runCall() {
  const entry = tools.find(item => item.name === cli.tool);
  if (!entry) {
    await emit({ status: 'error', error: `unknown tool: ${cli.tool || '(none)'}`, available: tools.map(item => item.name) });
    process.exitCode = 2;
    return;
  }
  let args;
  try {
    args = z.object(entry.inputSchema).parse(cli.args ? JSON.parse(cli.args) : {});
  } catch (error) {
    await emit({ status: 'error', error: `invalid arguments: ${error.message}`, tool: entry.name });
    process.exitCode = 2;
    return;
  }
  let result;
  try {
    result = await entry.handler(args);
  } catch (error) {
    await emit({ status: 'error', error: error?.message ?? String(error), code: error?.code ?? null, tool: entry.name });
    process.exitCode = 1;
    return;
  }
  let payload;
  try {
    payload = JSON.parse(result?.content?.[0]?.text ?? '{}');
  } catch {
    payload = { status: 'error', error: 'the tool returned an unreadable result', tool: entry.name };
  }
  await emit(payload);
}

const main = async () => {
  if (cli.mode === 'help') {
    await emit({ status: 'ok', usage: USAGE });
    return;
  }
  if (cli.mode === 'version') {
    await emit({ status: 'ok', version: VERSION, node: process.versions.node, remote_host: settings.remoteHost || null });
    return;
  }
  if (cli.stdinPassword) settings.fallbackPassword = await readStdinLine();
  if (cli.mode === 'list-tools') {
    await emit({ status: 'ok', version: VERSION, tools: await toolManifest() });
    return;
  }
  if (cli.mode === 'env-check') {
    await emit(await envCheck());
    return;
  }
  if (cli.mode === 'call') {
    await runCall();
    return;
  }
  await server.connect(new StdioServerTransport());
  console.error(`VAMP Vault stdio server ready${settings.remoteHost ? ` (remote host ${settings.remoteHost})` : ''}`);
};

await main();
