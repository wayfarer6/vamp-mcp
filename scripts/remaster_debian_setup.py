#!/usr/bin/env python3
"""Removed: VAMP no longer remasters Debian installer ISOs with xorriso.

KVM Debian installs boot the stock installer ISO and receive their preseed and
guest setup over HTTP instead of a rewritten ISO carrying a /vamp payload.

    python3 scripts/script_server.py start
    wget -qO- http://10.0.2.2:8421/setup.sh | sh

This module is kept only so older callers fail loudly instead of invoking a
removed tool.
"""
from __future__ import annotations

MESSAGE = ('xorriso-based Debian installer remastering has been removed from VAMP. '
           'Use the stock ISO and the HTTP guest setup server: python3 scripts/script_server.py start, then '
           'wget -qO- http://10.0.2.2:8421/setup.sh | sh inside the guest.')


def build(*_args, **_kwargs):
    raise RuntimeError(MESSAGE)


if __name__ == '__main__':
    raise SystemExit(MESSAGE)
