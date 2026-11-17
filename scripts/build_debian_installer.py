#!/usr/bin/env python3
"""Removed: VAMP no longer rewrites Debian installer ISOs with xorriso.

Building a preseeded installer ISO required `xorriso` on the host and produced a
separate media image per platform. VAMP now boots the stock ISO and serves the
guest setup scripts from a Python HTTP server on port 8421, so the guest installs
the recorder with wget/curl (Windows: `irm .../setup.ps1 | iex`).

    python3 scripts/script_server.py start
    wget -qO- http://10.0.2.2:8421/setup.sh | sh

This module is kept only so older callers fail loudly instead of invoking a
removed tool.
"""
from __future__ import annotations
import argparse
import sys

MESSAGE = ('xorriso-based Debian installer media has been removed from VAMP. '
           'Boot the stock ISO (choose manual installation when VirtualBox cannot install unattended) '
           'and serve guest setup over HTTP: python3 scripts/script_server.py start, then '
           'wget -qO- http://10.0.2.2:8421/setup.sh | sh inside the guest.')


def build(*_args, **_kwargs):
    raise RuntimeError(MESSAGE)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Removed: use scripts/script_server.py instead.')
    parser.add_argument('--source')
    parser.add_argument('--output')
    args = parser.parse_args()
    parser.exit(2, MESSAGE + '\n')
