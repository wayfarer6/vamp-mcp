"""Owner-local persistent inference clients. No systemd, network listener or VM connection."""
import concurrent.futures
from contextlib import contextmanager
import errno
import hashlib
import json
import os
from pathlib import Path
import socket
import secrets
import subprocess
import sys
import tempfile
import time

ROOT=Path(__file__).resolve().parent
KINDS=('yolo','ocr')
PROTOCOL=1
WINDOWS = sys.platform == 'win32'


@contextmanager
def file_lock(path, blocking=True):
    with path.open('a+b') as handle:
        if WINDOWS:
            import msvcrt
            deadline = time.monotonic() + (20 if blocking else 0)
            while True:
                handle.seek(0)
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError as error:
                    if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                        raise
                    if time.monotonic() >= deadline:
                        raise BlockingIOError('Model process lock is held') from error
                    time.sleep(.05)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        yield


def runtime_dir():
    digest=hashlib.sha256(str(ROOT).encode()).hexdigest()[:10]
    owner = hashlib.sha256(str(Path.home()).encode()).hexdigest()[:12] if WINDOWS else os.getuid()
    if WINDOWS:
        import ctypes
        # An unelevated worker cannot read private files created by an elevated client.
        if ctypes.windll.shell32.IsUserAnAdmin():
            owner += '-elevated'
    directory=Path(tempfile.gettempdir())/f'spice-rpa-models-{owner}-{digest}'
    directory.mkdir(mode=0o700,exist_ok=True)
    if directory.is_symlink() or (hasattr(directory, 'is_junction') and directory.is_junction()):
        raise PermissionError('Model runtime directory must be local to this user')
    if not WINDOWS:
        if directory.stat().st_uid!=os.getuid():raise PermissionError('Model runtime directory owner mismatch')
        directory.chmod(0o700)
    return directory


def socket_path(kind):
    if kind not in KINDS:raise ValueError('Unknown model service')
    return runtime_dir()/f'{kind}.sock'


def pipe_address(kind):
    digest = hashlib.sha256(str(socket_path(kind)).casefold().encode()).hexdigest()[:32]
    return rf'\\.\pipe\vamp-model-{digest}'


def pipe_key(kind, create=False):
    path = socket_path(kind).with_suffix('.key')
    if create and not path.exists():
        with path.open('xb') as file:
            file.write(secrets.token_bytes(32))
    key = path.read_bytes()
    if len(key) != 32:
        raise ValueError('Invalid Windows model service key')
    return key


def model_interpreter(kind):
    configured = os.environ.get('VAMP_OCR_PYTHON' if kind == 'ocr' else 'VAMP_YOLO_PYTHON')
    directory = '.venv-ocr' if kind == 'ocr' else '.venv'
    python = 'Scripts/python.exe' if WINDOWS else 'bin/python'
    if configured:
        return Path(configured).expanduser().resolve()
    vamp_home = Path(os.environ.get('VAMP_HOME', Path.home() / '.vamp')).expanduser().resolve()
    try:
        settings = json.loads((vamp_home / 'vision-environment.json').read_text(encoding='utf-8'))
        managed = vamp_home / settings[kind]
        if managed.parent.resolve().is_relative_to(vamp_home / 'vision') and managed.is_file():
            return managed
    except (OSError, ValueError, TypeError, KeyError):
        pass
    local = ROOT / directory / python
    if local.is_file():
        return local
    return vamp_home / f'{kind}-python' / python


def raw_request(kind,payload,timeout=600):
    message = json.dumps({'protocol': PROTOCOL, **payload}).encode()
    if WINDOWS:
        from multiprocessing.connection import Client
        with Client(pipe_address(kind), family='AF_PIPE', authkey=pipe_key(kind)) as client:
            client.send_bytes(message)
            if not client.poll(timeout):
                raise TimeoutError('Model response timed out')
            data = client.recv_bytes(16*1024*1024)
    else:
        with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as client:
            client.settimeout(timeout);client.connect(str(socket_path(kind)))
            with client.makefile('rwb') as stream:
                stream.write(message+b'\n');stream.flush()
                data=stream.readline(16*1024*1024)
    if not data:raise ConnectionError('Model process closed the connection')
    response=json.loads(data)
    if not response.get('ok'):raise RuntimeError(response.get('error','Model request failed'))
    return response['result']


def status(kind):
    try:return raw_request(kind,{'op':'status'},timeout=1)
    except (OSError,ValueError,RuntimeError,EOFError):
        try:
            with file_lock(runtime_dir()/f'{kind}.lifetime.lock', blocking=False):
                pass
        except BlockingIOError:
            return {'kind':kind,'running':True,'ready':False,'state':'busy_or_loading'}
        return {'kind':kind,'running':False}


def start(kind,device='auto',*,warm=True):
    with file_lock(runtime_dir()/f'{kind}.start.lock'):
        state=status(kind)
        if state.get('running'):
            if warm and state.get('pid') and not state.get('ready'):
                raw_request(kind, {'op': 'warm'}, timeout=5)
            return state
        if WINDOWS:
            pipe_key(kind, create=True)
        else:
            socket_path(kind).unlink(missing_ok=True)
        interpreter=model_interpreter(kind)
        if not interpreter.is_file():raise RuntimeError(f'Missing model interpreter: {interpreter}')
        log_path=runtime_dir()/f'{kind}.log'
        with log_path.open('ab') as log:
            selected = os.environ.get('VAMP_YOLO_DEVICE', device) if kind == 'yolo' else device
            command = [str(interpreter),str(ROOT/'model_server.py'),'--kind',kind,'--device',selected]
            if not warm:
                command.append('--lazy')
            subprocess.Popen(command,
                cwd=ROOT,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,
                close_fds=True, **(
                    {'creationflags': subprocess.CREATE_NO_WINDOW} if WINDOWS else {'start_new_session': True}
                ))
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            state=status(kind)
            if state.get('pid'):return state
            time.sleep(.05)
        raise TimeoutError(f'Model process did not start; see {log_path}')


def ensure_services(wait=False,device='auto',pump=None,kinds=KINDS):
    def start_one(kind):
        try:
            return start(kind,device)
        except (OSError, ValueError, RuntimeError) as error:
            return {'kind': kind, 'running': False, 'ready': False, 'warm_error': str(error)}
    states = {kind: start_one(kind) for kind in kinds}
    if not wait:return states
    deadline=time.monotonic()+600
    while time.monotonic()<deadline:
        states={kind:state if state.get('warm_error') else status(kind) for kind,state in states.items()}
        for kind,state in list(states.items()):
            if not state.get('running') and not state.get('warm_error'):states[kind]=start_one(kind)
        errors=[state.get('warm_error') for state in states.values() if state.get('warm_error')]
        if errors:raise RuntimeError('Model warmup failed: '+'; '.join(errors))
        if all(state.get('ready') for state in states.values()):return states
        if pump:pump(.1)
        else:time.sleep(.1)
    raise TimeoutError('Model warmup timed out')


def request(kind,payload,pump=None,timeout=600):
    start(kind,payload.get('device','auto'),warm=False)
    # Only socket I/O runs on the helper thread; GLib/SPICE stays on its original thread.
    executor=concurrent.futures.ThreadPoolExecutor(max_workers=1)
    future=executor.submit(raw_request,kind,payload,timeout)
    try:
        while not future.done():
            if pump:pump(.05)
            else:time.sleep(.01)
        return future.result()
    finally:
        executor.shutdown(wait=False,cancel_futures=True)


def stop(kind):
    state=status(kind)
    if not state.get('running'):return {'kind':kind,'running':False}
    raw_request(kind,{'op':'shutdown'},timeout=5)
    deadline=time.monotonic()+60
    while time.monotonic()<deadline:
        if not status(kind).get('running'):return {'kind':kind,'running':False}
        time.sleep(.05)
    return {'kind':kind,'running':True,'message':'Shutdown in progress'}
