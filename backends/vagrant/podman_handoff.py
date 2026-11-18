"""Pure, opt-in handoff for trusted Packer-built Debian Podman boxes.

No host commands, downloads, archive extraction, or private-key reads occur.
metadata must be the reviewed metadata.json from the built .box, NOT a box
catalog. This validates the handoff contract, not disk contents or provenance.
A trusted box can contain executable Vagrantfile Ruby: audit it before use.
"""
import re
from pathlib import PurePosixPath, PureWindowsPath


def _path(value, suffix=None):
    if not isinstance(value, str) or not value or any(ord(c) < 32 for c in value):
        raise ValueError('Expected a local absolute path without control characters')
    path = value.replace('\\', '/')
    if not (PurePosixPath(path).is_absolute() or PureWindowsPath(path).is_absolute()):
        raise ValueError('Expected a local absolute path')
    if path.startswith('//') or '..' in path.split('/') or '://' in path:
        raise ValueError('Network URLs, UNC paths and traversal are not allowed')
    if suffix and not path.endswith(suffix):
        raise ValueError('Expected a provider-specific .box, not an OVA or QCOW2')
    return path


def _ruby(value):
    # Single quotes prevent Ruby #{...} interpolation; escape only Ruby literals.
    return "'" + value.replace('\\', '\\\\').replace("'", "\\'") + "'"


def render_vagrantfile(*, provider, metadata, box_path, box_sha256,
                       private_key_path, name='vamp-podman', memory_mb=4096, cpus=2):
    """Return text only. Caller writes/reviews it and explicitly deploys later.

    provider is the Vagrant provider name (KVM uses libvirt, never qemu/kvm).
    Caller owns the matching deployment key; the box must contain only its
    public key for user vamp. Do not use the public Vagrant insecure key.
    """
    if provider not in ('virtualbox', 'libvirt'):
        raise ValueError('Vagrant provider must be virtualbox or libvirt')
    if not isinstance(metadata, dict) or metadata.get('provider') != provider:
        raise ValueError('Box metadata provider must match deployment provider')
    if provider == 'libvirt':
        size = metadata.get('virtual_size')
        if metadata.get('format') != 'qcow2' or type(size) not in (int, float) or not 0 < size <= 4096:
            raise ValueError('libvirt metadata requires qcow2 and positive virtual_size in GiB')
    if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,62}', name):
        raise ValueError('Invalid machine name')
    if not isinstance(box_sha256, str) or not re.fullmatch(r'[a-fA-F0-9]{64}', box_sha256):
        raise ValueError('An independently verified box SHA256 is required')
    for value, low, high in ((memory_mb, 512, 262144), (cpus, 1, 64)):
        if type(value) is not int or not low <= value <= high:
            raise ValueError('Invalid memory or CPU limit')
    box = _path(box_path, '.box')
    key = _path(private_key_path)
    if key.rsplit('/', 1)[-1] in ('insecure_private_key', 'vagrant_private_key'):
        raise ValueError('Supply a private deployment key, not the default insecure key')
    digest = box_sha256.lower()
    lines = [
        '# Generated source only: review trusted box contents before vagrant up.',
        '# Host Vagrant/provider installation is a separate explicit prerequisite.',
        'Vagrant.configure("2") do |config|',
        f'  config.vm.box = {_ruby("vamp/podman-" + provider + "-" + digest)}',
        f'  config.vm.box_url = {_ruby(box)}',
        '  config.vm.box_check_update = false',
        "  config.vm.box_download_checksum_type = 'sha256'",
        f'  config.vm.box_download_checksum = {_ruby(digest)}',
        "  config.vm.guest = :debian",
        f'  config.vm.hostname = {_ruby(name)}',
        "  config.vm.synced_folder '.', '/vagrant', disabled: true",
        "  config.ssh.username = 'vamp'",
        f'  config.ssh.private_key_path = [{_ruby(key)}]',
        '  config.ssh.insert_key = false',
        '  config.ssh.forward_agent = false',
        '  config.ssh.forward_x11 = false',
        f'  config.vm.provider {_ruby(provider)} do |p|',
        f'    p.memory = {memory_mb}', f'    p.cpus = {cpus}',
    ]
    if provider == 'virtualbox':
        lines.append('    p.gui = false')
    else:
        lines.extend(["    p.driver = 'kvm'", "    p.graphics_type = 'none'"])
    lines.extend(['  end', 'end', ''])
    return '\n'.join(lines)
