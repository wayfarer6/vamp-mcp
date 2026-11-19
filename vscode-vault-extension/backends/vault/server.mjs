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
import { access, realpath, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { sep } from 'node:path';
import { BridgeClient, BridgeUnavailable } from '../../src/bridge_client.mjs';
import { cliStatus, resolveCli } from '../../src/downloader.mjs';
import { splitEntryPath, VaultCli } from '../../src/vault_cli.mjs';
import { checkVaultPlaceholders, parseVaultPlaceholder } from '../../src/placeholders.mjs';
import { createManagedVolume, deleteManagedVolume } from '../../src/managed_volume.mjs';
import { hypervVolume, kvmVolume, virtualBoxVolume } from '../../src/vm_volume.mjs';
import { withVmVolumeState } from '../../src/vm_volume_state.mjs';
import { auditRemoteDelivery, deliverCredential, deliveryTarget, remoteProcessTarget, validateCredentialField } from '../../src/credential_delivery.mjs';
import podmanModule from '../../../backends/podman/adapter.cjs';
import manifest from '../../package.json' with { type: 'json' };

const VERSION = manifest.version;

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
  deliveryTargets: env.VAULT_DELIVERY_TARGETS ?? '',
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
  'For sign-in, name the entry and destination, focus its matching blank field, and use vault_deliver_credential instead of vault_get_credential. Wait for the user to approve each field. Keep recording and screen capture off during delivery. A receipt confirms typing only; verify the screen without exposing the value. Submit a routine login separately only when the user authorized it. Pause for human action on passkeys, MFA, CAPTCHA, security keys and unexpected consent or authentication screens. Resume only when the user has completed the step and the next screen is verified.',
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
  workspaceAdapter:null,
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

async function resolveDeliveryField(selected) {
  const vault = await getCli();
  const master = await masterPassword({file:settings.kdbx});
  const input = {file:settings.kdbx,entry:selected.entry,databasePassword:master.password};
  const listing = await vault.listEntries(input);
  if (listing.entries.filter(item=>item.path===selected.entry).length !== 1) throw new Error('The credential path did not resolve uniquely.');
  let record;
  try {
    record = selected.field === 'totp' ? {totp:(await vault.totp(input)).code}
      : await vault.showEntry({...input,showProtected:selected.field==='password'});
  } catch {
    throw new Error('Could not resolve the selected credential field.');
  }
  return validateCredentialField(record,selected.field);
}

async function deliveryFileIdentity(files) {
  return Promise.all(files.map(async file => {
    const info = await stat(file,{bigint:true}).catch(()=>null);
    if (!info?.isFile()) throw new Error('The configured vault or destination file is unavailable.');
    return [info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':');
  })).then(identities=>identities.join('|'));
}

async function deliverWithChatApproval(args,selected,extra) {
  if (!extra || cli.mode !== 'stdio' || !settings.deliveryTargets || settings.bridgeSocket) {
    throw new Error('Open VAMP Vault in VS Code to approve this delivery, or configure chat approval in a standalone Vault MCP.');
  }
  if (!server.server.getClientCapabilities()?.elicitation?.form) {
    throw new Error('This MCP client cannot show a credential delivery approval form.');
  }
  if (!settings.fallbackPassword || !settings.kdbx) throw new Error('Configure a local vault and unlock it in the standalone server environment.');
  let targets;
  try {
    if (settings.deliveryTargets.length > 65536) throw new Error();
    targets=JSON.parse(settings.deliveryTargets);
  } catch {
    throw new Error('VAULT_DELIVERY_TARGETS must contain a JSON object of configured destinations.');
  }
  if (!targets || typeof targets !== 'object' || Array.isArray(targets) || !Object.hasOwn(targets,args.destination)) {
    throw new Error('Choose a configured credential destination.');
  }
  const {entry,field,...config} = targets[args.destination] ?? {};
  if (entry !== selected.entry || field !== selected.field || /[\x00-\x1f\x7f]/.test(entry)) {
    throw new Error('The field does not match the configured destination.');
  }
  const target = deliveryTarget(args.destination,{[args.destination]:config},args.vm_id);
  if (target.guestVolume || (!target.executable && !target.containerId && (!target.vmId || !args.vm_id))) {
    throw new Error('Choose a configured login receiver and supply its VM UUID when targeting a VM.');
  }
  const files=[settings.kdbx,...(target.executable ? [target.executable] : [target.identityFile,target.knownHostsFile])];
  const before=await deliveryFileIdentity(files);
  const identity=target.executable ? `${target.executable} ${JSON.stringify(target.args)}`
    : `${target.user}@${target.host}:${target.port} · ${target.vmId || target.containerId}`;
  if (identity.length > 2000) throw new Error('The configured destination description is too long to approve.');
  let answer;
  try {
    answer=await server.server.elicitInput({
      mode:'form',
      message:`Send the ${field} for “${entry}” to “${args.destination}” (\n${identity}\n)? The receiver gets this field directly.`,
      requestedSchema:{type:'object',properties:{approve:{type:'boolean',title:'Approve credential delivery'}},required:['approve']},
    },{signal:extra.signal,timeout:120000,relatedRequestId:extra.requestId});
  } catch {
    throw new Error('Credential delivery approval did not complete.');
  }
  if (answer.action !== 'accept' || answer.content?.approve !== true) return {status:'denied'};
  extra.signal.throwIfAborted();
  if (await deliveryFileIdentity(files) !== before) throw new Error('The vault or destination files changed. Review the transfer again.');
  const value = await resolveDeliveryField(selected);
  if (await deliveryFileIdentity(files) !== before) throw new Error('The vault or destination files changed. Review the transfer again.');
  const receipt=await deliverCredential(target,value,field,extra.signal);
  console.error(JSON.stringify({action:'credential_delivered',approval:'mcp_elicitation',entry,field,destination:args.destination}));
  return receipt;
}

tool('vault_deliver_credential', {
  title: 'Send a credential to a configured VM or container',
  description: 'Request user approval for one field in VS Code or an elicitation-capable standalone MCP client. The configured receiver gets the field directly and the tool returns only a receipt.',
  inputSchema: {
    entry: z.string().min(1).max(1024).optional(),
    reference: z.string().min(1).max(1024).optional(),
    destination: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
    vm_id: z.string().uuid().optional(),
    field: z.enum(['username','password','totp']).optional(),
  },
}, async (args,extra) => {
  try {
    const selected = args.reference === undefined ? args : parseVaultPlaceholder(args.reference);
    if (!selected?.entry || !['username','password','totp'].includes(selected.field) ||
        (args.reference !== undefined && (args.entry !== undefined || args.field !== undefined))) {
      throw new Error('Choose one username, password or TOTP reference, or provide an entry and field.');
    }
    if (settings.remoteHost) {
      if (cli.mode !== 'call' || !cli.stdinPassword || args.vm_id) throw new Error('Use the approved remote Vault proxy for remote process delivery.');
      const destination = await remoteProcessTarget(args.destination);
      if (selected.entry !== destination.entry || selected.field !== destination.field) throw new Error('The field does not match the configured remote destination.');
      const value = await resolveDeliveryField(selected);
      await auditRemoteDelivery(destination.directory,{ action:'credential_resolved', caller:'vault_deliver_credential',
        entry:selected.entry, field:selected.field, destination:args.destination });
      return text(await deliverCredential(destination.target,value,selected.field));
    }
    const bridge = await getBridge();
    if (!bridge) return text(await deliverWithChatApproval(args,selected,extra));
    return text(await bridge.request('deliver-credential', {
      entry: selected.entry, field: selected.field, destination: args.destination, vmId: args.vm_id,
    },{timeout:180000}));
  } catch (error) {
    return failure(error);
  }
});

tool('vault_check_placeholders', {
  title: 'Check Vault placeholder paths',
  description: 'Check placeholder syntax, exact entry matches and requested field availability in the default vault. Returns paths, field names and statuses only. This does not approve delivery.',
  inputSchema: { references: z.array(z.string().max(1024)).min(1).max(50) },
}, async ({ references }) => {
  try {
    if (!(await fileExists(settings.kdbx))) throw new Error('No database path configured or database missing.');
    const cli = await getCli();
    const master = await masterPassword({ file: settings.kdbx });
    const listing = await cli.listEntries({ file: settings.kdbx, databasePassword: master.password });
    const checks = checkVaultPlaceholders(references, listing.entries);
    const checked = new Map();
    for (const check of checks) {
      if (check.status !== 'entry_found') continue;
      const key = JSON.stringify([check.entry, check.field]);
      if (!checked.has(key)) {
        try {
          const present = await cli.placeholderFieldPresent({
            file: settings.kdbx, entry: check.entry, field: check.field, databasePassword: master.password,
          });
          checked.set(key, present ? 'placeholder_resolved' : 'placeholder_unresolved');
        } catch {
          checked.set(key, 'field_check_unavailable');
        }
      }
      check.status = checked.get(key);
    }
    return text({ status: 'ok', checks });
  } catch (error) {
    return failure(error);
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

tool('vault_add_credential', {
  title: 'Add a credential by hand',
  description: 'Create one entry the user dictates: title (or group path plus title), username, password, URL and notes. Use this when the user asks to save a credential that is not in the vault yet. It never overwrites an existing entry; use vault_update_credential for that. The password is written to the database and never returned. TOTP seeds are added in the KeePassXC application.',
  inputSchema: {
    entry: z.string().min(1).describe('Entry title or path, e.g. github.com or Social/Naver'),
    username: z.string().optional().describe('Username or account identifier'),
    password: z.string().min(1).describe('Secret/password to store'),
    url: z.string().optional().describe('Target URL'),
    notes: z.string().optional().describe('Optional notes'),
    group: z.string().optional().default('/').describe('Group path in the vault'),
    file: z.string().optional().describe('Database path. Defaults to the configured vault.'),
  },
}, async args => {
  try {
    const cli = await getCli();
    if (!cli.hasKeepass) {
      return failure(new Error('keepassxc-cli is not installed or was not found. Run "VAMP Vault: Set Up KeePassXC and VeraCrypt" in VS Code.'), { code: 'keepassxc_missing' });
    }
    const file = args.file || settings.kdbx;
    if (!file) return failure(new Error('No database path configured.'), { code: 'path_required' });
    if (!(await fileExists(file))) return text({ status: 'no_database', file, hint: 'Create a vault first with vault_create or "VAMP Vault: Create Vault".' });
    const master = await masterPassword({ file });
    const parsed = splitEntryPath(args.entry);
    if (!parsed.entry) return failure(new Error('An entry title is required after the group path, e.g. Social/Naver.'), { code: 'entry_required' });
    const group = args.group && args.group !== '/' ? args.group.replace(/\/+$/, '') : parsed.group;
    const target = group ? `${group}/${parsed.entry}` : parsed.entry;
    const existing = await cli.listEntries({ file, databasePassword: master.password });
    if (existing.entries.some(item => item.path === target)) {
      return text({ status: 'exists', path: target, created: false, hint: 'Use vault_update_credential to change the fields of this entry.' });
    }
    const created = await cli.addEntry({
      file,
      entry: parsed.entry,
      group,
      username: args.username,
      secret: args.password,
      url: args.url,
      notes: args.notes,
      databasePassword: master.password,
    });
    cacheForget(created.path);
    return text({ status: 'created', ...created });
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

const groupPath = z.string().min(1).max(1024).refine(value =>
  value === '/' || value.split('/').every(part =>
    part && part.trim() === part && part !== '.' && part !== '..' && !/^-/u.test(part) && !/[\x00-\x1f]/u.test(part)));

tool('vault_list_groups', {
  title: 'List Vault groups',
  description: 'List group paths and direct and descendant credential counts, including empty groups. Returns no credential titles or values.',
  inputSchema: { confirm: z.boolean().default(false) },
}, async args => {
  try {
    const action = 'vault_list_groups';
    const detail = 'List group paths and credential counts in the default Vault.';
    const decision = await approve({ action, entry: '/', detail, confirm: args.confirm });
    if (decision.pending) return approvalNotice('/', detail);
    if (!decision.approved) return text({ status: 'denied' });
    const cli = await getCli();
    const file = settings.kdbx;
    const master = await masterPassword({ file });
    const listing = await cli.listEntries({ file, databasePassword: master.password });
    const groups = new Map();
    for (const group of listing.groups) {
      if (group === '/' || groups.has(group)) continue;
      const separator = group.lastIndexOf('/');
      const parent = separator < 0 ? '/' : group.slice(0, separator);
      groups.set(group, { path: group, parent, direct_entries: 0, total_entries: 0 });
    }
    for (const entry of listing.entries) {
      const group = groups.get(entry.group);
      if (!group) continue;
      group.direct_entries++;
      for (let ancestor = group; ancestor; ancestor = groups.get(ancestor.parent)) ancestor.total_entries++;
    }
    return text({ status: 'ok', groups: [...groups.values()] });
  } catch (error) {
    return failure(error);
  }
});

for (const action of ['vault_create_group', 'vault_move_credential']) {
  const move = action === 'vault_move_credential';
  tool(action, {
    title: move ? 'Move a credential to an existing group' : 'Create a credential group',
    description: 'Update the default KeePassXC vault after approval. Returns paths only.',
    inputSchema: { group: groupPath, ...(move ? { entry: groupPath } : {}), confirm: z.boolean().default(false) },
  }, async args => {
    try {
      if ((!move && args.group === '/') || (move && args.entry === '/')) throw new Error('Choose a non-root group or entry for this operation.');
      const detail = move ? `Move "${args.entry}" to "${args.group}".` : `Create the group "${args.group}".`;
      const entry = move ? `${args.entry} → ${args.group}` : args.group;
      const decision = await approve({ action, entry, detail, confirm: args.confirm });
      if (decision.pending) return approvalNotice(entry, detail);
      if (!decision.approved) return text({ status: 'denied' });
      const cli = await getCli();
      const master = await masterPassword({ file: settings.kdbx });
      const input = { file: settings.kdbx, group: args.group, databasePassword: master.password };
      if (move) return text({ status: 'moved', path: await cli.moveEntry({ ...input, entry: args.entry }) });
      await cli.ensureGroup(input);
      return text({ status: 'ok', group: args.group });
    } catch (error) {
      return failure(error);
    }
  });
}

tool('vault_rename_group', {
  title: 'Rename Vault group',
  description: 'Rename one existing group in place after approval. Requires the local KDBX Python editor.',
  inputSchema:{group:groupPath,name:groupPath.refine(value=>!value.includes('/')),confirm:z.boolean().default(false)},
},async args=>{
  try{
    if(args.group==='/')throw Error('Choose a non-root group.');
    const detail=`Rename "${args.group}" to "${args.name}".`;
    const decision=await approve({action:'rename_group',entry:detail,detail,confirm:args.confirm});
    if(decision.pending)return approvalNotice(args.group,detail);
    if(!decision.approved)return text({status:'denied'});
    const cli=await getCli();
    const master=await masterPassword({file:settings.kdbx});
    const report=await cli.renameGroup({file:settings.kdbx,group:args.group,name:args.name,databasePassword:master.password});
    scope.cache.clear();
    return text(report);
  }catch(error){return failure(error);}
});

tool('vault_delete_group', {
  title: 'Move a Vault group to the recycle bin',
  description: 'Move one group to the KeePassXC recycle bin. Non-empty groups require recursive confirmation.',
  inputSchema: { group: groupPath, recursive: z.boolean().default(false), confirm: z.boolean().default(false) },
}, async args => {
  try {
    if (args.group === '/') throw new Error('Choose a non-root group.');
    const detail = `Move "${args.group}"${args.recursive ? ' and all its contents' : ' if empty'} to the Vault recycle bin.`;
    if (!args.confirm) return text({ status: 'approval_required', group: args.group, detail });
    const decision = await approve({ action: 'delete_group', entry: detail, detail, confirm: true });
    if (!decision.approved) return text({ status: 'denied' });
    const cli = await getCli();
    const master = await masterPassword({ file: settings.kdbx });
    const result = await cli.recycleGroup({ file: settings.kdbx, group: args.group, recursive: args.recursive, databasePassword: master.password });
    scope.cache.clear();
    return text(result);
  } catch (error) {
    return failure(error);
  }
});

tool('vault_create_volume', {
  title: 'Create a managed encrypted volume',
  description: 'Create a VeraCrypt container or a fixed guest VHD with an encrypted block device on Linux or Windows via WSL. Store the generated password in KeePassXC after approval.',
  inputSchema: {
    volume: z.string().min(1).max(4096),
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    size_mb: z.number().int().min(8).max(32768).default(64),
    format: z.enum(['container', 'guest-vhd']).default('container'),
    confirm: z.boolean().default(false),
  },
}, async args => {
  try {
    if (process.platform !== 'linux' && (process.platform !== 'win32' || !process.env.VAULT_VERACRYPT_WSL_DISTRO)) {
      throw new Error('Managed volume creation requires Linux or VAULT_VERACRYPT_WSL_DISTRO on Windows.');
    }
    const detail = `Create ${args.volume} (${args.size_mb} MiB, ${args.format}) and store its credential as VeraCrypt/${args.name}.`;
    const decision = await approve({ action: 'create_volume', entry: detail, detail, confirm: args.confirm });
    if (decision.pending) return approvalNotice(args.volume, detail);
    if (!decision.approved) return text({ status: 'denied' });
    const cli = await getCli();
    const master = await masterPassword({ file: settings.kdbx });
    return text(await withVmVolumeState(() => createManagedVolume(cli, {
      file: settings.kdbx, volume: args.volume, name: args.name,
      sizeBytes: args.size_mb * 1024 * 1024, databasePassword: master.password, format: args.format,
    })));
  } catch (error) {
    return failure(error);
  }
});

tool('vault_delete_volume', {
  title: 'Delete a managed encrypted volume',
  description: 'On Linux or Windows with configured WSL, unmount one managed VeraCrypt file, remove its KeePassXC entry and delete the file after explicit confirmation.',
  inputSchema: {
    volume: z.string().min(1).max(4096),
    entry: z.string().regex(/^VeraCrypt\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    confirm: z.boolean().default(false),
  },
}, async args => {
  try {
    const wsl = process.platform === 'win32' && Boolean(process.env.VAULT_VERACRYPT_WSL_DISTRO);
    if (process.platform !== 'linux' && !wsl) throw new Error('Managed volume deletion requires Linux or configured WSL on Windows.');
    const location = wsl ? ` from WSL ${process.env.VAULT_VERACRYPT_WSL_DISTRO}` : '';
    const detail = `Unmount${location} and permanently remove the encrypted file ${args.volume} and remove the vault entry ${args.entry}.`;
    if (!args.confirm) return text({ status: 'approval_required', volume: args.volume, entry: args.entry, detail });
    const decision = await approve({ action: 'delete_volume', entry: detail, detail, confirm: true });
    if (decision.pending) return approvalNotice(args.volume, detail);
    if (!decision.approved) return text({ status: 'denied' });
    const cli = await getCli();
    const master = await masterPassword({ file: settings.kdbx });
    const remove = () => deleteManagedVolume(cli, {
      file: settings.kdbx, volume: args.volume, entry: args.entry, databasePassword: master.password,wsl,
    });
    const result = process.platform==='linux' || wsl ? await withVmVolumeState(async guard=>{
      await guard.assertDetached({volume:await realpath(args.volume)});
      return remove();
    }) : await remove();
    if (result.credential_removed) cacheForget(args.entry);
    return result.status === 'deleted' ? text(result) : { ...text(result), isError: true };
  } catch (error) {
    return failure(error);
  }
});

for (const operation of ['attach','detach']) tool(`vault_${operation}_vm`, {
  title: `${operation === 'attach' ? 'Attach' : 'Detach'} a VeraCrypt workspace disk`,
  description: 'Change a secondary disk slot of a powered-off VM. Supply a verified VeraCrypt mount and disk, or a managed guest VHD and its credential entry for Linux KVM or Windows Hyper-V and VirtualBox.',
  inputSchema: {
    vm: z.string().uuid(),
    volume: z.string().min(1).max(4096),
    mount_point: z.string().min(1).max(4096).optional(),
    credential_entry: z.string().regex(/^VeraCrypt\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
    backend: z.enum(['virtualbox','kvm','hyperv']).default('virtualbox'),
    controller: z.string().min(1).max(64).optional(),
    port: z.number().int().min(1).max(63).optional(),
    controller_number: z.number().int().min(0).max(3).optional(),
    target: z.string().regex(/^vd[b-z]$/).optional(),
    libvirt_uri: z.enum(['qemu:///session','qemu:///system']).optional(),
    disk: z.string().min(5).max(68).optional(),
    confirm: z.boolean().default(false),
  },
}, async args => {
  try {
    const wsl=process.platform==='win32' && args.backend!=='kvm' && Boolean(process.env.VAULT_VERACRYPT_WSL_DISTRO);
    const guestVhd=Boolean(args.credential_entry);
    const guestVhdSupported = args.backend==='kvm' ? process.platform==='linux' : process.platform==='win32';
    if (guestVhd ? (!guestVhdSupported || args.mount_point || args.disk)
        : (!args.mount_point || !args.disk)) {
      throw new Error('Specify a guest VHD credential entry for Linux KVM or Windows Hyper-V and VirtualBox, or both the mount point and disk filename.');
    }
    if (!guestVhd && (process.platform!=='linux' || args.backend==='hyperv') && !wsl) {
      throw new Error('Use VirtualBox or KVM on Linux, or VirtualBox or Hyper-V with configured WSL on Windows.');
    }
    const slot = args.backend==='kvm' ? `${args.libvirt_uri ?? 'qemu:///session'} target ${args.target ?? '(required)'}`
      : args.backend==='hyperv' ? `SCSI controller ${args.controller_number ?? 0}, slot ${args.port}` : `controller ${args.controller}, port ${args.port}`;
    const source=guestVhd ? `${args.volume} (${args.credential_entry})` : `${args.disk} in ${args.volume} mounted at ${args.mount_point}`;
    const detail=`${operation} ${source} on ${args.backend} VM ${args.vm}, ${slot}.`;
    if (!args.confirm) return text({status:'approval_required',vm:args.vm,detail});
    const decision=await approve({action:`workspace_${operation}`,entry:detail,detail,confirm:true});
    if(!decision.approved)return text({status:'denied'});
    const change = {kvm:kvmVolume,virtualbox:virtualBoxVolume,hyperv:hypervVolume}[args.backend];
    const cli=await getCli();
    const credentials=guestVhd ? {
      file:settings.kdbx, entry:args.credential_entry, databasePassword:(await masterPassword({file:settings.kdbx})).password,
    } : undefined;
    return text(await withVmVolumeState(guard=>change(cli,{
      operation,vm:args.vm,volume:args.volume,mountPoint:args.mount_point,controller:args.controller,port:args.port,disk:args.disk,
      target:args.target,uri:args.libvirt_uri,controllerNumber:args.controller_number,wsl,credentials,
    },{guard})));
  } catch (error) {
    if (error.code==='hyperv_access_denied') return failure(error,{status:'needs_elevation'});
    if (['hyperv_medium_unavailable','hyperv_local_medium_unavailable'].includes(error.code)) return failure(error,{status:error.code});
    return failure(error);
  }
});

tool('vault_attach_container', {
  title: 'Attach encrypted workspace to a Podman desktop',
  description: 'Check or attach one configured native Linux workspace to a new disposable, network-isolated Podman desktop. The volume must be mounted. Check first, then confirm the exact returned binding and approval ID.',
  inputSchema: {
    binding: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    approval_id: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    confirm: z.boolean().default(false),
  },
}, async args => {
  try {
    if (settings.remoteHost) throw new Error('Use the Podman tools on the workspace host for a remote Vault.');
    if (process.platform!=='linux') throw new Error('Vault container workspaces require a native Linux rootless Podman host.');
    const adapter=scope.workspaceAdapter ??= podmanModule.createPodmanAdapter();
    const connection='local-linux';
    if(!args.approval_id) {
      const {binding}=await adapter.check(connection);
      return text({connection,binding,...await adapter.workspaceStatus(connection,binding)});
    }
    if(!args.binding) throw new Error('Provide the exact connection binding returned by the workspace check.');
    const detail='Create a new network-isolated Podman desktop with write access to the configured VeraCrypt workspace.';
    if(!args.confirm)return text({status:'approval_required',detail});
    const decision=await approve({action:'attach_container',entry:args.approval_id,detail,confirm:true});
    if(!decision.approved)return text({status:'denied'});
    return text(await adapter.workspaceAttach(connection,args.binding,args.approval_id));
  } catch(error) { return failure(error); }
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
    credential_entry: z.string().regex(/^VeraCrypt\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
    confirm: z.boolean().default(false),
  },
}, async args => {
  try {
    const cli = await getCli();
    const wsl = process.platform === 'win32' && Boolean(args.credential_entry);
    if (!wsl && !cli.hasVeracrypt) return failure(new Error('The VeraCrypt CLI is not installed.'), { code: 'veracrypt_missing' });
    const volume = args.volume || settings.volume;
    if (!volume) return failure(new Error('No volume path configured.'), { code: 'path_required' });
    if (!(await fileExists(volume))) return text({ status: 'volume_missing', volume, hint: 'Create it with vault_create (volume_file) or the VeraCrypt application.' });
    if (args.credential_entry && process.platform !== 'linux' && !wsl) throw new Error('Mounting with a Vault credential on stdin requires Linux or WSL.');
    if (wsl && (!process.env.VAULT_VERACRYPT_WSL_DISTRO || !args.mount_point || args.pim || args.slot || args.key_files?.length)) {
      throw new Error('Configure the WSL distribution and specify its mount directory. Managed WSL mounts use the generated Vault password.');
    }
    const credential = args.credential_entry ? ` using ${args.credential_entry}` : '';
    const destination = wsl ? ` in WSL ${process.env.VAULT_VERACRYPT_WSL_DISTRO} at ${args.mount_point} (WSL root mount)` : '';
    const decision = await approve({ action: 'mount_volume', entry: volume + credential + destination, confirm: args.confirm, detail: `Mount ${volume}${args.read_only ? ' read-only' : ''}${credential}${destination}.` });
    if (decision.pending) return approvalNotice(volume, 'Mount this encrypted volume.');
    if (!decision.approved) return text({ status: 'denied', volume, reason: decision.how });
    let password;
    if (args.credential_entry) {
      const file = settings.kdbx;
      const master = await masterPassword({ file });
      const listing = await cli.listEntries({ file, databasePassword: master.password });
      if (listing.entries.filter(item => item.path === args.credential_entry).length !== 1) throw new Error('Choose one unique volume credential.');
      const record = await cli.showEntry({ file, entry: args.credential_entry, databasePassword: master.password });
      if (!record.password || record.url !== pathToFileURL(await realpath(volume)).href) {
        throw new Error('The vault entry is not bound to this encrypted volume.');
      }
      password = record.password;
    } else if (process.platform !== 'win32') {
      password = (await masterPassword({ file: volume, label: 'VeraCrypt volume password' })).password;
    }
    if (wsl) {
      const result = await cli.mountVolumeViaWsl({file:volume,mountPoint:args.mount_point,password,readOnly:args.read_only});
      return text({status:result.mounted?'mounted':'failed',approved_by:decision.how,...result});
    }
    const result = await cli.mountVolume({
      file: volume,
      mountPoint: args.mount_point || settings.mountPoint,
      password,
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
    if (process.platform==='win32' && args.mount_point?.startsWith('/') && !args.all) {
      const result=await withVmVolumeState(async guard=>{
        await guard.assertDetached({mountPoint:args.mount_point});
        return cli.unmountVolumeViaWsl(args.mount_point);
      });
      return text({status:result.unmounted?'unmounted':'failed',...result});
    }
    if (!cli.hasVeracrypt) return failure(new Error('The VeraCrypt CLI is not installed.'), { code: 'veracrypt_missing' });
    const mountPoint=args.mount_point || (args.all ? null : settings.mountPoint);
    const unmount=()=>cli.unmountVolume({mountPoint,all:args.all});
    const result=process.platform==='linux' ? await withVmVolumeState(async guard=>{
      const canonical=mountPoint&&!args.all ? await realpath(mountPoint).catch(error=>{
        if(error.code==='ENOENT')return mountPoint;
        throw error;
      }) : undefined;
      await guard.assertDetached({mountPoint:canonical});
      return unmount();
    }) : await unmount();
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
