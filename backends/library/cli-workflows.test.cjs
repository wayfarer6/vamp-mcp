'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { catalog, atomic, hash } = require('./cli-catalog.cjs');
const { runs } = require('./cli-runs.cjs');
const sample = require('../../examples/cli-workflows/order-python.json');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vamp-cli-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = catalog(path.join(root, 'catalog'), path.join(root, 'state'));
  const known = path.join(root, 'known-hosts');
  const identity = path.join(root, 'test-identity');
  await fs.writeFile(known, 'unit-test host identity');
  await fs.writeFile(identity, '');
  const target = {
    id: 'demo',
    backend: 'kvm',
    vm_id: randomUUID(),
    host: 'localhost',
    port: 22,
    user: 'worker',
    image: 'sha256:' + '2'.repeat(64),
    known_hosts: known,
    identity
  };
  await repo.bind(target);
  const { revision } = await repo.install(sample);
  const request = {
    id: sample.id,
    expected_revision: revision,
    workspace_id: 'demo',
    inputs: { order_id: 'ORD-1042', output_name: 'order.csv' }
  };
  return { root, repo, request, target };
}

const denied = (status) => (error) => error.status === status;
const confirmed = (request) => ({
  ...request,
  mode: 'run',
  confirmed: true,
  request_id: randomUUID()
});
const csv = Buffer.from('order_id,quantity\nORD-1042,12\n');
const good = {
  status: 'verified',
  exit_code: 0,
  checks: [{ name: 'row', passed: true }],
  artifact: { name: 'order.csv', data: csv.toString('base64') }
};
async function finished(service, id) {
  for (let i = 0; i < 200; i++) {
    const record = await service.status(id);
    if (!['running', 'queued'].includes(record.status)) return record;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error('Run did not terminate');
}

test('import, review and dependency updates are scoped to revision and workspace', async (t) => {
  const { root, repo, request, target } = await fixture(t);
  await repo.approve(sample.id, request.expected_revision, target.id);
  const copy = catalog(path.join(root, 'second'), path.join(root, 'state'));
  assert.equal(
    (await copy.install({ ...sample, reviewed: true })).revision,
    request.expected_revision
  );
  await copy.bind(target);
  assert.equal((await copy.details(await copy.snapshot(sample.id))).reviewed, false);
  const changed = structuredClone(sample);
  changed.files['requirements.lock'] = '# different dependency set\n';
  await assert.rejects(repo.install(changed), denied('revision_conflict'));
  await repo.install(changed, request.expected_revision);
  assert.equal((await repo.details(await repo.snapshot(sample.id))).reviewed, false);
  await assert.rejects(runs(repo).start(request), denied('revision_conflict'));
});

test('preview and rejected requests dispatch zero guest processes', async (t) => {
  const { repo, request, target, root } = await fixture(t);
  let calls = 0;
  const service = runs(repo, () => {
    calls++;
  });
  await assert.rejects(service.start(request), denied('needs_review'));
  await repo.approve(sample.id, request.expected_revision, target.id);
  assert.equal((await service.start(request)).status, 'preview');
  for (const inputs of [
    {},
    { ...request.inputs, extra: 'x' },
    { ...request.inputs, output_name: '../bad' },
    { ...request.inputs, output_name: 'CON.txt' }
  ])
    await assert.rejects(service.start({ ...confirmed(request), inputs }));
  await repo.bind({ ...target, id: 'other' });
  await assert.rejects(
    service.start({ ...confirmed(request), workspace_id: 'other' }),
    denied('needs_review')
  );
  await assert.rejects(service.start({ ...request, mode: 'run' }), denied('needs_confirmation'));
  const gui = randomUUID();
  await atomic(path.join(root, 'catalog', gui, 'rpa.json'), { id: gui, format: 'vamp-saved-rpa' });
  await assert.rejects(service.start({ ...request, id: gui }), denied('wrong_workflow_kind'));
  await fs.writeFile(target.known_hosts, 'rotated identity');
  const bound = await repo.binding(target.id);
  assert.notEqual(await fs.readFile(bound.known_hosts, 'utf8'), 'rotated identity');
  await repo.bind(target);
  await assert.rejects(service.start(request), denied('needs_review'));
  assert.equal(calls, 0);
});

test('concurrent runs claim an ID once and verify the local artifact', async (t) => {
  const { repo, request, target } = await fixture(t);
  let calls = 0;
  await repo.approve(sample.id, request.expected_revision, target.id);
  const service = runs(repo, async () => {
    calls++;
    return good;
  });
  const data = confirmed(request);
  const ids = await Promise.all(Array.from({ length: 6 }, () => service.start(data)));
  assert.equal(new Set(ids.map((r) => r.run_id)).size, 1);
  const id = ids[0].run_id;
  const record = await finished(service, id);
  assert.equal(record.status, 'verified');
  assert.equal(record.artifacts[0].sha256, hash(csv));
  assert.deepEqual(
    await fs.readFile(path.join(repo.state, 'runs', id, record.artifacts[0].ref)),
    csv
  );
  await assert.rejects(
    service.start({ ...data, inputs: { ...data.inputs, order_id: 'ORD-1043' } }),
    denied('request_conflict')
  );
  assert.equal((await runs(repo).start(data)).run_id, id);
  assert.equal(calls, 1);
  assert.equal((await fs.readdir(path.join(repo.state, 'runs'))).length, 1);
});

test('verification, failure, unverified completion and timeout retain distinct outcomes', async (t) => {
  const { repo, request, target } = await fixture(t);
  await repo.approve(sample.id, request.expected_revision, target.id);
  for (const [reply, expected] of [
    [{ status: 'completed_unverified', exit_code: 0 }, 'completed_unverified'],
    [{ status: 'timed_out', exit_code: 124 }, 'timed_out'],
    [{ status: 'failed', exit_code: 0, checks: [{ name: 'row', passed: false }] }, 'failed'],
    [{ ...good, checks: [] }, 'failed'],
    [{ ...good, artifact: undefined }, 'failed'],
    [{ ...good, artifact: { name: '../x', data: '' } }, 'failed']
  ]) {
    const service = runs(repo, async () => reply);
    const run = await service.start(confirmed(request));
    assert.equal((await finished(service, run.run_id)).status, expected);
  }
  const id = randomUUID();
  await atomic(path.join(repo.state, 'runs', id, 'status.json'), {
    run_id: id,
    status: 'running',
    owner: 2147483647
  });
  assert.equal((await runs(repo).status(id)).status, 'interrupted');
});
