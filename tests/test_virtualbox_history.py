import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from backends.virtualbox import history

class HistoryTests(unittest.TestCase):
    def test_sqlite_records_task_and_bounds_artifact_lookup(self):
        with tempfile.TemporaryDirectory() as folder,patch.dict('os.environ',{'VAMP_DATA_DIR':folder}):
            def fake(*args):
                if args[0]=='showvminfo':return 'VMState="running"\nrecording_started="off"\n'
                if 'screenshotpng' in args:Path(args[-1]).write_bytes(b'png test fixture')
                return ''
            created=history.begin('test',False,fake)
            history.event(created['run_id'],'robot_task',{'status':'PASS','name':'test'})
            result=history.end(created['run_id'],'PASS',fake)
            self.assertEqual(result['robot_status'],'PASS')
            self.assertEqual(result['artifact_count'],2)
            self.assertTrue(Path(folder,'history.sqlite3').exists())
            with self.assertRaises(ValueError):history.artifact(9999)
    def test_failed_video_configuration_does_not_leave_active_run(self):
        with tempfile.TemporaryDirectory() as folder,patch.dict('os.environ',{'VAMP_DATA_DIR':folder}):
            def fake(*args):
                if args[0]=='showvminfo':return 'VMState="running"\nrecording_started="off"\n'
                raise RuntimeError('recording unsupported')
            with self.assertRaises(RuntimeError):history.begin('test',True,fake)
            self.assertEqual(history.listing()['runs'][0]['status'],'failed')
