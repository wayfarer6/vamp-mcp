"""Build a Debian Installer answer ISO containing a compressed initrd overlay."""
import gzip
from io import BytesIO

import pycdlib


def cpio_entry(name, payload, inode, mode):
    name = name.encode() + b"\0"
    fields = (inode, mode, 0, 0, 1, 0, len(payload), 0, 0, 0, 0, len(name), 0)
    header = b"070701" + b"".join(f"{value:08x}".encode() for value in fields) + name
    return header + b"\0" * (-len(header) % 4) + payload + b"\0" * (-len(payload) % 4)


def create_setup_iso(path, files):
    payload = b"".join(
        cpio_entry(name, contents, inode, mode)
        for inode, (name, contents, mode) in enumerate(files, start=1)
    )
    payload += cpio_entry("TRAILER!!!", b"", 0, 0)
    compressed = gzip.compress(payload, mtime=0)
    iso = pycdlib.PyCdlib()
    iso.new(interchange_level=3, joliet=3, vol_ident="VAMP_SETUP")
    with BytesIO(compressed) as stream:
        iso.add_fp(stream, len(compressed), iso_path="/VAMPBOOT.GZ;1", joliet_path="/vampboot.gz")
        iso.write(str(path))
    iso.close()
