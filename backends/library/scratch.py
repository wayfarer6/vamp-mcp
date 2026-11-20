"""Host-configured isolation checks for a VirtualBox repair guest."""
import os
import subprocess
import uuid

from backends.virtualbox.provision import executable, parse


def show_vm(vm):
    result = subprocess.run(
        [executable(), 'showvminfo', vm, '--machinereadable'],
        check=True, capture_output=True, text=True, timeout=15,
    )
    return parse(result.stdout)


def require_virtualbox_scratch(vm, *, read_config=show_vm, environment=None):
    environment = os.environ if environment is None else environment
    try:
        requested = str(uuid.UUID(vm))
        configured = str(uuid.UUID(environment['VAMP_REPAIR_SCRATCH_VM']))
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError('Configure a dedicated VirtualBox repair VM UUID on the host.') from error
    if requested != configured:
        raise ValueError('The requested VM is not the host-configured repair VM.')

    fields = read_config(requested)
    if fields.get('UUID', '').lower() != requested or fields.get('VMState') != 'running':
        raise ValueError('The exact VirtualBox repair VM must already be running.')
    isolated = {
        **{f'nic{index}': 'none' for index in range(1, 9)},
        'clipboard': 'disabled',
        'clipboard_file_transfers': 'off',
        'draganddrop': 'disabled',
        'vrde': 'off',
        'usb': 'off',
        'teleporterenabled': 'off',
    }
    exposed = [name for name, value in isolated.items() if fields.get(name) != value]
    if any(name.lower().startswith('sharedfoldernamemapping') or
           name.lower().startswith('sharedfoldername') for name in fields):
        exposed.append('shared folders')
    if exposed:
        raise ValueError('The VirtualBox repair VM isolation check failed: ' + ', '.join(exposed))
    return requested
