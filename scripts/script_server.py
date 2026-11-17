#!/usr/bin/env python3
"""Serve the VAMP guest setup folder over HTTP so a guest installs it with wget or curl.

The VAMP host code no longer rewrites ISO images with xorriso. Guest setup
scripts, the recorder bundle and the vault helpers are staged into one folder
and served by Python's standard library on the fixed port 8421, which is not a
well-known port and is unlikely to collide with another service.

VirtualBox NAT and QEMU user networking both expose the host to the guest as
10.0.2.2; libvirt's default NAT network exposes it as 192.168.122.1.

    python3 scripts/script_server.py start            # stage + start, print JSON
    python3 scripts/script_server.py status
    python3 scripts/script_server.py stop

Guests then run:

    wget -qO- http://10.0.2.2:8421/setup.sh | sh
    powershell -ExecutionPolicy Bypass -Command "irm http://10.0.2.2:8421/setup.ps1 | iex"

The server only serves the staged setup folder (no directory listing, no
dotfiles) and stops itself after --ttl seconds (default 1800) unless stopped
sooner.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'backends/common'))
from guest_install import PROFILE
SCRIPT_SERVER_PORT = PROFILE['script_server_port']
DEFAULT_BIND = '0.0.0.0'
DEFAULT_TTL = 1800
SERVICE = 'vamp-script-server'
GUEST_HOSTS = {
    'virtualbox_nat': '10.0.2.2',
    'kvm_user_network': '10.0.2.2',
    'kvm_default_network': '192.168.122.1',
}
SKIP = shutil.ignore_patterns('__pycache__', '*.pyc', '.git')
# The recorder bundle is committed to the repository so a clean checkout, a
# published package or a remote host can stage guest setup without the local
# third_party recorder sources. This URL is the last resort when neither the
# sources nor the committed bundle are present.
RECORDER_ZIP_URL = os.environ.get(
    'VAMP_RECORDER_ZIP_URL',
    'https://raw.githubusercontent.com/wayfarer6/vamp-mcp/main/guest_setup/recorder/recorder.zip',
)
RECORDER_ENTRY = 'PyAutoGuiRecorder.py'


def state_directory() -> Path:
    if os.environ.get('VAMP_SCRIPT_SERVER_DIR'):
        return Path(os.environ['VAMP_SCRIPT_SERVER_DIR']).expanduser()
    if os.environ.get('VAMP_DATA_DIR'):
        return Path(os.environ['VAMP_DATA_DIR']).expanduser() / 'script-server'
    return Path.home() / '.vamp' / 'script-server'


def _copy_tree(source: Path, destination: Path) -> None:
    shutil.copytree(source, destination, ignore=SKIP, dirs_exist_ok=True)


def _add_tree(archive: tarfile.TarFile, root: Path, name: str) -> None:
    for path in sorted(root.rglob('*')):
        if '__pycache__' in path.parts or path.suffix == '.pyc':
            continue
        archive.add(path, arcname=str(Path(name) / path.relative_to(root)))


def _zip_tree(archive: zipfile.ZipFile, root: Path, name: str) -> None:
    for path in sorted(root.rglob('*')):
        if '__pycache__' in path.parts or path.suffix == '.pyc':
            continue
        archive.write(path, str(Path(name) / path.relative_to(root)))


def digest(path: Path) -> str:
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def _recorder_zip_usable(path: Path) -> bool:
    """True when path is a zip that carries the recorder program itself."""
    try:
        with zipfile.ZipFile(path) as archive:
            return RECORDER_ENTRY in {Path(name).name for name in archive.namelist()}
    except (OSError, zipfile.BadZipFile):
        return False


def download_recorder_zip(destination: Path, url: str = RECORDER_ZIP_URL, timeout: int = 30) -> Path:
    """Fetch the committed recorder bundle when no local copy exists."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={'User-Agent': 'vamp-script-server'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = response.read()
    if not payload.startswith(b'PK'):
        raise RuntimeError(f'{url} did not return a zip archive')
    destination.write_bytes(payload)
    if not _recorder_zip_usable(destination):
        destination.unlink(missing_ok=True)
        raise RuntimeError(f'{url} is not a usable recorder bundle (no {RECORDER_ENTRY})')
    return destination


def ensure_recorder_zip(folder: Path, recorder_source: Path | None = None) -> Path:
    """Keep recorder.zip beside the recorder setup.

    Order: rebuild from the packaged recorder sources, reuse the bundle that
    ships in the repository, then download it from the project's GitHub URL.
    """
    recorder_zip = folder / 'recorder.zip'
    if recorder_source and recorder_source.is_dir():
        folder.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(recorder_zip, 'w', zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(recorder_source.rglob('*')):
                if path.is_file() and '__pycache__' not in path.parts and path.suffix != '.pyc':
                    archive.write(path, str(path.relative_to(recorder_source)))
        return recorder_zip
    if _recorder_zip_usable(recorder_zip):
        return recorder_zip
    return download_recorder_zip(recorder_zip)


def stage(source: Path | None = None, destination: Path | None = None,
          port: int = SCRIPT_SERVER_PORT) -> dict:
    """Build the served folder: HTTP bootstraps at the root plus the setup trees."""
    source = Path(source or ROOT / 'guest_setup').expanduser().resolve()
    if not (source / 'recorder' / 'setup.sh').is_file():
        raise FileNotFoundError(f'Guest setup source is incomplete: {source}')
    destination = Path(destination or state_directory() / 'stage').expanduser().resolve()
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)

    http = source / 'http'
    for name in ('setup.sh', 'postdeb.sh', 'debian-preseed.cfg'):
        shutil.copy2(http / name, destination / name)
        (destination / name).chmod(0o755)
    for name in ('setup.ps1', 'setup-all.ps1', 'setup-win.cmd', 'postwin.ps1'):
        shutil.copy2(http / name, destination / name)
    for name in ('setup-all.sh', 'setup-all.ps1'):
        candidate = source / name
        if candidate.is_file():
            shutil.copy2(candidate, destination / name)
    for name in ('recorder', 'vault', 'kvm'):
        if (source / name).is_dir():
            _copy_tree(source / name, destination / name)

    # Guest setups expect recorder.zip beside setup.sh: rebuild it from the
    # packaged recorder sources, otherwise keep the bundle committed in the
    # repository, otherwise download it so a clean environment still works.
    recorder_source = source.parent / 'third_party' / 'pyautogui-recorder'
    try:
        ensure_recorder_zip(destination / 'recorder', recorder_source)
    except (OSError, RuntimeError, urllib.error.URLError) as error:
        # A missing recorder only disables the recording tool, so keep serving
        # the rest of guest setup and say plainly what is missing.
        print(f'vamp: recorder bundle unavailable: {error}', file=sys.stderr)

    # Optional verified VeraCrypt CLI payload for the vault setup.
    cli_source = source.parent / 'artifacts' / 'kvm-setup' / 'bin'
    if (cli_source / 'SHA256SUMS').is_file() and (cli_source / 'veracrypt.tar.gz').is_file():
        (destination / 'cli').mkdir(exist_ok=True)
        for name in ('SHA256SUMS', 'veracrypt.tar.gz'):
            shutil.copy2(cli_source / name, destination / 'cli' / name)

    # Host checkout line endings must never leak into a Linux guest shell.
    # Normalize before creating either archive, including nested recorder scripts.
    for shell in destination.rglob('*.sh'):
        shell.write_bytes(shell.read_bytes().replace(b'\r\n', b'\n'))

    tar_path = destination / 'vamp-guest-setup.tar.gz'
    with tarfile.open(tar_path, 'w:gz') as archive:
        for name in ('recorder', 'vault', 'kvm'):
            if (destination / name).is_dir():
                _add_tree(archive, destination / name, name)
        if (destination / 'cli').is_dir():
            _add_tree(archive, destination / 'cli', 'cli')
        for name in ('setup-all.sh', 'setup-all.ps1'):
            if (destination / name).is_file():
                archive.add(destination / name, arcname=name)

    zip_path = destination / 'vamp-guest-setup.zip'
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name in ('recorder', 'vault', 'kvm'):
            if (destination / name).is_dir():
                _zip_tree(archive, destination / name, name)
        if (destination / 'cli').is_dir():
            _zip_tree(archive, destination / 'cli', 'cli')
        for name in ('setup-all.sh', 'setup-all.ps1'):
            if (destination / name).is_file():
                archive.write(destination / name, name)

    commands = guest_commands(port)
    manifest = {
        'service': SERVICE,
        'version': 1,
        'port': port,
        'guest_hosts': GUEST_HOSTS,
        'bundles': {
            'tar_gz': {'name': tar_path.name, 'sha256': digest(tar_path), 'bytes': tar_path.stat().st_size},
            'zip': {'name': zip_path.name, 'sha256': digest(zip_path), 'bytes': zip_path.stat().st_size},
        },
        'commands': commands,
        'note': 'Guest setup is downloaded, not installed: verify the guest after running it.',
    }
    (destination / 'vamp-setup.json').write_text(json.dumps(manifest, indent=2) + '\n')
    files = sorted(
        str(path.relative_to(destination)).replace(os.sep, '/')
        for path in destination.rglob('*') if path.is_file()
    )
    return {'status': 'staged', 'directory': str(destination), 'files': files, 'manifest': manifest}


def guest_commands(port: int = SCRIPT_SERVER_PORT, host: str = '10.0.2.2') -> dict:
    base = f'http://{host}:{port}'
    return {
        'base_url': base,
        'debian_recorder': f'wget -qO- {base}/setup.sh | sh',
        'debian_recorder_curl': f'curl -fsSL {base}/setup.sh | sh',
        'debian_all': f'wget -qO- {base}/setup.sh | sh -s -- --all',
        'windows_recorder': f'powershell -ExecutionPolicy Bypass -Command "irm {base}/setup.ps1 | iex"',
        'windows_cmd': f'curl.exe -fsSL {base}/setup-win.cmd -o %TEMP%\\setup-win.cmd && %TEMP%\\setup-win.cmd',
    }


class ScriptRequestHandler(SimpleHTTPRequestHandler):
    """Serve only the staged setup folder; no listings, no dotfiles, no caching."""
    server_version = 'VAMPScriptServer/1.0'
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.sh': 'text/plain; charset=utf-8',
        '.ps1': 'text/plain; charset=utf-8',
        '.cmd': 'text/plain; charset=utf-8',
        '.json': 'application/json',
        '.gz': 'application/gzip',
        '.zip': 'application/zip',
    }

    def end_headers(self) -> None:
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def list_directory(self, path):  # noqa: D401 - stdlib hook
        self.send_error(404, 'Directory listing is disabled')
        return None

    def translate_path(self, path: str) -> str:
        resolved = super().translate_path(path)
        root = Path(self.directory).resolve()
        candidate = Path(resolved).resolve()
        if root not in candidate.parents and candidate != root:
            return str(root / '__forbidden__')
        if any(part.startswith('.') for part in candidate.relative_to(root).parts):
            return str(root / '__forbidden__')
        return str(candidate)

    def do_GET(self) -> None:  # noqa: N802 - stdlib name
        if self.path.split('?', 1)[0] == '/healthz':
            payload = json.dumps({
                'status': 'ok',
                'service': SERVICE,
                'port': self.server.server_address[1],
                'directory': str(self.server.stage_directory),
                'started_at': self.server.started_at,
                'ttl_seconds': self.server.ttl,
            }).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if self.path.split('?', 1)[0] == '/':
            self.path = '/vamp-setup.json'
        super().do_GET()

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - stdlib name
        sys.stderr.write(f'{time.strftime("%Y-%m-%d %H:%M:%S")} {self.address_string()} {format % args}\n')


def make_server(directory: Path, port: int = SCRIPT_SERVER_PORT, bind: str = DEFAULT_BIND,
                ttl: int = DEFAULT_TTL) -> ThreadingHTTPServer:
    handler = lambda *args, **kwargs: ScriptRequestHandler(*args, directory=str(directory), **kwargs)  # noqa: E731
    server = ThreadingHTTPServer((bind, port), handler)
    server.stage_directory = Path(directory)
    server.started_at = time.strftime('%Y-%m-%dT%H:%M:%S%z')
    server.ttl = ttl
    return server


def serve(directory: Path, port: int, bind: str, ttl: int) -> int:
    try:
        server = make_server(directory, port, bind, ttl)
    except OSError as error:
        sys.stderr.write(f'Cannot listen on {bind}:{port}: {error}\n')
        return 2
    stopping = threading.Event()

    def stop(*_args) -> None:
        if stopping.is_set():
            return
        stopping.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    if ttl > 0:
        timer = threading.Timer(ttl, stop)
        timer.daemon = True
        timer.start()
    sys.stderr.write(json.dumps({
        'status': 'serving', 'service': SERVICE, 'port': server.server_address[1],
        'bind': bind, 'directory': str(directory), 'ttl_seconds': ttl,
    }) + '\n')
    sys.stderr.flush()
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
    return 0


def _pid_file(port: int = SCRIPT_SERVER_PORT) -> Path:
    return state_directory() / f'{port}.pid'


def _log_file(port: int = SCRIPT_SERVER_PORT) -> Path:
    return state_directory() / f'{port}.log'


def _health(port: int) -> dict | None:
    url = f'http://127.0.0.1:{port}/healthz'
    try:
        with urllib.request.urlopen(url, timeout=1.5) as response:
            payload = json.loads(response.read())
    except (urllib.error.URLError, OSError, ValueError):
        return None
    if isinstance(payload, dict) and payload.get('service') == SERVICE:
        return payload
    return {'status': 'foreign', 'service': payload.get('service') if isinstance(payload, dict) else None}


def status(port: int = SCRIPT_SERVER_PORT) -> dict:
    pid_path = _pid_file(port)
    record: dict = {}
    if pid_path.is_file():
        try:
            record = json.loads(pid_path.read_text())
        except ValueError:
            record = {}
    health = _health(port)
    if health and health.get('status') == 'ok':
        return {'status': 'running', 'port': port, 'url': f'http://127.0.0.1:{port}',
                'guest_urls': {name: f'http://{host}:{port}' for name, host in GUEST_HOSTS.items()},
                'directory': health.get('directory'), 'started_at': health.get('started_at'),
                'ttl_seconds': health.get('ttl_seconds'), 'pid': record.get('pid'),
                'log': str(_log_file(port))}
    if health and health.get('status') == 'foreign':
        return {'status': 'port_in_use', 'port': port,
                'error': f'Port {port} is already used by another service. Stop it before starting the VAMP script server.'}
    if record.get('pid') and _alive(int(record['pid'])):
        return {'status': 'starting', 'port': port, 'pid': record.get('pid'),
                'log': str(_log_file(port))}
    return {'status': 'stopped', 'port': port}


def _alive(pid: int) -> bool:
    if os.name == 'posix':
        try:
            os.kill(pid, 0)
        except OSError:
            return False
        return True
    # os.kill(pid, 0) terminates a process on Windows, so query the handle instead.
    try:
        import ctypes
        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        ctypes.windll.kernel32.CloseHandle(handle)
        return True
    except Exception:
        return True


def _terminate(pid: int) -> None:
    if os.name == 'posix':
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
        return
    subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'], capture_output=True, timeout=15)


def _wait_health(port: int, seconds: float = 10.0) -> dict | None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        health = _health(port)
        if health and health.get('status') == 'ok':
            return health
        time.sleep(0.2)
    return None


def start(source: Path | None = None, port: int = SCRIPT_SERVER_PORT, bind: str = DEFAULT_BIND,
          ttl: int = DEFAULT_TTL) -> dict:
    current = status(port)
    if current['status'] == 'running':
        # Refresh upgraded/normalized payloads without deleting files currently
        # being downloaded. Publish each staged file atomically.
        if current.get('directory'):
            with tempfile.TemporaryDirectory(prefix='vamp-stage-') as temporary:
                staged=stage(source,Path(temporary)/'stage',port=port)
                staged_root=Path(staged['directory'])
                live=Path(current['directory'])
                for file in staged_root.rglob('*'):
                    if file.is_file():
                        target=live/file.relative_to(staged_root)
                        target.parent.mkdir(parents=True,exist_ok=True)
                        pending=target.with_name(target.name+'.pending')
                        shutil.copy2(file,pending)
                        os.replace(pending,target)
        return {**current, 'reused': True}
    if current['status'] == 'port_in_use':
        return current
    staged = stage(source, port=port)
    state = state_directory()
    state.mkdir(parents=True, exist_ok=True)
    directory = Path(staged['directory'])
    log_path = _log_file(port)
    detach = {'start_new_session': True} if os.name == 'posix' else {
        'creationflags': getattr(subprocess, 'DETACHED_PROCESS', 0) | getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0)}
    with log_path.open('ab') as log:
        process = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), 'serve',
             '--directory', str(directory), '--port', str(port), '--bind', bind, '--ttl', str(ttl)],
            stdout=log, stderr=log, stdin=subprocess.DEVNULL, **detach,
        )
    health = _wait_health(port)
    if not health:
        return {'status': 'failed', 'port': port,
                'error': f'The script server did not answer on port {port}. Read {log_path}.'}
    record = {'pid': process.pid, 'port': port, 'bind': bind, 'directory': str(directory),
              'started_at': health.get('started_at'), 'ttl_seconds': ttl}
    _pid_file(port).write_text(json.dumps(record, indent=2) + '\n')
    return {'status': 'running', 'port': port, 'pid': process.pid, 'bind': bind,
            'directory': str(directory), 'started_at': health.get('started_at'), 'ttl_seconds': ttl,
            'url': f'http://127.0.0.1:{port}',
            'guest_urls': {name: f'http://{host}:{port}' for name, host in GUEST_HOSTS.items()},
            'commands': guest_commands(port), 'manifest': str(directory / 'vamp-setup.json'),
            'log': str(log_path)}


def stop(port: int = SCRIPT_SERVER_PORT) -> dict:
    pid_path = _pid_file(port)
    record: dict = {}
    if pid_path.is_file():
        try:
            record = json.loads(pid_path.read_text())
        except ValueError:
            record = {}
    pid = record.get('pid')
    if not pid:
        if status(port)['status'] == 'running':
            return {'status': 'running', 'port': port,
                    'error': 'A script server answers on this port but its pid file is missing. Stop it from the terminal that started it.'}
        return {'status': 'stopped', 'port': port}
    pid = int(pid)
    _terminate(pid)
    deadline = time.time() + 6
    while time.time() < deadline and _alive(pid):
        time.sleep(0.2)
    if _alive(pid) and os.name == 'posix':
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    pid_path.unlink(missing_ok=True)
    return {'status': 'stopped', 'port': port, 'pid': pid}


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=('serve', 'stage', 'start', 'stop', 'status'))
    parser.add_argument('--port', type=int, default=SCRIPT_SERVER_PORT,
                        help=f'HTTP port; VAMP uses {SCRIPT_SERVER_PORT} (default)')
    parser.add_argument('--bind', default=DEFAULT_BIND, help=f'Bind address (default {DEFAULT_BIND})')
    parser.add_argument('--directory', help='Guest setup source folder (default: <repo>/guest_setup)')
    parser.add_argument('--ttl', type=int, default=DEFAULT_TTL, help='Seconds before the server stops itself (0 = no limit)')
    parser.add_argument('--json', action='store_true', help='Print one JSON document on stdout')
    args = parser.parse_args(argv)
    source = Path(args.directory) if args.directory else None

    if args.command == 'serve':
        if not args.directory:
            parser.error('serve needs --directory (run "start" to stage and launch)')
        return serve(Path(args.directory), args.port, args.bind, args.ttl)
    if args.command == 'stage':
        result = stage(source, port=args.port)
    elif args.command == 'start':
        result = start(source, args.port, args.bind, args.ttl)
    elif args.command == 'stop':
        result = stop(args.port)
    else:
        result = status(args.port)
    print(json.dumps(result, indent=2))
    return 0 if result.get('status') not in ('failed', 'port_in_use') else 1


if __name__ == '__main__':
    sys.exit(main())
