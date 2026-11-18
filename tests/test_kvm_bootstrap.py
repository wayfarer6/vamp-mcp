"""Pure address/template tests and local mocked downloader; no VM or network."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backends/packer'))
import kvm_bootstrap as bootstrap
import templates


class KvmBootstrapTests(unittest.TestCase):
    def test_qemu_build_default_does_not_use_deployed_libvirt_gateway(self):
        self.assertEqual(bootstrap.resolve_kvm_bootstrap_host({}, {}), '10.0.2.2')
        self.assertEqual(bootstrap.resolve_kvm_bootstrap_host({'libvirt_uri': 'qemu:///system'}, {'VAMP_LIBVIRT_URI': 'qemu:///system'}), '10.0.2.2')

    def test_explicit_host_overrides_environment_and_empty_fails_closed(self):
        self.assertEqual(bootstrap.resolve_kvm_bootstrap_host({}, {'VAMP_PACKER_BOOTSTRAP_HOST': '192.168.50.1'}), '192.168.50.1')
        self.assertEqual(bootstrap.resolve_kvm_bootstrap_host({'bootstrap_host': '10.42.0.1'}, {'VAMP_PACKER_BOOTSTRAP_HOST': '192.168.50.1'}), '10.42.0.1')
        for value in ['', None, True, 'http://10.0.2.2:8421', 'host', '127.0.0.1', '0.0.0.0',
                      '8.8.8.8', '198.51.100.1', '100.64.0.1', '0.0.0.1', '169.254.1.1', '224.0.0.1', '::1', '10.0.2.2 ', '10.0.2.2; echo bad']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                bootstrap.resolve_kvm_bootstrap_host({'bootstrap_host': value}, {})
        with self.assertRaises(ValueError):
            bootstrap.resolve_kvm_bootstrap_host({}, {'VAMP_PACKER_BOOTSTRAP_HOST': ''})

    def test_endpoint_validation_rejects_injection_and_target_mismatch(self):
        base, callback = 'http://10.0.2.2:8421', 'http://10.0.2.2:9999/complete/token'
        self.assertEqual(bootstrap.kvm_script_endpoints(base, callback)['host'], '10.0.2.2')
        for badbase, badcallback in [
            ('http://user:secret@10.0.2.2:8421', callback),
            ('http://@10.0.2.2:8421', callback),
            ('http://10.0.2.2:80', callback),
            ('http://10.0.2.2:8421/other', callback),
            ('http://10.0.2.2:8421\n', callback),
            (base, 'http://192.168.1.1:9999/complete/token'),
            (base, 'http://10.0.2.2:9999/complete/token?x=1'),
            (base, 'http://10.0.2.2:9999/complete/$(touch-malicious)'),
        ]:
            with self.subTest(base=badbase, callback=badcallback), self.assertRaises(ValueError):
                bootstrap.kvm_late_command(badbase, badcallback)

    def test_kvm_preseed_uses_host_variable_virtualbox_is_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            iso = root / 'debian.iso'
            iso.write_bytes(b'fixture')
            for backend in ['kvm', 'virtualbox']:
                folder = root / backend
                folder.mkdir()
                request = {'backend': backend, 'guest_os': 'debian', 'iso_path': str(iso),
                           'cpus': 2, 'memory_mb': 4096, 'disk_mb': 65536}
                templates.render(request, folder, 'a' * 64, 'http://10.42.0.1:8421', 'http://10.42.0.1:9999/complete/token')
                text = (folder / 'http/preseed.cfg').read_text()
                if backend == 'kvm':
                    self.assertIn("VAMP_BOOTSTRAP_HOST='10.42.0.1'", text)
                    self.assertIn('VAMP_SCRIPT_BASE_URL="http://${VAMP_BOOTSTRAP_HOST}:8421"', text)
                    self.assertIn('test -s /tmp/vamp-postdeb.sh.download', text)
                    self.assertIn('force-efi-extra-removable', text)
                    self.assertEqual(text.count('d-i preseed/late_command '), 1)
                    hcl = (folder / 'guest.pkr.hcl').read_text()
                    self.assertIn('http_bind_address = "10.42.0.1"', hcl)
                    self.assertIn('preseed/url=http://10.42.0.1:{{ .HTTPPort }}', hcl)
                else:
                    self.assertNotIn('VAMP_BOOTSTRAP_HOST', text)
                    self.assertIn('wget -qO /tmp/vamp-postdeb.sh http://10.42.0.1:8421/postdeb.sh && VAMP_SCRIPT_BASE_URL=http://10.42.0.1:8421', text)

    def test_local_inventory_is_readonly_and_fails_closed(self):
        calls = []
        def execute(args, **kwargs):
            calls.append((args, kwargs))
            return subprocess.CompletedProcess(args, 0, json.dumps([{'addr_info': [
                {'family': 'inet', 'local': '192.168.50.1'},
                {'family': 'inet6', 'local': '::1'}]}]), '')
        self.assertEqual(bootstrap.local_ipv4_addresses(execute), {'192.168.50.1'})
        self.assertEqual(calls[0][0], ['ip', '-j', '-4', 'address', 'show'])
        self.assertEqual(calls[0][1]['timeout'], 10)
        for output in ['bad json', '{}']:
            with self.assertRaisesRegex(RuntimeError, 'Cannot verify local'):
                bootstrap.local_ipv4_addresses(lambda *args, **kwargs: subprocess.CompletedProcess([], 0, output, ''))

    def test_default_maps_to_loopback_without_inventory_override_requires_ownership(self):
        with patch.object(bootstrap, 'local_ipv4_addresses', side_effect=AssertionError('no probe for alias')):
            self.assertEqual(bootstrap.kvm_bind_address('10.0.2.2'), '127.0.0.1')
        self.assertEqual(bootstrap.kvm_bind_address('192.168.50.1', {'192.168.50.1'}), '192.168.50.1')
        with self.assertRaisesRegex(ValueError, 'not assigned'):
            bootstrap.kvm_bind_address('192.168.50.1', {'192.168.50.2'})

    def test_listener_is_exact_job_owned_and_port_conflict_has_no_fallback(self):
        calls = []
        def factory(bind, port):
            calls.append((bind, port))
            return 'owned'
        self.assertEqual(bootstrap.bind_kvm_listener('10.0.2.2', 8421, factory), 'owned')
        self.assertEqual(calls, [('127.0.0.1', 8421)])
        with self.assertRaisesRegex(ValueError, 'not assigned'):
            bootstrap.bind_kvm_listener('192.168.50.1', 8421, factory, set())
        self.assertEqual(len(calls), 1)
        def occupied(bind, port):
            calls.append((bind, port))
            raise OSError('address occupied')
        with self.assertRaisesRegex(RuntimeError, 'No existing server or wildcard'):
            bootstrap.bind_kvm_listener('192.168.50.1', 8421, occupied, {'192.168.50.1'})
        self.assertEqual(calls[-1], ('192.168.50.1', 8421))
        self.assertNotIn(('0.0.0.0', 8421), calls)

    def test_default_preseed_and_postinstall_use_same_alias_with_loopback_bind(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            request = {'backend': 'kvm', 'guest_os': 'debian', 'iso_path': str(folder / 'debian.iso'),
                       'cpus': 2, 'memory_mb': 4096, 'disk_mb': 65536}
            hcl = templates.render(request, folder, 'a' * 64, 'http://10.0.2.2:8421', 'http://10.0.2.2:9999/complete/token').read_text()
            self.assertIn('http_bind_address = "127.0.0.1"', hcl)
            self.assertIn('preseed/url=http://10.0.2.2:{{ .HTTPPort }}', hcl)
            self.assertNotIn('http_bind_address = "0.0.0.0"', hcl)
            self.assertEqual((folder / 'http/preseed.cfg').read_text().count('d-i preseed/late_command '), 1)

    def test_worker_refuses_nonlocal_before_preparation_and_owns_both_listeners(self):
        import runner
        import script_server
        import osinfo
        from unittest.mock import MagicMock
        for assigned in [set(), {'192.168.50.1'}]:
            with self.subTest(assigned=assigned), tempfile.TemporaryDirectory() as directory:
                folder = Path(directory)
                (folder / 'image.json').write_text('{}')
                (folder / 'request.json').write_text(json.dumps({'backend': 'kvm', 'name': 'fixture', 'bootstrap_host': '192.168.50.1'}))
                callback, scripts = MagicMock(), MagicMock()
                with patch.object(runner, 'directory', return_value=folder), patch.object(runner, 'home', return_value=folder), \
                     patch.object(runner, 'conflicts'), patch.object(runner.threading, 'Thread'), \
                     patch.object(bootstrap, 'local_ipv4_addresses', return_value=assigned), \
                     patch.object(runner, 'ThreadingHTTPServer', return_value=callback) as callback_factory, \
                     patch.object(script_server, 'stage', return_value={'directory': str(folder / 'bootstrap')}) as stage, \
                     patch.object(script_server, 'make_server', return_value=scripts) as script_factory, \
                     patch.object(script_server, 'start', side_effect=AssertionError('cannot reuse detached server')), \
                     patch.object(osinfo, 'resolve', side_effect=RuntimeError('fixture stopped before hypervisor')) as resolve:
                    runner.worker('a' * 32)
                record = json.loads((folder / 'image.json').read_text())
                self.assertEqual(record['status'], 'failed')
                if assigned:
                    self.assertEqual(callback_factory.call_args.args[0], ('192.168.50.1', 0))
                    self.assertEqual(script_factory.call_args.args[1:3], (8421, '192.168.50.1'))
                    callback.server_close.assert_called_once()
                    scripts.server_close.assert_called_once()
                    resolve.assert_called_once()
                else:
                    self.assertIn('not assigned', record['error'])
                    callback_factory.assert_not_called()
                    script_factory.assert_not_called()
                    stage.assert_not_called()
                    resolve.assert_not_called()

    @unittest.skipUnless(os.name == "posix", "POSIX installer shell fixture")
    def test_installer_shell_exports_host_and_failed_or_empty_fetch_never_executes(self):
        # Only generated local fixture scripts run. The fake wget never uses a network.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bindir = root / 'bin'
            bindir.mkdir()
            output = root / 'executed'
            downloaded = root / 'postdeb.sh'
            command = bootstrap.kvm_late_command('http://10.42.0.1:8421', 'http://10.42.0.1:9999/complete/token')
            command = command.replace('/tmp/vamp-postdeb.sh', str(downloaded))
            env = {**os.environ, 'PATH': str(bindir) + ':/usr/bin:/bin'}
            for behavior in ['exit 42', ': > "$2"; exit 0']:
                downloaded.write_text(f'echo stale > "{output}"\n')
                (bindir / 'wget').write_text('#!/bin/sh\n' + behavior + '\n')
                (bindir / 'wget').chmod(0o700)
                result = subprocess.run(['/bin/sh', '-c', command], env=env, capture_output=True, timeout=5)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(output.exists())
            script = ('#!/bin/sh\nprintf "%s|%s|%s" "$VAMP_BOOTSTRAP_HOST" '
                      f'"$VAMP_SCRIPT_BASE_URL" "$VAMP_PACKER_CALLBACK" > "{output}"\n')
            (bindir / 'wget').write_text('#!/bin/sh\ncat > "$2" <<\'FIXTURE\'\n' + script + 'FIXTURE\n')
            (bindir / 'wget').chmod(0o700)
            subprocess.run(['/bin/sh', '-c', command], env=env, capture_output=True, check=True, timeout=5)
            self.assertEqual(output.read_text(), '10.42.0.1|http://10.42.0.1:8421|http://10.42.0.1:9999/complete/token')


if __name__ == '__main__':
    unittest.main()
