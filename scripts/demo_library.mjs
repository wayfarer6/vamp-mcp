import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '../third_party/mcp-virtualbox/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../third_party/mcp-virtualbox/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const [, , step, requestPath, mode] = process.argv;
const root = fileURLToPath(new URL('../', import.meta.url));
const client = new Client({ name: 'VAMP ERP showcase', version: '1.0.0' });
try {
  const requestText = await readFile(requestPath, 'utf8');
  const request = JSON.parse(requestText.replace(/^\uFEFF/, ''));
  const { id, vm_id, inputs = {} } = request;
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  if (!uuid.test(id)) throw new Error('Supply a saved RPA UUID.');
  if (step === 'saved-replay' && (!uuid.test(vm_id) || !['--dryrun', '--confirm'].includes(mode)))
    throw new Error('Supply a VirtualBox VM UUID and choose --dryrun or --confirm.');
  const repairActions = { '--validate': 'validate', '--test': 'test', '--commit': 'test-and-commit' };
  const action = repairActions[mode];
  if (step !== 'saved-replay' && (step !== 'repair' || !action))
    throw new Error('Select a saved replay or a repair mode.');
  if (!process.env.VAMP_RPA_REGISTRY) throw new Error('Set VAMP_RPA_REGISTRY to the reviewed demo catalog.');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../backends/library/server.mjs', import.meta.url))],
    cwd: root,
    env: { ...process.env, RPA_REPLAY_PYTHON: process.env.VAMP_DEMO_PYTHON || process.env.RPA_REPLAY_PYTHON || 'python',
      RPA_HOST_PYTHON: process.env.VAMP_DEMO_PYTHON || process.env.RPA_HOST_PYTHON || 'python' },
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
  if (step === 'repair') {
    const { source_file, expected_commit, scratch_vm, outcome_text, test_inputs } = request;
    if (typeof source_file !== 'string' || !/^[0-9a-f]{40}$/.test(expected_commit)) {
      throw new Error('Supply source_file and the exact expected_commit.');
    }
    const source = await readFile(resolve(dirname(requestPath), source_file), 'utf8');
    const result = await call('rpa_revision', { id, action, source, expected_commit,
      scratch_vm, outcome_text, test_inputs, confirmed: action !== 'validate' });
    const { status, committed, commit, guest_verified, modal_check_verified, artifact_verified, run_id,
      verification_stage, source_sha256 } = result;
    console.log(JSON.stringify({ id, action, status, committed, commit, guest_verified, modal_check_verified,
      artifact_verified, run_id, verification_stage, source_sha256 }, null, 2));
    const expected = { validate: 'static_validation_passed', test: 'scratch_screen_verified',
      'test-and-commit': 'verified_commit_needs_review' };
    if (status !== expected[action]) process.exitCode = 1;
  } else {
    const dry_run = mode === '--dryrun';
    const started = performance.now();
    const result = await call('rpa_run_saved', { id, vm_id, inputs, dry_run, confirmed: !dry_run });
    const { status, actions_completed } = result;
    console.log(JSON.stringify({ id, vm_id, dry_run, status, actions_completed,
      elapsed_seconds: Number(((performance.now() - started) / 1000).toFixed(3)) }, null, 2));
    if (status !== (dry_run ? 'validated' : 'completed_unverified')) process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
