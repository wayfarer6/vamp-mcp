import importlib.util
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('snapshot_provision',ROOT/'backends/virtualbox/provision.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
from snapshots import manage

class SnapshotTests(unittest.TestCase):
    def setUp(self):self.calls=[];self.state='running'
    def fake(self,*args):
        self.calls.append(args)
        if args[0]=='showvminfo':return 'VMState="'+self.state+'"\n'
        if args[2]=='list':return 'SnapshotName="VAMP-initial"\nSnapshotUUID="sample-id"\n'
        return ''
    def test_running_restore_never_stops_guest(self):
        with self.assertRaisesRegex(ValueError,'powered-off'):manage('vm','restore_initial',confirm_restore=True,run=self.fake)
        self.assertEqual(len(self.calls),1)
    def test_restore_requires_confirmation(self):
        self.state='poweroff'
        with self.assertRaisesRegex(ValueError,'confirm'):manage('vm','restore_initial',run=self.fake)
        self.assertEqual(len(self.calls),1)
    def test_initial_restore_uses_exact_existing_target(self):
        self.state='poweroff';result=manage('vm','restore_initial',confirm_restore=True,run=self.fake)
        self.assertEqual(result['target'],'VAMP-initial');self.assertFalse(result['vm_started'])
        self.assertIn(('snapshot','vm','restore','VAMP-initial'),self.calls)
