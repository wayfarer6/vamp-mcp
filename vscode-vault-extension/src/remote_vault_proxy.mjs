// VAMP Vault (Remote) — the MCP server VS Code starts for one remote host.
//
// It answers the agent with the vault that lives on that host, and it keeps the
// two things that must stay on this computer here: the master password (VS Code
// secret storage) and the approval dialogs. Each tool call travels to the host
// as one SSH command; the password rides on that command's standard input, so it
// never appears in a process list, a shell history or a file on either machine.
//
// Nothing is mirrored: there is no copy of the remote database here, and the
// local vault is never read for a remote call.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseVaultPlaceholder } from './placeholders.mjs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BridgeClient, BridgeUnavailable } from './bridge_client.mjs';
import {
  normalizeRemoteVaultConfig,
  RemoteVaultClient,
  remoteVaultId,
  remoteVaultLabel,
  remoteVaultTarget,
} from './remote_vault_client.mjs';

import manifest from '../package.json' with { type: 'json' };

const VERSION = process.env.VAULT_REMOTE_VERSION || manifest.version;

function parseArgs(argv) {
  const out = {};
  const keys = {
    '--host': 'host',
    '--port': 'port',
    '--username': 'username',
    '--identity': 'privateKeyPath',
    '--node': 'remoteNodePath',
    '--kdbx': 'kdbxPath',
    '--volume': 'volumePath',
    '--mount': 'mountPoint',
    '--approval-mode': 'approvalMode',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = keys[argv[index]];
    if (!key) continue;
    out[key] = argv[index + 1];
    index += 1;
  }
  return out;
}

const config = normalizeRemoteVaultConfig({ ...parseArgs(process.argv.slice(2)), enabled: true });
const vaultId = remoteVaultId(config);
const label = remoteVaultLabel(config);
const approvalMode = config.approvalMode;
const client = new RemoteVaultClient(config);

// Tools whose answer contains a secret, or that change the database, need the
// user's yes on this computer before anything is sent.
const APPROVAL_TOOLS = new Set(['vault_get_credential', 'vault_delete_credential', 'vault_mount_volume',
  'vault_create_group', 'vault_delete_group', 'vault_list_groups', 'vault_move_credential', 'vault_create_volume',
  'vault_delete_volume', 'vault_attach_vm', 'vault_detach_vm','vault_rename_group']);
// vault_create is excluded: it makes its own password through the bridge below.
const PASSWORD_TOOLS = new Set([
  'vault_get_credential',
  'vault_list_credentials',
  'vault_set_credential',
  'vault_update_credential',
  'vault_delete_credential',
  'vault_mount_volume',
  'vault_check_placeholders',
  'vault_create_group',
  'vault_delete_group',
  'vault_rename_group',
  'vault_list_groups',
  'vault_move_credential',
  'vault_create_volume',
  'vault_delete_volume',
]);

const session = {
  bridge: null,
  bridgeClosed: false,
  approved: new Set(),
  revision: null,
  unlocked: true,
  tools: null,
};

const log = message => process.stderr.write(`vamp vault remote: ${message}\n`);

async function getBridge() {
  if (session.bridge) return session.bridge;
  if (session.bridgeClosed) return null;
  try {
    session.bridge = await BridgeClient.connect({
      socketPath: process.env.VAULT_BRIDGE_SOCKET,
      token: process.env.VAULT_BRIDGE_TOKEN,
    });
    return session.bridge;
  } catch (error) {
    if (!(error instanceof BridgeUnavailable)) log(`bridge: ${error.message}`);
    session.bridgeClosed = true;
    return null;
  }
}

/** Ask the extension for the live policy: approval mode, lock state, revision. */
async function refreshPolicy() {
  const bridge = await getBridge();
  if (!bridge) return null;
  try {
    const live = await bridge.request('state', { kdbx: vaultId }, { timeout: 6000 });
    if (session.revision !== live.revision || !live.unlocked) session.approved.clear();
    session.revision = live.revision;
    session.unlocked = Boolean(live.unlocked);
    return live;
  } catch (error) {
    log(`policy: ${error.message}`);
    return null;
  }
}

async function approve({ tool, entry, detail, always = false }) {
  if (!always && approvalMode === 'off') return { approved: true, how: 'approval disabled' };
  const key = `${tool}|${entry ?? ''}`;
  if (!always && approvalMode === 'per-session' && session.approved.has(key)) return { approved: true, how: 'already approved' };
  const bridge = await getBridge();
  if (!bridge) {
    return { approved: false, how: 'no approval dialog', unreachable: true };
  }
  try {
    const result = await bridge.approve({ action: tool, entry: entry ?? '', detail });
    if (!result.approved) return { approved: false, how: 'declined' };
    if (!always && (result.remember || approvalMode === 'per-session')) session.approved.add(key);
    return { approved: true, how: 'approved in VS Code' };
  } catch (error) {
    log(`approve: ${error.message}`);
    return { approved: false, how: 'no approval dialog', unreachable: true };
  }
}

async function masterPassword({ create = false } = {}) {
  const bridge = await getBridge();
  if (!bridge) {
    throw new Error('VS Code is not reachable, so the remote vault master password cannot be read. Unlock the remote vault in VS Code first.');
  }
  const result = create
    ? await bridge.newPassword({ purpose: 'master', label: `New master password for ${label}`, kdbx: vaultId })
    : await bridge.unlock(vaultId);
  if (result?.cancelled || !result?.password) {
    const error = new Error(`The ${create ? 'new ' : ''}master password for ${remoteVaultTarget(config)} was not provided.`);
    error.code = 'user_cancelled';
    throw error;
  }
  return result.password;
}

async function loadTools() {
  if (session.tools) return session.tools;
  const candidates = [];
  if (process.env.VAULT_REMOTE_MANIFEST) candidates.push(process.env.VAULT_REMOTE_MANIFEST);
  try {
    candidates.push(fileURLToPath(new URL('./vault_tools.json', import.meta.url)));
  } catch {}
  for (const file of candidates) {
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (Array.isArray(data.tools) && data.tools.length) {
        session.tools = data.tools;
        return session.tools;
      }
    } catch {
      // try the next source
    }
  }
  session.tools = await client.listTools();
  return session.tools;
}

function textResult(payload, { isError = false } = {}) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) };
}

const server = new Server(
  { name: label, version: VERSION },
  {
    capabilities: { tools: {} },
    instructions: [
      `This is the vault of the remote host ${remoteVaultTarget(config)}.`,
      'Its entries exist only on that host: they are not the entries of the local VAMP Vault, and nothing is copied or synced between the two.',
      'Read a secret only when the current step of the task needs it, one entry at a time, and never repeat it in a summary, log or file.',
      'The user approves each read on their own computer before the request leaves it.',
    ].join(' '),
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = await loadTools();
  return {
    tools: tools.filter(tool => tool.name !== 'vault_attach_container').map(tool => ({
      name: tool.name,
      title: tool.title,
      description: tool.name === 'vault_deliver_credential'
        ? 'Ask the local VS Code user to approve a remote Vault field. The remote host resolves it and sends it to a configured local process on that host.'
        : tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request, {signal}) => {
  const tool = request.params?.name;
  const args = { ...(request.params?.arguments ?? {}) };
  try {
    if (tool === 'vault_deliver_credential') {
      const selected = args.reference === undefined ? args : parseVaultPlaceholder(args.reference);
      if (!selected?.entry || typeof selected.entry !== 'string' || selected.entry.length > 1024 || /[\x00-\x1f\x7f]/.test(selected.entry) ||
          !['username','password','totp'].includes(selected.field) || typeof args.destination !== 'string' ||
          !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(args.destination) || args.vm_id !== undefined ||
          (args.reference !== undefined && (args.entry !== undefined || args.field !== undefined))) {
        throw new Error('Choose one remote credential field and configured process destination.');
      }
      const detail = `Send the ${selected.field} for "${selected.entry}" to the configured process "${args.destination}" on ${remoteVaultTarget(config)}.`;
      const approval = await approve({tool,entry:selected.entry,detail,always:true});
      if (approval.unreachable) throw new Error('Open the remote Vault in VS Code to approve this delivery.');
      if (!approval.approved) return textResult({status:'denied'});
      signal?.throwIfAborted();
      const password = await masterPassword();
      signal?.throwIfAborted();
      const result = await client.call(tool,{entry:selected.entry,field:selected.field,destination:args.destination},{password}).catch(()=>null);
      if (result?.status !== 'delivered' || result.destination !== args.destination) {
        throw new Error('Remote delivery failed. Check the configured entry, process, and audit on the Vault host.');
      }
      return textResult({status:'delivered',destination:args.destination});
    }
    if (tool === 'vault_attach_container') throw new Error('Use the Podman tools on the workspace host for a remote Vault.');
    await refreshPolicy();

    if (tool === 'vault_delete_group' && args.confirm !== true) {
      return textResult({status:'approval_required',group:args.group,message:'Confirm moving this group to the recycle bin before retrying.'});
    }
    if (tool === 'vault_delete_volume' && args.confirm !== true) {
      return textResult({ status: 'approval_required', volume: args.volume, entry: args.entry,
        message: 'Confirm removal of this encrypted volume and vault entry before retrying.' });
    }
    if ((tool === 'vault_attach_vm' || tool === 'vault_detach_vm') && args.confirm !== true) {
      return textResult({status:'approval_required',vm:args.vm,message:'Confirm the exact workspace disk and VM slot before retrying.'});
    }
    if (APPROVAL_TOOLS.has(tool)) {
      const subject = tool === 'vault_mount_volume' ? `${args.volume || config.volumePath}${args.read_only ? ' (read-only)' : ''}${args.credential_entry ? ` using ${args.credential_entry}` : ''}`
        : tool === 'vault_create_group' ? args.group
        : tool === 'vault_rename_group' ? `Rename "${args.group}" to "${args.name}"`
        : tool === 'vault_delete_group' ? `Move "${args.group}"${args.recursive ? ' and all its contents' : ' if empty'} to the recycle bin`
        : tool === 'vault_list_groups' ? 'the default Vault group paths and credential counts'
        : tool === 'vault_move_credential' ? `${args.entry} → ${args.group}`
        : tool === 'vault_create_volume' ? `${args.volume} (${args.size_mb ?? 64} MiB, ${args.format ?? 'container'}) for agent ${args.owner_agent_id} → VeraCrypt/${args.name}`
        : tool === 'vault_delete_volume' ? `${args.volume} and its vault entry ${args.entry}`
        : tool === 'vault_attach_vm' || tool === 'vault_detach_vm'
          ? `${args.credential_entry ? `${args.volume} (${args.credential_entry})` : `${args.disk} in ${args.volume} mounted at ${args.mount_point}`}, ${args.backend ?? 'virtualbox'} VM ${args.vm}, ${
            args.backend==='kvm' ? `${args.libvirt_uri ?? 'qemu:///session'} target ${args.target}`
              : args.backend==='hyperv' ? `SCSI controller ${args.controller_number ?? 0}, slot ${args.port}` : `controller ${args.controller}, port ${args.port}`}`
          : args.entry;
      const detail = tool === 'vault_get_credential'
        ? `Release ${(args.fields ?? ['username', 'password']).join(', ')} for "${args.entry}" from the vault on ${remoteVaultTarget(config)}.`
        : tool === 'vault_delete_credential'
          ? `Move "${args.entry}" to the recycle bin in the vault on ${remoteVaultTarget(config)}.`
          : tool === 'vault_mount_volume'
            ? `Mount ${subject} on ${remoteVaultTarget(config)}.`
            : tool === 'vault_delete_volume'
              ? `Unmount and permanently remove ${subject} on ${remoteVaultTarget(config)}.`
              : `${tool}: ${subject} on ${remoteVaultTarget(config)}.`;
      const decision = await approve({ tool, entry: subject, detail });
      if (decision.unreachable) {
        return textResult({
          status: 'error',
          error: 'No approval dialog is reachable, so nothing was sent to the remote host. Open VS Code with the VAMP Vault extension running and try again.',
          code: 'approval_unavailable',
        }, { isError: true });
      }
      if (!decision.approved) {
        return textResult({ status: 'denied', tool, entry: subject ?? null, reason: 'the user declined in VS Code' });
      }
      args.confirm = true;
    }

    let password;
    if (PASSWORD_TOOLS.has(tool)) password = await masterPassword();
    else if (tool === 'vault_create' && !args.master_password) password = await masterPassword({ create: true });

    const result = await client.call(tool, args, { password });
    return textResult(result);
  } catch (error) {
    if (error?.code === 'user_cancelled') return textResult({ status: 'denied', tool, reason: error.message });
    log(`${tool}: ${error.message}`);
    return textResult({ status: 'error', error: error?.message ?? String(error), tool }, { isError: true });
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
log(`serving ${label} (${config.kdbxPath})`);

const shutdown = () => {
  session.bridge?.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
