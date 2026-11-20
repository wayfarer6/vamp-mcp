"""Host-configured isolation checks for a VirtualBox repair guest."""
import hashlib
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import stat
import subprocess
from tempfile import TemporaryDirectory
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
        'ehci': 'off',
        'xhci': 'off',
        'audio_in': 'off',
        'audio_out': 'off',
        **{f'uart{index}': 'off' for index in range(1, 5)},
        **{f'lpt{index}': 'off' for index in range(1, 3)},
        'teleporterenabled': 'off',
    }
    exposed = [name for name, value in isolated.items() if fields.get(name) != value]
    if any(name.lower().startswith('sharedfoldernamemapping') or
           name.lower().startswith('sharedfoldername') for name in fields):
        exposed.append('shared folders')
    if exposed:
        raise ValueError('The VirtualBox repair VM isolation check failed: ' + ', '.join(exposed))
    return requested


def scratch_artifact_settings(environment=None):
    environment = os.environ if environment is None else environment
    source = environment.get('VAMP_REPAIR_ARTIFACT', '')
    username = environment.get('VAMP_REPAIR_GUEST_USER', '')
    password = Path(environment.get('VAMP_REPAIR_GUEST_PASSWORD_FILE', ''))
    baseline = environment.get('VAMP_REPAIR_ARTIFACT_BASELINE_SHA256', '')
    expected = environment.get('VAMP_REPAIR_ARTIFACT_SHA256', '')
    absolute = PurePosixPath(source).is_absolute() or PureWindowsPath(source).is_absolute()
    if (not absolute or source.startswith(('//', '\\\\')) or any(c in source for c in '*?[]\r\n\x00')
            or not username or not password.is_absolute() or not password.is_file()
            or not re.fullmatch(r'[a-f0-9]{64}', baseline)
            or not re.fullmatch(r'[a-f0-9]{64}', expected) or baseline == expected):
        raise ValueError('Configure the scratch output path, guest credentials and distinct baseline and expected SHA-256 values on the host.')
    return source, username, password, baseline, expected


def scratch_modal_settings(environment=None, *, required=False):
    environment = os.environ if environment is None else environment
    model = environment.get('VAMP_REPAIR_MODAL_MODEL', '')
    label = environment.get('VAMP_REPAIR_MODAL_LABEL', '').strip()
    if not required and not model and not label:
        return None
    path = Path(model)
    if not path.is_absolute() or not path.is_file() or not 1 <= len(label) <= 100:
        raise ValueError('Configure a trusted local modal detector and its exact forbidden class on the host.')
    return str(path.resolve()), label


def scratch_artifact_hash(vm, settings, *, execute=subprocess.run):
    source, username, password, _, _ = settings
    command = [executable(), 'guestcontrol', vm]
    auth = [f'--username={username}', f'--passwordfile={password}']

    def run(operation, *arguments):
        result = execute([*command, operation, *auth, *arguments],
                         capture_output=True, text=True, timeout=30)
        if result.returncode:
            raise ValueError('VirtualBox could not read the configured scratch output.')
        return result.stdout

    info = run('stat', source)
    match = re.search(r'^[ \t]*Size:[ \t]*(\d+)[ \t]+Alloc:[ \t]*\d+[ \t]+Type:[ \t]*file[ \t]*\r?$', info, re.MULTILINE | re.IGNORECASE)
    if not match or int(match[1]) > 1024 * 1024:
        raise ValueError('The scratch output must be a regular file of at most 1 MiB.')
    with TemporaryDirectory(prefix='vamp-repair-artifact-') as directory:
        if os.name == 'nt':
            account = subprocess.run(
                ['whoami.exe', '/user', '/fo', 'csv', '/nh'],
                check=True, capture_output=True, text=True, timeout=10,
            ).stdout
            sid = re.search(r'"(S-1-[\d-]+)"', account)
            if not sid:
                raise ValueError('Could not identify the local account for scratch artifact verification.')
            # An elevated VirtualBox service can own the copied file. Grant the
            # same desktop user explicit inherited access within this temp folder.
            subprocess.run(['icacls.exe', directory, '/grant', f'*{sid[1]}:(OI)(CI)M'],
                           check=True, capture_output=True, timeout=10)
        target = Path(directory) / 'output'
        run('copyfrom', '--no-replace', source, str(target))
        metadata = target.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size != int(match[1]):
            raise ValueError('The copied scratch output differs from the guest file reported by VirtualBox.')
        with target.open('rb') as stream:
            return hashlib.file_digest(stream, 'sha256').hexdigest()
