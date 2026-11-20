#!/usr/bin/env node
// VAMP Remote Hypervisor MCP server (stdio).
//
// Runs on the machine that owns the hypervisor and is normally started by an
// SSH client, so an agent anywhere can drive KVM or VirtualBox desktops
// without opening a hypervisor port or copying guest credentials off the host.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolveConfig, parseArgs } from './config.mjs';
import { createTools, VERSION } from './tools.mjs';
import { registerRemoteTools as registerTools, registerLocalKvmTools } from './register.mjs';
import { registerPythonTools } from './python-bridge.mjs';

export const SERVER_NAME = 'vamp-remote';
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export const remoteInstructions = [
  'When authoring or repairing GUI RPAs, include task-specific local OCR/YOLO verification in Python and assert its result in Robot by default; add artifact checks when available. Input dispatch or an arbitrary detection alone is not success.',
  'Token efficiency: run reusable RPA and outcome checks locally; on success return compact status, verification and evidence paths. Do not forward full OCR text, YOLO arrays, unchanged screenshots, base64 images, full logs or source into the model context by default. For failure, ambiguity, UI changes or requested inspection, read only a targeted region/query/page first. Local OCR/YOLO reduces model tokens only when outputs stay local or compact; do not claim a measured saving without a comparable benchmark.',
  'This server controls virtual desktops on the host that runs it, reached over SSH. Only screenshots are available - there is no live screen stream, so take a new screenshot for a new frame.',
  'Work in this order: remote_env_check to see whether the host is usable, remote_vm_list to find a desktop, remote_vm_status for detail, then remote_vm_screenshot before acting.',
  'A started VM is not a booted guest: verify with a screenshot. A hypervisor state of running does not prove an application finished loading.',
  'remote_vm_stop asks the guest to shut down; force=true powers it off and can lose unsaved work, so use it only on an explicit instruction.',
  'remote_vm_mouse_click takes fractions of the guest screen (0-1), matching the last screenshot. KVM guests need an absolute pointing device. VirtualBox mouse input needs --repo and a Python runtime with the matching SDK.',
  'remote_rpa_run executes a reviewed saved VAMP RPA and changes the guest; ask the user first and pass confirmed=true only after authorization.',
  'Secrets stay on the host. Never request, echo or store guest passwords in tool output, and do not paste credentials into text fields unless the user asked for exactly that.',
].join(' ');
const INSTRUCTIONS = remoteInstructions;

export function registerRemoteTools(server, options={}) {
  const remote=registerTools(server,{...options,run:options.run||createRunner()});
  const local=registerLocalKvmTools(server,{...options,run:options.run||createRunner()});
  const python=registerPythonTools(server,options);
  return {names:[...remote.names,...local.names,...python.names]};
}


export function createRunner() {
  return (exe, args, { timeoutMs = 30000, input } = {}) => new Promise((resolve, reject) => {
    const child = execFile(exe, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
    child.on('error', () => {});
    if (input !== undefined) child.stdin.end(String(input));
    else child.stdin.end();
  });
}

/** JSON-RPC dispatcher for MCP over stdio. Returns null when no reply is due. */
export function createMcpHandler({ tools, version = VERSION, instructions = INSTRUCTIONS, serverName = SERVER_NAME, audit }) {
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  return async function handle(message) {
    if (!message || typeof message !== 'object') return null;
    const { id, method, params } = message;
    const reply = result => ({ jsonrpc: '2.0', id, result });
    const failure = (code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } });
    if (typeof method !== 'string') return failure(-32600, 'Invalid Request');
    if (method.startsWith('notifications/')) return null;
    if (method === 'initialize') {
      const requested = params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: serverName, version },
        instructions,
      });
    }
    if (method === 'ping') return reply({});
    if (method === 'tools/list') {
      return reply({
        tools: tools.map(tool => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: { readOnlyHint: ['remote_env_check', 'remote_vm_list', 'remote_vm_status', 'remote_vm_screenshot'].includes(tool.name) },
        })),
      });
    }
    if (method === 'resources/list') return reply({ resources: [] });
    if (method === 'prompts/list') return reply({ prompts: [] });
    if (method === 'tools/call') {
      const name = params?.name;
      const tool = byName.get(name);
      if (!tool) {
        return reply({ content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: 'Unknown remote tool.' }) }], isError: true });
      }
      const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      try {
        const output = await tool.handler(args);
        const content = [];
        if (output && output.text !== undefined) content.push({ type: 'text', text: JSON.stringify(output.text) });
        for (const image of output?.images ?? []) content.push({ type: 'image', data: image.data, mimeType: image.mimeType });
        if (!content.length) content.push({ type: 'text', text: JSON.stringify(output) });
        await audit?.(tool.name, (output?.text ?? output)?.status === 'error' ? 'error' : 'returned');
        return reply({ content });
      } catch (error) {
        await audit?.(tool.name, 'error');
        return reply({ content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: String(error?.message || error) }) }], isError: true });
      }
    }
    return failure(-32601, `Method not found: ${method}`);
  };
}

function toolAudit(directory) {
  let warned = false;
  return async (tool, outcome) => {
    try {
      const uid = process.getuid();
      await mkdir(directory, { recursive:true, mode:0o700 });
      const parent = await lstat(directory);
      if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o022)) throw Error('Unsafe audit directory');
      const file = await open(path.join(directory,'tool-audit.jsonl'),
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.uid !== uid || info.nlink !== 1 || (info.mode & 0o077)) throw Error('Unsafe audit file');
        await file.writeFile(JSON.stringify({at:new Date().toISOString(),tool,outcome})+'\n');
      } finally {
        await file.close();
      }
    } catch {
      if (!warned) process.stderr.write('vamp-remote: private tool audit unavailable\n');
      warned = true;
    }
  };
}

function write(stdout, value) {
  stdout.write(`${JSON.stringify(value)}\n`);
}

export async function serveStdio({ tools, stdin = process.stdin, stdout = process.stdout, instructions, audit } = {}) {
  const handle = createMcpHandler({ tools, instructions, audit });
  const lines = createInterface({ input: stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();
  lines.on('line', line => {
    const text = line.trim();
    if (!text) return;
    queue = queue.then(async () => {
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        write(stdout, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      const batch = Array.isArray(payload) ? payload : [payload];
      const replies = [];
      for (const message of batch) {
        const result = await handle(message);
        if (result) replies.push(result);
      }
      if (!replies.length) return;
      write(stdout, Array.isArray(payload) ? replies : replies[0]);
    }).catch(error => {
      process.stderr.write(`vamp-remote: ${error?.stack || error}\n`);
    });
  });
  await new Promise(resolve => lines.on('close', resolve));
  await queue;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write([
      'VAMP Remote Hypervisor MCP server',
      '',
      'Usage: node server.mjs [options] [--call TOOL] [--args JSON]',
      '',
      'Options:',
      '  --backend kvm|virtualbox   Hypervisor to control (default kvm)',
      '  --libvirt-uri URI          libvirt connection (default qemu:///system)',
      '  --python PATH              Python for RPA replay (default python3)',
      '  --repo PATH                VAMP checkout on this host, for RPA replay',
      '  --registry PATH            Saved RPA registry folder',
      '  --vboxmanage PATH          VBoxManage executable',
      '  --workdir PATH             Server work directory (default ~/.vamp/remote)',
      '  --call TOOL                Run one tool and print JSON, then exit',
      '  --args JSON                Arguments for --call',
      '  --tools                    List tool names',
      '  --version                  Print the server version',
      '',
      'Without --call the server speaks MCP JSON-RPC over stdin/stdout.',
    ].join('\n') + '\n');
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const config = resolveConfig({ argv });
  const tools = createTools({ run: createRunner(), config });
  if (args.tools) {
    process.stdout.write(`${tools.tools.map(tool => tool.name).join('\n')}\n`);
    return 0;
  }
  if (args.call) {
    const name = String(args.call);
    const tool = tools.tools.find(item => item.name === name);
    if (!tool) {
      process.stdout.write(`${JSON.stringify({ status: 'error', message: `Unknown tool "${name}".` })}\n`);
      return 2;
    }
    let payload = {};
    if (typeof args.args === 'string') {
      try {
        payload = JSON.parse(args.args);
      } catch {
        process.stdout.write(`${JSON.stringify({ status: 'error', message: '--args is not valid JSON.' })}\n`);
        return 2;
      }
    }
    try {
      const output = await tool.handler(payload && typeof payload === 'object' ? payload : {});
      const body = output && output.text !== undefined ? { ...output.text } : { ...output };
      if (output?.images?.length) body.images = output.images;
      process.stdout.write(`${JSON.stringify(body)}\n`);
      return body.status === 'error' ? 1 : 0;
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ status: 'error', message: String(error?.message || error) })}\n`);
      return 1;
    }
  }
  const { default: windowsAdmin } = await import('../common/windows-admin.cjs');
  await windowsAdmin.requireAdministrator();
  // Warm this host's OCR/YOLO workers before the first tool call; the workers
  // are detached, so stdio and the MCP handshake are never delayed. A host that
  // runs this server without the VAMP repository simply logs the skip.
  try {
    const { default: visionPreload } = await import('../common/vision-preload.cjs');
    const vision = visionPreload.ensureVisionServices({runtime: process.env.VAMP_REMOTE_REPO || fileURLToPath(new URL('../..', import.meta.url)),logger: message => process.stderr.write(`${message}\n`)});
    if (vision.status === 'started') process.stderr.write(`vamp-remote: vision workers starting (pid ${vision.pid})\n`);
    else if (vision.status === 'unavailable') process.stderr.write(`vamp-remote: vision workers unavailable: ${vision.reason}\n`);
  } catch (error) {
    process.stderr.write(`vamp-remote: vision preload skipped: ${error?.message || error}\n`);
  }
  await serveStdio({ tools: tools.tools, audit: config.backend === 'kvm' && process.platform === 'linux' ? toolAudit(config.workdir) : undefined });
  return 0;
}

if (process.argv[1] && ['remote_ssh','remote'].includes(path.basename(path.dirname(fileURLToPath(import.meta.url)))) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`vamp-remote: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
