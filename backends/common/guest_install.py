"""Host-independent installer policy shared by MCP and VSIX runtimes.

This module builds plans and renders configuration; it never starts a VM or
injects input. Backend adapters execute plans using their native APIs.
"""
import json
from pathlib import Path
import platform
import sys

ROOT=Path(__file__).resolve().parents[2]
HOST_ARCH=platform.machine()
PROFILE=json.loads(Path(__file__).with_name('guest-install.json').read_text())

def require_install_host(backend, host=None, architecture=None):
    host=host or sys.platform
    architecture=architecture or HOST_ARCH
    if host not in PROFILE['hosts'].get(backend,[]):
        raise ValueError(f'{backend} local installation is unsupported on {host}')
    if architecture not in PROFILE['amd64_install_host_arches']:
        raise ValueError(f'Current amd64 installer profiles require an x64 host; {architecture} is unsupported')

def efi_boot_plan(guest_os, base_url):
    if guest_os not in ('debian','windows11'):
        raise ValueError('No automatic EFI boot profile for '+guest_os)
    return [dict(step,**({'text':step['text'].format(base_url=base_url.rstrip('/'))} if 'text' in step else {}))
            for step in PROFILE[guest_os]['efi_boot']]

def post_create_notice(guest_os, base_url):
    """The same user-facing handoff is returned to MCP and rendered by VSIX."""
    base_url=base_url.rstrip('/')
    windows=guest_os=='windows11'
    return {
        'title':'Important: check guest setup after first login',
        'message':'Log in after OS installation. Guest setup downloads and runs automatically. If it fails or does not start, run the recovery command below inside the guest. Do not suspend or lock the VM until setup completes. Setup disables automatic sleep and screen locking.',
        'setup_command':f'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm {base_url}/setup.ps1 | iex"' if windows else f'wget -qO /tmp/vamp-setup.sh {base_url}/setup.sh && sh /tmp/vamp-setup.sh --base={base_url}',
        'resolution_note':'Before automation, set Windows Settings > System > Display to 1920x1080 and Scale 100%. Open the resolution guide in VM Manager if this mode is unavailable.' if windows else 'Debian may not keep 1920x1080. After setup, run this command in a GNOME Xorg terminal. If the mode is unavailable, check Guest Additions and guest display settings.',
        'resolution_command':None if windows else 'xrandr --output "$(xrandr --query | awk \'/ connected/{print $1; exit}\')" --mode 1920x1080',
    }

def virtualbox_preseed():
    # One Debian policy source; only account substitution and the native late
    # command differ for VirtualBox's built-in unattended installer.
    source=(ROOT/'guest_setup/http/debian-preseed.cfg').read_text()
    substitutions={
      'd-i netcfg/get_hostname':'d-i netcfg/get_hostname string @@VBOX_INSERT_HOSTNAME_WITHOUT_DOMAIN@@',
      'd-i passwd/user-fullname':'d-i passwd/user-fullname string @@VBOX_INSERT_USER_FULL_NAME@@',
      'd-i passwd/username':'d-i passwd/username string @@VBOX_INSERT_USER_LOGIN@@',
      'd-i preseed/late_command':'d-i preseed/late_command string cp /cdrom/vboxpostinstall.sh /target/root/vboxpostinstall.sh && chmod +x /target/root/vboxpostinstall.sh && /bin/sh /target/root/vboxpostinstall.sh --need-target-bash --preseed-late-command',
    }
    lines=[]
    for line in source.splitlines():
        if line.startswith('d-i passwd/user-password'):continue
        lines.append(next((value for key,value in substitutions.items() if line.startswith(key+' ')),line))
    lines.append('d-i passwd/user-password-crypted password @@VBOX_INSERT_USER_PASSWORD_SHACRYPT512@@')
    return '\n'.join(lines)+'\n'
