import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
def load(name):
    spec=importlib.util.spec_from_file_location(name,ROOT/'guest_setup/recorder'/name)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

class GuestDisplayTests(unittest.TestCase):
    def test_every_login_registration_is_not_removed_on_success(self):
        install=load('install-display-startup.py')
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            with patch.dict('os.environ',{'LOCALAPPDATA':str(root/'local'),'APPDATA':str(root/'roaming')}):
                registered=install.install(home=root,platform='win32',python='C:/Python/python.exe')
                self.assertEqual(registered['trigger'],'every_user_login')
                self.assertIn('apply-display.py',Path(registered['launcher']).read_text())
                self.assertTrue(Path(registered['script']).exists())
    def test_gnome_refuses_multi_monitor_and_checks_current_mode(self):
        gnome=load('gnome-display.py')
        mode=('mode',1920,1080,60,1,[1],{'is-current':True})
        state=(1,[(('Virtual-1','vendor','product','serial'),[mode],{})],[(0,0,1,0,True,[],{})],{})
        self.assertTrue(gnome.verify(state));self.assertEqual(gnome.select_mode(state)[2][0],'mode')
        state[2][0]=(0,0,1.5,0,True,[],{})
        self.assertFalse(gnome.verify(state))
        with self.assertRaises(RuntimeError):gnome.select_mode((1,state[1]*2,state[2],{}))
    def test_recording_handoff_never_executes_source(self):
        recorder=load('prepare-recording.py')
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'macro.py';path.write_text('raise RuntimeError("must not execute")\n')
            result=recorder.describe(path)
            self.assertFalse(result['source_executed']);self.assertEqual(result['status'],'ready_for_ai_review')
