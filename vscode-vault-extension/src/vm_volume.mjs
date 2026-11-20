import { lstat, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from './downloader.mjs';

function parseState(output) {
  const fields = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(?:"([^"]+)"|([^=]+))="(.*)"$/.exec(line);
    if (match) {
      const unescape = value => value.replace(/\\([\\"])/g, '$1');
      fields.set(match[1] === undefined ? match[2] : unescape(match[1]), unescape(match[3]));
    }
  }
  return fields;
}

async function workspaceDisk(cli, {operation,vm,volume,mountPoint,disk,wsl=false}) {
  if (!['attach','detach'].includes(operation) || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(vm)
      || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\.vhd$/i.test(disk)) {
    throw new Error('Choose a VM UUID and VHD filename.');
  }
  if (!path.isAbsolute(volume) || !(wsl ? /^\/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+$/.test(mountPoint) : path.isAbsolute(mountPoint))) {
    throw new Error('Use absolute VeraCrypt volume and mount paths.');
  }
  const backing = await realpath(volume);
  const root = wsl ? mountPoint : await realpath(mountPoint);
  const source = wsl ? await cli.windowsVolumePathInWsl(backing) : backing;
  const distro = cli.env?.VAULT_VERACRYPT_WSL_DISTRO;
  if (wsl && !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,63}$/.test(distro ?? '')) throw new Error('Configure a WSL distribution first.');
  const hostRoot = wsl ? '\\\\wsl.localhost\\'+distro+root.replaceAll('/','\\') : root;
  const medium = path.join(hostRoot,disk);
  const matchesMount = item => {
    if (item.volume !== source) return false;
    if (item.mount_point === root) return true;
    return !wsl && process.platform === 'win32' && /^[a-z]:$/i.test(item.mount_point)
      && item.mount_point.toUpperCase() + '\\' === root.toUpperCase();
  };
  const inspectMount = async () => {
    const listing=wsl ? {available:true,mounted:await cli.listWslVolumes()} : await cli.listVolumes();
    if (!listing.available || listing.mounted.filter(matchesMount).length !== 1) {
      throw new Error('The requested VeraCrypt mount could not be verified.');
    }
    const [mount,file]=await Promise.all([stat(hostRoot),lstat(medium)]).catch(error=>{
      if (wsl && ['ENOENT','EACCES','EPERM'].includes(error.code)) {
        throw new Error('Windows could not access the mounted workspace disk through the WSL file share. For a Windows VM, use a managed local guest VHD.');
      }
      throw error;
    });
    if (!mount.isDirectory() || !file.isFile() || file.nlink!==1 || file.dev!==mount.dev) {
      throw new Error('Choose a regular VHD stored directly inside the verified VeraCrypt volume.');
    }
    return file;
  };
  const identity = await inspectMount();
  const stream = await open(medium,'r');
  try {
    const opened = await stream.stat();
    const footer = Buffer.alloc(512);
    if (opened.ino!==identity.ino || opened.dev!==identity.dev || opened.size<512
      || (await stream.read(footer,0,512,opened.size-512)).bytesRead!==512
      || footer.toString('ascii',0,8)!=='conectix' || ![2,3].includes(footer.readUInt32BE(60))) {
      throw new Error('The mounted file must be a fixed or dynamic VHD with no parent disk.');
    }
  } finally {
    await stream.close();
  }
  const recheck = async () => {
    const fresh=await inspectMount();
    if(fresh.ino!==identity.ino || fresh.dev!==identity.dev) throw new Error('The workspace disk changed before the operation.');
  };
  return { medium,recheck,volume:backing,mountPoint:root };
}

const executeVirtualBox = argv => run(process.env.VAULT_VBOXMANAGE || (process.platform==='win32'
    ? path.join(process.env.ProgramFiles || 'C:\\Program Files','Oracle/VirtualBox/VBoxManage.exe') : 'VBoxManage'),
    argv, { timeout: 30000 });

export async function releaseWindowsVirtualBoxMount(cli, guard, { volume, mountPoint }, execute = executeVirtualBox) {
  const drive = /^([a-z]:)\\?$/i.exec(mountPoint)?.[1].toUpperCase();
  if (!drive || !/^[a-z]:\\/i.test(volume)) throw new Error('The Windows workspace is not a local file-backed drive.');
  await guard.assertDetached({ volume, mountPoint, detachedVolume: volume });
  const { stdout } = await execute(['list', 'hdds']);
  if (stdout.split(/\r?\n/).some(line => {
    const location = /^Location:[ \t]*(.+)$/i.exec(line)?.[1].trim().replace(/^\\\\\?\\/, '');
    return location && path.win32.normalize(location).toUpperCase().startsWith(drive + '\\');
  })) throw new Error('VirtualBox still has a disk registered on the workspace drive.');
  const inspect = async () => {
    const observed = await cli.listVolumes({ requireBackingPaths: true });
    if (!observed.available) throw new Error('The host VeraCrypt mount state could not be verified.');
    return observed.mounted.filter(item => item.mount_point.toUpperCase() === drive
      || item.volume?.toUpperCase() === volume.toUpperCase());
  };
  const matches = await inspect();
  if (!matches.length) return;
  if (matches.length !== 1 || matches[0].volume !== volume || matches[0].mount_point.toUpperCase() !== drive) {
    throw new Error('The mounted VeraCrypt container does not match the detached VM workspace.');
  }
  const result = await cli.unmountVolume({ mountPoint: drive, unattended: true });
  if (!result.unmounted || (await inspect()).length) throw new Error('The VeraCrypt workspace is busy or still mounted.');
}

async function virtualBoxSlot(execute, { vm, controller, port }) {
  const fields = parseState((await execute(['showvminfo', vm, '--machinereadable'])).stdout);
  if (fields.get('UUID')?.toLowerCase() !== vm.toLowerCase()) throw new Error('VirtualBox reported a different VM.');
  const selected = [...fields.keys()].find(key => /^storagecontrollername\d+$/.test(key) && fields.get(key) === controller);
  if (!selected || fields.get(selected.replace('name', 'type')) !== 'IntelAhci') {
    throw new Error('The selected SATA controller does not exist.');
  }
  const changedAt = fields.get('VMStateChangeTime');
  const changedMs = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,9}Z?$/.test(changedAt)
    ? Date.parse(changedAt.endsWith('Z') ? changedAt : changedAt + 'Z') : NaN;
  return { power: fields.get('VMState'), medium: fields.get(`${controller}-${port}-0`) || 'none',
    changedMs: Number.isFinite(changedMs) ? changedMs : null };
}

async function releaseVirtualBoxGuestDisk(execute, medium) {
  const inventory = (await execute(['list', 'hdds'])).stdout;
  const matches = inventory.split(/\r?\n\s*\r?\n/).filter(record =>
    /^Location:[ \t]*(.+)$/m.exec(record)?.[1].trim() === medium);
  if (!matches.length) return;
  const uuid = /^UUID:[ \t]*([a-f0-9-]{36})\s*$/im.exec(matches[0])?.[1];
  if (matches.length !== 1 || !uuid) throw new Error('Could not identify the registered VirtualBox guest disk.');
  await execute(['closemedium', 'disk', uuid]);
}

export async function reconcileVirtualBoxDisks(guard, execute = executeVirtualBox, releaseHostMount) {
  const results = [];
  for (const disk of await guard.registeredDisks()) {
    const { backend, vm, volume, controller, port, medium, mountPoint, observedRunning } = disk;
    const guestOnly = mountPoint === '' && medium === volume;
    if (backend !== 'virtualbox' || (!guestOnly && !mountPoint) ||
        !path.isAbsolute(medium) || !/\.vhd$/i.test(medium) ||
        !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(vm) ||
        !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(controller) ||
        !Number.isInteger(port) || port < 1 || port > 29) continue;
    try {
      const state = await virtualBoxSlot(execute, disk);
      const missedCycle = state.power === 'poweroff' && state.changedMs !== null && Number.isSafeInteger(disk.attachmentStateMs)
        && state.changedMs > disk.attachmentStateMs;
      const observedCycle = state.medium === medium && (state.power === 'running' || missedCycle);
      if (observedCycle && observedRunning !== true) {
        await guard.observedRunning(disk);
      }
      if (observedRunning !== true && !(missedCycle && observedCycle)) continue;
      if (state.power !== 'poweroff') {
        results.push({ vm, status: 'waiting_for_shutdown', power: state.power || 'unknown' });
        continue;
      }
      if (state.medium !== 'none') {
        if (state.medium !== medium) throw new Error('The workspace slot now contains a different disk.');
        await execute(['storageattach', vm, '--storagectl', controller, '--port', String(port),
          '--device', '0', '--type', 'hdd', '--medium', 'none']);
        const after = await virtualBoxSlot(execute, disk);
        if (after.power !== 'poweroff' || after.medium !== 'none') throw new Error('Could not verify workspace detachment.');
      }
      await releaseVirtualBoxGuestDisk(execute, medium);
      if (!guestOnly) {
        if (!releaseHostMount) {
          throw new Error('The VM disk was detached. Host mount cleanup requires verification on this platform.');
        }
        await releaseHostMount({ volume, mountPoint });
      }
      await guard.detached(volume);
      results.push({ vm, status: guestOnly ? 'detached' : 'unmounted' });
    } catch (error) {
      results.push({ vm, status: 'pending', error: error.message });
    }
  }
  return results;
}

export async function virtualBoxVolume(cli, args, { execute = executeVirtualBox, guard } = {}) {
  const {operation, vm, controller, port}=args;
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(controller) || !Number.isInteger(port) || port < 1 || port > 29) {
    throw new Error('Choose a SATA controller and secondary port.');
  }
  const {medium,recheck,volume,mountPoint}=await (args.credentials ? guestDisk(cli,args) : workspaceDisk(cli,args));
  const registered={backend:'virtualbox',vm,controller,port,medium,volume,mountPoint};
  const state = async () => {
    const state = await virtualBoxSlot(execute, registered);
    if (state.power !== 'poweroff') {
      throw new Error('Shut down the exact VirtualBox VM before changing its workspace disk.');
    }
    return state;
  };
  const before=await state();
  const known=operation==='detach' && await guard?.beforeChange(operation,registered);
  const releaseGuestDisk = async () => {
    if (!args.credentials) return;
    await releaseVirtualBoxGuestDisk(execute, medium);
  };
  if(known && before.medium==='none'){
    await releaseGuestDisk();
    await guard.detached(volume);
    return {status:'detached',backend:'virtualbox',vm,controller,port};
  }
  const expected=operation==='attach'?'none':medium;
  if (before.medium!==expected) throw new Error('The selected slot does not match the requested operation.');
  await recheck();
  if(operation==='attach')await guard?.beforeChange(operation,{ ...registered, attachmentStateMs: before.changedMs });
  await execute(['storageattach',vm,'--storagectl',controller,'--port',String(port),'--device','0',
    '--type','hdd','--medium',operation==='attach'?medium:'none']);
  if ((await state()).medium!==(operation==='attach'?medium:'none')) throw new Error('VirtualBox could not verify the resulting disk attachment.');
  if(operation==='detach') {
    await releaseGuestDisk();
    await guard?.detached(volume);
  }
  return { status:operation==='attach'?'attached':'detached', backend:'virtualbox',vm,controller,port };
}

export async function kvmVolume(cli,args,{
  execute = argv=>run(process.env.VAULT_VIRSH || 'virsh',argv,{timeout:30000,env:{...process.env,LC_ALL:'C'}}),
  guard,
}={}) {
  const {operation,vm,target,uri='qemu:///session'}=args;
  if (!/^vd[b-z]$/.test(target) || !['qemu:///session','qemu:///system'].includes(uri)) {
    throw new Error('Choose a secondary virtio disk target and a local libvirt connection.');
  }
  const {medium,recheck,volume,mountPoint}=await (args.credentials ? guestDisk(cli,args) : workspaceDisk(cli,args));
  const registered={backend:'kvm',vm,target,uri,medium,volume,mountPoint};
  const virsh=(...argv)=>execute(['-c',uri,...argv]);
  const state=async()=>{
    if ((await virsh('domstate',vm)).stdout.trim()!=='shut off') {
      throw new Error('Shut down the exact libvirt VM before changing its workspace disk.');
    }
    const inventory=(await virsh('domblklist',vm,'--inactive','--details')).stdout.trim().split(/\r?\n/);
    if (!/^Type\s+Device\s+Target\s+Source$/.test(inventory[0]?.trim() ?? '') || !/^-+$/.test(inventory[1]?.trim() ?? '')) {
      throw new Error('Could not verify the libvirt disk inventory.');
    }
    const slots=new Map();
    for(const line of inventory.slice(2)) {
      const match=/^\s*(\S+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
      if (!match || slots.has(match[3])) throw new Error('Could not verify the libvirt disk inventory.');
      slots.set(match[3],{type:match[1],device:match[2],source:match[4]});
    }
    return slots.get(target);
  };
  const matches=slot=>slot?.type==='file' && slot.device==='disk' && slot.source===medium;
  const before=await state();
  const known=operation==='detach' && await guard?.beforeChange(operation,registered);
  if(known && !before){
    await guard.detached(volume);
    return {status:'detached',backend:'kvm',vm,target};
  }
  if (operation==='attach'?Boolean(before):!matches(before)) throw new Error('The selected slot does not match the requested operation.');
  await recheck();
  if(operation==='attach') {
    await guard?.beforeChange(operation,registered);
    await virsh('attach-disk',vm,medium,target,'--config','--driver','qemu','--subdriver','vpc',
      '--targetbus','virtio','--sourcetype','file','--cache','none');
  } else {
    await virsh('detach-disk',vm,target,'--config');
  }
  const after=await state();
  if (operation==='attach'?!matches(after):Boolean(after)) throw new Error('Libvirt could not verify the resulting disk attachment.');
  if(operation==='detach')await guard?.detached(volume);
  return {status:operation==='attach'?'attached':'detached',backend:'kvm',vm,target};
}

const hypervScript=String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$p = [Console]::In.ReadToEnd() | ConvertFrom-Json
try {
  Get-VMHost -ComputerName localhost | Out-Null
} catch {
  $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  $hypervAdministrators = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-578')
  $service = Get-Service vmms -ErrorAction SilentlyContinue
  if ($service.Status -eq 'Running' -and
      -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -and
      -not $principal.IsInRole($hypervAdministrators)) {
    @{code='hyperv_access_denied'} | ConvertTo-Json -Compress
    return
  }
  throw
}
$vm = Get-VM -ComputerName localhost -Id ([guid]$p.vm)
if ($vm.State -ne 'Off') { throw 'Shut down the selected Hyper-V VM first.' }
$controller = @(Get-VMScsiController -VM $vm | Where-Object ControllerNumber -eq $p.controllerNumber)
if ($controller.Count -ne 1) { throw 'The selected Hyper-V SCSI controller was not found.' }
function Get-Slot {
  @(Get-VMHardDiskDrive -VM $vm; Get-VMDvdDrive -VM $vm) |
    Where-Object { $_.ControllerType -eq 'SCSI' -and $_.ControllerNumber -eq $p.controllerNumber -and $_.ControllerLocation -eq $p.port }
}
$slot = @(Get-Slot)
if ($slot.Count -gt 1) { throw 'The selected Hyper-V slot is ambiguous.' }
$matches = $slot.Count -eq 1 -and $slot[0].GetType().Name -eq 'HardDiskDrive' -and $slot[0].Path -eq $p.medium
if ($p.action -eq 'check') {
  if ($p.operation -eq 'attach' -and $slot.Count -eq 0) {
    try {
      $vhd = Get-VHD -ComputerName localhost -Path $p.medium
    } catch {
      @{code=$(if ($p.guestVhd) {'hyperv_local_medium_unavailable'} else {'hyperv_medium_unavailable'})} | ConvertTo-Json -Compress
      return
    }
    if ($vhd.VhdFormat -ne 'VHD' -or $vhd.VhdType -notin @('Fixed','Dynamic')) {
      throw 'Hyper-V could not verify a standalone VHD at the mounted path.'
    }
  }
  @{empty=($slot.Count -eq 0); matches=$matches} | ConvertTo-Json -Compress
} elseif ($p.action -eq 'attach' -and $slot.Count -eq 0) {
  Add-VMHardDiskDrive -VM $vm -ControllerType SCSI -ControllerNumber $p.controllerNumber -ControllerLocation $p.port -Path $p.medium
  @{changed=$true} | ConvertTo-Json -Compress
} elseif ($p.action -eq 'detach' -and $matches) {
  Remove-VMHardDiskDrive -VMHardDiskDrive $slot[0] -Confirm:$false
  @{changed=$true} | ConvertTo-Json -Compress
} else { throw 'The selected Hyper-V slot changed.' }
`;

async function hypervCommand(request) {
  const encoded=Buffer.from(hypervScript,'utf16le').toString('base64');
  const {stdout}=await run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-OutputFormat','Text','-EncodedCommand',encoded],{
    timeout:30000,input:JSON.stringify(request),
  });
  const result=JSON.parse(stdout);
  const guidance = {
    hyperv_access_denied: 'Hyper-V management access is required. Launch VS Code as administrator or use an account authorized to manage Hyper-V, then retry.',
    hyperv_medium_unavailable: 'Hyper-V could not open the VHD through the WSL file share. Windows file access alone does not grant the Hyper-V service access to this workspace.',
    hyperv_local_medium_unavailable: 'Hyper-V could not open the local guest VHD. Check the file and Hyper-V storage permissions.',
  };
  if (Object.hasOwn(guidance, result.code)) {
    const error=new Error(guidance[result.code]);
    error.code=result.code;
    throw error;
  }
  return result;
}

async function guestDisk(cli, { volume, credentials }) {
  const localPath = value => cli.platform === 'win32' ? /^[a-z]:[\\/]/i.test(value) : path.isAbsolute(value);
  if (!localPath(volume) || !/\.vhd$/i.test(volume)) throw new Error('Use the local path to a managed guest VHD.');
  const medium = await realpath(volume);
  if (!localPath(medium)) throw new Error('The guest VHD must resolve to a local absolute path.');
  const listing = await cli.listEntries(credentials);
  if (listing.entries.filter(item => item.path === credentials.entry).length !== 1) throw new Error('Choose one managed guest VHD entry.');
  const record = await cli.showEntry({ ...credentials, showProtected:false });
  if (record.url !== pathToFileURL(medium).href || record.notes !== 'VAMP format: guest-vhd') {
    throw new Error('The selected vault entry is not bound to this guest VHD.');
  }
  const file = await open(medium, 'r');
  let identity;
  try {
    identity = await file.stat({bigint:true});
    const footer = Buffer.alloc(512);
    if (!identity.isFile() || identity.nlink !== 1n || identity.size < 512n ||
        (await file.read(footer,0,512,Number(identity.size)-512)).bytesRead !== 512 ||
        footer.toString('ascii',0,8) !== 'conectix' || footer.readUInt32BE(60) !== 2 ||
        footer.readBigUInt64BE(48) !== identity.size - 512n) throw new Error('Expected a standalone fixed guest VHD.');
  } finally { await file.close(); }
  const recheck = async () => {
    const current = await lstat(medium,{bigint:true});
    if (!current.isFile() || current.nlink !== 1n || current.dev !== identity.dev || current.ino !== identity.ino || current.size !== identity.size) {
      throw new Error('The guest VHD changed before the operation.');
    }
  };
  return {medium, volume:medium, mountPoint:'', recheck};
}

export async function hypervVolume(cli,args,{execute=hypervCommand,guard}={}) {
  const {operation,vm,port,controllerNumber=0}=args;
  const guestVhd=Boolean(args.credentials);
  if ((!args.wsl && !guestVhd) || !Number.isInteger(controllerNumber) || controllerNumber<0 || controllerNumber>3 ||
      !Number.isInteger(port) || port<1 || port>63) {
    throw new Error('Choose a Hyper-V SCSI controller and secondary slot on Windows with configured WSL.');
  }
  const {medium,recheck,volume,mountPoint}=await (guestVhd ? guestDisk(cli,args) : workspaceDisk(cli,args));
  const registered={backend:'hyperv',vm,controllerNumber,port,medium,volume,mountPoint};
  const command=action=>execute({...registered,operation,action,guestVhd});
  const before=await command('check');
  const known=operation==='detach' && await guard?.beforeChange(operation,registered);
  const result={status:operation==='attach'?'attached':'detached',backend:'hyperv',vm,controller_number:controllerNumber,port};
  if (known && before.empty===true) {
    await guard.detached(volume);
    return result;
  }
  if (operation==='attach'?before.empty!==true:before.matches!==true) {
    throw new Error('The selected Hyper-V slot does not match the requested operation.');
  }
  await recheck();
  if (operation==='attach') await guard?.beforeChange(operation,registered);
  if ((await command(operation)).changed!==true) throw new Error('Hyper-V did not confirm the disk operation.');
  const after=await command('check');
  if (operation==='attach'?after.matches!==true:after.empty!==true) throw new Error('Hyper-V could not verify the resulting disk configuration.');
  if (operation==='detach') await guard?.detached(volume);
  return result;
}
