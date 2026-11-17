#!/usr/bin/env python3
"""Rebuild guest_setup/recorder/recorder.zip from third_party/pyautogui-recorder.

The bundle is committed so a clean checkout, the VSIX runtime and the npm
package can stage guest setup without the third_party sources. Run this after
changing the recorder sources, then commit the new zip.

    python3 scripts/build_recorder_zip.py [--check]

--check rebuilds in memory and exits 1 when the committed zip is stale, which
is useful in CI without touching the working tree.
"""
from __future__ import annotations
import argparse
import io
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'third_party' / 'pyautogui-recorder'
TARGET = ROOT / 'guest_setup' / 'recorder' / 'recorder.zip'


def payload_files(source: Path = SOURCE) -> list[Path]:
    return sorted(
        path for path in source.rglob('*')
        if path.is_file() and '__pycache__' not in path.parts and path.suffix != '.pyc'
    )


def build(stream) -> None:
    with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in payload_files():
            archive.write(path, str(path.relative_to(SOURCE)))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--check', action='store_true', help='only report whether the committed zip is current')
    arguments = parser.parse_args()
    if not SOURCE.is_dir():
        print(f'missing recorder sources: {SOURCE}')
        return 2
    buffer = io.BytesIO()
    build(buffer)
    expected = buffer.getvalue()
    if arguments.check:
        if not TARGET.is_file():
            print(f'missing bundle: {TARGET}')
            return 1
        if TARGET.read_bytes() != expected:
            print(f'stale bundle: {TARGET} (run scripts/build_recorder_zip.py)')
            return 1
        print(f'bundle is current: {TARGET}')
        return 0
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_bytes(expected)
    print(f'wrote {TARGET} ({len(expected)} bytes, {len(payload_files())} files)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
