// Tools of the VAMP remote hypervisor server.
// Every tool runs on the machine that hosts the hypervisor and reaches it
// through the local CLI (virsh / VBoxManage). Callers reach these tools over
// SSH stdio, so no hypervisor port is exposed to the network.
import fs from 'node:fs/promises';
import hostSupport from '../common/host-support.cjs';
import packerModule from '../common/packer.cjs';
import {remoteReplayEndpoint,runWithVault} from '../library/vault-replay.mjs';
import path from 'node:path';
import { describeConfig } from './config.mjs';
import { clickEvents, parseDomainIds, parseDomainInfo, parseDomainXml, CLICK_BUTTONS } from './libvirt.mjs';
import { parseMachineReadable, parseVmList, vboxStatus, vboxVm } from './virtualbox.mjs';
import { keyEvents, chordKeys, SCANCODES } from './input.mjs';
import { toPng } from './png.mjs';

export const VERSION = '0.3.5';
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024;

function assertVm(value) {
  const vm = String(value ?? '').trim();
  if (!vm) throw new Error('A VM name or UUID is required.');
  if (vm.length > 128 || vm.startsWith('-') || /[\u0000-\u001f]/.test(vm)) throw new Error('Invalid VM identifier.');
  return vm;
}

function positiveNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

// Compares dotted version strings numerically so 3.15 sorts above 3.14 and 3.11.
// Any non-numeric suffix ('3.15.0rc1', '3.15-dev', 'v22.14.0') is read as
// its leading number, and a missing segment counts as 0, so the check keeps
// working when a newer Python or Node release appears.
export function compare(version, minimum) {
  const segments = value => String(value ?? '').trim().replace(/^v/i, '').split('.').map(part => {
    const match = /^\d+/.exec(part);
    return match ? Number(match[0]) : 0;
  });
  const left = segments(version);
  const right = segments(minimum);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] || 0;
    const b = right[index] || 0;
    if (a !== b) return a - b;
  }
  return 0;
}

function parseMonitorReply(stdout) {
  const text = String(stdout || '').trim();
  try {
    return JSON.parse(text.slice(text.indexOf('{')));
  } catch {
    return { return: text };
  }
}

export function createTools({ run, config, fsx = fs, now = () => new Date() }) {
  const exec = async (exe, args, { timeoutMs = 30000, input } = {}) => {
    try {
      const tool=path.basename(exe).replace(/\.exe$/i,'');
      if(['virsh','virt-install','qemu-img'].includes(tool))hostSupport.requireBackendHost('kvm',config.platform);
      const result = await run(exe, args, { timeoutMs, input });
      return { ok: true, stdout: String(result?.stdout ?? ''), stderr: String(result?.stderr ?? '') };
    } catch (error) {
      return {
        ok: false,
        stdout: String(error?.stdout ?? ''),
        stderr: String(error?.stderr ?? ''),
        code: error?.code,
        message: String(error?.message ?? error),
      };
    }
  };
  const detail = (result, fallback) => String(result.stderr || result.stdout || result.message || fallback).trim().slice(0, 600);
  const virsh = (args, options) => exec('virsh', ['-c', config.libvirtUri, ...args], options);
  const vbox = (args, options) => exec(config.vboxManage, args, options);
  const qmp = async (vm, payload, timeoutMs = 30000) => {
    const reply = await virsh(['qemu-monitor-command', vm, JSON.stringify(payload)], { timeoutMs });
    if (!reply.ok) throw new Error(`QEMU monitor is not available for ${vm}: ${detail(reply)}`);
    const parsed = parseMonitorReply(reply.stdout);
    if (parsed.error) throw new Error(`QEMU monitor rejected the request: ${parsed.error.desc || parsed.error.class || 'unknown error'}`);
    return parsed.return;
  };

  async function kvmList() {
    const listed = await virsh(['list', '--all', '--uuid'], { timeoutMs: 45000 });
    if (!listed.ok) throw new Error(`libvirt is not reachable at ${config.libvirtUri}: ${detail(listed)}`);
    const ids = parseDomainIds(listed.stdout).slice(0, 100);
    const vms = [];
    for (const id of ids) {
      const info = await virsh(['dominfo', id], { timeoutMs: 20000 });
      if (!info.ok) {
        vms.push({ backend: 'kvm', id, name: '', state: 'unavailable', note: detail(info, 'dominfo failed') });
        continue;
      }
      const parsed = parseDomainInfo(info.stdout);
      vms.push({
        backend: 'kvm',
        id: parsed.id || id,
        name: parsed.name,
        state: parsed.state,
        memory_mb: parsed.memory_mb,
        cpus: parsed.cpus,
        autostart: parsed.autostart,
      });
    }
    return { status: 'ok', backend: 'kvm', connection: config.libvirtUri, count: vms.length, vms };
  }

  async function vboxList() {
    const listed = await vbox(['list', 'vms'], { timeoutMs: 45000 });
    if (!listed.ok) throw new Error(`${config.vboxManage} is not available on this host: ${detail(listed)}`);
    const running = new Set(parseVmList((await vbox(['list', 'runningvms'], { timeoutMs: 30000 })).stdout).map(row => row.id));
    const rows = parseVmList(listed.stdout).slice(0, 100);
    const vms = [];
    for (const row of rows) {
      const info = await vbox(['showvminfo', row.id, '--machinereadable'], { timeoutMs: 20000 });
      const fields = info.ok ? parseMachineReadable(info.stdout) : {};
      const vm = vboxVm(fields, row);
      if (!info.ok) vm.state = running.has(row.id) ? 'running' : 'unavailable';
      vms.push({ backend: 'virtualbox', ...vm });
    }
    return { status: 'ok', backend: 'virtualbox', count: vms.length, vms };
  }

  async function list() {
    return config.backend === 'kvm' ? kvmList() : vboxList();
  }

  async function status({ vm }) {
    const target = assertVm(vm);
    if (config.backend === 'virtualbox') {
      const info = await vbox(['showvminfo', target, '--machinereadable'], { timeoutMs: 30000 });
      if (!info.ok) throw new Error(`Cannot read ${target}: ${detail(info)}`);
      return { status: 'ok', backend: 'virtualbox', vm: vboxStatus(parseMachineReadable(info.stdout)) };
    }
    const info = await virsh(['dominfo', target], { timeoutMs: 20000 });
    if (!info.ok) throw new Error(`Cannot read ${target}: ${detail(info)}`);
    const xml = await virsh(['dumpxml', target], { timeoutMs: 20000 });
    const parsed = { ...parseDomainInfo(info.stdout), ...(xml.ok ? parseDomainXml(xml.stdout) : {}) };
    return {
      status: 'ok',
      backend: 'kvm',
      connection: config.libvirtUri,
      vm: {
        ...parsed,
        running: parsed.state === 'running',
        note: parsed.state === 'running'
          ? 'State is the hypervisor state, not proof that the guest OS finished booting.'
          : undefined,
      },
    };
  }

  async function start({ vm }) {
    const target = assertVm(vm);
    if(config.platform==='linux'){
      if(config.backend==='kvm'){const active=await vbox(['list','runningvms']);if(active.ok&&active.stdout.trim())throw new Error('A VirtualBox VM is active. Shut it down before starting KVM (VERR_SVM_IN_USE).');}
      else for(const uri of ['qemu:///session','qemu:///system']){const active=await exec('virsh',['-c',uri,'list','--name']);if(active.ok&&active.stdout.trim())throw new Error('A KVM VM is active. Shut it down before starting VirtualBox (VERR_SVM_IN_USE).');}
    }
    const result = config.backend === 'kvm'
      ? await virsh(['start', target], { timeoutMs: 60000 })
      : await vbox(['startvm', target, '--type', 'headless'], { timeoutMs: 90000 });
    if (!result.ok) throw new Error(`Could not start ${target}: ${detail(result)}`);
    const after = await status({ vm: target }).catch(() => null);
    return {
      status: 'start_requested',
      vm: target,
      backend: config.backend,
      state: after?.vm?.state,
      note: 'Started headless. Use remote_vm_screenshot to confirm the guest screen; boot may still be in progress.',
    };
  }

  async function stop({ vm, force = false }) {
    const target = assertVm(vm);
    if(config.platform==='linux'){
      if(config.backend==='kvm'){const active=await vbox(['list','runningvms']);if(active.ok&&active.stdout.trim())throw new Error('A VirtualBox VM is active. Shut it down before starting KVM (VERR_SVM_IN_USE).');}
      else for(const uri of ['qemu:///session','qemu:///system']){const active=await exec('virsh',['-c',uri,'list','--name']);if(active.ok&&active.stdout.trim())throw new Error('A KVM VM is active. Shut it down before starting VirtualBox (VERR_SVM_IN_USE).');}
    }
    const result = config.backend === 'kvm'
      ? await virsh([force ? 'destroy' : 'shutdown', target], { timeoutMs: 90000 })
      : await vbox(['controlvm', target, force ? 'poweroff' : 'acpipowerbutton'], { timeoutMs: 60000 });
    if (!result.ok) throw new Error(`Could not stop ${target}: ${detail(result)}`);
    return {
      status: 'stop_requested',
      vm: target,
      backend: config.backend,
      force,
      note: force
        ? 'Forced power off can lose unsaved guest data. Prefer a graceful stop.'
        : 'Graceful shutdown requested. The guest decides when it actually powers off; check remote_vm_status.',
    };
  }

  async function screenshot({ vm, screen = 0, save_path, include_image = true }) {
    const target = assertVm(vm);
    const index = Math.round(positiveNumber(screen, 0, 0, 15));
    await fsx.mkdir(config.screenshotDir, { recursive: true, mode: 0o700 });
    const stem = `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const raw = path.join(config.screenshotDir, config.backend === 'virtualbox' ? `${stem}.png` : `${stem}.ppm`);
    try {
      const result = config.backend === 'kvm'
        ? await virsh(['screenshot', target, raw, '--screen', String(index)], { timeoutMs: 60000 })
        : await vbox(['controlvm', target, 'screenshotpng', raw], { timeoutMs: 60000 });
      if (!result.ok) {
        throw new Error(`Screenshot failed for ${target}: ${detail(result)}. The guest must be running, and a KVM guest needs a graphics device (VNC or SPICE).`);
      }
      const bytes = await fsx.readFile(raw);
      const image = toPng(bytes);
      if (image.png.length > MAX_SCREENSHOT_BYTES) throw new Error('Screenshot is larger than the 12 MB limit.');
      let saved;
      if (save_path) {
        const destination = path.resolve(String(save_path));
        if (!destination.toLowerCase().endsWith('.png')) throw new Error('save_path must end with .png');
        await fsx.mkdir(path.dirname(destination), { recursive: true });
        await fsx.writeFile(destination, image.png, { mode: 0o600 });
        saved = destination;
      }
      return {
        text: {
          status: 'ok',
          vm: target,
          backend: config.backend,
          screen: index,
          width: image.width,
          height: image.height,
          bytes: image.png.length,
          mime_type: 'image/png',
          saved_path: saved,
          captured_at: now().toISOString(),
          note: 'A picture of the guest screen taken by the hypervisor. It is not a live stream and does not prove the guest is responsive.',
        },
        images: include_image ? [{ mimeType: 'image/png', data: image.png.toString('base64') }] : [],
      };
    } finally {
      await fsx.rm(raw, { force: true });
    }
  }

  async function sendKeys({ vm, text = '', keys = [], hotkey = [], hold_time_ms }) {
    const target = assertVm(vm);
    const typed = String(text || '');
    const named = Array.isArray(keys) ? keys : [];
    const chord = chordKeys(hotkey);
    if (!typed && !named.length && !chord.length) throw new Error('Provide text to type, named keys, or both.');
    if (typed.length > 2000) throw new Error('Type at most 2000 characters per call.');
    if (config.backend === 'virtualbox') {
      if (typed) {
        const result = await vbox(['controlvm', target, 'keyboardputstring', typed], { timeoutMs: 30000 });
        if (!result.ok) throw new Error(`Could not type into ${target}: ${detail(result)}`);
      }
      const scan = [];
      const chordCodes = chord.map(({ key }) => SCANCODES[key]);
      if (chordCodes.some(code => code === undefined)) throw new Error('Unsupported VirtualBox hotkey');
      const unsupported = [];
      for (const key of named) {
        const code = SCANCODES[String(key).toLowerCase().replace(/[\s_-]/g, '')];
        if (code === undefined) {
          unsupported.push(String(key));
          continue;
        }
        if (code > 0xff) scan.push('e0');
        scan.push((code & 0xff).toString(16).padStart(2, '0'));
        if (code > 0xff) scan.push('e0');
        scan.push(((code & 0xff) | 0x80).toString(16).padStart(2, '0'));
      }
      for (const code of chordCodes) {
        if (code > 0xff) scan.push('e0');
        scan.push((code & 0xff).toString(16).padStart(2, '0'));
      }
      for (const code of [...chordCodes].reverse()) {
        if (code > 0xff) scan.push('e0');
        scan.push(((code & 0xff) | 0x80).toString(16).padStart(2, '0'));
      }
      if (scan.length) {
        const result = await vbox(['controlvm', target, 'keyboardputscancode', ...scan], { timeoutMs: 30000 });
        if (!result.ok) throw new Error(`Could not press keys in ${target}: ${detail(result)}`);
      }
      if (unsupported.length) throw new Error(`Unsupported keys for VirtualBox: ${unsupported.join(', ')}`);
      return { status: 'ok', vm: target, typed_characters: typed.length, keys: named, note: 'Input was delivered to the guest keyboard device; the guest application may still ignore it.' };
    }
    const { events, unsupported } = keyEvents({ text: typed, keys: named });
    events.push(...chord.map(({ qcode }) => ({ type: 'key', data: { down: true, key: { type: 'qcode', data: qcode } } })),
      ...[...chord].reverse().map(({ qcode }) => ({ type: 'key', data: { down: false, key: { type: 'qcode', data: qcode } } })));
    if (!events.length) throw new Error('No supported characters or keys were provided.');
    for (let index = 0; index < events.length; index += 8) {
      await qmp(target, { execute: 'input-send-event', arguments: { events: events.slice(index, index + 8) } });
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(15, Number(hold_time_ms) || 15))));
    }
    return {
      status: 'ok',
      vm: target,
      typed_characters: typed.length,
      keys: named,
      events: events.length,
      unsupported: unsupported.length ? unsupported : undefined,
      note: unsupported.length ? 'Unsupported characters were skipped; only a US keyboard layout is mapped.' : undefined,
    };
  }

  async function mouseClick({ vm, x = 0.5, y = 0.5, button = 'left', double = false }) {
    const target = assertVm(vm);
    if (!CLICK_BUTTONS.includes(button)) throw new Error(`Unsupported button "${button}".`);
    if (config.backend === 'virtualbox' && config.repo) {
      const measured = await screenshot({ vm: target, include_image: false });
      const { width, height } = measured.text;
      const px = Math.round(positiveNumber(x, 0.5, 0, 1) * (width - 1));
      const py = Math.round(positiveNumber(y, 0.5, 0, 1) * (height - 1));
      const script = await packerModule.resolveRuntimeAsset(config.repo, 'backends/virtualbox/mouse_click.py');
      const result = await exec(config.python, [script, target, String(px), String(py), button, ...(double ? ['--double'] : [])]);
      if (!result.ok) throw new Error(`VirtualBox mouse input failed: ${detail(result)}`);
      return { status: 'ok', vm: target, backend: 'virtualbox', pixels: [px, py],
        note: 'SDK input dispatched; verify the application result with a fresh screenshot.' };
    }
    if (config.backend === 'virtualbox') {
      return {
        status: 'unsupported',
        vm: target,
        backend: 'virtualbox',
        message: 'KVM uses QEMU absolute input. VirtualBox requires --repo pointing to VAMP and --python with the matching VirtualBox SDK installed.',
      };
    }
    const events = clickEvents({ x: positiveNumber(x, 0.5, 0, 1), y: positiveNumber(y, 0.5, 0, 1), button, double: Boolean(double) });
    // USB tablets can coalesce down/up pairs from a single monitor batch.
    await qmp(target, { execute: 'input-send-event', arguments: { events: events.slice(0, 2) } });
    for (let index = 2; index < events.length; index += 2) {
      try {
        await qmp(target, { execute: 'input-send-event', arguments: { events: [events[index]] } });
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      finally { await qmp(target, { execute: 'input-send-event', arguments: { events: [events[index + 1]] } }); }
      if (index + 2 < events.length) await new Promise(resolve => setTimeout(resolve, 100));
    }
    return {
      status: 'ok',
      vm: target,
      x: positiveNumber(x, 0.5, 0, 1),
      y: positiveNumber(y, 0.5, 0, 1),
      button,
      double: Boolean(double),
      note: 'Coordinates are fractions of the guest screen, so they follow the last screenshot. The guest needs an absolute pointing device (USB tablet); otherwise the click is ignored.',
    };
  }

  async function mouseMove({vm, x = 0.5, y = 0.5}) {
    const target = assertVm(vm);
    const fx = positiveNumber(x, .5, 0, 1), fy = positiveNumber(y, .5, 0, 1);
    if (config.backend === 'kvm') {
      await qmp(target, {execute:'input-send-event', arguments:{events:clickEvents({x:fx,y:fy}).slice(0,2)}});
    } else {
      if (!config.repo) return {status:'unsupported',message:'VirtualBox move requires --repo and a matching Python SDK'};
      const measured = await screenshot({vm:target, include_image:false});
      const script = await packerModule.resolveRuntimeAsset(config.repo, 'backends/virtualbox/mouse_move.py');
      const result = await exec(config.python, [script,target,
        String(Math.round(fx*(measured.text.width-1))),String(Math.round(fy*(measured.text.height-1)))]);
      if (!result.ok) throw new Error(`VirtualBox mouse move failed: ${detail(result)}`);
    }
    return {status:'ok',vm:target,x:fx,y:fy,action:'move',note:'Input dispatched; observe the guest to verify.'};
  }

  async function rpaRun({ registry, id, vm_id, inputs = {}, confirmed = false, dry_run = false, timeout_ms, vault_destination }) {
    const registryPath = String(registry || config.registry || '');
    if (!config.repo) throw new Error('The VAMP repository path is not configured on the remote host (remoteRepo). Run remote_env_setup or set vamp.remote.remoteRepo.');
    if (!UUID_PATTERN.test(String(id || ''))) throw new Error('A saved RPA UUID is required.');
    if (!UUID_PATTERN.test(String(vm_id || ''))) throw new Error('A target VM UUID is required.');
    if (confirmed !== true && dry_run !== true) {
      return {
        status: 'needs_confirmation',
        message: 'Replaying a saved RPA drives the guest. Ask the user for authorization, confirm the declared inputs, then call again with confirmed=true.',
      };
    }
    if (vault_destination !== undefined && (typeof vault_destination !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(vault_destination))) {
      throw new Error('Provide a valid destination name from the remote Vault host.');
    }
    const needsVault = Boolean(vault_destination) && dry_run !== true;
    const vaultBridge = !needsVault ? null : process.env.VAULT_RPA_BRIDGE_SOCKET && process.env.VAULT_RPA_BRIDGE_TOKEN
      ? {socketPath:process.env.VAULT_RPA_BRIDGE_SOCKET,token:process.env.VAULT_RPA_BRIDGE_TOKEN}
      : await remoteReplayEndpoint();
    if (needsVault && !vaultBridge) {
      return {status:'approval_required',actions_completed:0,message:'The remote host has no approved Vault replay bridge.'};
    }
    const payload = {
      id,
      vm_id,
      inputs,
      confirmed: dry_run !== true,
      dry_run: dry_run === true,
      registry: registryPath,
      libvirt_uri: config.libvirtUri,
      ...(vaultBridge && {vault_destination}),
    };
    const script = await packerModule.resolveRuntimeAsset(config.repo, 'backends/library/replay.py');
    let parsed = null;
    if (vaultBridge) {
      parsed=await runWithVault(config.python,script,payload,{
        ...vaultBridge,timeoutMs:Math.max(1000,Math.min(Number(timeout_ms)||610000,610000)),
      });
    } else {
      const result = await exec(config.python, [script], {
        input: JSON.stringify(payload),
        timeoutMs: Math.min(Number(timeout_ms) || 610000, 900000),
      });
      try {
        parsed = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
      } catch {
        throw new Error(`RPA replay did not return a result: ${detail(result, 'no output')}`);
      }
      if (!parsed) throw new Error('RPA replay did not return a result.');
    }
    return {
      status: parsed.status || 'unknown',
      backend: config.backend,
      vm_id,
      rpa_id: id,
      result: parsed,
      note: 'completed_unverified means the recorded actions ran, not that the application outcome was verified.',
    };
  }

  async function envCheck() {
    const checks = [];
    const add = (id, label, state, value, fix) => checks.push({ id, label, status: state, detail: value, fix });
    add('platform', 'Remote host operating system', 'ok', `${config.platform} ${process.arch}`, config.platform === 'win32' ? 'Native VirtualBox stdio is supported. For native Windows SSH use an explicit PowerShell launch command; the extension automatic uploader uses a POSIX shell.' : undefined);
    const nodeVersion = process.versions.node;
    add('node', 'Node.js runtime for this server', compare(nodeVersion, '20.0.0') >= 0 ? 'ok' : 'warn', `v${nodeVersion}`, compare(nodeVersion, '20.0.0') >= 0 ? undefined : 'Node.js 20 or newer is recommended on the remote host.');

    const pythonVersion = await exec(config.python, ['-c', 'import sys;print("%d.%d.%d"%sys.version_info[:3])'], { timeoutMs: 15000 });
    const python = pythonVersion.ok ? pythonVersion.stdout.trim() : '';
    add('python', 'Python for RPA replay', python && compare(python, '3.11.0') >= 0 ? 'ok' : python ? 'warn' : 'missing', python || detail(pythonVersion), python && compare(python, '3.11.0') >= 0 ? undefined : `Install Python 3.11+ (3.15 and newer work too) and set remotePython (${config.python}).`);

    if (config.backend === 'kvm') {
      const libvirtVersion = await exec('virsh', ['--version'], { timeoutMs: 15000 });
      add('virsh', 'libvirt client (virsh)', libvirtVersion.ok ? 'ok' : 'missing', libvirtVersion.ok ? libvirtVersion.stdout.trim() : 'virsh not found', libvirtVersion.ok ? undefined : 'Install libvirt-clients / libvirt-client.');
      const connection = await virsh(['list', '--all', '--uuid'], { timeoutMs: 30000 });
      add('libvirt', `libvirt connection ${config.libvirtUri}`, connection.ok ? 'ok' : 'failed', connection.ok ? `${parseDomainIds(connection.stdout).length} domain(s) visible` : detail(connection), connection.ok ? undefined : 'Start libvirtd and make sure this user may connect to the URI (libvirt group or qemu+ssh).');
      for (const [id, label, args] of [['virt-install', 'virt-install (new desktops)', ['--version']], ['qemu-img', 'qemu-img (disk images)', ['--version']]]) {
        const probe = await exec(id, args, { timeoutMs: 15000 });
        add(id, label, probe.ok ? 'ok' : 'warn', probe.ok ? probe.stdout.trim().split(/\r?\n/)[0] : 'not found', probe.ok ? undefined : 'Only needed to create new desktops from this host.');
      }
    } else {
      const version = await vbox(['--version'], { timeoutMs: 20000 });
      add('vboxmanage', 'VBoxManage', version.ok ? 'ok' : 'missing', version.ok ? version.stdout.trim() : `${config.vboxManage} not found`, version.ok ? undefined : 'Install VirtualBox on the remote host or set vamp.remote.remoteVboxManage.');
      const listed = version.ok ? await vbox(['list', 'vms'], { timeoutMs: 30000 }) : { ok: false, stdout: '' };
      add('vbox-vms', 'VirtualBox inventory readable', listed.ok ? 'ok' : 'failed', listed.ok ? `${parseVmList(listed.stdout).length} VM(s)` : 'could not list VMs', listed.ok ? undefined : 'The SSH user must be able to run VBoxManage for the account that owns the VMs.');
    }

    const replay = config.repo ? await packerModule.resolveRuntimeAsset(config.repo, 'backends/library/replay.py', {cacheOnly:true}) : '';
    let replayOk = false;
    if (replay) {
      replayOk = await fsx.access(replay).then(() => true).catch(() => false);
    }
    add('repo', 'VAMP repository for RPA replay', replayOk ? 'ok' : config.repo ? 'failed' : 'warn', config.repo ? `${config.repo}${replayOk ? '' : ' (replay.py missing)'}` : 'not configured', replayOk ? undefined : 'Set remoteRepo to the VAMP checkout on the remote host to run saved RPAs; VM lifecycle and screenshots work without it.');

    const writable = await fsx.mkdir(config.workdir, { recursive: true, mode: 0o700 })
      .then(() => fsx.writeFile(path.join(config.workdir, '.write-probe'), 'ok', { mode: 0o600 }))
      .then(() => fsx.rm(path.join(config.workdir, '.write-probe'), { force: true }))
      .then(() => true)
      .catch(() => false);
    add('workdir', 'Server work directory', writable ? 'ok' : 'failed', config.workdir, writable ? undefined : 'Create the directory with write permission for this SSH user.');

    try {
      const stats = fsx.statfs ? await fsx.statfs(config.workdir) : null;
      if (stats) {
        const freeGb = (Number(stats.bavail) * Number(stats.bsize)) / 1024 ** 3;
        add('disk', 'Free disk space', freeGb >= 5 ? 'ok' : 'warn', `${freeGb.toFixed(1)} GB available`, freeGb >= 5 ? undefined : 'Guest disks need space; free some room before creating new desktops.');
      }
    } catch {
      // statfs is unavailable on older Node.js builds; not a failure.
    }

    const blockers = checks.filter(check => check.status === 'failed' || (check.status === 'missing' && ['virsh', 'vboxmanage', 'libvirt', 'python'].includes(check.id)));
    return {
      status: 'ok',
      backend: config.backend,
      ready: blockers.length === 0,
      checked_at: now().toISOString(),
      environment: describeConfig(config),
      checks,
      blockers: blockers.map(check => ({ id: check.id, detail: check.detail, fix: check.fix })),
      next_step: blockers.length ? 'Fix the blockers, then call remote_env_setup or run it again.' : 'Environment looks usable. remote_vm_list lists desktops.',
    };
  }

  async function envSetup({ install_packages = true, python_venv = true, dry_run = false } = {}) {
    const steps = [];
    const record = (id, label, state, command, extra = {}) => {
      steps.push({ id, label, status: state, command: Array.isArray(command) ? command.join(' ') : command, ...extra });
    };
    const runStep = async (id, label, command, timeoutMs = 300000) => {
      if (dry_run) {
        record(id, label, 'planned', command);
        return { ok: true, planned: true };
      }
      const [exe, ...args] = command;
      const result = await exec(exe, args, { timeoutMs });
      record(id, label, result.ok ? 'done' : 'failed', command, result.ok ? undefined : { error: detail(result) });
      return result;
    };

    if (!dry_run) {
      await fsx.mkdir(config.workdir, { recursive: true, mode: 0o700 }).catch(() => {});
      await fsx.writeFile(config.configFile, `${JSON.stringify(describeConfig(config), null, 2)}\n`, { mode: 0o600 }).catch(() => {});
    }
    record('workdir', 'Work directory and server configuration', dry_run ? 'planned' : 'done', config.workdir);

    // The label states the range so a newer interpreter (3.15, 3.16) is not
    // mistaken for an unsupported one; the comparison itself is numeric.
    const pythonProbe = await exec(config.python, ['-c', 'import sys;print("%d.%d.%d"%sys.version_info[:3])'], { timeoutMs: 15000 });
    if (!pythonProbe.ok) {
      record('python', 'Python 3.11+ (3.15+ supported)', 'needs_manual', `${config.python} -V`, { fix: 'Install Python 3.11 or newer (3.15 and newer work too) on the remote host, then run setup again.' });
    } else if (compare(pythonProbe.stdout.trim(), '3.11') < 0) {
      record('python', 'Python 3.11+ (3.15+ supported)', 'needs_manual', `${config.python} -V`, { fix: `Detected Python ${pythonProbe.stdout.trim()}. Install 3.11 or newer and set remotePython.` });
    } else {
      record('python', 'Python 3.11+ (3.15+ supported)', 'ok', `Python ${pythonProbe.stdout.trim()}`);
      if (python_venv) {
        const venv = path.join(config.workdir, 'venv');
        const exists = await fsx.access(path.join(venv, config.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')).then(() => true).catch(() => false);
        if (exists) {
          record('venv', 'Python virtual environment', 'skipped', venv, { note: 'Already present.' });
        } else {
          await runStep('venv', 'Create Python virtual environment', [config.python, '-m', 'venv', venv], 180000);
        }
        const requirements = config.repo ? path.join(config.repo, 'requirements-mcp.txt') : '';
        const hasRequirements = requirements ? await fsx.access(requirements).then(() => true).catch(() => false) : false;
        if (hasRequirements) {
          const venvPython = path.join(venv, config.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
          await runStep('requirements', 'Install VAMP MCP requirements in the remote venv', [venvPython, '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', requirements], 900000);
        } else {
          record('requirements', 'VAMP MCP requirements', 'skipped', 'requirements-mcp.txt not found', { note: 'Set remoteRepo to the VAMP checkout to install replay dependencies.' });
        }
      }
    }

    if (config.backend === 'kvm') {
      const hasVirsh = (await exec('virsh', ['--version'], { timeoutMs: 15000 })).ok;
      if (hasVirsh) {
        record('virsh', 'libvirt client', 'ok', 'virsh present');
      } else if (!install_packages) {
        record('virsh', 'libvirt client', 'needs_manual', 'install libvirt', { fix: 'Install libvirt-clients (Debian/Ubuntu) or libvirt-client (Fedora/RHEL).' });
      } else {
        const managers = await Promise.all(['apt-get', 'dnf', 'yum', 'zypper', 'pacman'].map(async name => [name, (await exec('sh', ['-c', `command -v ${name}`], { timeoutMs: 10000 })).ok]));
        const manager = managers.find(([, found]) => found)?.[0];
        const sudo = await exec('sudo', ['-n', 'true'], { timeoutMs: 10000 });
        const installs = {
          'apt-get': ['apt-get', 'install', '-y', 'qemu-kvm', 'libvirt-daemon-system', 'libvirt-clients', 'virtinst', 'qemu-utils', 'osinfo-db', 'libosinfo-bin', 'ovmf', 'swtpm'],
          dnf: ['dnf', 'install', '-y', 'qemu-kvm', 'libvirt-daemon-config-network', 'libvirt-daemon-kvm', 'virt-install', 'qemu-img'],
          yum: ['yum', 'install', '-y', 'qemu-kvm', 'libvirt', 'libvirt-client', 'virt-install', 'qemu-img'],
          zypper: ['zypper', '--non-interactive', 'install', 'qemu-kvm', 'libvirt', 'virt-install'],
          pacman: ['pacman', '-S', '--noconfirm', 'libvirt', 'qemu-full'],
        };
        const command = manager ? installs[manager] : ['apt-get', 'install', '-y', 'qemu-kvm', 'libvirt-daemon-system', 'libvirt-clients', 'virtinst'];
        if (!sudo.ok) {
          record('libvirt-install', 'Install libvirt and QEMU', 'needs_manual', command, {
            fix: `Passwordless sudo is not available. Run this on the remote host as an administrator: sudo ${command.join(' ')}`,
          });
        } else {
          await runStep('libvirt-install', 'Install libvirt and QEMU', ['sudo', '-n', ...command], 900000);
          await runStep('libvirtd', 'Enable and start libvirtd', ['sudo', '-n', 'systemctl', 'enable', '--now', 'libvirtd'], 120000);
          const user = process.env.USER || process.env.LOGNAME || '';
          if (user) {
            await runStep('libvirt-group', 'Allow this user to manage system VMs', ['sudo', '-n', 'usermod', '-aG', 'libvirt', user], 60000);
            record('relogin', 'Session refresh', 'needs_manual', `log out and back in as ${user}`, { note: 'Group membership applies to new SSH sessions.' });
          }
        }
      }
      if (dry_run) {
        record('libvirt', `libvirt connection ${config.libvirtUri}`, 'planned', `virsh -c ${config.libvirtUri} list --all`);
      } else {
        const connection = await virsh(['list', '--all', '--uuid'], { timeoutMs: 30000 });
        record('libvirt', `libvirt connection ${config.libvirtUri}`, connection.ok ? 'ok' : 'failed', `virsh -c ${config.libvirtUri} list --all`, connection.ok ? { note: `${parseDomainIds(connection.stdout).length} domain(s) visible` } : { error: detail(connection) });
      }
    } else {
      const version = await vbox(['--version'], { timeoutMs: 20000 });
      const vboxState = dry_run ? 'planned' : version.ok ? 'ok' : 'needs_manual';
      record('vboxmanage', 'VBoxManage', vboxState, `${config.vboxManage} --version`, dry_run
        ? undefined
        : version.ok
          ? { note: version.stdout.trim() }
          : { fix: 'Install VirtualBox on the remote host (https://www.virtualbox.org/wiki/Downloads), then set remoteVboxManage if it is not on PATH.' });
    }

    const runtime=config.repo||config.workdir;
    const packerScript=dry_run?'backends/packer/runner.py':await packerModule.resolveRuntimeAsset(runtime,'backends/packer/runner.py');
    await runStep('packer','Install HashiCorp Packer CLI and official hypervisor plugin',[config.python||'python3',packerScript,'prepare','--backend',config.backend],600000);
    const failed = steps.filter(step => step.status === 'failed');
    const manual = steps.filter(step => step.status === 'needs_manual');
    return {
      status: failed.length ? 'incomplete' : manual.length ? 'needs_attention' : 'ok',
      dry_run: Boolean(dry_run),
      backend: config.backend,
      steps,
      next_step: failed.length
        ? 'Read the failed steps. Nothing was removed; fix the reported command and run setup again.'
        : manual.length ? 'Some steps need an administrator or a manual install; the rest is ready.' : 'Remote environment is ready. Verify with remote_env_check.',
    };
  }

  async function createVm(args = {}) {
    hostSupport.requireBackendHost(config.backend,config.platform);
    if (args.confirmed !== true) return {status:'needs_confirmation',vm_created:false,message:'Authorize creation and startup, then pass confirmed:true with a host ISO path.'};
    const guest_os=args.guest_os ?? 'debian';
    if (!['debian','ubuntu','windows11'].includes(guest_os)) throw new Error('Unsupported guest_os');
    if (guest_os==='windows11' && args.windows_confirmed!==true) return {status:'needs_windows_confirmation',vm_created:false,message:'Windows requires your own valid license and explicit windows_confirmed:true.'};
    if (typeof args.name!=='string' || !/^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test(args.name)) throw new Error('Invalid VM name');
    if (typeof args.iso_path!=='string' || !path.isAbsolute(args.iso_path)) throw new Error('Choose an absolute host ISO path');
    if(args.bootstrap_host!==undefined&&config.backend!=='kvm')throw new Error('bootstrap_host is only configurable for KVM on this host.');
    const values={memory_mb:args.memory_mb ?? (guest_os==='windows11'?4096:2048),cpus:args.cpus ?? 2,disk_mb:args.disk_mb ?? 256000};
    for (const [key,min,max] of [['memory_mb',guest_os==='windows11'?4096:2048,131072],['cpus',1,64],['disk_mb',32768,2097152]]) {
      if (!Number.isInteger(values[key]) || values[key]<min || values[key]>max) throw new Error(`Invalid ${key}: expected integer ${min}..${max}`);
    }
    const lifecycle=(await import('../common/host-backends.cjs')).default;
    const adapter=lifecycle.hostBackends({globalStorageUri:{fsPath:config.workdir}},{
      runtime:config.repo || config.workdir,python:()=>config.python||(process.platform==='win32'?'python':'python3'),platform:config.platform,config:()=>({get:key=>key==='libvirtUri'?config.libvirtUri:key==='kvmPythonExecutable'?config.python:undefined}),
      execute:(exe,argv,options)=>run(exe,argv,{timeoutMs:options.timeout}),
    });
    const created=await adapter.create(config.backend,{name:args.name,iso_path:args.iso_path,guest_os,installation_mode:args.installation_mode,windows_confirmed:args.windows_confirmed,bootstrap_host:args.bootstrap_host,...values});
    return { ...created,backend:config.backend,guest_os,os_installation_completed:false,guest_setup_completed:false,
      next_action:'Packer build queued. Use remote_golden_images for completion status, file paths, sizes and logs. Public sandbox autologin: vboxuser / password123!.'};
  }

  const packer=packerModule.packer({runtime:config.repo||config.workdir,python:()=>config.python||(process.platform==='win32'?'python':'python3')});
  const tools = [
    {name:'remote_packer_prepare',description:'Download the managed Packer CLI and selected official plugin on this host; creates no VM.',inputSchema:{type:'object',properties:{},additionalProperties:false},handler:()=>packer('prepare',{backend:config.backend})},
    {name:'remote_golden_images',description:'List golden image build status, absolute paths and byte sizes on this host.',inputSchema:{type:'object',properties:{},additionalProperties:false},handler:()=>packer('images')},
    {name:'remote_golden_image_delete',description:'Delete a VAMP golden image by ID. Without confirmed returns path/size; get explicit user approval before confirmed:true. Live VM disks are separate.',inputSchema:{type:'object',properties:{id:{type:'string',pattern:'^[a-f0-9]{32}$'},confirmed:{type:'boolean',default:false}},required:['id'],additionalProperties:false},handler:args=>packer('delete-image',args)},
    {
      name: 'remote_env_check',
      title: 'Check the remote host environment',
      description: 'Verify Node.js, Python, libvirt/VirtualBox, the VAMP repository and disk space on the machine running this server. Read-only.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => envCheck(),
    },
    {
      name: 'remote_env_setup',
      title: 'Prepare the remote host environment',
      description: 'Create the work directory and Python venv, install libvirt/QEMU or report VirtualBox installation steps, and verify the hypervisor connection. Uses passwordless sudo when available and never removes existing data.',
      inputSchema: {
        type: 'object',
        properties: {
          install_packages: { type: 'boolean', description: 'Try to install missing hypervisor packages with passwordless sudo.', default: true },
          python_venv: { type: 'boolean', description: 'Create a Python venv and install VAMP MCP requirements when the repository is configured.', default: true },
          dry_run: { type: 'boolean', description: 'Only list the commands that would run.', default: false },
        },
        additionalProperties: false,
      },
      handler: args => envSetup(args),
    },
    {
      name: 'remote_vm_create',
      title: 'Create a VM with HashiCorp Packer',
      description: 'Create and deploy a new VM with the selected hypervisor through the same Packer runner as VS Code. Requires confirmed:true. HashiCorp Packer installs Debian/Windows and post-install scripts, waits 60s after reboot, exports a golden image and deploys a separate live disk. Windows requires windows_confirmed:true and your own license. Public sandbox autologin vboxuser/password123!.',
      inputSchema: {type:'object',properties:{
        name:{type:'string',pattern:'^[A-Za-z][A-Za-z0-9_-]{0,62}$'},iso_path:{type:'string',description:'Absolute ISO path on the host running this server'},
        guest_os:{type:'string',enum:['debian','windows11'],default:'debian'},bootstrap_host:{type:'string',format:'ipv4',description:'Optional guest-reachable IPv4 for the KVM Packer build only. Leave unset for the QEMU NAT default.'},installation_mode:{type:'string',enum:['auto','unattended']},
        memory_mb:{type:'integer',minimum:2048,maximum:131072},cpus:{type:'integer',minimum:1,maximum:64},disk_mb:{type:'integer',minimum:32768,maximum:2097152},
        confirmed:{type:'boolean',default:false},windows_confirmed:{type:'boolean',default:false}
      },required:['name','iso_path'],additionalProperties:false},
      handler: args => createVm(args),
    },
    {
      name: 'remote_vm_list',
      title: 'List remote desktops',
      description: 'List the virtual machines on the remote hypervisor with state, memory and CPU count.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => list(),
    },
    {
      name: 'remote_vm_status',
      title: 'Read one remote desktop',
      description: 'Detailed state of one remote VM, including disks, graphics endpoint and network devices. Hypervisor state is not proof that the guest booted.',
      inputSchema: {
        type: 'object',
        properties: { vm: { type: 'string', description: 'VM name or UUID.' } },
        required: ['vm'],
        additionalProperties: false,
      },
      handler: args => status(args),
    },
    {
      name: 'remote_vm_start',
      title: 'Start a remote desktop',
      description: 'Start a remote VM headless. Confirm with remote_vm_screenshot; a started VM may still be booting.',
      inputSchema: {
        type: 'object',
        properties: { vm: { type: 'string', description: 'VM name or UUID.' } },
        required: ['vm'],
        additionalProperties: false,
      },
      handler: args => start(args),
    },
    {
      name: 'remote_vm_stop',
      title: 'Stop a remote desktop',
      description: 'Request a graceful guest shutdown. force=true powers the VM off and can lose unsaved guest data, so use it only on an explicit instruction.',
      inputSchema: {
        type: 'object',
        properties: {
          vm: { type: 'string', description: 'VM name or UUID.' },
          force: { type: 'boolean', description: 'Power off instead of asking the guest to shut down.', default: false },
        },
        required: ['vm'],
        additionalProperties: false,
      },
      handler: args => stop(args),
    },
    {
      name: 'remote_vm_screenshot',
      title: 'Capture a remote desktop screenshot',
      description: 'Capture the guest screen from the remote hypervisor and return it as a PNG image. There is no live stream: capture again for a newer frame.',
      inputSchema: {
        type: 'object',
        properties: {
          vm: { type: 'string', description: 'VM name or UUID.' },
          screen: { type: 'number', description: 'Screen index for multi-monitor guests.', default: 0 },
          save_path: { type: 'string', description: 'Optional .png path on the remote host to keep a copy.' },
          include_image: { type: 'boolean', description: 'Return the image data. Set false to only measure the screen.', default: true },
        },
        required: ['vm'],
        additionalProperties: false,
      },
      handler: args => screenshot(args),
    },
    {
      name: 'remote_vm_send_keys',
      title: 'Type into a remote desktop',
      description: 'Type text and press named keys in the guest keyboard, mapped for a US layout. Unsupported characters are skipped and reported.',
      inputSchema: {
        type: 'object',
        properties: {
          vm: { type: 'string', description: 'VM name or UUID.' },
          text: { type: 'string', description: 'Literal text to type.' },
          keys: { type: 'array', items: { type: 'string' }, description: 'Sequential key presses, such as enter or tab.' },
          hotkey: { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'Simultaneous chord after text/keys, e.g. ["super","r"] or ["ctrl","p"].' },
          hold_time_ms: { type: 'number', description: 'Pause between batches of key events.' },
        },
        required: ['vm'],
        additionalProperties: false,
      },
      handler: args => sendKeys(args),
    },
    {
      name:'remote_vm_mouse_move',title:'Move the remote guest pointer',
      description:'Move the guest absolute pointer without clicking. Fractions match the guest screenshot; VirtualBox needs --repo and matching SDK.',
      inputSchema:{type:'object',properties:{vm:{type:'string'},x:{type:'number',minimum:0,maximum:1},y:{type:'number',minimum:0,maximum:1}},required:['vm','x','y'],additionalProperties:false},
      handler: args => mouseMove(args),
    },
    {
      name: 'remote_vm_mouse_click',
      title: 'Click in a remote desktop',
      description: 'Click at a point given as fractions of the guest screen (0-1), so it matches the last screenshot. Requires an absolute pointing device; VirtualBox also needs --repo and a Python SDK runtime.',
      inputSchema: {
        type: 'object',
        properties: {
          vm: { type: 'string', description: 'VM name or UUID.' },
          x: { type: 'number', description: 'Horizontal position, 0 = left edge, 1 = right edge.', default: 0.5 },
          y: { type: 'number', description: 'Vertical position, 0 = top edge, 1 = bottom edge.', default: 0.5 },
          button: { type: 'string', enum: CLICK_BUTTONS, default: 'left' },
          double: { type: 'boolean', default: false },
        },
        required: ['vm'],
        additionalProperties: false,
      },
      handler: args => mouseClick(args),
    },
    {
      name: 'remote_rpa_run',
      title: 'Replay a reviewed RPA on a remote desktop',
      description: 'Run a reviewed saved VAMP RPA on the remote host with the repository replay engine. Requires explicit confirmation and the declared inputs.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Saved RPA UUID.' },
          vm_id: { type: 'string', description: 'Target VM UUID.' },
          inputs: { type: 'object', description: 'Exact declared input values.', additionalProperties: { type: 'string' } },
          registry: { type: 'string', description: 'Optional RPA registry folder on the remote host.' },
          confirmed: { type: 'boolean', description: 'True only after the user authorized this run.', default: false },
          dry_run: { type: 'boolean', description: 'Check reviewed Vault references on the remote host without starting replay.', default: false },
          vault_destination: { type:'string', description:'Destination name in the Vault configured on the remote RPA host.', pattern:'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' },
          timeout_ms: { type: 'number', description: 'Replay timeout in milliseconds.' },
        },
        required: ['id', 'vm_id'],
        additionalProperties: false,
      },
      handler: args => rpaRun(args),
    },
  ];

  return { tools, envCheck, envSetup, list, status, start, stop, screenshot, sendKeys, mouseClick, mouseMove, rpaRun };
}
