"""Create new local KVM guests without replacing existing domains or disks."""
import json
from pathlib import Path
import re
import shutil
import subprocess


def create(controller, name, image_path='', iso_path='', seed_iso_path='', memory_mb=3072, cpus=2, disk_gb=20, guest_os='debian', preseed_path='', setup_script_path='', nested_virtualization=False):
    if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,62}', name):
        raise ValueError('Use a VM name starting with a letter, followed by letters, numbers, _ or -')
    if not 1024 <= memory_mb <= 32768 or not 1 <= cpus <= 16 or not 8 <= disk_gb <= 512:
        raise ValueError('Invalid VM resources: RAM 1024..32768 MB, CPUs 1..16, disk 8..512 GB')
    if bool(image_path) == bool(iso_path):
        raise ValueError('Choose exactly one image_path (qcow2 cloud image) or iso_path (installer ISO)')
    if name in controller.virsh('list', '--all', '--name').splitlines() or name in controller.config['vms']:
        raise ValueError('VM already exists or is configured; existing VMs are never overwritten')
    if guest_os not in ('debian', 'windows11'):
        raise ValueError('Supported guests: debian, windows11')
    if controller.config.get('single_running_vm', True) and controller.virsh('list', '--name').splitlines():
        raise ValueError('Another VM is running; shut it down before creating the next VM')
    source = Path(image_path or iso_path).expanduser().resolve(strict=True)
    if not source.is_file():
        raise ValueError('Installation source must be a file')
    if ',' in str(source):
        raise ValueError('Source path cannot contain a comma')
    seed = Path(seed_iso_path).expanduser().resolve(strict=True) if seed_iso_path else None
    if seed and not seed.is_file():
        raise ValueError('Seed ISO must be a file')
    automated_debian = bool(iso_path and guest_os == 'debian' and not preseed_path)
    if iso_path and guest_os == 'debian' and not shutil.which('cpio'):
        raise ValueError('Install cpio on the KVM host before starting the Debian preseed installer.')
    packaged_preseed = None
    if automated_debian:
        from rpa_package import ROOT
        # Stock ISO plus an initrd-injected preseed: no ISO rewrite, so xorriso is not needed.
        packaged_preseed = ROOT/'backends/kvm/debian-preseed.cfg'
        if not packaged_preseed.is_file():
            raise ValueError('Packaged Debian preseed file is missing')
        preseed_path = str(packaged_preseed)
    uri = controller.config.get('libvirt_uri', 'qemu:///system')
    if not uri.endswith('/session'):
        try:
            network = controller.virsh('net-info', 'default')
        except RuntimeError as error:
            raise ValueError('Configure the default libvirt network before creating a system KVM guest.') from error
        if not re.search(r'^Active:[ \t]+yes[ \t]*$', network, re.MULTILINE):
            raise ValueError('Start the default libvirt network with virsh net-start default before creating a system KVM guest.')
    directory = controller.jobs_root.parent / 'vms' / name
    directory.mkdir(parents=True, exist_ok=False)
    if automated_debian:
        # virt-install injects the file under its own name, so the preseed must be preseed.cfg.
        preseed_path = str(shutil.copy2(packaged_preseed, directory/'preseed.cfg'))
    if iso_path and guest_os == 'windows11' and seed is None:
        from rpa_package import ROOT
        from scripts.prepare_windows_installers import prepare
        from scripts.build_windows_setup_media import build as windows_media
        installers=ROOT/'artifacts/kvm-setup/windows-installers'
        import contextlib,sys
        with contextlib.redirect_stdout(sys.stderr):
            prepare(installers)
        seed=Path(windows_media(source,installers,directory/'setup.iso',name)['iso'])
    disk = directory / 'disk.qcow2'
    if image_path:
        info = controller.command(['qemu-img', 'info', '--output=json', source])
        if info.returncode:
            raise RuntimeError(info.stderr[:300])
        metadata = json.loads(info.stdout)
        if metadata.get('format') != 'qcow2' or metadata.get('backing-filename'):
            raise ValueError('Use a standalone qcow2 source without a backing file')
        if metadata['virtual-size'] > disk_gb * 1024**3:
            raise ValueError('Requested disk is smaller than source image')
        result = controller.command(['qemu-img', 'convert', '-f', 'qcow2', '-O', 'qcow2', source, disk], timeout=180)
        if result.returncode:
            raise RuntimeError(result.stderr[:300])
        args = ['qemu-img', 'resize', disk, f'{disk_gb}G']
    else:
        args = ['qemu-img', 'create', '-f', 'qcow2', disk, f'{disk_gb}G']
    result = controller.command(args)
    if result.returncode:
        raise RuntimeError(result.stderr[:300])
    args = ['virt-install', '--connect', uri, '--name', name, '--virt-type', 'kvm',
            '--memory', str(memory_mb), '--vcpus', f'{cpus},sockets=1,cores={cpus},threads=1', '--cpu', 'host-passthrough',
            '--disk', f'path={disk},format=qcow2,bus={"sata" if guest_os == "windows11" else "virtio"}', '--osinfo', 'win11' if guest_os == 'windows11' else 'debian13',
            '--graphics', 'vnc,listen=127.0.0.1', '--video', 'vga,model.vram=65536' if guest_os == 'windows11' else 'virtio', '--input', 'tablet,bus=usb',
            '--network', ('user,model=e1000e' if guest_os == 'windows11' else 'user,model=virtio') if uri.endswith('/session') else 'network=default,model=virtio',
            '--noautoconsole', '--xml', './devices/graphics/@sharePolicy=ignore',
            '--xml', './devices/video/model/resolution/@x=1920', '--xml', './devices/video/model/resolution/@y=1080', '--serial', f'pty,log.file={directory / "serial.log"},log.append=on']
    if nested_virtualization:
        flags = Path('/proc/cpuinfo').read_text().split()
        extension = 'svm' if 'svm' in flags else 'vmx' if 'vmx' in flags else None
        if extension is None:
            raise RuntimeError('Host hardware virtualization extension is unavailable')
        args[args.index('--cpu') + 1] += ',migratable=off,require=' + extension
    if guest_os == 'windows11':
        args += ['--channel', 'unix,target.type=virtio,target.name=org.qemu.guest_agent.0']
        args += ['--boot', 'uefi', '--tpm', 'backend.type=emulator,backend.version=2.0,model=tpm-crb']
    if image_path:
        args += ['--import']
    elif preseed_path:
        preseed = Path(preseed_path).resolve(strict=True)
        if guest_os != 'debian' or preseed.name != 'preseed.cfg':
            raise ValueError('Debian automated installer needs a file named preseed.cfg')
        args += ['--location', f'{source},kernel=install.amd/vmlinuz,initrd=install.amd/initrd.gz',
                 '--initrd-inject', str(preseed), '--extra-args',
                 'auto=true priority=critical preseed/file=/preseed.cfg console=ttyS0,115200n8 console=tty0']
        if setup_script_path:
            args += ['--initrd-inject', str(Path(setup_script_path).resolve(strict=True))]
    else:
        args += ['--cdrom', str(source)]
    if seed:
        args += ['--disk', f'path={seed},device=cdrom,readonly=on']
    result = controller.command(args, timeout=180)
    (directory / 'provision.log').write_text(result.stdout + '\n' + result.stderr)
    if result.returncode:
        raise RuntimeError(result.stderr[-600:])
    profile = {'backend': 'vnc', 'guest_os': guest_os, 'managed_by': 'vamp',
               'supported_rpas': ['desktop_control', 'captcha_handoff', 'firefox_launch', 'firefox_naver', 'naver_login', 'debian_update', 'kvm_validation']}
    if guest_os == 'windows11':
        profile['supported_rpas'] = ['desktop_control', 'captcha_handoff', 'windows_kvm_validation']
    controller.config['vms'][name] = profile
    import threading
    controller.locks[name] = threading.Lock()
    temporary = controller.config_path.with_suffix('.tmp')
    temporary.write_text(json.dumps(controller.config, indent=2) + '\n')
    temporary.replace(controller.config_path)
    return {'status': 'installation_started' if iso_path else 'boot_requested', 'vm_name': name,
            'backend': 'kvm', 'memory_mb': memory_mb, 'cpu_topology': {'sockets': 1, 'cores': cpus, 'threads': 1}, 'nested_virtualization': bool(nested_virtualization), 'disk_path': str(disk), 'serial_log': str(directory / 'serial.log'),
            'installation_verified': False}
