#!/usr/bin/env python3
"""Removed: nested lab media no longer rewrites the Debian ISO with xorriso.

Boot the stock ISO and install the guest setup from the HTTP script server on
port 8421 (`python3 scripts/script_server.py start`). The preseed and isolinux
templates remain under scripts/windows for reference only.
"""
from __future__ import annotations
import argparse
import sys

MESSAGE = ('xorriso-based nested Debian media has been removed from VAMP. '
           'Boot the stock ISO and run wget -qO- http://10.0.2.2:8421/setup.sh | sh in the guest '
           'after starting scripts/script_server.py.')


def build(*_args, **_kwargs):
    raise RuntimeError(MESSAGE)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Removed: use scripts/script_server.py instead.')
    parser.add_argument('--source')
    parser.add_argument('--output')
    args = parser.parse_args()
    sys.exit(2)
