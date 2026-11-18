"""Static and isolated process fixtures only: no actual X/GUI/container launches."""
import importlib.util
import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


health = load('healthcheck', 'healthcheck.py')
with patch.dict(sys.modules, {'healthcheck': health}):
    desktop = load('desktop_fixture', 'desktop.py')
launcher = load('chromium_fixture', 'chromium-launcher.py')
GOOD = '''number of screens:    1
screen #0:
  dimensions:    1920x1080 pixels (508x285 millimeters)
  depth of root window:    24 planes
'''


class DesktopTests(unittest.TestCase):
    def test_actual_dimensions_depth_and_single_screen_required(self):
        self.assertEqual(health.verify_display(GOOD)['width'], 1920)
        for output in [GOOD.replace('1920x1080', '1280x720'), GOOD.replace('24 planes', '16 planes'),
                       GOOD.replace('screens:    1', 'screens:    2'), '', GOOD + GOOD]:
            with self.subTest(output=output), self.assertRaises(RuntimeError):
                health.verify_display(output)

    def test_measure_uses_fixed_display_not_host_environment(self):
        calls = []
        def run(args, **kwargs):
            calls.append((args, kwargs))
            return types.SimpleNamespace(stdout=GOOD)
        with patch.dict(health.os.environ, {'DISPLAY': 'host:0', 'XAUTHORITY': '/host/key'}):
            self.assertEqual(health.measure(run)['height'], 1080)
        args, kwargs = calls[0]
        self.assertEqual(args, ['xdpyinfo', '-display', ':99'])
        self.assertEqual(kwargs['env']['DISPLAY'], ':99')
        self.assertEqual(kwargs['env']['XAUTHORITY'], '/tmp/vamp-desktop-runtime/Xauthority')

    def test_image_contract_nonroot_apps_and_no_network_viewer(self):
        text = (ROOT / 'Containerfile').read_text()
        self.assertTrue(text.startswith('ARG DEBIAN_BASE=docker.io/library/debian:trixie-slim\nFROM ${DEBIAN_BASE}\n'))
        self.assertIn('USER 1000:1000', text)
        for package in ['xfce4-session', 'chromium', 'libreoffice-writer', 'libreoffice-calc',
                        'libreoffice-impress', 'fonts-noto-cjk', 'novnc', 'websockify']:
            self.assertIn(package, text)
        self.assertNotIn('\nEXPOSE ', text)
        self.assertNotIn('gnome-', text)
        self.assertNotIn('chromium-sandbox', text)
        self.assertEqual(desktop.SESSION[-1], '--disable-tcp')
        self.assertIn('-nolisten', desktop.XVFB)
        self.assertEqual(desktop.XVFB[desktop.XVFB.index('-nolisten') + 1], 'tcp')
        self.assertIn('1920x1080x24', desktop.XVFB)
        self.assertIn(('-extension', 'RANDR'), tuple(zip(desktop.XVFB, desktop.XVFB[1:])))
        self.assertIn('-auth', desktop.XVFB)

    def test_chromium_rejects_sandbox_disabling_arguments(self):
        for flag in ['--no-sandbox', '--disable-setuid-sandbox', '--disable-namespace-sandbox',
                     '--disable-seccomp-filter-sandbox', '--no-zygote', '--single-process',
                     '--disable-gpu-sandbox=true']:
            with self.assertRaises(ValueError):
                launcher.checked_arguments([flag])
        self.assertEqual(launcher.checked_arguments(['about:blank']), ['about:blank'])

    def test_supervisor_fixture_verified_start_and_signal_shutdown(self):
        self.run_supervisor(drift=False)

    def test_supervisor_fixture_rejects_resolution_drift_and_cleans_up(self):
        self.run_supervisor(drift=True)

    def run_supervisor(self, drift):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = Path(tmp)
            handlers = {}
            spawned = []
            killed = []
            class Child:
                def __init__(self, args, **kwargs):
                    self.pid = 100 + len(spawned)
                    spawned.append((args, kwargs))
                def poll(self): return None
                def wait(self, timeout): return 0
            def sleep(seconds):
                ready = json.loads((runtime / 'ready.json').read_text())
                self.assertEqual(ready['width'], 1920)
                self.assertFalse(ready['viewer_listening'])
                handlers[signal.SIGTERM](signal.SIGTERM, None)
            observations = [health.verify_display(GOOD)]
            observations.append(RuntimeError('resolution drift') if drift else health.verify_display(GOOD))
            with patch.object(desktop, 'RUNTIME', runtime), \
                 patch.object(desktop, 'prepare_runtime'), \
                 patch.object(desktop, 'measure', side_effect=observations), \
                 patch.object(desktop.subprocess, 'Popen', Child), \
                 patch.object(desktop.subprocess, 'run', return_value=types.SimpleNamespace()), \
                 patch.object(desktop.signal, 'signal', side_effect=lambda key, fn: handlers.update({key: fn})), \
                 patch.object(desktop.os, 'killpg', side_effect=lambda pid, sig: killed.append((pid, sig))), \
                 patch.object(desktop.time, 'sleep', side_effect=sleep):
                self.assertEqual(desktop.main(), 1 if drift else 0)
            self.assertEqual([args[0] for args, _ in spawned], ['Xvfb', 'dbus-run-session'])
            self.assertEqual(len(killed), 2)
            self.assertFalse((runtime / 'ready.json').exists())

    def test_root_rejected_before_runtime_changes(self):
        with patch.object(desktop.os, 'getuid', return_value=0), \
             patch.object(desktop.subprocess, 'run', side_effect=AssertionError('must not execute')):
            with self.assertRaisesRegex(RuntimeError, 'non-root'):
                desktop.prepare_runtime()

    def test_x_cookie_generated_per_launch_not_baked_or_on_command_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = Path(tmp) / 'private'
            calls = []
            with patch.object(desktop, 'RUNTIME', runtime), \
                 patch.dict(desktop.os.environ, {'DISPLAY': ':99'}), \
                 patch.object(desktop.os.path, 'ismount', return_value=False), \
                 patch.object(desktop.secrets, 'token_hex', return_value='a' * 32), \
                 patch.object(desktop.subprocess, 'run', side_effect=lambda args, **kwargs: calls.append((args, kwargs))):
                desktop.prepare_runtime()
            self.assertEqual(runtime.stat().st_mode & 0o777, 0o700)
            self.assertEqual((runtime / 'Xauthority').stat().st_mode & 0o777, 0o600)
            self.assertNotIn('a' * 32, json.dumps(calls[0][0]))
            self.assertIn('a' * 32, calls[0][1]['input'])


if __name__ == '__main__':
    unittest.main()
