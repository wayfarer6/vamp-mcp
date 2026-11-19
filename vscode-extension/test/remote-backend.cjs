// Extension side of the remote backend: MCP provider, settings, commands,
// the screenshot panel and plain-language failures, against a fake vscode host.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PassThrough } = require('node:stream');

const root = path.resolve(__dirname, '..');

function harness(overrides = {}, { exportPath, tunnelClosed = new Promise(() => {}), reconnect = false } = {}) {
  const settings = {
    'remote.enabled': true,
    'remote.host': 'lab-host.local',
    'remote.port': 22,
    'remote.username': 'dev',
    'remote.privateKeyPath': '',
    'remote.backend': 'kvm',
    'remote.libvirtUri': 'qemu:///system',
    'remote.remotePythonPath': 'python3',
    'remote.remoteNodePath': 'node',
    ...overrides,
  };
  const calls = [];
  const messages = [];
  const posted = [];
  const providers = new Map();
  const commands = new Map();
  const notices = [];
  const statusItems = [];
  let receiveMessage;
  let disposePanel;
  const panel = {
    visible: true,
    reveal() {},
    dispose() { disposePanel?.(); },
    onDidDispose(fn) { disposePanel = fn; },
    onDidChangeViewState() {},
    webview: {
      cspSource: 'test:',
      asWebviewUri: value => value,
      postMessage: message => messages.push(message),
      set html(value) { this._html = value; },
      get html() { return this._html; },
      onDidReceiveMessage(fn) { receiveMessage = fn; },
    },
  };
  const vscode = {
    workspace: {
      getConfiguration() {
        return {
          get: key => settings[`remote.${key}`] ?? settings[key],
          update: async (key, value) => { settings[key] = value; },
        };
      },
    },
    lm: {
      registerMcpServerDefinitionProvider(id, provider) {
        providers.set(id, provider);
        return { dispose() {} };
      },
    },
    commands: {
      registerCommand(id, handler) { commands.set(id, handler); return { dispose() {} }; },
      executeCommand: async (id, ...args) => { calls.push(['executeCommand', id, ...args]); },
    },
    window: {
      createStatusBarItem: () => {
        const item = { show() {}, dispose() { this.disposed = true; } };
        statusItems.push(item);
        return item;
      },
      createWebviewPanel: () => panel,
      withProgress: async (_options, task) => task({ report() {} }),
      showInformationMessage: async (...args) => { notices.push(args); return exportPath && args.includes('Verify') ? 'Verify' : undefined; },
      showWarningMessage: async (...args) => { notices.push(args); return reconnect && args.includes('Reconnect') ? 'Reconnect' : undefined; },
      showErrorMessage: async (...args) => { notices.push(args); return undefined; },
      showInputBox: async () => 'lab-host.local',
      showQuickPick: async items => items[0],
      showSaveDialog: async () => exportPath ? { fsPath: exportPath } : undefined,
    },
    Uri: { joinPath: (...parts) => ({ fsPath: parts.join('/') }), file: value => value },
    ProgressLocation: { Notification: 15, Window: 10 },
    ViewColumn: { Active: 1 },
    StatusBarAlignment: { Left: 1 },
    ConfigurationTarget: { Global: 1 },
    McpStdioServerDefinition: class {
      constructor(label, command, args, env, version) { Object.assign(this, { label, command, args, env, version }); }
    },
    EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
  };
  const fakeClient = {
    calls,
    list: async () => ({ status: 'ok', count: 1, connection: 'qemu:///system', vms: [{ name: 'lab-desktop', id: 'uuid-1', state: 'running', memory_mb: 2048, cpus: 2 }] }),
    envCheck: async () => ({ status: 'ok', ready: true, checks: [{ id: 'node', label: 'Node.js', status: 'ok', detail: 'v22' }], blockers: [] }),
    start: async name => { calls.push(['start', name]); return { status: 'start_requested', state: 'running' }; },
    stop: async (name, options) => { calls.push(['stop', name, options]); return { status: 'stop_requested' }; },
    screenshot: async name => ({ status: 'ok', width: 2, height: 1, png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) }),
    upload: async () => ({ server_version: '0.1.7', setup_script: null }),
    verifyStdio: async () => { calls.push(['verifyStdio']); return { toolCount: 15 }; },
    openForward: async port => {
      const first = !calls.some(([name]) => name === 'openForward');
      calls.push(['openForward', port]);
      return { localPort: 37591, closed: first ? tunnelClosed : new Promise(() => {}), dispose: () => calls.push(['closeForward']) };
    },
    call: async (tool) => { calls.push(['call', tool]); return { status: 'ok', steps: [] }; },
  };
  const module = { exports: {} };
  const req = name => {
    if (name === 'vscode') return vscode;
    if (name === './dist/remote_client.cjs') return {
      normalizeRemoteConfig: input => {
        if (input.host && /[^A-Za-z0-9._:-]/.test(input.host)) throw new Error('Remote host may contain only letters, digits, dots, colons, underscores and hyphens.');
        return { ...input, port: Number(input.port) || 22, host: input.host || '', username: input.username || '', backend: input.backend || 'kvm', libvirtUri: input.libvirtUri || 'qemu:///system', privateKeyPath: input.privateKeyPath || '' };
      },
      RemoteSshClient: class { constructor() { return fakeClient; } },
      sshArgs: (config, command) => ['-T', '-o', 'BatchMode=yes', '--', `${config.username}@${config.host}`, command],
      remoteMcpCommand: () => 'node ~/.vamp/remote/server.mjs',
      remoteStdioDefinition: () => ({ command: 'ssh', args: ['-T', '--', 'dev@lab-host.local', 'node ~/.vamp/remote/server.mjs'] }),
    };
    return require(name);
  };
  vm.runInNewContext(`(function(require,module,exports){${fs.readFileSync(path.join(root, 'remote-backend.js'), 'utf8')}\n})`, { require: req, module, exports: module.exports, process, console, Buffer, setInterval, clearInterval, Date, JSON, fs })(req, module, module.exports);
  const changes = new vscode.EventEmitter();
  const output = { lines: [], appendLine(value) { this.lines.push(String(value)); }, show() {} };
  const api = module.exports.registerRemote(
    { subscriptions: [], extensionUri: '/extension', globalStorageUri: { fsPath: '/tmp/vamp-remote-ext' } },
    { runtime: '/runtime', output, version: '0.1.7', changes },
  );
  return {
    api, settings, providers, commands, messages, notices, calls, panel, output, statusItems,
    send: message => receiveMessage(message),
    dispose: () => disposePanel?.(),
  };
}

test('configuration export writes a mergeable fragment and preserves existing files', async t => {
  const folder = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vamp-remote-export-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const exportPath = path.join(folder, 'mcp.json');
  const { commands, calls, notices } = harness({}, { exportPath });
  const save = commands.get('vamp.remote.exportMcpConfig');
  await save();
  const fragment = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  assert.deepEqual(fragment, { mcpServers: { 'vamp-remote': { command: 'ssh', args: ['-T', '--', 'dev@lab-host.local', 'node ~/.vamp/remote/server.mjs'] } } });
  assert.deepEqual(calls, [['verifyStdio']]);
  assert.ok(notices.some(([message]) => message.includes('15 MCP tools')));

  const existing = '{"mcpServers":{"existing":{"command":"other"}}}\n';
  fs.writeFileSync(exportPath, existing);
  await save();
  assert.equal(fs.readFileSync(exportPath, 'utf8'), existing);
  assert.deepEqual(calls, [['verifyStdio']]);
  assert.ok(notices.some(([message]) => message.includes('existing MCP configuration was preserved')));
});

test('live viewer opens one forward on demand and closes it with the panel', async () => {
  const { commands, calls, panel, dispose } = harness();
  const open = commands.get('vamp.remote.openLiveViewer');
  assert.deepEqual(calls, []);
  await Promise.all([open(), open()]);
  assert.deepEqual(calls, [['openForward', 6080]]);
  assert.match(panel.webview.html, /src="http:\/\/127\.0\.0\.1:37591\/vnc\.html\?/);
  dispose();
  assert.deepEqual(calls, [['openForward', 6080], ['closeForward']]);
});

test('live viewer replaces its frame with a message when SSH forwarding ends', async () => {
  let disconnect;
  const tunnelClosed = new Promise(resolve => { disconnect = resolve; });
  const { commands, panel, dispose, statusItems } = harness({}, { tunnelClosed });
  await commands.get('vamp.remote.openLiveViewer')();
  assert.match(statusItems[0].text, /connected$/);
  disconnect();
  await tunnelClosed;
  assert.match(panel.webview.html, /SSH forwarding disconnected/);
  assert.doesNotMatch(panel.webview.html, /<iframe/);
  assert.match(statusItems[0].text, /stopped$/);
  dispose();
  assert.equal(statusItems[0].disposed, true);
});

test('choosing Reconnect opens a new live viewer tunnel after disconnect', async () => {
  let disconnect;
  const tunnelClosed = new Promise(resolve => { disconnect = resolve; });
  const { commands, calls, panel, dispose } = harness({}, { tunnelClosed, reconnect: true });
  await commands.get('vamp.remote.openLiveViewer')();
  disconnect();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['openForward', 6080], ['closeForward'], ['openForward', 6080]]);
  assert.match(panel.webview.html, /<iframe/);
  dispose();
});

test('the MCP provider stays quiet until remote is enabled and configured', () => {
  const disabled = harness({ 'remote.enabled': false });
  assert.equal(disabled.providers.get('vamp.remote').provideMcpServerDefinitions().length, 0);
  const empty = harness({ 'remote.host': '' });
  assert.equal(empty.providers.get('vamp.remote').provideMcpServerDefinitions().length, 0);
  const ready = harness();
  const definitions = ready.providers.get('vamp.remote').provideMcpServerDefinitions();
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].command, 'ssh');
  assert.match(definitions[0].label, /lab-host\.local/);
  assert.ok(definitions[0].args.includes('--'));
  assert.ok(definitions[0].args.some(arg => arg.includes('server.mjs')));
});

test('settings from the manager are saved and invalid hosts are reported instead of used', async () => {
  const h = harness({ 'remote.enabled': false, 'remote.host': '' });
  await h.api.saveSettings({ enabled: true, host: 'lab-host.local', port: '2222', username: 'dev', backend: 'virtualbox' });
  assert.equal(h.settings['remote.enabled'], true);
  assert.equal(h.settings['remote.port'], 2222);
  assert.equal(h.settings['remote.backend'], 'virtualbox');
  assert.match(h.api.summary().detail, /lab-host\.local:2222 · VirtualBox/);
  await h.api.saveSettings({ host: 'lab host; rm -rf /' });
  const summary = h.api.summary();
  assert.equal(summary.configured, false);
  assert.match(summary.detail, /letters, digits/);
  assert.equal(h.api.isConfigured(), false);
});

test('verify, list, start and stop use the SSH client and explain failures', async () => {
  const h = harness();
  const report = await h.api.verify({ quiet: true });
  assert.equal(report.ready, true);
  assert.equal(h.api.state.report.ready, true);
  const listed = await h.api.list();
  assert.equal(listed.count, 1);
  await h.api.start({ name: 'lab-desktop', id: 'uuid-1' });
  await h.api.stop({ name: 'lab-desktop' }, { force: false });
  const started = h.calls.filter(call => call[0] === 'start');
  const stopped = h.calls.filter(call => call[0] === 'stop');
  assert.equal(started.length, 1);
  assert.equal(started[0][1], 'lab-desktop');
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0][1], 'lab-desktop');
  assert.equal(stopped[0][2].force, false);
});

test('the screenshot panel shows a view-only frame and saves on request', async () => {
  const h = harness();
  const panel = await h.api.openScreen({ name: 'lab-desktop', id: 'uuid-1' });
  assert.ok(panel);
  const html = h.panel.webview.html;
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /screenshots only/);
  assert.match(html, /no live stream/i);
  assert.ok(!/innerHTML/.test(html));
  for (const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  await h.send({ type: 'ready' });
  const frame = h.messages.find(message => message.type === 'frame');
  assert.ok(frame, 'a frame is posted after ready');
  assert.match(frame.image, /^data:image\/png;base64,/);
  await h.send({ type: 'refresh' });
  assert.ok(h.messages.filter(message => message.type === 'frame').length >= 2);
  // A second open reuses the existing panel instead of stacking windows.
  const again = await h.api.openScreen({ name: 'lab-desktop', id: 'uuid-1' });
  assert.equal(again, panel);
  h.dispose();
});

test('remote screenshots never run without a configured host', async () => {
  const h = harness({ 'remote.enabled': false });
  await assert.rejects(() => h.api.verify({ quiet: true }), /turned off/);
  assert.equal(h.api.summary().configured, false);
});
