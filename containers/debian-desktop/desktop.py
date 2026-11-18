#!/usr/bin/python3
"""Supervise only an authenticated local X socket and non-root XFCE session."""
import json
import os
from pathlib import Path
import secrets
import signal
import stat
import subprocess
import sys
import time
# Only the root-owned image sibling is added; -I ignores cwd and PYTHONPATH.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from healthcheck import RUNTIME, display_environment, measure

XVFB = ['Xvfb', ':99', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp',
        '-auth', str(RUNTIME / 'Xauthority'), '-noreset']
SESSION = ['dbus-run-session', '--', 'xfce4-session', '--disable-tcp']


def prepare_runtime():
    if os.getuid() == 0:
        raise RuntimeError('Run this image as its non-root desktop user with rootless Podman')
    if os.environ.get('DISPLAY', ':99') != ':99':
        raise RuntimeError('A host DISPLAY is not supported')
    if os.path.ismount('/tmp/.X11-unix'):
        raise RuntimeError('A mounted host X11 socket directory is not supported')
    for socket in ('/var/run/docker.sock', '/run/podman/podman.sock'):
        if Path(socket).exists():
            raise RuntimeError('Host engine sockets must not be mounted')
    os.umask(0o077)
    try:
        RUNTIME.mkdir(mode=0o700)
    except FileExistsError:
        info = RUNTIME.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise RuntimeError('Runtime directory must be private and owned by the desktop user')
    (RUNTIME / 'ready.json').unlink(missing_ok=True)
    authority = RUNTIME / 'Xauthority'
    authority.unlink(missing_ok=True)
    authority.touch(mode=0o600)
    # A new random cookie per launch, sent on stdin, never printed or baked in.
    cookie = secrets.token_hex(16)
    subprocess.run(['xauth', '-f', str(authority)], input=f'add :99 . {cookie}\n',
                   text=True, capture_output=True, timeout=5, check=True)


def stop_children(children):
    for child in reversed(children):
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    for child in reversed(children):
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(timeout=5)


def main():
    children = []
    stopping = False
    prepared = False
    def stop(signum, frame):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        prepare_runtime()
        prepared = True
        env = display_environment()
        env.pop('DBUS_SESSION_BUS_ADDRESS', None)
        children.append(subprocess.Popen(XVFB, env=env, start_new_session=True))
        deadline = time.monotonic() + 20
        while True:
            if stopping or children[0].poll() is not None:
                raise RuntimeError('Xvfb did not become ready')
            try:
                measured = measure()
                break
            except (OSError, RuntimeError, subprocess.SubprocessError):
                if time.monotonic() >= deadline:
                    raise RuntimeError('Xvfb framebuffer verification timed out')
                time.sleep(0.2)
        subprocess.run(['xset', 's', 'off'], env=env, check=True, timeout=5)
        subprocess.run(['xset', 's', 'noblank'], env=env, check=True, timeout=5)
        children.append(subprocess.Popen(SESSION, env=env, start_new_session=True))
        # xfce4-session being alive is not proof Chromium/Office/viewer work.
        while not stopping:
            if any(child.poll() is not None for child in children):
                raise RuntimeError('Desktop or Xvfb exited')
            measured = measure()
            pending = RUNTIME / 'ready.tmp'
            pending.write_text(json.dumps({**measured,
                'xvfb_pid': children[0].pid, 'desktop_pid': children[1].pid,
                'viewer_listening': False}))
            pending.replace(RUNTIME / 'ready.json')
            time.sleep(2)
        return 0
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f'VAMP desktop unavailable: {error}', file=sys.stderr, flush=True)
        return 1
    finally:
        if prepared:
            (RUNTIME / 'ready.json').unlink(missing_ok=True)
        stop_children(children)


if __name__ == '__main__':
    sys.exit(main())
