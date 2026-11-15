import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('vamp_provision',ROOT/'backends/virtualbox/provision.py')
provision=importlib.util.module_from_spec(spec);spec.loader.exec_module(provision)

class ProvisioningTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.iso=self.root/'installer.iso';self.iso.write_bytes(b'test')
        self.calls=[];self.os_type='Debian_64';self.listed='';self.supported=True
    def command(self,args,**kwargs):
        self.calls.append(list(map(str,args[1:])))
        output=''
        if args[1:3]==['list','vms']:output=self.listed
        if args[1:3]==['unattended','detect']:
            output=f'detectedOSTypeId="{self.os_type}"\nisInstallSupported="{str(self.supported).lower()}"\n'
        if args[1]=='showvminfo':output=f'ostype="{self.os_type}"\nstoragecontrollername0="SATA"\nVMState="poweroff"\n'
        if '--help' in args:output='--user-password'
        return subprocess.CompletedProcess(args,0,output,'')
    def create(self):
        with patch.object(provision.subprocess,'run',self.command):
            return provision.create(iso_path=str(self.iso),name='test-vm',basedir=str(self.root/'vms'))
    def test_unattended_request_and_real_recorder_media(self):
        result=self.create()
        self.assertEqual(result['status'],'installation_started')
        self.assertFalse(result['installation_verified'])
        install=next(args for args in self.calls if args[:2]==['unattended','install'] and '--help' not in args)
        self.assertEqual(install[install.index('--start-vm')+1],'separate')
        self.assertEqual(install[install.index('--user')+1],'vboxuser')
        self.assertEqual(install[install.index('--user-password')+1],'password123!')
        import pycdlib
        iso=pycdlib.PyCdlib();iso.open(str(self.root/'vms/test-vm/recorder-setup.iso'))
        try:
            buf=io.BytesIO();iso.get_file_from_iso_fp(buf,joliet_path='/postdeb.sh')
            self.assertIn(b'runuser -u vboxuser',buf.getvalue())
        finally:iso.close()
    def test_existing_vm_is_not_modified(self):
        self.listed='"test-vm" {1234}\n'
        with self.assertRaisesRegex(ValueError,'already exists'):self.create()
        self.assertEqual(self.calls,[['list','vms']])
    def test_unsupported_iso_is_rejected_before_vm_creation(self):
        self.supported=False
        with self.assertRaisesRegex(ValueError,'does not support'):self.create()
        self.assertFalse(any(args[0]=='createvm' for args in self.calls))
    def test_windows_hardware_and_first_login_hook(self):
        self.os_type='Windows11_64';self.create()
        modify=next(args for args in self.calls if args[0]=='modifyvm')
        self.assertIn('--tpm-type',modify)
        install=next(args for args in self.calls if args[:2]==['unattended','install'] and '--help' not in args)
        self.assertIn('postwin.cmd',install[install.index('--post-install-command')+1])
