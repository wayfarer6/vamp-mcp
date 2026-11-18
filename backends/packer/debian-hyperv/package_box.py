"""Package a Packer Hyper-V export and stage Debian provisioning inputs."""
import argparse
from io import BytesIO
import json
from pathlib import Path
import sys
import tarfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.path.insert(0, str(REPO))

from scripts.script_server import stage


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job_dir", type=Path)
    job = parser.parse_args().job_dir.resolve()
    export = job / "export"
    disks = export / "Virtual Hard Disks"
    machines = export / "Virtual Machines"
    if len(list(disks.glob("*.vhdx"))) != 1 or len(list(machines.glob("*.vmcx"))) != 1:
        parser.error("Expected a completed Gen 2 Packer Hyper-V export")
    if not (job / "deployment.json").is_file():
        parser.error("Deployment metadata missing")
    provision = job / "provision"
    stage(destination=provision)
    (provision / "hyperv-provision.sh").write_bytes((HERE / "provision.sh").read_bytes().replace(b"\r\n", b"\n"))
    metadata = json.dumps({"provider": "hyperv", "architecture": "amd64"}).encode()
    box_path = job / "debian-hyperv.box"
    with tarfile.open(box_path, "x", format=tarfile.PAX_FORMAT) as box:
        entry = tarfile.TarInfo("metadata.json")
        entry.size = len(metadata)
        box.addfile(entry, BytesIO(metadata))
        box.add(disks, arcname=disks.name)
        box.add(machines, arcname=machines.name)
    print(box_path)


if __name__ == "__main__":
    main()
