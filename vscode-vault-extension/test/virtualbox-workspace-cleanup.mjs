import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { reconcileVirtualBoxDisks, releaseWindowsVirtualBoxMount } from '../src/vm_volume.mjs';
import { withVmVolumeState } from '../src/vm_volume_state.mjs';

const vm = '01234567-89ab-cdef-0123-456789abcdef';
const imageId = '01234567-89ab-cdef-0123-456789abcdea';

test('Windows host cleanup waits for its exact container and retries a busy drive', async () => {
  const target = { volume: 'C:\\QA\\workspace.vc', mountPoint: 'X:\\' };
  const guard = { assertDetached: async checked => assert.deepEqual(checked, { ...target, detachedVolume: target.volume }) };
  let registered = 'Location: x:\\other.vhd';
  let mounted = [{ mount_point: 'X:', volume: 'C:\\QA\\other.vc' }];
  let busy = true;
  let attempts = 0;
  const cli = {
    listVolumes: async options => {
      assert.deepEqual(options, { requireBackingPaths: true });
      return { available: true, mounted };
    },
    unmountVolume: async options => {
      assert.deepEqual(options, { mountPoint: 'X:', unattended: true });
      attempts++;
      if (!busy) mounted = [];
      return { unmounted: !busy };
    },
  };
  const reconcile = () => releaseWindowsVirtualBoxMount(cli, guard, target, async args => {
    assert.deepEqual(args, ['list', 'hdds']);
    return { stdout: registered };
  });
  await assert.rejects(reconcile, /disk registered/);
  registered = '';
  await assert.rejects(reconcile, /does not match/);
  assert.equal(attempts, 0);
  mounted = [{ mount_point: 'X:', volume: target.volume }];
  await assert.rejects(reconcile, /busy/);
  busy = false;
  await reconcile();
  await reconcile();
  assert.equal(attempts, 2);
});

test('VirtualBox cleanup waits for power off and retries a busy guest disk after restart', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vamp-virtualbox-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const medium = path.join(directory, 'managed.vhd');
  const target = { backend: 'virtualbox', vm, controller: 'SATA', port: 1,
    medium, volume: medium, mountPoint: '' };
  let power = 'poweroff';
  let slot = medium;
  let busy = true;
  let changedAt = '2026-11-20T00:00:01.000000000';
  const commands = [];
  function execute(args) {
    commands.push(args);
    switch (args[0]) {
      case 'showvminfo':
        assert.deepEqual(args, ['showvminfo', vm, '--machinereadable']);
        return { stdout: [
          `UUID="${vm}"`, `VMState="${power}"`,
          `VMStateChangeTime="${changedAt}"`,
          'storagecontrollername0="SATA"', 'storagecontrollertype0="IntelAhci"',
          `"SATA-1-0"="${slot.replaceAll('\\', '\\\\')}"`,
        ].join('\n') };
      case 'storageattach':
        assert.equal(power, 'poweroff');
        assert.deepEqual(args, ['storageattach', vm, '--storagectl', 'SATA', '--port', '1',
          '--device', '0', '--type', 'hdd', '--medium', 'none']);
        slot = 'none';
        return {};
      case 'list':
        assert.deepEqual(args, ['list', 'hdds']);
        return { stdout: `UUID: ${imageId}\nLocation: ${medium}\n` };
      case 'closemedium':
        assert.deepEqual(args, ['closemedium', 'disk', imageId]);
        if (busy) throw new Error('Disk is in use.');
        return {};
      default:
        assert.fail(`Unexpected command: ${args.join(' ')}`);
    }
  }
  const state = work => withVmVolumeState(work, { directory });
  const reconcile = () => state(guard => reconcileVirtualBoxDisks(guard, execute));
  await state(guard => guard.beforeChange('attach', target));
  assert.deepEqual(await reconcile(), []);
  assert.deepEqual(commands.map(args => args[0]), ['showvminfo']);
  power = 'running';
  await reconcile();
  assert.equal(await state(guard => guard.beforeChange('detach', target)), true);
  power = 'paused';
  await reconcile();
  assert.equal(slot, medium);
  power = 'poweroff';
  slot = path.join(directory, 'unrelated.vhd');
  assert.equal((await reconcile())[0].status, 'pending');
  assert.equal(commands.filter(args => args[0] === 'storageattach').length, 0);
  slot = medium;
  assert.deepEqual(await reconcile(), [{ vm, status: 'pending', error: 'Disk is in use.' }]);
  assert.equal(slot, 'none');
  assert.equal((await state(guard => guard.registeredDisks()))[0].observedRunning, true);
  busy = false;
  assert.deepEqual(await reconcile(), [{ vm, status: 'detached' }]);
  assert.deepEqual(await state(guard => guard.registeredDisks()), []);
  assert.equal(commands.filter(args => args[0] === 'storageattach').length, 1);

  const host = { ...target, volume: path.join(directory, 'container.vc'), mountPoint: directory };
  await state(guard => guard.beforeChange('attach', { ...host, attachmentStateMs: Date.parse('2026-11-20T00:00:01Z') }));
  let otherWriter = true;
  let mountChecks = 0;
  const reconcileHost = () => state(guard => reconcileVirtualBoxDisks(guard, execute, async detached => {
    assert.deepEqual(detached, { volume: host.volume, mountPoint: host.mountPoint });
    assert.equal(slot, 'none');
    await guard.assertDetached({ ...detached, detachedVolume: host.volume });
    mountChecks++;
    if (otherWriter) throw new Error('A workspace consumer is still present.');
  }));
  slot = medium;
  assert.deepEqual(await reconcileHost(), []);
  assert.equal(mountChecks, 0);
  // Both the start and the external shutdown happened while the MCP was offline.
  changedAt = '2026-11-20T00:00:20.000000000';
  assert.deepEqual(await reconcile(), [{ vm, status: 'pending',
    error: 'The VM disk was detached. Host mount cleanup requires verification on this platform.' }]);
  assert.equal(slot, 'none');
  assert.equal((await state(guard => guard.registeredDisks()))[0].volume, host.volume);
  assert.deepEqual(await reconcileHost(), [{ vm, status: 'pending', error: 'A workspace consumer is still present.' }]);
  assert.equal((await state(guard => guard.registeredDisks()))[0].volume, host.volume);
  otherWriter = false;
  assert.deepEqual(await reconcileHost(), [{ vm, status: 'unmounted' }]);
  assert.deepEqual(await state(guard => guard.registeredDisks()), []);
});
