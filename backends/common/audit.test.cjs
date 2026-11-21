'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { ledger, identity, observe, search, mark, profileFor } = require('./audit.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vamp-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = ledger('qa', root);
  return { root, store };
}
test('SQLite filters compose; exact name resolution, endpoint bounds and keyset paging', async (t) => {
  const { root, store } = fixture(t);
  const script_id = randomUUID(),
    run_id = randomUUID();
  const registry = path.join(root, 'registry');
  fs.mkdirSync(path.join(registry, script_id), { recursive: true });
  fs.writeFileSync(
    path.join(registry, script_id, 'rpa.json'),
    JSON.stringify({ id: script_id, name: '주문 내보내기' })
  );
  const e = {
    category: 'cli',
    source: 'mcp',
    script_id,
    agent_id: 'orders-agent',
    agent_basis: 'configured',
    run_id
  };
  store.record({ ...e, action: 'accept', outcome: 'queued' });
  store.record({ ...e, action: 'execute', outcome: 'verified' });
  store.record({ ...e, action: 'execute', outcome: 'verified' });
  store.record({
    ...e,
    run_id: randomUUID(),
    agent_id: 'another',
    action: 'preview',
    outcome: 'preview'
  });
  const all = await search(
    store,
    { script_name: '주문 내보내기', agent_id: 'orders-agent' },
    registry
  );
  assert.equal(all.events.length, 2);
  assert.equal(all.events[0].outcome, 'verified');
  assert.equal(
    store.search({ script_id, agent_id: 'orders-agent', group_runs: true }).events.length,
    1
  );
  assert.equal((await search(store, { script_name: 'missing' }, registry)).events.length, 0);
  const at = all.events[0].at;
  assert(
    store.search({ from: at, agent_id: 'orders-agent' }).events.some((e) => e.action === 'execute')
  );
  assert(!store.search({ from: '2020-01-01T00:00:00Z', to: at }).events.some((e) => e.at === at));
  const page = store.search({ limit: 1 });
  store.record({ ...e, run_id: randomUUID(), action: 'preview', outcome: 'preview' });
  const next = store.search({ snapshot_seq: page.snapshot_seq, before: page.next_before });
  assert(next.events.every((row) => row.seq < page.events[0].seq));
  assert.throws(() => store.search({ agent_id: "' OR 1=1" }));
  assert.throws(() => store.search({ from: 'today' }));
  assert.equal(ledger('other', root).coverage().events, 0);
});
test('records requests automatically, links trusted nested operations and omits sensitive values', async (t) => {
  const { root, store } = fixture(t);
  const secret = 'UNIQUE-PRIVATE-FIXTURE-733';
  await observe(
    store,
    { source: 'mcp', category: 'gui', action: 'replay', script_id: randomUUID(), ...identity() },
    async (run_id) => {
      await observe(
        store,
        { source: 'mcp', category: 'credential', action: 'delivery', run_id },
        async () => {
          mark(store, 'resolve', 'resolved');
          return { status: 'delivered', password: secret, destination: secret };
        }
      );
      return {
        content: [
          { type: 'text', text: JSON.stringify({ status: 'completed_unverified', inputs: secret }) }
        ]
      };
    }
  );
  const rows = ledger('qa', root).search().events;
  assert.equal(new Set(rows.map((e) => e.run_id)).size, 1);
  assert.equal(rows.length, 5);
  assert(rows.some((e) => e.outcome === 'resolved'));
  assert(!JSON.stringify(rows).includes(secret));
  const dbfile = path.join(root, 'qa', 'events.sqlite');
  assert.equal(fs.readFileSync(dbfile).subarray(0, 15).toString(), 'SQLite format 3');
  for (const f of fs.readdirSync(path.dirname(dbfile)))
    assert(!fs.readFileSync(path.join(path.dirname(dbfile), f)).includes(secret));
});
test('failed storage blocks dispatch and an interrupted CLI process is never redispatched', async (t) => {
  const { root, store } = fixture(t);
  let calls = 0;
  await assert.rejects(
    observe(
      {
        record() {
          throw Error('unavailable');
        }
      },
      {},
      () => {
        calls++;
      }
    )
  );
  assert.equal(calls, 0);
  const run_id = randomUUID();
  store.record({ category: 'cli', source: 'vsix', run_id, action: 'accept', outcome: 'queued' });
  const db = new DatabaseSync(path.join(root, 'qa', 'events.sqlite'));
  try {
    db.prepare('UPDATE cli_owners SET pid=? WHERE run_id=?').run(2147483647, run_id);
  } finally {
    db.close();
  }
  assert.equal(store.search({ run_id }).events[0].outcome, 'interrupted');
  assert.equal(store.search({ run_id }).events.length, 2);
});
test('configured identity, client claims and generated process identity are distinguishable', (t) => {
  const value = process.env.VAMP_AGENT_ID;
  t.after(() => {
    if (value === undefined) delete process.env.VAMP_AGENT_ID;
    else process.env.VAMP_AGENT_ID = value;
  });
  delete process.env.VAMP_AGENT_ID;
  assert.equal(identity().agent_basis, 'process_session');
  assert.equal(identity().agent_id, identity().agent_id);
  const extra = { _meta: { 'vamp/agent_id': 'claimed' } };
  assert.deepEqual(identity(extra), { agent_id: 'claimed', agent_basis: 'client_declared' });
  process.env.VAMP_AGENT_ID = 'bound';
  assert.deepEqual(identity(extra), { agent_id: 'bound', agent_basis: 'configured' });
});

test('a VS Code profile shares its audit log with its MCP registry and Vault', (t) => {
  const configured = process.env.VAMP_AUDIT_PROFILE;
  t.after(() => {
    if (configured === undefined) delete process.env.VAMP_AUDIT_PROFILE;
    else process.env.VAMP_AUDIT_PROFILE = configured;
  });
  delete process.env.VAMP_AUDIT_PROFILE;
  const base = path.join(os.tmpdir(), 'audit-profile-test');
  const main = path.join(base, 'wayfarer6.vamp-mcp-tools');
  const vault = path.join(base, 'wayfarer6.vamp-vault');
  assert.equal(profileFor(main), profileFor(vault));
  assert.equal(profileFor(main), profileFor(undefined, path.join(main, 'rpa-catalog')));
  assert.notEqual(profileFor(undefined, path.join(base, 'registry-a')), profileFor(undefined, path.join(base, 'registry-b')));
});
