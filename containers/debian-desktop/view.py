#!/usr/bin/python3
"""Single RFB session: view-only by default, paired human control opt-in."""
import importlib.util
import os
from pathlib import Path
import selectors
import signal
import socket
import subprocess
import sys
import time

_spec = importlib.util.spec_from_file_location('vamp_helper_common', Path(__file__).resolve().with_name('helper_common.py'))
common = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(common)

# -inetd receives a real connected AF_UNIX socket, not raw pipes, for compatibility
# with x11vnc builds that require socket operations on stdin. No bind/listen call.
COMMAND = ['/usr/bin/x11vnc', '-norc', '-inetd', '-q', '-once', '-viewonly',
           '-display', ':99', '-auth', '/tmp/vamp-desktop-runtime/Xauthority',
           '-timeout', '30', '-rfbwait', '30000', '-rfbversion', '3.8',
           '-safer', '-nocmds', '-nosel', '-noprimary', '-nosetprimary',
           '-noclipboard', '-nosetclipboard']
MAX_PENDING = 1024 * 1024
SESSION_SECONDS = 3600


def parse_mode(argv):
    """Only the managed host viewer or RPA can request fixed input modes."""
    if argv == []:
        return False
    if argv == ['--interactive']:
        return True
    if argv == ['--rpa']:
        return 'rpa'
    raise RuntimeError('Viewer accepts only one fixed input mode')


def command_for(interactive=False):
    if type(interactive) is not bool and interactive != 'rpa':
        raise RuntimeError('Interactive mode must be explicit')
    # No caller command, environment, display, port or x11vnc arguments pass
    # through. Host RPA sends physical modifier state for the fixed US layout.
    if interactive == 'rpa':
        return ['-nomodtweak' if arg == '-viewonly' else arg for arg in COMMAND]
    return [arg for arg in COMMAND if not (interactive and arg == '-viewonly')]


def relay(peer, child, input_fd=0, output_fd=1, session_seconds=SESSION_SECONDS):
    """Bounded backpressure; EOF/revocation closes the one child session."""
    peer.setblocking(False)
    old_input, old_output = os.get_blocking(input_fd), os.get_blocking(output_fd)
    os.set_blocking(input_fd, False)
    os.set_blocking(output_fd, False)
    to_child, to_viewer = bytearray(), bytearray()
    deadline = time.monotonic() + session_seconds
    next_health = time.monotonic() + 5
    peer_open = True
    try:
        with selectors.DefaultSelector() as poller:
            def watch(fileobj, events, tag):
                try:
                    poller.get_key(fileobj)
                except KeyError:
                    if events:
                        poller.register(fileobj, events, tag)
                else:
                    if events:
                        poller.modify(fileobj, events, tag)
                    else:
                        poller.unregister(fileobj)
            while True:
                now = time.monotonic()
                if now >= deadline:
                    raise RuntimeError('Viewer session expired')
                if now >= next_health:
                    common.require_ready()
                    next_health = now + 5
                if not peer_open and not to_viewer:
                    return
                watch(input_fd, selectors.EVENT_READ if len(to_child) < MAX_PENDING and peer_open else 0, 'input')
                watch(output_fd, selectors.EVENT_WRITE if to_viewer else 0, 'output')
                peer_events = (selectors.EVENT_READ if peer_open and len(to_viewer) < MAX_PENDING else 0)
                if peer_open and to_child:
                    peer_events |= selectors.EVENT_WRITE
                watch(peer, peer_events, 'peer')
                for key, events in poller.select(min(1, max(0, deadline - now))):
                    try:
                        if key.data == 'input':
                            block = os.read(input_fd, min(65536, MAX_PENDING - len(to_child)))
                            if not block:
                                return  # Do not keep sending after the outer transport revoked access.
                            to_child.extend(block)
                        elif key.data == 'output':
                            count = os.write(output_fd, to_viewer)
                            del to_viewer[:count]
                        else:
                            if events & selectors.EVENT_READ:
                                block = peer.recv(min(65536, MAX_PENDING - len(to_viewer)))
                                if not block:
                                    peer_open = False
                                else:
                                    to_viewer.extend(block)
                            if peer_open and events & selectors.EVENT_WRITE and to_child:
                                count = peer.send(to_child)
                                del to_child[:count]
                    except BlockingIOError:
                        continue
    finally:
        os.set_blocking(input_fd, old_input)
        os.set_blocking(output_fd, old_output)


def serve(spawn=subprocess.Popen, relay_fn=relay, *, interactive=False):
    command = command_for(interactive)
    common.require_ready()
    parent, endpoint = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    child = None
    try:
        child = spawn(command, stdin=endpoint, stdout=endpoint, stderr=subprocess.DEVNULL,
                      env=common.helper_environment(), close_fds=True)
        endpoint.close()
        relay_fn(parent, child)
        return 0
    finally:
        endpoint.close()
        parent.close()
        if child is not None:
            if child.poll() is None:
                child.terminate()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=2)


def main():
    try:
        interactive = parse_mode(sys.argv[1:])
        def interrupted(signum, frame):
            raise RuntimeError('Viewer session closed')
        signal.signal(signal.SIGTERM, interrupted)
        signal.signal(signal.SIGINT, interrupted)
        return serve(interactive=interactive)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        # Never forward x11vnc stderr, environment or Xauthority content.
        print('VAMP desktop viewer unavailable', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
