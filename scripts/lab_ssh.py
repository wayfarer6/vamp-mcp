#!/usr/bin/env python3
"""Execute a lab PowerShell file over key-only SSH, preserving its exact text."""
import argparse
import base64
from pathlib import Path
import subprocess

if __name__ == '__main__':
    p=argparse.ArgumentParser();p.add_argument('--key',required=True);p.add_argument('--host',default='vboxuser@127.0.0.1');p.add_argument('--port',default='2229');p.add_argument('script');a=p.parse_args()
    source="$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new();\n"+Path(a.script).read_text(encoding='utf8')
    encoded=base64.b64encode(source.encode('utf-16le')).decode()
    r=subprocess.run(['ssh','-T','-p',a.port,'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','ConnectTimeout=10','-i',a.key,a.host,'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand '+encoded])
    raise SystemExit(r.returncode)
