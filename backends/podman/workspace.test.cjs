'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspacePlanner } = require('./workspace.cjs');
const fixture = () => ({
  targetId: 'target1', observedAt: 1000, topology: 'linux-local',
  volume: { present: true, unlocked: true, mountId: 'uuid1', scopeId: 'folder1', dedicated: true,
    containsSensitiveMaterial: false, symlinkFree: true, scopeAuthorized: true },
  engine: { visible: true, mountId: 'uuid1', scopeId: 'folder1', mappingVerified: true, rootless: true },
  writers: { known: true, ids: ['container1'] },
  container: { exists: true, id: 'container1', running: true, mountId: 'uuid1', scopeId: 'folder1', destination: '/workspace', access: 'rw', insideReadWriteVerified: true },
});
const plan = (s, time = 1000) => createWorkspacePlanner({readVerifiedSnapshot: async () => s, now: () => time}).planWorkspace('target1');
test('no adapter or raw caller evidence cannot claim readiness', async () => {
  const p = createWorkspacePlanner();
  assert.equal((await p.planWorkspace('target1')).reason, 'trusted_probe_unavailable');
  assert.equal((await p.planWorkspace(fixture())).reason, 'invalid_target');
});
test('trusted mock produces ready for every explicitly mapped topology', async () => {
  for (const topology of ['linux-local', 'wsl', 'windows-debian-vm']) {
    const s = fixture(); s.topology = topology;
    assert.equal((await plan(s)).state, 'ready');
  }
});
test('missing and locked never propose automatic unlock', async () => {
  const s = fixture(); s.volume.present = false;
  assert.equal((await plan(s)).state, 'missing');
  s.volume.present = true; s.volume.unlocked = false;
  assert.equal((await plan(s)).recommendation, 'unlock_explicitly');
});
test('mapping identity required even when caller claims visibility', async () => {
  for (const topology of ['linux-local', 'wsl', 'windows-debian-vm']) {
    const s = fixture(); s.topology = topology; s.engine.mountId = 'different';
    assert.equal((await plan(s)).state, 'engine_not_visible');
    s.engine.mountId = 'uuid1'; s.engine.mappingVerified = false;
    assert.equal((await plan(s)).state, 'engine_not_visible');
  }
});
test('existing container needs recreation for wrong mount and start when stopped', async () => {
  const s = fixture(); s.container.destination = '/other';
  assert.equal((await plan(s)).state, 'recreate_required');
  s.container.destination = '/workspace'; s.container.running = false; s.writers.ids = [];
  assert.equal((await plan(s)).state, 'restart_required');
});
test('one writer enforced, including unknown and absent usage evidence', async () => {
  for (const writers of [{known:false,ids:[]},{known:true,ids:['other']},{known:true,ids:['container1','other']},{known:true,ids:[]}]) {
    const s = fixture(); s.writers = writers;
    assert.equal((await plan(s)).state, 'unavailable');
  }
});
test('a declared rw bind is not proof of read/write inside the running workload', async () => {
  const s=fixture(); delete s.container.insideReadWriteVerified;
  assert.equal((await plan(s)).reason,'container_read_write_unverified');
});
test('scope authorization and sensitive-directory exclusion are mandatory', async () => {
  for (const [key,value] of [['dedicated',false],['scopeAuthorized',false],['symlinkFree',false],['containsSensitiveMaterial',true]]) {
    const s=fixture();s.volume[key]=value;
    assert.equal((await plan(s)).state,'unavailable');
  }
  const s=fixture();s.engine.rootless=false;
  assert.equal((await plan(s)).state,'unavailable');
});
test('stale future mismatched and malformed snapshots fail closed', async () => {
  assert.equal((await plan(fixture(),31001)).state,'unavailable');
  assert.equal((await plan(fixture(),999)).state,'unavailable');
  const s=fixture();s.targetId='other';assert.equal((await plan(s)).state,'unavailable');
  assert.equal((await plan(null)).state,'unavailable');
});
test('output does not expose private probe data or errors', async () => {
  const s=fixture();s.secret='NEVER_OUTPUT';s.path='/private/NEVER_OUTPUT';
  assert.ok(!JSON.stringify(await plan(s)).includes('NEVER_OUTPUT'));
  const p=createWorkspacePlanner({readVerifiedSnapshot:()=>{throw Error('NEVER_OUTPUT');}});
  assert.equal((await p.planWorkspace('target1')).reason,'trusted_probe_failed');
});
