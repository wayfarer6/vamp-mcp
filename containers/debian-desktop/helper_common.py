"""Trusted sibling imports and preflight for fixed, non-root image helpers."""
import importlib.util
import os
from pathlib import Path
import stat
import subprocess

# Python -I excludes the script directory from sys.path. Load only this immutable
# image sibling, never cwd/PYTHONPATH or a user-supplied path.
_spec = importlib.util.spec_from_file_location('vamp_image_health', Path(__file__).resolve().with_name('healthcheck.py'))
healthcheck = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(healthcheck)


def helper_environment():
    return {'PATH': '/usr/bin:/bin', 'HOME': '/home/desktop', 'USER': 'desktop',
            'LOGNAME': 'desktop', 'LC_ALL': 'C', 'DISPLAY': ':99',
            'XAUTHORITY': '/tmp/vamp-desktop-runtime/Xauthority',
            'XDG_RUNTIME_DIR': '/tmp/vamp-desktop-runtime'}


def require_ready():
    if os.getuid() != 1000 or os.geteuid() != 1000:
        raise RuntimeError('Desktop helper requires non-root UID 1000')
    runtime = healthcheck.RUNTIME
    info = runtime.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 1000 or stat.S_IMODE(info.st_mode) != 0o700:
        raise RuntimeError('Desktop runtime directory is not private')
    authority = (runtime / 'Xauthority').lstat()
    if not stat.S_ISREG(authority.st_mode) or authority.st_uid != 1000 or stat.S_IMODE(authority.st_mode) != 0o600:
        raise RuntimeError('Desktop Xauthority is not private')
    def trusted_measure(args, **kwargs):
        if args != ['xdpyinfo', '-display', ':99']:
            raise RuntimeError('Unexpected display probe')
        kwargs['env'] = helper_environment()
        return subprocess.run(['/usr/bin/xdpyinfo', '-display', ':99'], **kwargs)
    healthcheck.health(run=trusted_measure)
