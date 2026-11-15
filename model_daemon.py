"""Owner-local persistent inference clients. No systemd, network listener or VM connection."""
import concurrent.futures
import fcntl
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time

ROOT=Path(__file__).resolve().parent
KINDS=('yolo','ocr')
PROTOCOL=1


def runtime_dir():
    digest=hashlib.sha256(str(ROOT).encode()).hexdigest()[:10]
    directory=Path(tempfile.gettempdir())/f'spice-rpa-models-{os.getuid()}-{digest}'
    directory.mkdir(mode=0o700,exist_ok=True)
    if directory.stat().st_uid!=os.getuid():raise PermissionError('Model runtime directory owner mismatch')
    directory.chmod(0o700)
    return directory


def socket_path(kind):
    if kind not in KINDS:raise ValueError('Unknown model service')
    return runtime_dir()/f'{kind}.sock'


def raw_request(kind,payload,timeout=600):
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as client:
        client.settimeout(timeout);client.connect(str(socket_path(kind)))
        stream=client.makefile('rwb')
        stream.write(json.dumps({'protocol':PROTOCOL,**payload}).encode()+b'\n');stream.flush()
        data=stream.readline(16*1024*1024)
        if not data:raise ConnectionError('Model process closed the connection')
        response=json.loads(data)
        if not response.get('ok'):raise RuntimeError(response.get('error','Model request failed'))
        return response['result']


def status(kind):
    try:return raw_request(kind,{'op':'status'},timeout=1)
    except (OSError,ValueError,RuntimeError):
        with (runtime_dir()/f'{kind}.lifetime.lock').open('a') as lease:
            try:fcntl.flock(lease,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:
                return {'kind':kind,'running':True,'ready':False,'state':'busy_or_loading'}
        return {'kind':kind,'running':False}


def start(kind,device='auto'):
    with (runtime_dir()/f'{kind}.start.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        state=status(kind)
        if state.get('running'):return state
        path=socket_path(kind);path.unlink(missing_ok=True)
        interpreter=ROOT/('.venv-ocr/bin/python' if kind=='ocr' else '.venv/bin/python')
        if not interpreter.is_file():raise RuntimeError(f'Missing model interpreter: {interpreter}')
        log_path=runtime_dir()/f'{kind}.log'
        with log_path.open('ab') as log:
            subprocess.Popen([str(interpreter),str(ROOT/'model_server.py'),'--kind',kind,'--device',device],
                cwd=ROOT,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,
                start_new_session=True,close_fds=True)
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            state=status(kind)
            if state.get('running'):return state
            time.sleep(.05)
        raise TimeoutError(f'Model process did not start; see {log_path}')


def ensure_services(wait=False,device='auto',pump=None):
    states={kind:start(kind,device) for kind in KINDS}
    if not wait:return states
    deadline=time.monotonic()+600
    while time.monotonic()<deadline:
        states={kind:status(kind) for kind in KINDS}
        for kind,state in list(states.items()):
            if not state.get('running'):states[kind]=start(kind,device)
        errors=[state.get('warm_error') for state in states.values() if state.get('warm_error')]
        if errors:raise RuntimeError('Model warmup failed: '+'; '.join(errors))
        if all(state.get('ready') for state in states.values()):return states
        if pump:pump(.1)
        else:time.sleep(.1)
    raise TimeoutError('Model warmup timed out')


def request(kind,payload,pump=None,timeout=600):
    start(kind,payload.get('device','auto'))
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
