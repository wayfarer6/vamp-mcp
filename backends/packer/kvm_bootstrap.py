"""Guest-visible KVM Packer script host, distinct from deployed libvirt networks.

The current Packer QEMU builder uses user networking: 10.0.2.2 is its host alias.
Do not derive this address from libvirt's default network (deployment occurs later),
or try to bind a host-side HTTP listener to the guest-only alias.
"""
import ipaddress
import json
import subprocess
import os
import re
from urllib.parse import urlsplit

DEFAULT_QEMU_SCRIPT_HOST = '10.0.2.2'


def validate_ipv4_host(value):
    if not isinstance(value, str) or value != value.strip():
        raise ValueError('Bootstrap host must be a plain reachable IPv4 address')
    try:
        address = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError as error:
        raise ValueError('Bootstrap host must be a plain reachable IPv4 address') from error
    if address.packed[0] == 0 or address.is_unspecified or address.is_loopback or address.is_multicast or address.is_link_local or address.is_reserved or str(address) == '255.255.255.255':
        raise ValueError('Bootstrap host must not be unspecified, loopback, multicast, link-local or reserved')
    if not any(address in ipaddress.IPv4Network(network) for network in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')):
        raise ValueError('KVM bootstrap host must be an RFC1918 private IPv4 address')
    return str(address)


def resolve_kvm_bootstrap_host(request, env=None):
    """Pure, deterministic address selection; no discovery or network mutation.

    Overrides are meaningful only when the caller has already arranged a route
    from the Packer build guest to that host. Validation is not reachability proof.
    Empty explicitly supplied values fail instead of silently choosing a target.
    """
    env = os.environ if env is None else env
    if 'bootstrap_host' in request:
        value = request['bootstrap_host']
    elif 'VAMP_PACKER_BOOTSTRAP_HOST' in env:
        value = env['VAMP_PACKER_BOOTSTRAP_HOST']
    else:
        value = DEFAULT_QEMU_SCRIPT_HOST
    return validate_ipv4_host(value)



def local_ipv4_addresses(execute=None):
    """Read kernel interface inventory, not DNS or remote reachability evidence."""
    execute = subprocess.run if execute is None else execute
    try:
        result = execute(['ip', '-j', '-4', 'address', 'show'], capture_output=True,
                         text=True, timeout=10, check=True)
        if len(result.stdout) > 1024 * 1024:
            raise ValueError('Interface inventory exceeds size limit')
        interfaces = json.loads(result.stdout)
        if not isinstance(interfaces, list):
            raise ValueError('Invalid interface inventory')
        return {item['local'] for interface in interfaces
                for item in interface.get('addr_info', [])
                if item.get('family') == 'inet' and isinstance(item.get('local'), str)}
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError) as error:
        raise RuntimeError('Cannot verify local KVM bootstrap address ownership. A working iproute2 interface inventory is required for overrides; no remote or wildcard fallback is allowed.') from error


def kvm_bind_address(host, addresses=None):
    host = validate_ipv4_host(host)
    if host == DEFAULT_QEMU_SCRIPT_HOST:
        # libslirp sotranslate_out maps the default guest host alias to loopback.
        return '127.0.0.1'
    addresses = local_ipv4_addresses() if addresses is None else addresses
    if host not in addresses:
        raise ValueError('KVM bootstrap override is not assigned to a local builder interface; refusing to download executable scripts from another host')
    return host


def bind_kvm_listener(host, port, factory, addresses=None):
    """Bind one job-owned listener. Never reuse another process or broaden bind."""
    bind = kvm_bind_address(host, addresses)
    try:
        return factory(bind, port)
    except OSError as error:
        raise RuntimeError(f'Cannot bind the job-owned KVM bootstrap listener to {bind}:{port}; the local address must still exist and the port must be free. No existing server or wildcard listener was reused.') from error


def kvm_script_endpoints(base, callback):
    """Validate strings before interpolating them into installer shell commands."""
    try:
        source, completed = urlsplit(base), urlsplit(callback)
        host = validate_ipv4_host(source.hostname)
        if source.scheme != 'http' or source.port != 8421 or source.path not in ('', '/') or source.query or source.fragment or source.username is not None or source.password is not None:
            raise ValueError('Invalid script server endpoint')
        if completed.scheme != 'http' or completed.hostname != host or completed.port is None or not 1 <= completed.port <= 65535 or completed.query or completed.fragment or completed.username is not None or completed.password is not None:
            raise ValueError('Invalid completion endpoint')
        if not re.fullmatch(r'/complete/[A-Za-z0-9_-]+', completed.path):
            raise ValueError('Invalid completion path')
        # urlsplit silently strips some controls. Reject rather than normalize.
        if any(character.isspace() or ord(character) < 32 for character in base + callback):
            raise ValueError('Invalid endpoint characters')
    except (ValueError, TypeError, AttributeError) as error:
        raise ValueError('KVM bootstrap requires safe same-host HTTP script/completion endpoints') from error
    return {'host': host, 'script_port': 8421, 'callback_port': completed.port,
            'callback_path': completed.path}


def kvm_late_command(base, callback):
    endpoints = kvm_script_endpoints(base, callback)
    # Installer /bin/sh interprets this once. HCL interpolation escaping does not
    # apply to preseed files. Neither a failed nor an empty download is executed.
    return (
        f"VAMP_BOOTSTRAP_HOST='{endpoints['host']}'; export VAMP_BOOTSTRAP_HOST; "
        'VAMP_SCRIPT_BASE_URL="http://${VAMP_BOOTSTRAP_HOST}:8421"; export VAMP_SCRIPT_BASE_URL; '
        f'VAMP_PACKER_CALLBACK="http://${{VAMP_BOOTSTRAP_HOST}}:{endpoints["callback_port"]}{endpoints["callback_path"]}"; export VAMP_PACKER_CALLBACK; '
        'wget -qO /tmp/vamp-postdeb.sh.download "${VAMP_SCRIPT_BASE_URL}/postdeb.sh" '
        '&& test -s /tmp/vamp-postdeb.sh.download '
        '&& mv /tmp/vamp-postdeb.sh.download /tmp/vamp-postdeb.sh '
        '&& sh /tmp/vamp-postdeb.sh'
    )
