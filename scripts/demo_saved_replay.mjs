import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Client } from '../third_party/mcp-virtualbox/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../third_party/mcp-virtualbox/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const [, , requestPath, mode] = process.argv;
const root = fileURLToPath(new URL('../', import.meta.url));
const client = new Client({ name: 'VAMP ERP showcase', version: '1.0.0' });
try {
  const requestText = await readFile(requestPath, 'utf8');
  const { id, vm_id, inputs = {} } = JSON.parse(requestText.replace(/^\uFEFF/, ''));
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  if (!uuid.test(id) || !uuid.test(vm_id) || !['--dryrun', '--confirm'].includes(mode)) {
    throw new Error('Supply saved RPA and VirtualBox VM UUIDs and choose --dryrun or --confirm.');
  }
  if (!process.env.VAMP_RPA_REGISTRY) throw new Error('Set VAMP_RPA_REGISTRY to the reviewed demo catalog.');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../backends/library/server.mjs', import.meta.url))],
    cwd: root,
    env: { ...process.env, RPA_REPLAY_PYTHON: process.env.VAMP_DEMO_PYTHON || process.env.RPA_REPLAY_PYTHON || 'python' },
    stderr: 'inherit',
  });
  await client.connect(transport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 620000 });
    if (result.isError) throw new Error(`MCP rejected ${name}.`);
    return JSON.parse(result.content[0].text);
  };
  const definition = await call('rpa_details', { id });
  if (definition.backend !== 'virtualbox' || definition.reviewed !== true) {
    throw new Error('Select a reviewed VirtualBox RPA from the demo catalog.');
  }
  const dry_run = mode === '--dryrun';
  const started = performance.now();
  const result = await call('rpa_run_saved', { id, vm_id, inputs, dry_run, confirmed: !dry_run });
  const { status, actions_completed } = result;
  console.log(JSON.stringify({ id, vm_id, dry_run, status, actions_completed,
    elapsed_seconds: Number(((performance.now() - started) / 1000).toFixed(3)) }, null, 2));
  if (status !== (dry_run ? 'validated' : 'completed_unverified')) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
