import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
# provision makes its sibling imports available for the script/packaged runtime.
spec=importlib.util.spec_from_file_location('display_provision',ROOT/'backends/virtualbox/provision.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
from display import configure,insert_additions

class DisplayTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.iso=Path(self.tmp.name)/'VBoxGuestAdditions.iso';self.iso.write_bytes(b'iso')
        self.calls=[];self.size=(1920,1080);self.occupied='emptydrive'
    def fake_run(self,*args):
        self.calls.append(args)
        if args[0]=='showvminfo':return f'VMState="running"\nostype="Windows11_64"\nstoragecontrollername0="SATA"\nSATA-2-0="{self.occupied}"\n'
        if args[:3]==('controlvm','guest','screenshotpng'):
            Path(args[3]).write_bytes(b'\x89PNG\r\n\x1a\n'+b'\0'*8+struct.pack('>II',*self.size))
        return ''
    def test_scaled_frontend_preserves_native_verified_pixels(self):
        result=configure('guest',self.fake_run)
        self.assertTrue(result['resolution_verified'])
        self.assertIn(('setextradata','guest','GUI/Scale','true'),self.calls)
        self.assertIn(('setextradata','guest','GUI/AutoresizeGuest','false'),self.calls)
    def test_successful_hint_does_not_prove_resolution(self):
        self.size=(1280,720)
        result=configure('guest',self.fake_run)
        self.assertEqual(result['video_hint'],'sent')
        self.assertFalse(result['resolution_verified'])
    def test_iso_insert_only_does_not_install_guest_software(self):
        result=insert_additions('guest',str(self.iso),self.fake_run)
        self.assertEqual(result['status'],'media_inserted')
        self.assertFalse(result['guest_additions_installed_verified'])
        self.assertTrue(any(args[0]=='storageattach' for args in self.calls))
        self.assertFalse(any(args[0] in ('guestcontrol','startvm') for args in self.calls))
    def test_iso_never_replaces_occupied_media(self):
        self.occupied='/existing/disk.vdi'
        with self.assertRaisesRegex(ValueError,'occupied'):insert_additions('guest',str(self.iso),self.fake_run)
        self.assertFalse(any(args[0]=='storageattach' for args in self.calls))
