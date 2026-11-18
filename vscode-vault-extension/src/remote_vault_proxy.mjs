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
const APPROVAL_TOOLS = new Set(['vault_get_credential', 'vault_delete_credential', 'vault_mount_volume']);
// vault_create is excluded: it makes its own password through the bridge below.
const PASSWORD_TOOLS = new Set([
  'vault_get_credential',
  'vault_list_credentials',
  'vault_set_credential',
  'vault_update_credential',
  'vault_delete_credential',
  'vault_mount_volume',
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

async function approve({ tool, entry, detail }) {
  if (approvalMode === 'off') return { approved: true, how: 'approval disabled' };
  const key = `${tool}|${entry ?? ''}`;
  if (approvalMode === 'per-session' && session.approved.has(key)) return { approved: true, how: 'already approved' };
  const bridge = await getBridge();
  if (!bridge) {
    return { approved: false, how: 'no approval dialog', unreachable: true };
  }
  try {
    const result = await bridge.approve({ action: tool, entry: entry ?? '', detail });
    if (!result.approved) return { approved: false, how: 'declined' };
    if (result.remember || approvalMode === 'per-session') session.approved.add(key);
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
    tools: tools.map(tool => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async request => {
  const tool = request.params?.name;
  const args = { ...(request.params?.arguments ?? {}) };
  try {
    await refreshPolicy();

    if (APPROVAL_TOOLS.has(tool)) {
      const subject = tool === 'vault_mount_volume' ? (args.volume || config.volumePath) : args.entry;
      const detail = tool === 'vault_get_credential'
        ? `Release ${(args.fields ?? ['username', 'password']).join(', ')} for "${args.entry}" from the vault on ${remoteVaultTarget(config)}.`
        : tool === 'vault_delete_credential'
          ? `Move "${args.entry}" to the recycle bin in the vault on ${remoteVaultTarget(config)}.`
          : `Mount ${subject} on ${remoteVaultTarget(config)}.`;
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
