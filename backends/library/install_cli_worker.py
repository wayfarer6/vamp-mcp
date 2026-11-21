"""Install the stdio worker in a Linux VM after checking its hypervisor and UUID."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import uuid

VIRTUALIZATION = {'virtualbox':{'oracle'}, 'kvm':{'kvm'}, 'hyperv':{'microsoft'}}


def install_atomic(dest, data):
    dest.parent.mkdir(mode=0o755,parents=True,exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=dest.parent,delete=False) as temp:
        temp.write(data)
        temp.flush()
        os.fchmod(temp.fileno(),0o644)
    os.replace(temp.name,dest)


def matching_vm_id(backend, expected):
    if backend == 'hyperv':
        # Hyper-V generates a separate SMBIOS UUID. Pool 3 carries the host VM ID.
        pool = Path('/var/lib/hyperv/.kvp_pool_3')
        if not pool.exists():
            raise ValueError('Enable Hyper-V Data Exchange and start hv_kvp_daemon in the guest.')
        with pool.open('rb') as stream:
            while record := stream.read(512 + 2048):
                if len(record) != 2560:
                    raise ValueError('Incomplete Hyper-V KVP record. Retry when Data Exchange is ready.')
                key = record[:512].split(b'\0', 1)[0]
                if key == b'VirtualMachineId':
                    value = record[512:].split(b'\0', 1)[0].decode('ascii')
                    return uuid.UUID(value.strip()) == expected
        raise ValueError('VirtualMachineId is missing from the Hyper-V Data Exchange pool.')
    firmware = uuid.UUID(Path('/sys/class/dmi/id/product_uuid').read_text().strip())
    return expected in (firmware, uuid.UUID(bytes_le=firmware.bytes))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend',choices=VIRTUALIZATION,required=True)
    parser.add_argument('--vm-id',type=uuid.UUID,required=True)
    parser.add_argument('--workspace',required=True)
    parser.add_argument('--image',required=True,help='Rootless worker account’s locally prepared image ID')
    parser.add_argument('--python-lock-sha256')
    parser.add_argument('--playwright-lock-sha256')
    args=parser.parse_args()
    if os.getuid()!=0 or not shutil.which('podman') or not Path('/usr/bin/podman').is_file():
        parser.error('Run the installer as root in a Linux guest with Podman installed.')
    kind=subprocess.check_output(['systemd-detect-virt','--vm'],text=True).strip()
    if kind not in VIRTUALIZATION[args.backend]:
        parser.error('Selected backend differs from the detected VM type: '+kind)
    try:
        matches = matching_vm_id(args.backend, args.vm_id)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    if not matches:
        parser.error('Selected VM UUID differs from the identity reported by the hypervisor.')
    locks={k:v for k,v in [('python',args.python_lock_sha256),('playwright',args.playwright_lock_sha256)] if v}
    if (not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}',args.workspace) or
            not re.fullmatch(r'sha256:[0-9a-f]{64}',args.image) or not locks or
            any(not re.fullmatch(r'[0-9a-f]{64}',v) for v in locks.values())):
        parser.error('Invalid workspace, image ID or dependency lock digest.')
    config={'backend':args.backend,'vm_id':str(args.vm_id),'workspace_id':args.workspace,'image':args.image,'locks':locks}
    install_atomic(Path('/usr/local/lib/vamp/cli_worker.py'),Path(__file__).with_name('cli_worker.py').read_bytes())
    install_atomic(Path('/etc/vamp/cli-workspace.json'),json.dumps(config).encode())
    print(json.dumps({'status':'installed',**config}))


if __name__=='__main__':
    main()
