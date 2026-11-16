#!/usr/bin/env python3
"""Create an unattended Debian amd64 BIOS installer without modifying the source ISO."""
import argparse
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
CREDENTIALS = {'username': 'vboxuser', 'password': 'password123!', 'public_sandbox_credentials': True}


def build(source, output):
    source = Path(source).expanduser().resolve(strict=True)
    output = Path(output).expanduser().resolve()
    if not source.is_file() or source == output or output.exists():
        raise ValueError('Choose a readable source ISO and a new output path')
    preseed = ROOT / 'backends/kvm/debian-preseed.cfg'
    if not preseed.is_file():
        raise ValueError('Packaged Debian preseed file is missing')
    def run(args):
        try:
            result = subprocess.run(['xorriso', *map(str, args)], capture_output=True, text=True, timeout=600)
        except FileNotFoundError as error:
            raise RuntimeError('Install xorriso on the VM host for Debian automatic installation, or choose manual installation') from error
        if result.returncode:
            raise RuntimeError('Debian installer preparation failed: ' + result.stderr[-1500:])
        return result
    # Fail before creating a VM/disk if this is not the supported Debian installer layout.
    run(['-indev', source, '-ls', '/install.amd/vmlinuz', '/install.amd/initrd.gz', '/isolinux/isolinux.bin'])
    output.parent.mkdir(parents=True, exist_ok=True)
    menu = output.with_suffix('.isolinux.cfg')
    menu.write_text('default vamp\nprompt 0\ntimeout 10\nlabel vamp\n  kernel /install.amd/vmlinuz\n  append initrd=/install.amd/initrd.gz auto=true priority=critical preseed/file=/cdrom/preseed.cfg console=tty0 --- quiet\n')
    result = run(['-indev', source, '-outdev', output, '-boot_image', 'any', 'replay',
                  '-map', preseed, '/preseed.cfg', '-map', menu, '/isolinux/isolinux.cfg'])
    output.with_suffix('.build.log').write_text(result.stdout + '\n' + result.stderr)
    return {'status': 'media_built', 'iso': str(output), 'credentials': CREDENTIALS,
            'installation_verified': False, 'recorder_installed_verified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(build(args.source, args.output)))
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        parser.exit(1, str(error) + '\n')
