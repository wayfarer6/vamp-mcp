// Remote SSH backend: pure helpers, the MCP protocol surface, and the whole
// server driven against a fake virsh so no hypervisor is needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');

const repo = path.resolve(__dirname, '../..');
const load = async name => import(pathToFileURL(path.join(repo, 'backends/remote_ssh', name)).href);
const VM_A = '11111111-2222-3333-4444-555555555555';
const VM_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function fakeHost() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vamp-remote-test-'));
  const bin = path.join(dir, 'bin');
  const work = path.join(dir, 'work');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(bin,'VBoxManage'),'#!/bin/sh\nexit 0\n',{mode:0o700});
  const log = path.join(dir, 'virsh.log');
  fs.writeFileSync(log, '');
  const script = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
args="$*"
case "$args" in
  "--version"*) echo "9.0.0"; exit 0 ;;
  *"list --all --uuid"*) printf ' ${VM_A}\\n ${VM_B}\\n'; exit 0 ;;
  *"dominfo ${VM_A}"*) printf 'Id:             1\\nName:           lab-desktop\\nUUID:           ${VM_A}\\nOS Type:        hvm\\nState:          running\\nCPU(s):         2\\nCPU time:       12.5s\\nMax memory:     2097152 KiB\\nPersistent:     yes\\nAutostart:      disable\\n'; exit 0 ;;
  *"dominfo ${VM_B}"*) printf 'Id:             -\\nName:           windows-box\\nUUID:           ${VM_B}\\nOS Type:        hvm\\nState:          shut off\\nCPU(s):         4\\nMax memory:     4194304 KiB\\nPersistent:     yes\\nAutostart:      enable\\n'; exit 0 ;;
  *"dumpxml ${VM_A}"*) printf '<domain type="kvm"><name>lab-desktop</name><uuid>${VM_A}</uuid><memory unit="KiB">2097152</memory><vcpu>2</vcpu><os><type arch="x86_64" machine="q35">hvm</type><loader>/usr/share/OVMF.fd</loader></os><devices><disk type="file" device="disk"><source file="/var/lib/libvirt/images/lab.qcow2"/><target dev="vda" bus="virtio"/></disk><graphics type="vnc" port="5901" autoport="yes" listen="127.0.0.1"/><interface type="network"><mac address="52:54:00:11:22:33"/></interface></devices></domain>'; exit 0 ;;
  *"screenshot"*) file="$(printf '%s' "$args" | sed -E 's/.*screenshot [^ ]+ ([^ ]+) .*/\\1/')"; printf 'P6\\n2 1\\n255\\n' > "$file"; printf '\\377\\000\\000\\000\\377\\000' >> "$file"; exit 0 ;;
  *"qemu-monitor-command"*) echo '{"return":{}}'; exit 0 ;;
  *"start "*) echo "Domain started"; exit 0 ;;
  *"shutdown "*) echo "Domain shutdown"; exit 0 ;;
  *"destroy "*) echo "Domain destroyed"; exit 0 ;;
  *) printf 'unsupported virsh call: %s\\n' "$args" >&2; exit 2 ;;
esac
`;
  const virsh = path.join(bin, 'virsh');
  fs.writeFileSync(virsh, script, { mode: 0o755 });
  return { dir, bin, work, log };
}

function withPath(bin, fn) {
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before}`;
  return Promise.resolve().then(fn).finally(() => { process.env.PATH = before; });
}

function runNode(args, { env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}

test('PPM screenshots become PNG without losing dark pixels or whitespace values', async () => {
  const png = await load('png.mjs');
  const rgb = Buffer.from([0xff, 0x00, 0x00, 0x00, 0xff, 0x00]);
  const encoded = png.pngFromRgb(2, 1, rgb);
  assert.ok(png.isPng(encoded));
  assert.deepEqual(png.pngSize(encoded), { width: 2, height: 1 });
  const ppm = Buffer.concat([Buffer.from('P6\n2 1\n255\n', 'ascii'), rgb]);
  const converted = png.toPng(ppm);
  assert.ok(png.isPng(converted.png));
  assert.equal(converted.width, 2);
  // A first pixel byte of 0x0a is data, not header whitespace.
  const dark = Buffer.concat([Buffer.from('P6\n1 1\n255\n', 'ascii'), Buffer.from([0x0a, 0x20, 0x09])]);
  const darkPng = png.toPng(dark);
  assert.equal(darkPng.width, 1);
  assert.ok(darkPng.png.length > 0);
  assert.ok(png.toPng(encoded).png.equals(encoded));
  assert.throws(() => png.toPng(Buffer.from('not an image')), /PPM/);
});

test('keys map to QEMU qcodes with Shift held only where the layout needs it', async () => {
  const input = await load('input.mjs');
  const plain = input.keyEvents({ text: 'a1 ' });
  assert.deepEqual(plain.events.map(event => event.data.key.data), ['a', 'a', '1', '1', 'spc', 'spc']);
  const upper = input.keyEvents({ text: 'A!' });
  assert.deepEqual(upper.events.map(event => `${event.data.down ? 'v' : '^'}${event.data.key.data}`),
    ['vshift', 'vA'.replace('A', 'a'), '^a', '^shift', 'vshift', 'v1', '^1', '^shift']);
  const named = input.keyEvents({ keys: ['enter', 'F5'] });
  assert.deepEqual(named.events.map(event => event.data.key.data), ['ret', 'ret', 'f5', 'f5']);
  const korean = input.keyEvents({ text: '한' });
  assert.deepEqual(korean.unsupported, ['한']);
  assert.equal(korean.events.length, 0);
});

test('libvirt and VirtualBox output parse into the same desktop shape', async () => {
  const libvirt = await load('libvirt.mjs');
  const vbox = await load('virtualbox.mjs');
  const info = libvirt.parseDomainInfo('Name:  lab-desktop\nUUID:  11111111-2222-3333-4444-555555555555\nState:  shut off\nCPU(s):  4\nMax memory:  4194304 KiB\nAutostart:  enable\n');
  assert.equal(info.name, 'lab-desktop');
  assert.equal(info.state, 'poweroff');
  assert.equal(info.memory_mb, 4096);
  assert.equal(info.cpus, 4);
  assert.equal(info.autostart, true);
  assert.deepEqual(libvirt.parseDomainIds(` ${VM_A}\n ${VM_B}\n`), [VM_A, VM_B]);
  const xml = libvirt.parseDomainXml('<domain><name>lab</name><uuid>' + VM_A + '</uuid><memory unit="MiB">2048</memory><vcpu>2</vcpu><os><type machine="q35">hvm</type><loader>/x</loader></os><devices><disk type="file" device="disk"><source file="/d.qcow2"/><target dev="vda" bus="virtio"/></disk><graphics type="vnc" port="5901" listen="127.0.0.1"/></devices></domain>');
  assert.equal(xml.memory_mb, 2048);
  assert.equal(xml.firmware, 'uefi');
  assert.equal(xml.disks[0].source, '/d.qcow2');
  assert.equal(xml.graphics[0].port, 5901);
  const list = vbox.parseVmList('"lab desktop" {' + VM_A + '}\n"other" {' + VM_B + '}\n');
  assert.deepEqual(list, [{ name: 'lab desktop', id: VM_A }, { name: 'other', id: VM_B }]);
  const fields = vbox.parseMachineReadable('name="lab"\nUUID="' + VM_A + '"\nVMState="poweroff"\nmemory=4096\ncpus=2\nostype="Ubuntu_64"\nForwarding(0)="ssh,tcp,,2222,,22"\n');
  const status = vbox.vboxStatus(fields);
  assert.equal(status.state, 'poweroff');
  assert.equal(status.memory_mb, 4096);
  assert.equal(status.port_forwarding[0].host_port, 2222);
});

test('remote tools list, inspect, start, stop and capture against a fake virsh', {skip:process.platform!=='linux'}, async () => {
  const host = fakeHost();
  const { resolveConfig } = await load('config.mjs');
  const { createTools } = await load('tools.mjs');
  const { createRunner } = await load('server.mjs');
  const config = resolveConfig({ argv: ['--backend', 'kvm', '--libvirt-uri', 'qemu:///system', '--workdir', host.work], env: { HOME: host.dir, PATH: process.env.PATH } });
  const tools = createTools({ run: createRunner(), config });
  await withPath(host.bin, async () => {
    const listed = await tools.list();
    assert.equal(listed.count, 2);
    assert.deepEqual(listed.vms.map(vm => [vm.name, vm.state, vm.memory_mb]), [['lab-desktop', 'running', 2048], ['windows-box', 'poweroff', 4096]]);
    const detail = await tools.status({ vm: VM_A });
    assert.equal(detail.vm.firmware, 'uefi');
    assert.equal(detail.vm.graphics[0].port, 5901);
    assert.match(detail.vm.note, /not proof/);
    const started = await tools.start({ vm: VM_B });
    assert.equal(started.status, 'start_requested');
    const stopped = await tools.stop({ vm: VM_A, force: true });
    assert.equal(stopped.force, true);
    const shot = await tools.screenshot({ vm: VM_A });
    assert.equal(shot.text.width, 2);
    assert.equal(shot.text.height, 1);
    assert.equal(shot.images.length, 1);
    const png = Buffer.from(shot.images[0].data, 'base64');
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(fs.readdirSync(config.screenshotDir).length, 0, 'temporary captures are removed');
    await tools.sendKeys({ vm: VM_A, text: 'Hi!' });
    await tools.mouseClick({ vm: VM_A, x: 0.25, y: 0.75, button: 'left' });
  });
  const log = fs.readFileSync(host.log, 'utf8');
  assert.ok(log.includes(`-c qemu:///system start ${VM_B}`), log);
  assert.match(log, /destroy .*11111111/);
  assert.match(log, /input-send-event/);
  assert.match(log, /"axis":"x","value":8192/, 'fractional x maps onto the absolute axis range');
});

test('Python 3.15 through 4.x rank above the 3.11 minimum', async () => {
  const { compare } = await load('tools.mjs');
  assert.ok(compare('3.15.0', '3.11.0') > 0, '3.15 is newer than 3.11');
  assert.ok(compare('3.15', '3.11') > 0);
  assert.ok(compare('3.14.4', '3.11.9') > 0);
  assert.ok(compare('4.0.0', '3.11.0') > 0);
  assert.ok(compare('3.11.0', '3.11') === 0);
  assert.ok(compare('3.10.14', '3.11.0') < 0, '3.10 is still too old');
  assert.ok(compare('3.2.0', '3.11.0') < 0, 'numeric, not lexical: 3.2 < 3.11');
  // A pre-release or decorated string is read by its leading numbers, so a
  // release candidate of a new interpreter is not called unsupported.
  assert.ok(compare('3.15.0rc1', '3.11.0') > 0);
  assert.ok(compare('v22.14.0', '20.0.0') > 0);
});

test('remote host setup accepts a 3.15 interpreter and rejects an older one', {skip:process.platform!=='linux'}, async () => {
  const host = fakeHost();
  const fakePython = version => {
    const file = path.join(host.bin, 'python3');
    fs.writeFileSync(file, `#!/bin/sh\ncase "$*" in\n  *"version_info[:3]"*) echo "${version}"; exit 0 ;;\nesac\nexit 0\n`, { mode: 0o755 });
  };
  const { resolveConfig } = await load('config.mjs');
  const { createTools } = await load('tools.mjs');
  const { createRunner } = await load('server.mjs');
  const config = resolveConfig({ argv: ['--backend', 'kvm', '--workdir', host.work], env: { HOME: host.dir, PATH: process.env.PATH } });
  const tools = createTools({ run: createRunner(), config });
  await withPath(host.bin, async () => {
    fakePython('3.15.0');
    const plan = await tools.envSetup({ dry_run: true, python_venv: false });
    const python = plan.steps.find(step => step.id === 'python');
    assert.equal(python.status, 'ok', JSON.stringify(python));
    assert.match(python.command, /3\.15\.0/);
    const check = await tools.envCheck();
    const reported = check.checks.find(item => item.id === 'python');
    assert.equal(reported.status, 'ok');
    assert.equal(reported.detail, '3.15.0');

    fakePython('3.10.14');
    const outdated = await tools.envSetup({ dry_run: true, python_venv: false });
    assert.equal(outdated.steps.find(step => step.id === 'python').status, 'needs_manual');
  });
});

test('VM arguments are validated and remote failures stay readable', async () => {
  const host = fakeHost();
  const { resolveConfig } = await load('config.mjs');
  const { createTools } = await load('tools.mjs');
  const { createRunner } = await load('server.mjs');
  const config = resolveConfig({ argv: ['--backend', 'kvm', '--workdir', host.work], env: { HOME: host.dir } });
  const tools = createTools({ run: createRunner(), config });
  await assert.rejects(() => tools.start({ vm: '--delete' }), /Invalid VM identifier/);
  await assert.rejects(() => tools.status({ vm: 'bad\nname' }), /Invalid VM identifier/);
  await assert.rejects(() => tools.stop({}), /required/);
  // Simulate an unreachable host independently of installed local hypervisors.
  const unavailable = createTools({ run: async () => { throw new Error('unavailable test host'); }, config });
  await assert.rejects(() => unavailable.list(), /libvirt is not reachable/);
  const check = await unavailable.envCheck();
  assert.equal(check.ready, false);
  assert.ok(check.blockers.some(blocker => blocker.id === 'libvirt'));
  const plan = await tools.envSetup({ dry_run: true, python_venv: false });
  assert.equal(plan.dry_run, true);
  assert.ok(plan.steps.every(step => ['planned', 'ok', 'skipped', 'needs_manual'].includes(step.status)));
  assert.ok(plan.steps.every(step => step.status !== 'done'), 'a dry run performs no step');
  const virtualbox = createTools({
    run: createRunner(),
    config: resolveConfig({ argv: ['--backend', 'virtualbox', '--workdir', host.work], env: { HOME: host.dir, VBOXMANAGE_PATH: '/nonexistent/VBoxManage' } }),
  });
  const click = await virtualbox.mouseClick({ vm: 'lab' });
  assert.equal(click.status, 'unsupported');
  assert.match(click.message, /KVM/);
});

test('MCP protocol answers initialize, tools/list and tools/call', async () => {
  const { createMcpHandler } = await load('server.mjs');
  const handle = createMcpHandler({
    tools: [{
      name: 'echo',
      title: 'Echo',
      description: 'Echo a value.',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      handler: async ({ value }) => ({ text: { status: 'ok', value } }),
    }],
  });
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test' } } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal(init.result.serverInfo.name, 'vamp-remote');
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(list.result.tools[0].name, 'echo');
  assert.equal(list.result.tools[0].inputSchema.type, 'object');
  const call = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { value: 'hi' } } });
  assert.equal(JSON.parse(call.result.content[0].text).value, 'hi');
  const unknown = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'missing' } });
  assert.equal(unknown.result.isError, true);
  const missingMethod = await handle({ jsonrpc: '2.0', id: 5, method: 'nope' });
  assert.equal(missingMethod.error.code, -32601);
  const failing = createMcpHandler({ tools: [{ name: 'boom', title: 'Boom', description: '', inputSchema: { type: 'object' }, handler: async () => { throw new Error('exploded'); } }] });
  const failure = await failing({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'boom' } });
  assert.match(failure.result.content[0].text, /exploded/);
  assert.equal(failure.result.isError, true);
});

test('stdio transport keeps request order and rejects malformed lines', async () => {
  const { serveStdio } = await load('server.mjs');
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let output = '';
  stdout.on('data', chunk => { output += chunk; });
  const tools = [{
    name: 'slow', title: 'Slow', description: '', inputSchema: { type: 'object' },
    handler: async ({ id }) => { await new Promise(resolve => setTimeout(resolve, id === 1 ? 30 : 1)); return { text: { id } }; },
  }];
  const done = serveStdio({ tools, stdin, stdout });
  stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"slow","arguments":{"id":1}}}\n');
  stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"slow","arguments":{"id":2}}}\n');
  stdin.write('not json\n');
  stdin.end();
  await done;
  const lines = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines[0].id, 1);
  assert.equal(lines[1].id, 2);
  assert.equal(lines[2].error.code, -32700);
});

test('the packaged server runs as a one-shot tool call over its command line', {skip:process.platform!=='linux'}, async () => {
  const host = fakeHost();
  const server = path.join(repo, 'backends/remote_ssh/server.mjs');
  const listed = await runNode([server, '--backend', 'kvm', '--workdir', host.work, '--call', 'remote_vm_list'], { env: { PATH: `${host.bin}${path.delimiter}${process.env.PATH}` } });
  assert.equal(listed.code, 0, listed.stderr);
  const payload = JSON.parse(listed.stdout);
  assert.equal(payload.count, 2);
  assert.equal(payload.vms[1].state, 'poweroff');
  const shot = await runNode([server, '--backend', 'kvm', '--workdir', host.work, '--call', 'remote_vm_screenshot', '--args', JSON.stringify({ vm: VM_A })], { env: { PATH: `${host.bin}${path.delimiter}${process.env.PATH}` } });
  assert.equal(shot.code, 0, shot.stderr);
  const image = JSON.parse(shot.stdout);
  assert.equal(image.images[0].mimeType, 'image/png');
  const bad = await runNode([server, '--backend', 'kvm', '--workdir', host.work, '--call', 'remote_vm_start', '--args', JSON.stringify({ vm: '--force' })], { env: { PATH: `${host.bin}${path.delimiter}${process.env.PATH}` } });
  assert.notEqual(bad.code, 0);
  assert.match(JSON.parse(bad.stdout).message, /Invalid VM identifier/);
  assert.match((await runNode([server, '--help'])).stdout, /--call TOOL/);
});

test('the remote command line expands $HOME and runs the uploaded server', {skip:process.platform==='win32'}, async t => {
  const client = await load('client.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vamp-remote-home-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const remoteDir = path.join(home, '.vamp', 'remote');
  fs.mkdirSync(remoteDir, { recursive: true });
  // The extension uploads the esbuild bundle, not a selection of raw modules.
  await require('esbuild').build({entryPoints:[path.join(repo,'backends/remote_ssh/server.mjs')],
    outfile:path.join(remoteDir,'server.mjs'),bundle:true,platform:'node',format:'esm',target:'node20',
    banner:{js:"import { createRequire as __vampRequire } from 'node:module'; const require = __vampRequire(import.meta.url);"}});
  const config = client.normalizeRemoteConfig({ host: 'lab-host.local', username: 'dev' });
  const command = client.remoteCommand(config, { tool: 'remote_env_check', args: {} });
  assert.ok(!command.includes(`'$HOME`), 'the home directory must be expanded by the remote shell');
  const result = await new Promise(resolve => {
    const child = spawn('sh', ['-c', command], { env: { ...process.env, HOME: home, VAMP_REMOTE_WORKDIR: path.join(home, 'work') } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'ok');
  assert.equal(payload.backend, 'kvm');
  assert.equal(fs.existsSync(path.join(home, '$HOME')), false, 'no literal $HOME directory is created');
  const upload = client.remoteFile('server.mjs');
  assert.equal(upload, '"$HOME/.vamp/remote/server.mjs"');
  assert.throws(() => client.remoteFile('../escape'), /Invalid remote file name/);
});

test('upload refuses a host without Node.js and setup runs the uploaded script', async () => {
  const client = await load('client.mjs');
  const config = client.normalizeRemoteConfig({ host: 'lab-host.local', username: 'dev' });
  const spawnReturning = (payload, code = 0) => () => {
    const child = new (require('node:events').EventEmitter)();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      if (payload) child.stdout.write(payload);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', code);
    });
    return child;
  };
  const blocked = new client.RemoteSshClient(config, { spawnImpl: spawnReturning('', 127) });
  blocked.exec = async command => command === 'uname -s'
    ? { code: 0, stdout: 'Linux\n' } : { code: 127, stdout: '', stderr: '' };
  await assert.rejects(() => blocked.upload({ serverFile: __filename }), /Node\.js was not found at "node"/);

  const commands = [];
  const responses = ['Linux\n', 'v22.14.0\n', '', '', '0.1.7\n'];
  let step = 0;
  const spy = new client.RemoteSshClient(config, {
    spawnImpl: (command, args) => {
      commands.push(args.at(-1));
      const payload = responses[step] ?? '';
      step += 1;
      return spawnReturning(payload)();
    },
  });
  const result = await spy.upload({ serverFile: __filename, setupScript: __filename });
  assert.equal(result.server_version, '0.1.7');
  assert.equal(commands[0], 'uname -s');
  assert.match(commands[2], /mktemp .*server\.mjs.*cat > "\$tmp".*wc -c.*chmod 600.*mv -f "\$tmp" .*server\.mjs/);
  assert.match(commands[3], /mktemp .*remote_host_setup\.sh.*cat > "\$tmp".*wc -c.*chmod 700.*mv -f "\$tmp" .*remote_host_setup\.sh/);

  const setupCommands = [];
  const runner = new client.RemoteSshClient(config, {
    spawnImpl: (command, args) => {
      setupCommands.push(args.at(-1));
      return spawnReturning('{"status":"ok","backend":"kvm","steps":[]}\n')();
    },
  });
  const setup = await runner.runSetup({ backend: 'kvm', repo: '/opt/vamp-mcp' });
  assert.equal(setup.status, 'ok');
  assert.ok(setupCommands.at(-1).includes('remote_host_setup.sh'));
  assert.ok(setupCommands.at(-1).includes("'/opt/vamp-mcp'"));
});

test('KVM upload rejects macOS and Windows before writing files', async () => {
  const { RemoteSshClient, normalizeRemoteConfig } = await load('client.mjs');
  for (const platform of ['Darwin', 'Windows']) {
    const client = new RemoteSshClient(normalizeRemoteConfig({ host: 'lab-host.local' }));
    const commands = [];
    client.exec = async command => {
      commands.push(command);
      if (command === 'uname -s') return platform === 'Darwin'
        ? { code: 0, stdout: 'Darwin\n' } : { code: 127, stdout: '' };
      assert.equal(command, 'cmd.exe /d /c ver');
      return { code: 0, stdout: 'Microsoft Windows [Version 10.0]\n' };
    };
    await assert.rejects(client.upload({ serverFile: __filename }), { code: 'remote_host_unsupported_os' });
    assert.deepEqual(commands, platform === 'Darwin' ? ['uname -s'] : ['uname -s', 'cmd.exe /d /c ver']);
  }
});

test('KVM upload reports SSH loss during OS detection', async () => {
  const { RemoteSshClient, normalizeRemoteConfig } = await load('client.mjs');
  for (const failureAt of ['uname -s', 'cmd.exe /d /c ver']) {
    const client = new RemoteSshClient(normalizeRemoteConfig({ host: 'lab-host.local' }));
    client.exec = async command => {
      if (command === failureAt) return { code: 255, stdout: '', stderr: 'Connection reset by peer' };
      assert.equal(command, 'uname -s');
      return { code: 127, stdout: '', stderr: '' };
    };
    await assert.rejects(client.upload({ serverFile: __filename }), { code: 255 });
  }
});

test('a truncated upload leaves the installed server intact', {skip:process.platform==='win32' && !process.env.VAMP_TEST_POSIX_SHELL}, async t => {
  const { RemoteSshClient, normalizeRemoteConfig } = await load('client.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vamp-upload-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const directory = path.join(home, '.vamp', 'remote');
  fs.mkdirSync(directory, { recursive: true });
  const installed = path.join(directory, 'server.mjs');
  fs.writeFileSync(installed, 'previous server\n');
  const client = new RemoteSshClient(normalizeRemoteConfig({ host: 'lab-host.local', username: 'dev' }));
  const commands = [];
  client.exec = async (command, { stdinText } = {}) => {
    commands.push(command);
    if (command === 'uname -s') return { code: 0, stdout: 'Linux\n', stderr: '' };
    if (!stdinText) return { code: 0, stdout: process.version, stderr: '' };
    const shell = process.env.VAMP_TEST_POSIX_SHELL || 'sh';
    const child = spawn(shell, ['-c', command], { env: { ...process.env, HOME: home.replaceAll('\\', '/') } });
    child.stdin.end(stdinText.subarray(0, 16));
    const code = await new Promise(resolve => child.once('close', resolve));
    return { code, stdout: '', stderr: '' };
  };
  await assert.rejects(client.upload({ serverFile: __filename }), /Could not upload/);
  assert.equal(fs.readFileSync(installed, 'utf8'), 'previous server\n');
  assert.deepEqual(fs.readdirSync(directory), ['server.mjs']);
  assert.equal(commands.length, 3);
});

test('the SSH client quotes arguments and maps connection failures to plain language', async () => {
  const client = await load('client.mjs');
  const config = client.normalizeRemoteConfig({ host: 'lab-host.local', username: 'dev', port: 2222, privateKeyPath: '/keys/lab' });
  const args = client.sshArgs(config, 'true');
  assert.deepEqual(args.slice(0, 3), ['-T', '-o', 'BatchMode=yes']);
  assert.ok(args.includes('2222'));
  assert.ok(args.includes('-i'));
  assert.deepEqual(args.slice(-3), ['--', 'dev@lab-host.local', 'true']);
  assert.equal(client.quote("it's a vm"), `'it'"'"'s a vm'`);
  assert.throws(() => client.normalizeRemoteConfig({ host: '-oProxyCommand=evil' }), /Remote host/);
  assert.throws(() => client.normalizeRemoteConfig({ host: 'ok', port: 70000 }), /port/);
  const command = client.remoteCommand(config, { tool: 'remote_vm_list', args: {} });
  assert.match(command, /server\.mjs/);
  assert.match(command, /--call 'remote_vm_list'/);
  assert.deepEqual(client.parseToolOutput('noise\n{"status":"ok"}\n'), { status: 'ok' });

  const okSpawn = () => {
    const child = new (require('node:events').EventEmitter)();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.write('{"status":"ok","count":0}\n');
      child.stdout.end();
      child.emit('close', 0);
    });
    return child;
  };
  const passing = new client.RemoteSshClient(config, { spawnImpl: okSpawn });
  assert.deepEqual(await passing.call('remote_vm_list'), { status: 'ok', count: 0 });

  const denied = () => {
    const child = new (require('node:events').EventEmitter)();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      child.stderr.write('dev@lab-host.local: Permission denied (publickey).\n');
      child.stderr.end();
      child.emit('close', 255);
    });
    return child;
  };
  const failing = new client.RemoteSshClient(config, { spawnImpl: denied });
  await assert.rejects(() => failing.call('remote_vm_list'), /SSH authentication failed for dev@lab-host\.local/);
});

test('remote chords hold modifiers through the target key and release in reverse order', async () => {
  const { createTools } = await load('tools.mjs');
  const { resolveConfig } = await load('config.mjs');
  const calls = [];
  const tools = createTools({ config: resolveConfig({platform:'linux'}), run: async (exe, args) => {
    calls.push(args); return { stdout: '{"return":{}}', stderr: '' };
  }});
  await tools.sendKeys({vm: VM_A, hotkey:['super','r']});
  const events = JSON.parse(calls[0].at(-1)).arguments.events;
  assert.deepEqual(events.map(e => [e.data.key.data,e.data.down]), [['meta_l',true],['r',true],['r',false],['meta_l',false]]);
  calls.length = 0;
  await assert.rejects(() => tools.sendKeys({vm:VM_A,text:'do not send',hotkey:['unknown']}), /Unsupported hotkey/);
  assert.equal(calls.length,0);
});

test('actual server entrypoint completes the stdio MCP handshake', async () => {
  const server = path.join(repo, 'backends/remote_ssh/server.mjs');
  const child = spawn(process.execPath, [server], {stdio:['pipe','pipe','pipe']});
  let output = '', error = '';
  child.stdout.on('data', b => output += b); child.stderr.on('data', b => error += b);
  child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}}})+'\n');
  const code = await new Promise(resolve => child.on('close',resolve));
  assert.equal(code,0,error);
  assert.equal(JSON.parse(output).result.serverInfo.name,'vamp-remote');
});

test('remote tablet clicks use separate down/up requests, including release after a failed down', async () => {
  const { createTools } = await load('tools.mjs');
  const { resolveConfig } = await load('config.mjs');
  const calls = [];
  let failDown = false;
  const tools = createTools({config:resolveConfig({platform:'linux'}),run:async (exe,args) => {
    const payload = JSON.parse(args.at(-1)); calls.push(payload.arguments.events);
    if(failDown && calls.length === 2) throw new Error('injected delivery failure');
    return {stdout:'{"return":{}}',stderr:''};
  }});
  await tools.mouseClick({vm:VM_A,x:.25,y:.75});
  assert.deepEqual(calls.map(events => events.map(e => [e.type,e.data.down])), [[['abs',undefined],['abs',undefined]],[['btn',true]],[['btn',false]]]);
  calls.length=0;failDown=true;
  await assert.rejects(() => tools.mouseClick({vm:VM_A}), /delivery failure/);
  assert.equal(calls.at(-1)[0].data.down,false);
});
