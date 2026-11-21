'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { AsyncLocalStorage } = require('node:async_hooks');
const scope = new AsyncLocalStorage();
const categories = ['gui', 'cli', 'mount', 'credential', 'hypervisor'];
const sources = ['mcp', 'vsix', 'remote'];
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const label = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const outcomes = new Set(
  'requested preview queued running verified completed_unverified failed error denied cancelled timed_out interrupted volume_missing setup_required vault_locked committed_needs_review completed rejected needs_review needs_setup needs_review_or_confirmation needs_confirmation invalid_inputs revision_conflict request_conflict workspace_unavailable awaiting_approval approval_required pending returned ok mounted unmounted delivered resolved copied revealed cached unknown'.split(
    ' '
  )
);
const schema = [
  'CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, at TEXT NOT NULL, category TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL, source TEXT NOT NULL, script_id TEXT, revision TEXT, agent_id TEXT, agent_basis TEXT, run_id TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS cli_owners (run_id TEXT PRIMARY KEY, pid INTEGER NOT NULL)',
  ...['at', 'script_id', 'agent_id', 'run_id'].map(
    (k) => 'CREATE INDEX IF NOT EXISTS events_' + k + ' ON events (' + k + ', seq)'
  )
];
// Older Node/Electron releases can use the same SQLite format via Python's standard library.
const python = [
  'import json, sqlite3, sys',
  'p=json.load(sys.stdin)',
  'db=sqlite3.connect(p["file"],timeout=5)',
  'db.row_factory=sqlite3.Row',
  'db.execute("PRAGMA journal_mode=WAL")',
  'with db:',
  '    for s in p["schema"]: db.execute(s)',
  '    for sql,args in p["writes"]: db.execute(sql,args)',
  '    rows=[dict(r) for r in db.execute(p["query"],p["args"])] if p["query"] else []',
  'db.close()',
  'print(json.dumps(rows))'
].join('\n');

function profileFor(storage, registry = process.env.VAMP_RPA_REGISTRY) {
  if (process.env.VAMP_AUDIT_PROFILE) {
    if (!label.test(process.env.VAMP_AUDIT_PROFILE)) throw Error('Invalid VAMP_AUDIT_PROFILE');
    return process.env.VAMP_AUDIT_PROFILE;
  }
  let root;
  if (storage) root=path.resolve(storage,'..');
  else if(registry) {
    const resolved=path.resolve(registry);
    const parent=path.dirname(resolved);
    const extension=/^wayfarer6\.vamp-(?:mcp-tools|vault)$/i.test(path.basename(parent));
    root=extension && path.basename(resolved)==='rpa-catalog'?path.dirname(parent):resolved;
  } else return 'default';
  if (process.platform === 'win32') root = root.toLowerCase();
  return 'profile-' + createHash('sha256').update(root).digest('hex').slice(0, 24);
}
const sessionAgent = randomUUID();
function identity(extra) {
  const configured = process.env.VAMP_AGENT_ID;
  const declared = extra?._meta?.['vamp/agent_id'];
  if (configured && label.test(configured))
    return { agent_id: configured, agent_basis: 'configured' };
  if (typeof declared === 'string' && label.test(declared))
    return { agent_id: declared, agent_basis: 'client_declared' };
  return { agent_id: sessionAgent, agent_basis: 'process_session' };
}
function timestamp(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/i.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw Error('Use an ISO timestamp with a time zone');
  return new Date(value).toISOString();
}
function ledger(
  profile = profileFor(),
  base = process.env.VAMP_AUDIT_DIR || path.join(os.homedir(), '.vamp', 'audit')
) {
  if (
    !label.test(profile) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(profile) ||
    profile.endsWith('.')
  )
    throw Error('Invalid audit profile');
  const dir = path.join(base, profile);
  const file = path.join(dir, 'events.sqlite');
  function sql(writes = [], query = null, args = []) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const info = fs.lstatSync(dir);
    if (
      !info.isDirectory() ||
      (process.getuid && (info.uid !== process.getuid() || info.mode & 0o077))
    )
      throw Error('Audit directory must be private');
    try {
      fs.closeSync(fs.openSync(file, 'wx', 0o600));
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const st = fs.lstatSync(file);
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      (process.getuid && (st.uid !== process.getuid() || st.mode & 0o077))
    )
      throw Error('Unsafe audit database');
    let sqlite;
    try {
      sqlite = require('node:sqlite');
    } catch (error) {
      if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE' && error.code !== 'MODULE_NOT_FOUND')
        throw error;
    }
    if (!sqlite?.DatabaseSync) {
      const cmd = process.platform === 'win32' ? 'python' : 'python3';
      const child = spawnSync(cmd, ['-I', '-c', python], {
        input: JSON.stringify({ file, schema, writes, query, args }),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 12000,
        maxBuffer: 1024 * 1024
      });
      if (child.status !== 0)
        throw Error('Audit storage unavailable. Use Node with SQLite or install Python 3.');
      return JSON.parse(child.stdout);
    }
    const db = new sqlite.DatabaseSync(file);
    try {
      db.exec('PRAGMA busy_timeout=5000');
      db.exec('PRAGMA journal_mode=WAL');
      for (const statement of schema) db.exec(statement);
      if (writes.length) {
        db.exec('BEGIN IMMEDIATE');
        for (const [statement, values] of writes) db.prepare(statement).run(...values);
        db.exec('COMMIT');
      }
      return query ? db.prepare(query).all(...args) : [];
    } finally {
      db.close();
    }
  }
  function record(e) {
    if (
      !categories.includes(e.category) ||
      !sources.includes(e.source) ||
      !label.test(e.action) ||
      !uuid.test(e.run_id)
    )
      throw Error('Invalid audit event');
    const now = new Date();
    const eventId = (uuid.test(e.operation_id) ? e.operation_id : e.run_id) + ':' + e.action;
    const cutoff = new Date(+now - 30 * 86400000).toISOString();
    const data = [
      eventId,
      now.toISOString(),
      e.category,
      e.action,
      outcomes.has(e.outcome) ? e.outcome : 'unknown',
      e.source,
      uuid.test(e.script_id) ? e.script_id.toLowerCase() : null,
      /^[a-f0-9]{40}$/i.test(e.revision) ? e.revision : null,
      typeof e.agent_id === 'string' && label.test(e.agent_id) ? e.agent_id : null,
      ['configured', 'client_declared', 'process_session'].includes(e.agent_basis)
        ? e.agent_basis
        : null,
      e.run_id
    ];
    const writes = [['DELETE FROM events WHERE at < ?', [cutoff]]];
    if (e.category === 'cli' && e.action === 'accept')
      writes.push(['INSERT OR IGNORE INTO cli_owners VALUES(?,?)', [e.run_id, process.pid]]);
    if (e.category === 'cli' && e.action === 'execute')
      writes.push(['DELETE FROM cli_owners WHERE run_id=?', [e.run_id]]);
    writes.push([
      'INSERT INTO events(event_id,at,category,action,outcome,source,script_id,revision,agent_id,agent_basis,run_id) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING',
      data
    ]);
    sql(writes);
  }
  function reconcile() {
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    const owners = sql(
      [
        ['DELETE FROM events WHERE at < ?', [cutoff]],
        [
          'DELETE FROM cli_owners WHERE NOT EXISTS (SELECT 1 FROM events WHERE events.run_id=cli_owners.run_id)',
          []
        ]
      ],
      "SELECT e.*, o.pid FROM cli_owners o JOIN events e ON e.run_id=o.run_id AND e.action='accept'"
    );
    for (const row of owners) {
      try {
        process.kill(row.pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') record({ ...row, action: 'execute', outcome: 'interrupted' });
      }
    }
  }
  function search(f = {}, detail = false, scriptIds) {
    reconcile();
    const since = f.from
      ? timestamp(f.from)
      : new Date(Date.now() - (detail ? 30 : 1) * 86400000).toISOString();
    const end = f.to ? timestamp(f.to) : null;
    if (end && since >= end) throw Error('Start time must precede end time');
    const where = ['at >= ?', 'at >= ?'],
      args = [since, new Date(Date.now() - 30 * 86400000).toISOString()];
    if (end) {
      where.push('at < ?');
      args.push(end);
    }
    for (const [k, valid] of Object.entries({
      script_id: (v) => uuid.test(v),
      agent_id: (v) => label.test(v),
      run_id: (v) => uuid.test(v),
      category: (v) => categories.includes(v),
      outcome: (v) => outcomes.has(v)
    })) {
      if (f[k] === undefined || f[k] === '') continue;
      if (typeof f[k] !== 'string' || !valid(f[k])) throw Error('Invalid filter ' + k);
      where.push(k + ' = ?');
      args.push(['script_id', 'run_id'].includes(k) ? f[k].toLowerCase() : f[k]);
    }
    if (scriptIds) {
      const ids = scriptIds.filter((id) => uuid.test(id)).slice(0, 2000);
      where.push(ids.length ? 'script_id IN (' + ids.map(() => '?').join(',') + ')' : '0');
      args.push(...ids);
    }
    const limit = f.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('Limit must be 1–100');
    const high = f.snapshot_seq ?? sql([], 'SELECT COALESCE(MAX(seq),0) AS n FROM events')[0].n;
    if (!Number.isSafeInteger(high) || high < 0) throw Error('Invalid snapshot');
    where.push('seq <= ?');
    args.push(high);
    let predicate = where.join(' AND ');
    if (f.group_runs === true)
      predicate = 'seq IN (SELECT MAX(seq) FROM events WHERE ' + predicate + ' GROUP BY run_id)';
    if (f.before !== undefined) {
      if (!Number.isSafeInteger(f.before) || f.before < 1) throw Error('Invalid page cursor');
      predicate += ' AND seq < ?';
      args.push(f.before);
    }
    const rows = sql([], 'SELECT * FROM events WHERE ' + predicate + ' ORDER BY seq DESC LIMIT ?', [
      ...args,
      limit + 1
    ]);
    const more = rows.length > limit;
    if (more) rows.pop();
    return {
      profile,
      snapshot_seq: high,
      events: rows,
      next_before: more ? rows.at(-1).seq : null
    };
  }
  function coverage() {
    reconcile();
    const row = sql(
      [],
      'SELECT MIN(at) AS first_event, MAX(at) AS latest_event, COUNT(*) AS events FROM events WHERE at >= ?',
      [new Date(Date.now() - 30 * 86400000).toISOString()]
    )[0];
    return { profile, retention_days: 30, ...row };
  }
  return { record, search, coverage };
}

// Preserve the observed result if the post-action write fails. The durable request
// then remains visible as unresolved and callers do not repeat the operation.
function finish(store, event) {
  try {
    store.record(event);
  } catch {
    console.error('VAMP audit: outcome could not be persisted for operation ' + event.run_id);
  }
}
async function observe(store, fields, fn) {
  const operation_id = randomUUID();
  const run_id = uuid.test(fields.run_id) ? fields.run_id : operation_id;
  const base = { ...fields, run_id, operation_id };
  store.record({ ...base, action: fields.action + '_request', outcome: 'requested' });
  let response;
  try {
    response = await scope.run(base, () => fn(run_id));
  } catch (error) {
    finish(store, { ...base, action: fields.action, outcome: 'error' });
    throw error;
  }
  let value = response;
  if (response?.content?.[0]?.type === 'text') {
    try {
      value = JSON.parse(response.content[0].text);
    } catch {
      value = {};
    }
  }
  const outcome = response?.isError
    ? 'error'
    : value?.cached === true
      ? 'cached'
      : value?.status || 'returned';
  finish(store, { ...base, action: fields.action, outcome });
  return response;
}
async function scripts(registry) {
  if (!registry) return [];
  let dirs;
  try {
    dirs = await fs.promises.readdir(registry, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const result = [];
  for (const dir of dirs.filter((d) => d.isDirectory() && uuid.test(d.name)).slice(0, 2000)) {
    const file = path.join(registry, dir.name, 'rpa.json');
    try {
      const stat = await fs.promises.lstat(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) continue;
      const item = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      if (item.id === dir.name && typeof item.name === 'string')
        result.push({ id: item.id, name: item.name });
    } catch {
      /* A concurrently removed or invalid catalog item has no display name. */
    }
  }
  return result;
}
async function search(store, filters, registry) {
  let ids;
  if (filters.script_name) {
    if (typeof filters.script_name !== 'string' || filters.script_name.length > 250)
      throw Error('Invalid script name');
    if (!registry)
      throw Error('Script name lookup requires a configured RPA registry. Use script_id.');
    ids = (await scripts(registry))
      .filter((s) => s.name.toLowerCase() === filters.script_name.toLowerCase())
      .map((s) => s.id);
  }
  return store.search(filters, false, ids);
}
function querySchema(z) {
  return {
    from: z.string().max(40).optional(),
    to: z.string().max(40).optional(),
    script_id: z.string().uuid().optional(),
    script_name: z.string().max(250).optional(),
    agent_id: z.string().max(64).optional(),
    run_id: z.string().uuid().optional(),
    category: z.enum(categories).optional(),
    outcome: z.string().max(48).optional(),
    before: z.number().int().positive().optional(),
    snapshot_seq: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(100).optional()
  };
}
function correlation(context = scope.getStore()) {
  if (!context || !uuid.test(context.run_id)) return {};
  return {
    run_id: context.run_id,
    script_id: uuid.test(context.script_id) ? context.script_id : undefined,
    agent_id:
      typeof context.agent_id === 'string' && label.test(context.agent_id)
        ? context.agent_id
        : undefined,
    agent_basis: ['configured', 'client_declared', 'process_session'].includes(context.agent_basis)
      ? context.agent_basis
      : undefined
  };
}
function mark(store, action, outcome, category) {
  const base = scope.getStore();
  if (base) store.record({ ...base, category: category || base.category, action, outcome });
}
module.exports = {
  correlation,
  mark,
  ledger,
  profileFor,
  identity,
  finish,
  observe,
  categories,
  scripts,
  search,
  querySchema
};
