'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname,'../..');
const read = file => fs.readFileSync(path.join(root,file),'utf8');

test('Container command and MCP provider are declared for the VSIX', () => {
  const {contributes: {commands, mcpServerDefinitionProviders}} = JSON.parse(read('vscode-extension/package.json'));
  assert.equal(commands.filter(c => c.command === 'vamp.openContainers').length, 1);
  assert.equal(mcpServerDefinitionProviders.filter(c => c.id === 'vamp.podman').length, 1);
  const entry = read('vscode-extension/extension.js');
  assert.ok(entry.includes("registerMcpServerDefinitionProvider('vamp.podman'"));
  assert.ok(entry.includes("'backends/podman/server.mjs'"));
  assert.ok(entry.includes("'./dist/containers_panel.cjs'"));
});

test('VSIX and npm build sources include the same Podman runtime and bundled guide', () => {
  const vsix = read('vscode-extension/build.mjs');
  assert.ok(vsix.includes("'src/containers-panel.cjs'") && vsix.includes("'dist/containers_panel.cjs'"));
  for (const file of ['backends/podman/adapter.cjs','backends/podman/server.mjs','.agents/skills/vamp-podman/SKILL.md']){
    assert.ok(read(file).length > 0);
  }
  assert.ok(vsix.includes("'backends/podman/adapter.cjs'") && vsix.includes("'backends/podman/server.mjs'"));
  assert.ok(vsix.includes("'vamp-podman'"));
  assert.ok(vsix.includes("'CONTAINERS_WSL.md'") && vsix.includes("'backends/vagrant/podman_handoff.py'"));
  assert.ok(read('vscode-extension/CONTAINERS_WSL.md').includes('podman-installer-windows-amd64.msi'));
  assert.match(read('npm-package/build.mjs'),/\['runtime','notices'\]/);
  const cli = read('npm-package/bin/vamp-mcp.mjs');
  assert.ok(cli.includes("podman:'podman'"));
  assert.ok(cli.includes("if (command !== 'podman')"));
  assert.ok(JSON.parse(read('npm-package/package.json')).files.includes('runtime/'));
});
