"""Offline MCP contract tests; fake VBoxManage, no installed VM required."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('virtualbox_client', ROOT/'backends/virtualbox/client.py')
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)

@unittest.skipUnless(shutil.which('node') and (ROOT/'third_party/mcp-virtualbox/dist/index.js').exists(),
                     'Build the optional VirtualBox Node adapter to run protocol tests')
class VirtualBoxProtocol(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        fake = self.folder/'VBoxManage'
        fake.write_text('''#!/usr/bin/env python3
import sys,os,json,base64
from pathlib import Path
args=sys.argv[1:]
with open(os.environ['VBOX_TEST_LOG'],'a') as f: f.write(json.dumps(args)+'\\n')
if args[0]=='showvminfo': print('VMState="'+os.environ.get('VBOX_TEST_STATE','poweroff')+'"')
elif args[:2]==['list','vms']: print('"test-vm" {12345678-1234-1234-1234-123456789012}')
elif args[0]=='controlvm' and args[2]=='screenshotpng':
 Path(args[3]).write_bytes(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='))
elif args[0] in ('startvm','setextradata','sharedfolder'): pass
else: sys.exit(2)
''')
        fake.chmod(0o700)
        self.log = self.folder/'calls.jsonl'
        self.env = patch.dict(os.environ,{'VBOXMANAGE_PATH':str(fake),'VBOX_TEST_LOG':str(self.log),
                                          'VBOX_TEST_STATE':'poweroff','VAMP_DATA_DIR':str(self.folder/'vamp-data')})
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_start_defaults_to_separate_through_mcp(self):
        response = client.VirtualBox().start_vm('test-vm')
        details = json.loads(response['texts'][0])
        self.assertEqual(details['type'],'separate')
        self.assertFalse(details['guest_ready_verified'])
        self.assertIn(['startvm','test-vm','--type','separate'],
                      [json.loads(line) for line in self.log.read_text().splitlines()])

    def test_running_vm_is_not_restarted(self):
        os.environ['VBOX_TEST_STATE']='running'
        response = client.VirtualBox().start_vm('test-vm')
        self.assertEqual(json.loads(response['texts'][0])['status'],'already_running')
        self.assertNotIn('startvm',self.log.read_text())

    def test_upstream_screenshot_saved_without_base64_in_result(self):
        path = self.folder/'shot.png'
        response = client.VirtualBox().observe_vm('test-vm',str(path))
        self.assertEqual(path.read_bytes()[:8],b'\x89PNG\r\n\x1a\n')
        self.assertEqual(response['screenshot'],str(path))
        self.assertNotIn('iVBOR',json.dumps(response))
