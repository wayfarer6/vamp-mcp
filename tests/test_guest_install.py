import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'backends/common'))
from guest_install import require_install_host, efi_boot_plan, virtualbox_preseed

class InstallPolicyTests(unittest.TestCase):
    def test_host_os_is_separate_from_guest_architecture(self):
        for host in ('win32','linux','darwin'):
            require_install_host('virtualbox',host,'x86_64')
        for backend,host in (('hyperv','linux'),('hyperv','darwin'),('kvm','win32'),('kvm','darwin')):
            with self.assertRaisesRegex(ValueError,'unsupported'):
                require_install_host(backend,host,'x86_64')
        with self.assertRaisesRegex(ValueError,'x64 host'):
            require_install_host('virtualbox','darwin','arm64')

    def test_shared_preseed_keeps_gnome_and_native_hook(self):
        cfg=virtualbox_preseed()
        self.assertIn('task-gnome-desktop',cfg)
        self.assertIn('@@VBOX_INSERT_USER_PASSWORD_SHACRYPT512@@',cfg)
        self.assertIn('/cdrom/vboxpostinstall.sh',cfg)
        self.assertNotIn('password123!',cfg)

    def test_backend_boot_plan_uses_the_given_host_address(self):
        plan=efi_boot_plan('debian','http://172.20.0.1:8421/')
        self.assertTrue(any('preseed/url=http://172.20.0.1:8421/debian-preseed.cfg' in step.get('text','') for step in plan))
        self.assertEqual(plan[-1],{'kind':'line','text':'boot'})
