"""Isolated renderer tests only; no existing VAMP runtime or VM tools imported."""
import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'backends/packer/podman/profile.py'
spec = importlib.util.spec_from_file_location('podman_profile', SOURCE)
profile = importlib.util.module_from_spec(spec)
spec.loader.exec_module(profile)


def key(byte):
    kind = b'ssh-ed25519'
    raw = len(kind).to_bytes(4, 'big') + kind + (32).to_bytes(4, 'big') + bytes([byte]) * 32
    return 'ssh-ed25519 ' + base64.b64encode(raw).decode()


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.out = Path(self.temp.name) / 'new'
        self.args = dict(provider='virtualbox', iso_url='https://cdimage.debian.org/fixture.iso',
                         iso_checksum='sha256:' + 'a' * 64, build_public_key=key(1),
                         deployment_public_key=key(2), ssh_private_key_file='/external/not-read-key')

    def test_both_provider_sources_are_separate_not_desktop(self):
        for provider, vagrant in [('virtualbox', 'virtualbox'), ('kvm', 'libvirt')]:
            output = self.out / provider
            result = profile.render_profile(output, **{**self.args, 'provider': provider})
            self.assertEqual(result['status'], 'source_only_unverified')
            self.assertFalse(result['box_created'])
            self.assertEqual(result['provider'], vagrant)
            self.assertFalse(Path(result['box_path']).exists())
            hcl = (output / 'podman.pkr.hcl').read_text()
            self.assertIn(f'debian-podman-{vagrant}.box', hcl)
            self.assertIn('post-processor "vagrant"', hcl)
            self.assertIn('headless = true', hcl)
            self.assertNotIn('ssh_password', hcl)
            self.assertNotIn('password123', hcl)
            self.assertNotIn('guest.pkr.hcl', hcl)
            self.assertIn('standard, ssh-server', (output / 'http/preseed.cfg').read_text())
            self.assertNotIn('gnome', (output / 'http/preseed.cfg').read_text())

    def test_invalid_inputs_rejected_before_output(self):
        for changes in [{'provider': 'hyperv'}, {'iso_checksum': 'none'},
                        {'iso_url': 'http://bad/iso'}, {'deployment_public_key': key(1)},
                        {'build_public_key': '-----BEGIN PRIVATE KEY-----'},
                        {'build_public_key': 'command="sh" ' + key(1)}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                profile.render_profile(self.out, **{**self.args, **changes})
            self.assertFalse(self.out.exists())

    def test_no_overwrite_or_private_key_read_and_interpolation_escaped(self):
        profile.render_profile(self.out, **{**self.args, 'ssh_private_key_file': '/missing/${file("secret")}'})
        self.assertIn('$${file', (self.out / 'podman.pkr.hcl').read_text())
        with self.assertRaises(FileExistsError):
            profile.render_profile(self.out, **self.args)

    def test_guest_finalization_removes_temporary_authorization(self):
        script = (SOURCE.parent / 'provision.sh').read_text()
        self.assertIn('/etc/sudoers.d/vamp-build', script)
        self.assertIn('install -o vamp -g vamp -m 600 /tmp/vamp-deployment.pub', script)
        self.assertIn('loginctl enable-linger vamp', script)
        self.assertIn('systemctl --user enable --now podman.socket', script)
        self.assertIn('PasswordAuthentication no', script)
        self.assertIn('PermitRootLogin no', script)
        self.assertIn('ssh-keygen -A', script)
        self.assertNotIn('tcp://', script)
        self.assertNotIn('password123', script)


if __name__ == '__main__':
    unittest.main()
