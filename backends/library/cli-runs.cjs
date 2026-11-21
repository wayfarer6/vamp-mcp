'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const audit = require('../common/audit.cjs');
const { randomUUID } = require('node:crypto');
const { check, hash, read, atomic, maybe, uuid, leaf } = require('./cli-catalog.cjs');

function sendGuest(b, payload) {
  const ssh =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot, 'System32', 'OpenSSH', 'ssh.exe')
      : '/usr/bin/ssh';
  const args = [
    '-F',
    'none',
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'GlobalKnownHostsFile=none',
    '-o',
    'UserKnownHostsFile="' + b.known_hosts.replaceAll('\\', '/') + '"',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'IdentityAgent=none',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'ConnectTimeout=8',
    '-p',
    String(b.port),
    '-i',
    b.identity,
    '--',
    b.user + '@' + b.host,
    '/usr/bin/python3 -I /usr/local/lib/vamp/cli_worker.py'
  ];
  return new Promise((resolve, reject) => {
    const child = execFile(
      ssh,
      args,
      { timeout: 150000, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 3 * 1024 * 1024 },
      (err, stdout) => {
        if (err)
          return reject(
            Object.assign(Error('Guest connection failed'), {
              status: err.killed ? 'timed_out' : 'workspace_unavailable'
            })
          );
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(Error('Invalid guest response'));
        }
      }
    );
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}
function runs(cat, dispatch = sendGuest, options = {}) {
  const store = options.store || audit.ledger(audit.profileFor(undefined,cat.registry));
  const source = options.source || 'mcp';
  function fields(a, id) {
    return {category:'cli', source, script_id:a.id, revision:a.expected_revision, run_id:id, ...options.actor};
  }
  const folder = (id) => {
    check(uuid.test(id), 'invalid_run_id');
    return path.join(cat.state, 'runs', id);
  };
  async function prepare(a) {
    const s = await cat.snapshot(a.id);
    check(s, 'wrong_workflow_kind');
    check(s.revision === a.expected_revision, 'revision_conflict');
    const b = await cat.binding(a.workspace_id);
    check(await maybe(await cat.receipt(s, b)), 'needs_review');
    const values = a.inputs;
    check(
      values &&
        typeof values === 'object' &&
        !Array.isArray(values) &&
        Object.keys(values).length === s.pkg.inputs.length &&
        s.pkg.inputs.every(
          (k) =>
            Object.hasOwn(values, k) && typeof values[k] === 'string' && values[k].length <= 10000
        ),
      'invalid_inputs'
    );
    const name = s.pkg.output_input === null ? null : values[s.pkg.output_input];
    check(name === null || leaf(name), 'invalid_output_name');
    return { s, b, values: Object.fromEntries(s.pkg.inputs.map((k) => [k, values[k]])), name };
  }
  async function status(id) {
    const directory = folder(id);
    const record =
      (await maybe(path.join(directory, 'result.json'))) ||
      (await maybe(path.join(directory, 'running.json'))) ||
      (await maybe(path.join(directory, 'status.json')));
    check(record, 'unknown_run');
    const { owner, ...result } = record;
    if (['queued', 'running'].includes(result.status)) {
      try {
        process.kill(owner, 0);
      } catch (e) {
        if (e.code === 'ESRCH') result.status = 'interrupted';
      }
    }
    return result;
  }
  async function execute(a, id) {
    const dir = folder(id),
      file = path.join(dir, 'result.json');
    const base = {
      run_id: id,
      workspace_id: a.workspace_id,
      id: a.id,
      revision: a.expected_revision
    };
    try {
      const { s, b, values, name } = await prepare(a);
      await atomic(path.join(dir, 'running.json'), {
        ...base,
        status: 'running',
        owner: process.pid
      });
      const out = await dispatch(b, {
        backend: b.backend,
        vm_id: b.vm_id,
        image: b.image,
        workspace_id: b.id,
        workflow: s.pkg,
        inputs: values
      });
      check(
        ['verified', 'completed_unverified', 'failed', 'timed_out'].includes(out.status),
        'invalid_guest_response'
      );
      const checks = out.checks ?? [];
      check(
        Array.isArray(checks) &&
          checks.length <= 64 &&
          checks.every(
            (c) =>
              typeof c.name === 'string' &&
              /^[a-zA-Z0-9_.-]{1,80}$/.test(c.name) &&
              typeof c.passed === 'boolean'
          ),
        'invalid_checks'
      );
      check(
        out.status !== 'verified' ||
          (Object.hasOwn(s.pkg.files, 'verify.py') &&
            out.exit_code === 0 &&
            checks.length &&
            checks.every((c) => c.passed)),
        'invalid_verification'
      );
      const artifacts = [];
      if (out.artifact !== undefined) {
        check(
          name &&
            out.artifact.name === name &&
            typeof out.artifact.data === 'string' &&
            out.artifact.data.length <= 1400000,
          'invalid_artifact'
        );
        const bytes = Buffer.from(out.artifact.data, 'base64');
        check(
          bytes.length <= 1024 * 1024 && bytes.toString('base64') === out.artifact.data,
          'invalid_artifact'
        );
        await fs.mkdir(path.join(dir, 'outputs'), { mode: 0o700 });
        await fs.writeFile(path.join(dir, 'outputs', name), bytes, { flag: 'wx', mode: 0o600 });
        artifacts.push({ name, ref: 'outputs/' + name, sha256: hash(bytes) });
      }
      check(out.status !== 'verified' || !name || artifacts.length, 'missing_artifact');
      const code = Number.isInteger(out.exit_code) ? out.exit_code : null;
      await atomic(file, { ...base, status: out.status, exit_code: code, checks, artifacts });
      audit.finish(store,{...fields(a,id),action:'execute',outcome:out.status});
    } catch (e) {
      await atomic(file, {
        ...base,
        status: e.status === 'timed_out' ? 'timed_out' : 'failed',
        reason: e.status || 'execution_failed'
      });
      audit.finish(store,{...fields(a,id),action:'execute',outcome:e.status==='timed_out'?'timed_out':'failed'});
    }
  }
  async function start(a) {
    const attempt = randomUUID();
    let prepared;
    try { prepared = await prepare(a); }
    catch(error) {
      store.record({...fields(a,attempt),action:'request',outcome:error.status||'error'});
      throw error;
    }
    const { s, b, values, name } = prepared;
    if ((a.mode ?? 'preview') === 'preview') {
      store.record({...fields(a,attempt),action:'preview',outcome:'preview'});
      return {
        status: 'preview',
        id: s.pkg.id,
        revision: s.revision,
        workspace_id: b.id,
        vm_id: b.vm_id,
        backend: b.backend,
        runner: s.pkg.runner,
        outputs: name ? [name] : []
      };
    }
    if(!(a.mode==='run' && a.confirmed===true && uuid.test(a.request_id))){
      store.record({...fields(a,attempt),action:'request',outcome:'needs_confirmation'});
    }
    check(
      a.mode === 'run' && a.confirmed === true && uuid.test(a.request_id),
      'needs_confirmation'
    );
    const fingerprint = hash(JSON.stringify([s.pkg.id, s.revision, s.digest, b, values]));
    const claim = path.join(cat.state, 'requests', b.id, a.request_id + '.json');
    const prior = await maybe(claim);
    if (prior) {
      check(prior.fingerprint === fingerprint, 'request_conflict');
      return status(prior.run_id);
    }
    const id = randomUUID(),
      dir = folder(id);
    await atomic(path.join(dir, 'status.json'), {
      run_id: id,
      status: 'queued',
      owner: process.pid,
      id: a.id,
      workspace_id: b.id,
      revision: s.revision
    });
    const candidate = path.join(dir, 'claim.json');
    await atomic(candidate, { run_id: id, fingerprint });
    await fs.mkdir(path.dirname(claim), { recursive: true, mode: 0o700 });
    try {
      await fs.link(candidate, claim);
    } catch (e) {
      await fs.rm(dir, { recursive: true, force: true });
      if (e.code !== 'EEXIST') throw e;
      const existing = await read(claim);
      check(existing.fingerprint === fingerprint, 'request_conflict');
      return status(existing.run_id);
    }
    try {store.record({...fields(a,id),action:'accept',outcome:'queued'});}
    catch(error){
      await atomic(path.join(dir,'result.json'),{run_id:id,id:a.id,revision:s.revision,workspace_id:b.id,status:'failed',reason:'audit_unavailable'});
      throw error;
    }
    void execute({ ...a, inputs: values }, id).catch((error) => {
      console.error('Could not persist CLI run status', id, error.code || error.name);
    });
    return { run_id: id, status: 'queued' };
  }
  return { start, status };
}
module.exports = { runs, sendGuest, leaf, audit, catalog: require('./cli-catalog.cjs').catalog };
