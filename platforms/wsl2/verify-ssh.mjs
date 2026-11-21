import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Client } from '../../third_party/mcp-virtualbox/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../third_party/mcp-virtualbox/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const [destination, output, ...arguments_] = process.argv.slice(2);
const separator = arguments_.indexOf('--');
const sshArgs = separator < 0 ? arguments_ : arguments_.slice(0, separator);
const remoteCommand = separator < 0 ? [] : arguments_.slice(separator + 1);
if (!destination || !output || !sshArgs.length) {
  throw new Error('Usage: node verify-ssh.mjs <ssh-alias> <new-result-file> <ssh-options...>');
}

const client = new Client({name:'VAMP worker verification',version:'1.0.0'});
const transport = new StdioClientTransport({
  command: 'ssh',
  args: ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', ...sshArgs, destination, ...remoteCommand],
  env: process.env,
  stderr: 'pipe',
});
transport.stderr.on('data', chunk => process.stderr.write(chunk));
try {
  await client.connect(transport, {timeout:120000});
  const {tools} = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['worker_run', 'worker_status']);
  async function call(name, args = {}) {
    const response = await client.callTool({name, arguments:args}, undefined, {timeout:60000});
    assert.ok(!response.isError);
    return response.structuredContent ?? JSON.parse(response.content[0].text);
  }
  const status = await call('worker_status');
  assert.equal(status.status, 'ready');
  assert.notEqual(status.uid, 0);
  const denied = await call('worker_run', {scenario:'headless_gui_smoke'});
  assert.equal(denied.status, 'confirmation_required');
  const result = await call('worker_run', {scenario:'headless_gui_smoke', confirmed:true});
  assert.equal(result.status, 'verified', JSON.stringify(result));
  const artifact = Buffer.from(result.artifact.data, 'base64');
  assert.equal(createHash('sha256').update(artifact).digest('hex'), result.artifact.sha256);
  assert.equal(artifact.toString('utf8'), 'VAMP WSL GUI check\n');
  await writeFile(output, artifact, {flag:'wx'});
  console.log(JSON.stringify({status, denied:denied.status, result:result.status, artifact_sha256:result.artifact.sha256}));
} finally {
  await client.close();
}
