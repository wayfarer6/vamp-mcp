'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { selectVaultDefinition } = require('../mcp-routing.cjs');
test('explicit local/remote selection calls only one factory', async () => {
  for (const target of ['local', 'remote']) {
    const calls = [];
    const result = await selectVaultDefinition(target,
      () => { calls.push('local'); return ['local']; },
      () => { calls.push('remote'); return ['remote']; });
    assert.deepEqual(calls, [target]); assert.deepEqual(result, [target]);
  }
});
test('invalid or ambiguous targets fail closed', async () => {
  for (const target of ['', null, undefined, 'both', ['local', 'remote']]) {
    let calls = 0;
    await assert.rejects(selectVaultDefinition(target, () => ++calls, () => ++calls));
    assert.equal(calls, 0);
  }
});
test('remote configuration failure does not fall back to local', async () => {
  let localCalls = 0;
  await assert.rejects(selectVaultDefinition('remote', () => ++localCalls,
    () => { throw new Error('not configured'); }), /not configured/);
  assert.equal(localCalls, 0);
});
test('manifest and extension register exactly one Vault provider', () => {
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  assert.deepEqual(pkg.contributes.mcpServerDefinitionProviders.map(p => p.id), ['vamp.vault']);
  const setting = pkg.contributes.configuration.properties['vampVault.mcpTarget'];
  assert.equal(setting.default, 'local'); assert.equal(setting.scope, 'application');
  const source = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  assert.equal((source.match(/registerMcpServerDefinitionProvider\(/g) || []).length, 1);
  assert.ok(!source.includes("registerMcpServerDefinitionProvider('vamp.vault.remote'"));
  assert.ok(!source.includes('if (force || !fresh)'));
});
