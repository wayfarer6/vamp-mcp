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
  if (step === 'saved-replay' && (!uuid.test(vm_id) ||
      !['--dryrun', '--confirm', '--confirm-expect-blocked'].includes(mode)))
    throw new Error('Supply a VirtualBox VM UUID and choose --dryrun, --confirm, or --confirm-expect-blocked.');
  const expectRejected = mode === '--test-expect-rejected';
  const repairActions = { '--validate': 'validate', '--test': 'test', '--commit': 'test-and-commit',
    '--test-expect-rejected': 'test' };
  const action = repairActions[mode];
  if (step !== 'saved-replay' && (step !== 'repair' || !action))
    throw new Error('Select a saved replay or a repair mode.');
  if (!process.env.VAMP_RPA_REGISTRY) throw new Error('Set VAMP_RPA_REGISTRY to the reviewed demo catalog.');
  const installedCli = process.env.VAMP_DEMO_MCP_CLI;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: installedCli
      ? [resolve(installedCli), 'library']
      : [fileURLToPath(new URL('../backends/library/server.mjs', import.meta.url))],
    cwd: root,
    env: { ...process.env, RPA_REPLAY_PYTHON: process.env.VAMP_DEMO_PYTHON || process.env.RPA_REPLAY_PYTHON || 'python',
      RPA_HOST_PYTHON: process.env.VAMP_DEMO_PYTHON || process.env.RPA_HOST_PYTHON || 'python' },
    stderr: 'inherit',
  });
  await client.connect(transport, installedCli ? { timeout: 150000 } : undefined);
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
    const { source_file, expected_commit, scratch_vm, outcome_text, test_inputs, start_text } = request;
    if (typeof source_file !== 'string' || !/^[0-9a-f]{40}$/.test(expected_commit)) {
      throw new Error('Supply source_file and the exact expected_commit.');
    }
    const source = await readFile(resolve(dirname(requestPath), source_file), 'utf8');
    const before = await call('rpa_revision', { id, action: 'status' });
    const started = performance.now();
    const result = await call('rpa_revision', { id, action, source, expected_commit,
      scratch_vm, outcome_text, test_inputs, start_text, confirmed: action !== 'validate' });
    const elapsed_seconds = Number(((performance.now() - started) / 1000).toFixed(3));
    const after = await call('rpa_revision', { id, action: 'status' });
    const { status, committed, commit, guest_verified, modal_check_verified, artifact_verified, run_id,
      verification_stage, source_sha256, ocr_comparison } = result;
    const head_before = before.latest_commit;
    const head_after = after.latest_commit;
    const commitId = /^[0-9a-f]{40}$/;
    const head_verified = commitId.test(head_before) && commitId.test(head_after) && (committed === true
      ? head_before === expected_commit && head_after === commit && head_after !== head_before
      : head_before === head_after);
    console.log(JSON.stringify({ id, action, status, committed, commit, guest_verified, modal_check_verified,
      artifact_verified, run_id, verification_stage, source_sha256, ocr_comparison, head_before, head_after,
      head_verified, elapsed_seconds }, null, 2));
    const expected = { validate: 'static_validation_passed', test: 'scratch_screen_verified',
      'test-and-commit': 'verified_commit_needs_review' };
    const rejected = status === 'error' && committed === false && verification_stage === 'screen_replay'
      && ocr_comparison?.expected_occurrences === 1 && ocr_comparison.observed_occurrences === 0
      && head_before === expected_commit;
    if (!head_verified || (expectRejected ? !rejected : status !== expected[action])) process.exitCode = 1;
  } else {
    const dry_run = mode === '--dryrun';
    const expectBlocked = mode === '--confirm-expect-blocked';
    const expected_source_sha256 = process.env.VAMP_DEMO_EXPECTED_SOURCE_SHA256;
    const started = performance.now();
    const result = await call('rpa_run_saved', { id, vm_id, inputs, dry_run, confirmed: !dry_run, expected_source_sha256 });
    const { status, actions_completed, message } = result;
    console.log(JSON.stringify({ id, vm_id, dry_run, status, actions_completed,
      ...(status === 'error' && typeof message === 'string' ? { message } : {}),
      ...(expectBlocked ? { expected_status: 'starting_screen_blocked', expected_actions_completed: 0 } : {}),
      elapsed_seconds: Number(((performance.now() - started) / 1000).toFixed(3)) }, null, 2));
    if (expectBlocked) {
      if (status !== 'starting_screen_blocked' || actions_completed !== 0) process.exitCode = 1;
    } else if (status !== (dry_run ? 'validated' : 'completed_unverified')) {
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
