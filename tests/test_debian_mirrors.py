import importlib.util
from pathlib import Path
import tempfile
import unittest
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('debian_mirrors',ROOT/'guest_setup/recorder/configure-debian-mirrors.py')
mirrors=importlib.util.module_from_spec(spec);spec.loader.exec_module(mirrors)

class MirrorTests(unittest.TestCase):
    def test_disable_cdrom_preserve_third_party_and_use_installed_release(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'etc/apt/sources.list.d').mkdir(parents=True)
            (root/'etc/os-release').write_text('ID=debian\nVERSION_CODENAME=trixie\n')
            source=root/'etc/apt/sources.list';source.write_text('deb cdrom:[Debian disc] trixie main\ndeb https://example.test/repo stable main\n')
            result=mirrors.configure(root)
            self.assertNotIn('cdrom:',source.read_text());self.assertIn('example.test',source.read_text())
            configured=(root/'etc/apt/sources.list.d/vamp-debian.sources').read_text()
            self.assertIn('trixie-security',configured);self.assertIn('debian-archive-keyring.gpg',configured)
            self.assertEqual(mirrors.configure(root)['changed'],[])
    def test_no_debian_repository_injected_into_ubuntu(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'etc').mkdir();(root/'etc/os-release').write_text('ID=ubuntu\nVERSION_CODENAME=noble\n')
            self.assertFalse(mirrors.configure(root)['changed'])
