"""Run the DHCP-free Debian Hyper-V build and deployment."""
import ipaddress
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid


def configuration(raw, environ):
    if raw is None:
        filename = environ.get('VAMP_HYPERV_DEBIAN_CONFIG')
        if not filename:
            raise ValueError('Hyper-V Debian needs a static deployment profile. Set VAMP_HYPERV_DEBIAN_CONFIG to its JSON file.')
        raw = json.loads(Path(filename).expanduser().read_text(encoding='utf-8-sig'))
    fields = {
        'switch', 'guest_ip', 'gateway', 'dns', 'dvd_sha256',
        'ssh_private_key', 'hyperv_daemons_deb', 'hyperv_daemons_sha256',
    }
    if not isinstance(raw, dict) or set(raw) != fields or any(not isinstance(raw[k], str) or not raw[k] for k in fields):
        raise ValueError('Invalid Hyper-V Debian profile. Required fields: ' + ', '.join(sorted(fields)))
    result = dict(raw)
    guest = ipaddress.IPv4Interface(result['guest_ip'])
    gateway = ipaddress.IPv4Address(result['gateway'])
    addresses = {guest.ip, gateway, guest.network.network_address, guest.network.broadcast_address}
    if gateway not in guest.network or len(addresses) != 4 or not guest.ip.is_private:
        raise ValueError('Use distinct usable private IPv4 addresses on the dedicated Hyper-V subnet')
    result.update(guest_ip=str(guest), gateway=str(gateway), dns=str(ipaddress.IPv4Address(result['dns'])))
    for key in ('dvd_sha256', 'hyperv_daemons_sha256'):
        if not re.fullmatch('[a-fA-F0-9]{64}', result[key]):
            raise ValueError('Expected a verified SHA-256 for ' + key)
    for key in ('ssh_private_key', 'hyperv_daemons_deb'):
        result[key] = str(Path(result[key]).expanduser().resolve(strict=True))
        if not Path(result[key]).is_file():
            raise ValueError('Expected a local file for ' + key)
    if not Path(result['ssh_private_key'] + '.pub').is_file():
        raise ValueError('The Hyper-V deployment SSH key needs its matching .pub file')
    return result


def require_network(profile, network):
    if network['switch_type'] != 'Internal' or network['host_ipv4'] != profile['gateway']:
        raise ValueError('Hyper-V Debian needs a dedicated internal switch with the configured gateway assigned on Windows')
    prefix = ipaddress.IPv4Interface(profile['guest_ip']).network.prefixlen
    if network.get('prefix_length') != prefix:
        raise ValueError('The reserved guest subnet prefix must match the selected Hyper-V adapter')


def vagrant_executable():
    default_vagrant = Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'Vagrant/bin/vagrant.exe'
    return os.environ.get('VAGRANT_PATH') or shutil.which('vagrant') or (str(default_vagrant) if default_vagrant.is_file() else None)


def require_host_tools():
    if importlib.util.find_spec('pycdlib') is None:
        raise ValueError('The MCP host Python is missing pycdlib. Install requirements-mcp.txt in RPA_HOST_PYTHON and retry.')
    if not vagrant_executable():
        raise ValueError('Vagrant is required for fixed-address Hyper-V deployment. Install it or set VAGRANT_PATH.')


def run_build(request, folder, live, assets, executable, init, environment, home, update):
    profile = request['hyperv_debian']
    source = assets / 'backends/packer/debian-hyperv'
    job = folder / 'offline'
    vagrant = vagrant_executable()
    if not vagrant:
        raise ValueError('Vagrant is required for fixed-address Hyper-V deployment. Install it or set VAGRANT_PATH.')

    def execute(args, log, timeout, **options):
        subprocess.run([str(arg) for arg in args], stdout=log, stderr=subprocess.STDOUT,
                       stdin=subprocess.DEVNULL, timeout=timeout, check=True,
                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), **options)

    with (folder / 'packer.log').open('w', encoding='utf-8') as log:
        update(stage='offline_answer_media')
        execute([sys.executable, source / 'prepare.py', '--dvd', request['iso_path'],
                 '--dvd-sha256', profile['dvd_sha256'], '--job-dir', job, '--vm-name', request['name'],
                 '--switch', profile['switch'], '--guest-ip', profile['guest_ip'], '--gateway', profile['gateway'],
                 '--dns', profile['dns'], '--ssh-public-key', profile['ssh_private_key'] + '.pub',
                 '--hyperv-daemons-deb', profile['hyperv_daemons_deb'],
                 '--hyperv-daemons-sha256', profile['hyperv_daemons_sha256']], log, 120)
        update(stage='offline_install')
        init('hyperv', home() / 'tools/packer/init/hyperv', log)
        template = source / 'debian.pkr.hcl'
        variables = [
            f'-var-file={job / "build.pkrvars.json"}',
            f'-var=vm_name=VAMP-build-{folder.name[:12]}',
            *(f'-var={key}={request[key]}' for key in ('memory_mb', 'cpus', 'disk_mb')),
        ]
        execute([executable(), 'validate', *variables, template], log, 120, env=environment())
        execute([executable(), 'build', '-color=false', '-on-error=abort', *variables, template], log, 1800, env=environment())
        update(stage='package_golden_image')
        execute([sys.executable, source / 'package_box.py', job], log, 1200)
        artifact = folder / 'artifact'
        (job / 'export').rename(artifact)
        deployment = job / 'deployment.json'
        data = json.loads(deployment.read_text())
        data.update(memory_mb=request['memory_mb'], cpus=request['cpus'], box_name=f'vamp/debian-hyperv-{folder.name}',
                    box_path=str(job / 'debian-hyperv.box'), ssh_private_key=profile['ssh_private_key'])
        update(status='deploying', stage='static_ip_provisioning', artifact_path=str(artifact))
        live.mkdir(parents=True)
        (live / 'deployment.json').write_text(json.dumps(data), encoding='utf-8')
        shutil.copyfile(source / 'Vagrantfile', live / 'Vagrantfile')
        shutil.copytree(job / 'provision', live / 'provision')
        env = {**os.environ, 'VAMP_DEBIAN_HYPERV_PROFILE': 'recorder', 'VAGRANT_CWD': str(live),
               'VAGRANT_DOTFILE_PATH': str(live / '.vagrant')}
        execute([vagrant, 'up', '--provider=hyperv'], log, 2700, cwd=live, env=env)
        update(stage='verify_static_ip_after_reboot')
        execute([vagrant, 'reload'], log, 900, cwd=live, env=env)
        execute([vagrant, 'ssh', '-c', 'test -f /var/lib/vamp/guest-setup.complete'], log, 120, cwd=live, env=env)
        vm_id = str(uuid.UUID((live / '.vagrant/machines/default/hyperv/id').read_text().strip()))
        ownership = {'id': vm_id, 'name': request['name'], 'folder': str(live),
                     'guest_os': 'debian', 'golden_image_id': folder.name}
        (live / 'vamp-ui.json').write_text(json.dumps(ownership), encoding='utf-8')
    return {'vm_id': vm_id, 'vm': request['name'], 'vm_path': str(live),
            'guest_ipv4': str(ipaddress.IPv4Interface(profile['guest_ip']).ip),
            'startup_verified': True, 'installation_verified': True, 'guest_setup_completed': True}
