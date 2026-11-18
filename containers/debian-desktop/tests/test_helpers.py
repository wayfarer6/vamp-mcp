"""No X11 or Podman: PNG fixtures and injected child over local socketpair only."""
import importlib.util
import io
import os
from pathlib import Path
import socket
import struct
import sys
import threading
import time
import unittest
from unittest.mock import patch
import zlib

ROOT = Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


capture = load('capture_fixture', 'capture.py')
view = load('view_fixture', 'view.py')


def chunk(kind, value):
    return struct.pack('!I', len(value)) + kind + value + struct.pack('!I', zlib.crc32(kind + value) & 0xffffffff)


def png(width=1920, height=1080, pixels=None):
    pixels = pixels if pixels is not None else b'\x00' * ((width * 3 + 1) * height)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b'')


class HelperTests(unittest.TestCase):
    def test_strict_single_png_and_full_decoded_dimensions(self):
        data = png()
        self.assertEqual(capture.validate_png(data), data)
        bad = [data + data, data + b'extra', data[:-1], png(800, 600), png(pixels=b'bad'),
               data[:20] + bytes([data[20] ^ 1]) + data[21:], b'x' * (capture.MAX_PNG_BYTES + 1)]
        for value in bad:
            with self.subTest(length=len(value)), self.assertRaises(RuntimeError):
                capture.validate_png(value)

    def test_capture_requires_ready_before_and_after_no_file_save(self):
        with patch.object(capture.common, 'require_ready') as ready, patch.object(capture, 'pipeline', return_value=png()):
            self.assertEqual(capture.capture(), png())
            self.assertEqual(ready.call_count, 2)
        with patch.object(capture.common, 'require_ready', side_effect=RuntimeError('unready')), \
             patch.object(capture, 'pipeline', side_effect=AssertionError('must not capture')):
            with self.assertRaises(RuntimeError):
                capture.capture()
        self.assertEqual(capture.COMMANDS[0], ['/usr/bin/xwd', '-root', '-silent', '-display', ':99'])
        self.assertEqual(capture.COMMANDS[-1], ['/usr/bin/pnmtopng', '-force'])
        self.assertEqual(capture.COMMANDS[-2], ['/usr/bin/pamdepth', '255'])

    def test_capture_stdout_is_png_only_errors_stderr_and_no_extra_args(self):
        class Output(io.StringIO):
            def __init__(self):
                super().__init__()
                self.buffer = io.BytesIO()
        output, err = Output(), io.StringIO()
        with patch.object(capture, 'capture', return_value=png()), patch.object(sys, 'argv', ['capture.py']), \
             patch.object(sys, 'stdout', output), patch.object(sys, 'stderr', err):
            self.assertEqual(capture.main(), 0)
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(output.buffer.getvalue(), png())
        self.assertEqual(err.getvalue(), '')
        with patch.object(sys, 'argv', ['capture.py', '--output=/tmp/file']), patch.object(sys, 'stderr', err), \
             patch.object(capture, 'capture', side_effect=AssertionError('must not execute')):
            self.assertEqual(capture.main(), 1)

    def test_view_is_server_side_readonly_and_does_not_read_user_rc_or_listen(self):
        for flag in ['-viewonly', '-inetd', '-q', '-once', '-norc', '-safer', '-nocmds', '-nosel', '-nosetclipboard']:
            self.assertIn(flag, view.COMMAND)
        for flag in ['-listen', '-rfbport', '-http', '-httpdir', '-passwd', '-rfbauth', '-permitfiletransfer', '-tightfilexfer', '-shared']:
            self.assertNotIn(flag, view.COMMAND)
        env = view.common.helper_environment()
        self.assertNotIn('X11VNC_REMOTE', env)
        self.assertNotIn('LD_PRELOAD', env)
        self.assertEqual(env['DISPLAY'], ':99')

    def test_view_mode_accepts_only_default_or_single_interactive_flag(self):
        self.assertFalse(view.parse_mode([]))
        self.assertTrue(view.parse_mode(['--interactive']))
        for argv in [['--interactive=true'], ['interactive'], ['--view-only'],
                     ['--interactive', '--interactive'], ['--interactive', '-listen', '0.0.0.0'],
                     ['--display=:0'], ['--help'], ['--interactive', '--']]:
            with self.subTest(argv=argv), self.assertRaises(RuntimeError):
                view.parse_mode(argv)
        self.assertEqual(view.command_for(), view.COMMAND)
        command = view.command_for(True)
        self.assertNotIn('-viewonly', command)
        self.assertEqual(command, [arg for arg in view.COMMAND if arg != '-viewonly'])
        for flag in ['-nosel', '-noclipboard', '-nosetclipboard', '-nosetprimary',
                     '-norc', '-safer', '-nocmds', '-inetd']:
            self.assertIn(flag, command)
        for flag in ['-permitfiletransfer', '-tightfilexfer', '-ultrafilexfer', '-listen', '-rfbport']:
            self.assertNotIn(flag, command)
        self.assertIn('-viewonly', view.COMMAND)  # No global command mutation.
        with self.assertRaises(RuntimeError):
            view.command_for('true')

    def test_main_dispatches_only_fixed_mode_without_forwarding_arguments(self):
        for argv, mode in [(['view.py'], False), (['view.py', '--interactive'], True)]:
            with patch.object(sys, 'argv', argv), patch.object(view.signal, 'signal'), \
                 patch.object(view, 'serve', return_value=0) as serve:
                self.assertEqual(view.main(), 0)
                serve.assert_called_once_with(interactive=mode)
        with patch.object(sys, 'argv', ['view.py', '--interactive', '--other']), \
             patch.object(view, 'serve', side_effect=AssertionError('must not spawn')), \
             patch.object(sys, 'stderr', io.StringIO()):
            self.assertEqual(view.main(), 1)

    def test_injected_child_gets_same_unix_socket_stdin_stdout_and_cleanup(self):
        child_socket = None
        class Child:
            terminated = False
            def poll(self): return None
            def terminate(self): self.terminated = True
            def wait(self, timeout): return 0
        child = Child()
        def spawn(command, **kwargs):
            nonlocal child_socket
            self.assertEqual(command, view.COMMAND)
            self.assertIs(kwargs['stdin'], kwargs['stdout'])
            self.assertEqual(kwargs['stdin'].family, socket.AF_UNIX)
            self.assertEqual(kwargs['stderr'], view.subprocess.DEVNULL)
            child_socket = kwargs['stdin'].dup()
            return child
        def relay(peer, selected):
            self.assertIs(selected, child)
            child_socket.sendall(b'RFB 003.008\n')
            self.assertEqual(peer.recv(12), b'RFB 003.008\n')
            peer.sendall(b'client bytes')
            self.assertEqual(child_socket.recv(12), b'client bytes')
        try:
            with patch.object(view.common, 'require_ready'):
                self.assertEqual(view.serve(spawn, relay), 0)
            self.assertTrue(child.terminated)
        finally:
            if child_socket:
                child_socket.close()

    def test_interactive_spawn_changes_only_viewonly_after_readiness(self):
        calls = []
        class Child:
            def poll(self): return 0
            def wait(self, timeout): return 0
        def spawn(command, **kwargs):
            calls.append(command)
            self.assertIs(kwargs['stdin'], kwargs['stdout'])
            return Child()
        with patch.object(view.common, 'require_ready') as ready:
            self.assertEqual(view.serve(spawn, lambda peer, child: None, interactive=True), 0)
            ready.assert_called_once()
        self.assertEqual(calls, [[arg for arg in view.COMMAND if arg != '-viewonly']])

    def test_actual_bounded_relay_fixture_pipes_socketpair_and_eof(self):
        peer, fake_child = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        input_read, input_write = os.pipe()
        output_read, output_write = os.pipe()
        failures = []
        class Child:
            def poll(self): return None
        def run():
            try:
                view.relay(peer, Child(), input_read, output_write, session_seconds=3)
            except Exception as error:
                failures.append(error)
        thread = threading.Thread(target=run)
        try:
            thread.start()
            fake_child.sendall(b'RFB 003.008\n')
            os.set_blocking(output_read, False)
            received = b''
            deadline = time.monotonic() + 2
            while len(received) < 12 and time.monotonic() < deadline:
                try: received += os.read(output_read, 12)
                except BlockingIOError: time.sleep(0.005)
            self.assertEqual(received, b'RFB 003.008\n')
            os.write(input_write, b'client-frame')
            fake_child.settimeout(2)
            self.assertEqual(fake_child.recv(12), b'client-frame')
            os.close(input_write)
            input_write = None
            thread.join(2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(failures, [])
        finally:
            if input_write is not None:
                os.close(input_write)
            thread.join(4)
            for fd in (input_read, output_read, output_write): os.close(fd)
            peer.close()
            fake_child.close()

    def test_helpers_fail_before_process_for_root_or_bad_readiness(self):
        with patch.object(capture.common.os, 'getuid', return_value=0):
            with self.assertRaisesRegex(RuntimeError, 'non-root'):
                capture.common.require_ready()
        with patch.object(view.common, 'require_ready', side_effect=RuntimeError('unready')):
            with self.assertRaises(RuntimeError):
                view.serve(lambda *args, **kwargs: self.fail('must not spawn'))

    def test_image_installs_fixed_helpers_and_runs_isolated_python(self):
        text = (ROOT / 'Containerfile').read_text()
        self.assertIn('helper_common.py capture.py view.py /opt/vamp-desktop/', text)
        self.assertIn('x11-apps netpbm', text)
        self.assertIn('"-I", "-B", "/opt/vamp-desktop/desktop.py"', text)
        for name in ('capture.py', 'view.py'):
            source = (ROOT / name).read_text()
            self.assertNotIn('shell=True', source)
            self.assertNotIn('socket.create_server', source)
            self.assertNotIn('.bind(', source)
            self.assertNotIn('.listen(', source)


if __name__ == '__main__':
    unittest.main()
