"""Build the Debian Installer answer ISO and inputs for the Hyper-V template."""
import argparse
import gzip
import hashlib
from io import BytesIO
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
from tempfile import TemporaryDirectory

import pycdlib

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]


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


def render_preseed():
    replaced = (
        "d-i passwd/user-password ", "d-i passwd/user-password-again ",
        "d-i apt-setup/use_mirror ", "d-i apt-setup/disable-cdrom-entries ",
        "d-i pkgsel/run_tasksel ", "d-i pkgsel/include ",
        "d-i preseed/late_command ", "tasksel ", "shared shared/default-x-display-manager ",
    )
    assets = Path(os.environ.get("VAMP_PROVISIONING_ASSETS") or REPO)
    source = assets / "guest_setup/http/debian-preseed.cfg"
    lines = [line for line in source.read_text().splitlines() if not line.startswith(replaced)]
    password = secrets.token_urlsafe(32)
    lines.extend((
        f"d-i passwd/user-password password {password}",
        f"d-i passwd/user-password-again password {password}",
        "d-i netcfg/enable boolean false",
        "d-i apt-setup/use_mirror boolean false",
        "d-i apt-setup/disable-cdrom-entries boolean true",
        "d-i apt-setup/services-select multiselect",
        "d-i pkgsel/run_tasksel boolean false",
        "d-i grub-installer/force-efi-extra-removable boolean true",
        "d-i grub-installer/update-nvram boolean true",
        "d-i debian-installer/exit/poweroff boolean true",
        "d-i preseed/early_command string mkdir -p /usr/lib/apt-setup/generators && cp /vamp-dvd-repository /usr/lib/apt-setup/generators/39vamp-dvd",
        "d-i preseed/late_command string sh /vamp-finish-offline",
    ))
    return ("\n".join(lines) + "\n").encode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dvd", type=Path, required=True)
    parser.add_argument("--dvd-sha256", required=True)
    parser.add_argument("--job-dir", type=Path, required=True)
    parser.add_argument("--vm-name", required=True)
    parser.add_argument("--switch", required=True)
    parser.add_argument("--guest-ip", type=ipaddress.IPv4Interface, required=True)
    parser.add_argument("--gateway", type=ipaddress.IPv4Address, required=True)
    parser.add_argument("--dns", type=ipaddress.IPv4Address, required=True)
    parser.add_argument("--ssh-public-key", type=Path, required=True)
    parser.add_argument("--hyperv-daemons-deb", type=Path, required=True)
    parser.add_argument("--hyperv-daemons-sha256", required=True)
    parser.add_argument("--reservation-dir", type=Path, default=Path.home() / ".vamp/hyperv-debian-addresses")
    args = parser.parse_args()
    if not args.dvd.is_file() or not re.fullmatch(r"[a-fA-F0-9]{64}", args.dvd_sha256):
        parser.error("Use a local Debian 13 amd64 DVD and its verified SHA-256")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,62}", args.vm_name):
        parser.error("VM name must be 1-63 ASCII letters, digits, or hyphens")
    if not args.hyperv_daemons_deb.is_file():
        parser.error("Debian DVD-1 requires a separate hyperv-daemons package")
    integration_package = args.hyperv_daemons_deb.read_bytes()
    if hashlib.sha256(integration_package).hexdigest() != args.hyperv_daemons_sha256.lower():
        parser.error("hyperv-daemons package does not match the signed APT index checksum")
    if args.gateway not in args.guest_ip.network or len({args.guest_ip.ip, args.gateway,
            args.guest_ip.network.network_address, args.guest_ip.network.broadcast_address}) != 4:
        parser.error("Guest and gateway must be distinct usable addresses on the same dedicated subnet")
    public_key = args.ssh_public_key.read_text().strip()
    if "\n" in public_key or not re.fullmatch(r"ssh-(ed25519|rsa) [A-Za-z0-9+/=]+(?: [^\r\n]*)?", public_key):
        parser.error("Use a single OpenSSH Ed25519 or RSA public key")

    job = args.job_dir.resolve()
    if job.exists():
        parser.error("Job directory already exists")
    job.parent.mkdir(parents=True, exist_ok=True)
    args.reservation_dir.mkdir(parents=True, exist_ok=True)
    reservation = args.reservation_dir / f"{args.guest_ip.ip}.json"
    try:
        lease = reservation.open("x")
    except FileExistsError:
        parser.error(f"Address already reserved: {reservation}")
    network = f"auto eth0\niface eth0 inet static\n    address {args.guest_ip}\n    gateway {args.gateway}\n"
    deployment = {"guest_ip": str(args.guest_ip.ip), "switch": args.switch, "vm_name": args.vm_name}
    variables = {
        "dvd_path": args.dvd.resolve().as_uri(),
        "dvd_sha256": args.dvd_sha256.lower(),
        "job_dir": job.as_posix(),
        "vm_name": args.vm_name,
        "switch_name": args.switch,
    }
    try:
        with lease:
            json.dump({"job": str(job), **deployment}, lease)
        with TemporaryDirectory(prefix=".debian-hyperv-", dir=job.parent) as scratch:
            staged = Path(scratch) / "job"
            (staged / "temporary").mkdir(parents=True)
            create_setup_iso(staged / "setup.iso", [
                ("preseed.cfg", render_preseed(), 0o100644),
                ("vamp-dvd-repository", (HERE / "dvd-repository.sh").read_text().encode(), 0o100755),
                ("vamp-finish-offline", (HERE / "finish-offline.sh").read_text().encode(), 0o100755),
                ("vamp-static-network", network.encode(), 0o100644),
                ("vamp-resolv.conf", f"nameserver {args.dns}\n".encode(), 0o100644),
                ("vamp-authorized-keys", (public_key + "\n").encode(), 0o100644),
                ("vamp-hyperv-daemons.deb", integration_package, 0o100644),
            ])
            (staged / "build.pkrvars.json").write_text(json.dumps(variables, indent=2) + "\n")
            (staged / "deployment.json").write_text(json.dumps(deployment, indent=2) + "\n")
            staged.rename(job)
    except BaseException:
        reservation.unlink(missing_ok=True)
        raise


if __name__ == "__main__":
    main()
