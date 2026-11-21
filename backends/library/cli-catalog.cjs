'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const git = require('node:util').promisify(execFile);
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const revision = /^[a-f0-9]{40}$/;
const workspace = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const filename = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
const hash = (data) => createHash('sha256').update(data).digest('hex');
function reject(status) {
  throw Object.assign(new Error(status), { status });
}
function check(ok, status) {
  if (!ok) reject(status);
}
function leaf(value) {
  return (
    typeof value === 'string' &&
    filename.test(value) &&
    !value.endsWith('.') &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  );
}
function normalize(p) {
  check(p?.format === 'vamp-cli-workflow' && uuid.test(p.id), 'invalid_package');
  const item = { format: p.format, id: p.id };
  for (const field of ['name', 'description', 'when_to_use', 'expected_result']) {
    check(
      typeof p[field] === 'string' && p[field].trim() && p[field].length <= 2000,
      'invalid_metadata'
    );
    item[field] = p[field];
  }
  check(
    Array.isArray(p.tags) &&
      p.tags.length <= 20 &&
      p.tags.every((t) => typeof t === 'string' && t.length <= 80),
    'invalid_tags'
  );
  check(
    Array.isArray(p.inputs) &&
      p.inputs.length <= 20 &&
      new Set(p.inputs).size === p.inputs.length &&
      p.inputs.every(
        (i) =>
          typeof i === 'string' &&
          /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(i) &&
          !['__proto__', 'constructor', 'prototype'].includes(i)
      ),
    'invalid_inputs'
  );
  check(['python', 'playwright'].includes(p.runner), 'invalid_runner');
  check(p.output_input === null || p.inputs.includes(p.output_input), 'invalid_output_input');
  const main = p.runner === 'python' ? 'main.py' : 'main.cjs';
  const lock = p.runner === 'python' ? 'requirements.lock' : 'package-lock.json';
  check(
    typeof p.files?.[main] === 'string' &&
      p.files[main].trim() &&
      typeof p.files[lock] === 'string',
    'missing_entrypoint_or_lock'
  );
  const files = Object.entries(p.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  check(
    files.length <= 24 &&
      files.every(([key, v]) => leaf(key) && key !== 'rpa.json' && typeof v === 'string') &&
      new Set(files.map(([k]) => k.toLowerCase())).size === files.length &&
      Buffer.byteLength(JSON.stringify(files)) <= 1024 * 1024,
    'invalid_files'
  );
  return {
    ...item,
    tags: p.tags,
    inputs: p.inputs,
    runner: p.runner,
    output_input: p.output_input,
    files: Object.fromEntries(files)
  };
}
async function read(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function atomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID();
  try {
    await fs.writeFile(temp, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
async function maybe(file) {
  try {
    return await read(file);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
function catalog(registry, stateBase = path.join(os.homedir(), '.vamp', 'cli-library')) {
  check(registry && path.isAbsolute(registry), 'needs_setup');
  const resolved = path.resolve(registry);
  const state = path.join(
    stateBase,
    hash(process.platform === 'win32' ? resolved.toLowerCase() : resolved).slice(0, 32)
  );
  const pointer = (id) => {
    check(uuid.test(id), 'invalid_id');
    return path.join(registry, id, 'rpa.json');
  };
  const bindingFile = (id) => {
    check(workspace.test(id), 'invalid_workspace');
    return path.join(state, 'workspaces', id + '.json');
  };
  async function install(source, expected) {
    const p = normalize(source);
    const folder = path.dirname(pointer(p.id));
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    // Unique claims let a restarted process discard dead owners without unlinking
    // another writer's lock. Contending imports can retry with the current revision.
    const claimName = '.cli-update-' + process.pid + '-' + randomUUID();
    const lock = path.join(folder, claimName);
    await fs.writeFile(lock, '', { flag: 'wx', mode: 0o600 });
    let staging;
    try {
      for (const entry of await fs.readdir(folder)) {
        const owner = /^\.cli-update-(\d+)-[a-f0-9-]{36}$/.exec(entry);
        if (!owner || entry === claimName) continue;
        try {
          process.kill(Number(owner[1]), 0);
        } catch (error) {
          if (error.code === 'ESRCH') {
            await fs.rm(path.join(folder, entry), { force: true });
            continue;
          }
          if (error.code !== 'EPERM') throw error;
        }
        reject('revision_conflict');
      }
      const prior = await maybe(pointer(p.id));
      check(!prior || prior.format === p.format, 'wrong_workflow_kind');
      const bytes = JSON.stringify(p) + '\n',
        digest = hash(bytes);
      if (prior?.digest === digest) {
        await snapshot(p.id);
        return prior;
      }
      check((prior?.revision ?? null) === (expected ?? null), 'revision_conflict');
      const snapshots = path.join(state, 'snapshots');
      await fs.mkdir(snapshots, { recursive: true, mode: 0o700 });
      staging = await fs.mkdtemp(path.join(snapshots, 'stage-'));
      await fs.writeFile(path.join(staging, 'workflow.json'), bytes);
      const options = {
        cwd: staging,
        windowsHide: true,
        timeout: 20000,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
          GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z'
        }
      };
      const run = (args) =>
        git(
          'git',
          [
            '-c',
            'core.autocrlf=false',
            '-c',
            'commit.gpgSign=false',
            '-c',
            'core.hooksPath=' + path.join(staging, '.no-hooks'),
            '-c',
            'user.name=VAMP',
            '-c',
            'user.email=library@localhost',
            ...args
          ],
          options
        );
      await run(['init', '-q']);
      await run(['add', '--', 'workflow.json']);
      await run(['commit', '-qm', 'Reviewed workflow candidate']);
      const rev = (await run(['rev-parse', 'HEAD'])).stdout.trim();
      check(revision.test(rev), 'invalid_revision');
      const target = path.join(snapshots, rev);
      try {
        await fs.rename(staging, target);
        staging = null;
      } catch (e) {
        if (hash(await fs.readFile(path.join(target, 'workflow.json'))) !== digest) throw e;
      }
      const { files, ...metadata } = p;
      const record = {
        ...metadata,
        revision: rev,
        digest,
        entrypoints: [{ name: 'run', file: p.runner === 'python' ? 'main.py' : 'main.cjs' }],
        version: rev.slice(0, 8)
      };
      await atomic(pointer(p.id), record);
      return record;
    } finally {
      try {
        if (staging) await fs.rm(staging, { recursive: true, force: true });
      } finally {
        await fs.rm(lock, { force: true });
      }
    }
  }
  async function snapshot(id) {
    const rec = await maybe(pointer(id));
    if (rec?.format !== 'vamp-cli-workflow') return null;
    check(rec.id === id && revision.test(rec.revision), 'revision_conflict');
    const bytes = await fs.readFile(path.join(state, 'snapshots', rec.revision, 'workflow.json'));
    check(hash(bytes) === rec.digest, 'revision_conflict');
    const pkg = normalize(JSON.parse(bytes));
    check(pkg.id === id, 'revision_conflict');
    return { pkg, digest: rec.digest, revision: rec.revision };
  }
  async function bind(b) {
    check(
      typeof b.id === 'string' &&
        workspace.test(b.id) &&
        leaf(b.id) &&
        uuid.test(b.vm_id) &&
        ['virtualbox', 'kvm', 'hyperv'].includes(b.backend),
      'invalid_workspace'
    );
    check(
      typeof b.host === 'string' &&
        /^[a-z0-9][a-z0-9.-]{0,252}$/i.test(b.host) &&
        typeof b.user === 'string' &&
        /^[a-z_][a-z0-9_-]{0,30}$/i.test(b.user) &&
        b.user !== 'root',
      'invalid_endpoint'
    );
    check(Number.isInteger(b.port) && b.port > 0 && b.port <= 65535, 'invalid_port');
    check(/^sha256:[0-9a-f]{64}$/.test(b.image), 'invalid_image');
    for (const file of [b.known_hosts, b.identity])
      check(
        typeof file === 'string' &&
          path.isAbsolute(file) &&
          !/["%\r\n]/.test(file) &&
          (await fs.lstat(file)).isFile(),
        'invalid_ssh_file'
      );
    const hostKeys = await fs.readFile(b.known_hosts);
    check(hostKeys.length > 0 && hostKeys.length <= 1024 * 1024, 'invalid_ssh_file');
    const pinned = path.join(state, 'host-keys', hash(hostKeys));
    await fs.mkdir(path.dirname(pinned), { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(pinned, hostKeys, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      check(hash(await fs.readFile(pinned)) === hash(hostKeys), 'invalid_ssh_file');
    }
    await atomic(bindingFile(b.id), {
      id: b.id,
      backend: b.backend,
      vm_id: b.vm_id,
      host: b.host,
      user: b.user,
      port: b.port,
      image: b.image,
      known_hosts: pinned,
      identity: b.identity
    });
  }
  async function binding(id) {
    const b = await maybe(bindingFile(id));
    check(b, 'workspace_unavailable');
    return b;
  }
  async function receipt(s, b) {
    const stamp = hash(
      JSON.stringify([s.revision, s.digest, b, hash(await fs.readFile(b.known_hosts))])
    );
    return path.join(state, 'reviews', s.pkg.id, stamp + '.json');
  }
  async function approve(id, expected, workspaceId) {
    const s = await snapshot(id);
    check(s && s.revision === expected, 'revision_conflict');
    const b = await binding(workspaceId);
    await atomic(await receipt(s, b), { approved: true });
  }
  async function workspaces() {
    const dir = path.join(state, 'workspaces');
    const names = await fs.readdir(dir).catch((e) => {
      if (e.code === 'ENOENT') return [];
      throw e;
    });
    return Promise.all(
      names.filter((n) => n.endsWith('.json')).map((n) => read(path.join(dir, n)))
    );
  }
  async function details(s) {
    const { files, ...meta } = s.pkg;
    const approved = [];
    for (const b of await workspaces())
      if (await maybe(await receipt(s, b)).catch(() => null))
        approved.push({ id: b.id, backend: b.backend, vm_id: b.vm_id });
    return {
      ...meta,
      title: meta.name,
      execution_kind: 'cli_based',
      revision: s.revision,
      verification: Object.hasOwn(files, 'verify.py') ? 'verify.py' : null,
      reviewed: approved.length > 0,
      workspaces: approved
    };
  }
  return { registry, state, install, snapshot, bind, binding, approve, receipt, workspaces, details };
}
module.exports = {
  catalog,
  normalize,
  check,
  reject,
  hash,
  read,
  atomic,
  maybe,
  uuid,
  revision,
  workspace,
  leaf
};
