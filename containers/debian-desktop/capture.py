#!/usr/bin/python3
"""One bounded PNG frame to stdout; no paths, shell, resizing or file saves."""
import importlib.util
import os
from pathlib import Path
import selectors
import struct
import subprocess
import sys
import time
import zlib

_spec = importlib.util.spec_from_file_location('vamp_helper_common', Path(__file__).resolve().with_name('helper_common.py'))
common = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(common)
MAX_PNG_BYTES = 8 * 1024 * 1024
CAPTURE_SECONDS = 10
COMMANDS = [
    ['/usr/bin/xwd', '-root', '-silent', '-display', ':99'],
    ['/usr/bin/xwdtopnm'],
    ['/usr/bin/pamdepth', '255'],
    ['/usr/bin/pnmtopng', '-force'],
]


def validate_png(data):
    if len(data) > MAX_PNG_BYTES or not data.startswith(b'\x89PNG\r\n\x1a\n'):
        raise RuntimeError('Invalid or oversized PNG')
    offset = 8
    seen_header = False
    seen_data = False
    compressed = bytearray()
    while offset + 12 <= len(data):
        length, kind = struct.unpack('!I4s', data[offset:offset + 8])
        end = offset + 12 + length
        if end > len(data):
            raise RuntimeError('Truncated PNG')
        if kind not in (b'IHDR', b'IDAT', b'IEND', b'sBIT', b'gAMA', b'cHRM', b'sRGB', b'pHYs'):
            raise RuntimeError('Unexpected PNG metadata or animation chunk')
        payload = data[offset + 8:offset + 8 + length]
        expected = struct.unpack('!I', data[end - 4:end])[0]
        if zlib.crc32(kind + payload) & 0xffffffff != expected:
            raise RuntimeError('Invalid PNG checksum')
        if not seen_header:
            if kind != b'IHDR' or length != 13:
                raise RuntimeError('PNG header missing')
            width, height, depth, color, compression, filtering, interlace = struct.unpack('!IIBBBBB', payload)
            if (width, height) != (1920, 1080) or depth != 8 or color != 2 or (compression, filtering, interlace) != (0, 0, 0):
                raise RuntimeError('PNG must be exactly 1920x1080, 8-bit, non-interlaced')
            seen_header = True
        elif kind == b'IHDR':
            raise RuntimeError('Duplicate PNG header')
        if kind == b'IDAT':
            seen_data = True
            compressed.extend(payload)
        if kind == b'IEND':
            if length != 0 or not seen_data or end != len(data):
                raise RuntimeError('PNG must contain one complete frame only')
            expected_size = 1080 * (1920 * 3 + 1)
            decoder = zlib.decompressobj()
            try:
                pixels = decoder.decompress(compressed, expected_size + 1)
            except zlib.error as error:
                raise RuntimeError('Invalid PNG image data') from error
            if len(pixels) != expected_size or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
                raise RuntimeError('Invalid PNG decoded size')
            if any(pixels[row * (1920 * 3 + 1)] > 4 for row in range(1080)):
                raise RuntimeError('Invalid PNG row filter')
            return data
        offset = end
    raise RuntimeError('PNG end missing')


def pipeline():
    children = []
    previous = None
    deadline = time.monotonic() + CAPTURE_SECONDS
    try:
        for command in COMMANDS:
            child = subprocess.Popen(command, stdin=previous if previous is not None else subprocess.DEVNULL,
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                     env=common.helper_environment())
            children.append(child)
            if previous is not None:
                previous.close()
            previous = child.stdout
        data = bytearray()
        with selectors.DefaultSelector() as selector:
            selector.register(previous, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise RuntimeError('Capture timed out')
                block = os.read(previous.fileno(), min(65536, MAX_PNG_BYTES + 1 - len(data)))
                if not block:
                    break
                data.extend(block)
                if len(data) > MAX_PNG_BYTES:
                    raise RuntimeError('Capture exceeds PNG byte limit')
        for child in children:
            if child.wait(timeout=max(0.01, deadline - time.monotonic())) != 0:
                raise RuntimeError('Capture conversion failed')
        return bytes(data)
    finally:
        if previous is not None:
            previous.close()
        for child in children:
            if child.poll() is None:
                child.kill()
        for child in children:
            child.wait(timeout=2)


def capture():
    common.require_ready()
    data = validate_png(pipeline())
    # A frame captured while the desktop drifted must not be delivered.
    common.require_ready()
    return data


def main():
    try:
        if len(sys.argv) != 1:
            raise RuntimeError('Capture helper accepts no arguments')
        data = capture()
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        # Do not include tool stderr, environment, filenames or captured content.
        print('VAMP desktop capture unavailable', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
