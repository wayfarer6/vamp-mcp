#!/usr/bin/env python3
"""Adapt zero-based screenshot pixels to VirtualBox's one-based absolute mouse API.
Delegates to the preserved MIT chryaner/mcp-virtualbox helper.
"""
from pathlib import Path
import runpy
import sys

if __name__=='__main__':
    if len(sys.argv)<4:raise SystemExit('Expected VM x y [button]')
    for index in (2,3):
        coordinate=int(sys.argv[index])
        if coordinate<0:raise SystemExit('Guest coordinates must be non-negative')
        sys.argv[index]=str(coordinate+1)
    runpy.run_path(str(Path(__file__).resolve().parents[2]/'third_party/mcp-virtualbox/scripts/mouse_click.py'),run_name='__main__')
