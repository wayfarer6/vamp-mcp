#!/usr/bin/python3
"""Measure the actual container framebuffer, not a viewer window's dimensions."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

RUNTIME = Path('/tmp/vamp-desktop-runtime')


def verify_display(output):
    dimensions = re.findall(r'^\s*dimensions:\s+(\d+)x(\d+) pixels', output, re.M)
    depths = re.findall(r'^\s*depth of root window:\s+(\d+) planes', output, re.M)
    screens = re.search(r'^\s*number of screens:\s+(\d+)', output, re.M)
    if dimensions != [('1920', '1080')] or depths != ['24'] or not screens or screens[1] != '1':
        raise RuntimeError('Framebuffer must be exactly one 1920x1080 screen at 24-bit depth')
    return {'width': 1920, 'height': 1080, 'depth': 24, 'screens': 1}


def display_environment():
    env = dict(os.environ)
    env.update(DISPLAY=':99', XAUTHORITY=str(RUNTIME / 'Xauthority'),
               XDG_RUNTIME_DIR=str(RUNTIME), LC_ALL='C')
    return env


def measure(run=subprocess.run):
    response = run(['xdpyinfo', '-display', ':99'], env=display_environment(),
                   capture_output=True, text=True, timeout=3, check=True)
    return verify_display(response.stdout)


def health(run=subprocess.run):
    # Ready exists only while the supervised session has passed verification.
    ready = json.loads((RUNTIME / 'ready.json').read_text())
    if ready.get('viewer_listening') is not False:
        raise RuntimeError('Unexpected viewer state')
    for key in ('xvfb_pid', 'desktop_pid'):
        os.kill(ready[key], 0)
    return {'status': 'healthy', **measure(run), 'viewer_listening': False}


if __name__ == '__main__':
    try:
        print(json.dumps(health()))
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        print(json.dumps({'status': 'unhealthy', 'error': str(error)}))
        sys.exit(1)
