import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

ROOT=Path(__file__).resolve().parents[1]
def load(name):
    spec=importlib.util.spec_from_file_location(name,ROOT/'guest_setup/recorder'/name)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

class GuestDisplayTests(unittest.TestCase):
    def test_linux_login_hook_survives_reinstallation(self):
        installer=load('install-display-startup.py')
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for _ in range(2):
                registered=installer.install(home=root,platform='linux',python='/usr/bin/python3')
                launcher=Path(registered['launcher']).read_text()
                self.assertIn('apply-display.py',launcher)
                self.assertIn('X-GNOME-Autostart-enabled=true',launcher)
                self.assertNotIn('RunOnce',launcher)
                self.assertTrue((root/'.config/autostart/vamp-session.desktop').is_file())
                self.assertFalse(registered['resolution_verified'])
    def test_every_login_registration_is_not_removed_on_success(self):
        install=load('install-display-startup.py')
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            with patch.dict('os.environ',{'LOCALAPPDATA':str(root/'local'),'APPDATA':str(root/'roaming')}):
                registered=install.install(home=root,platform='win32',python='C:/Python/python.exe')
                self.assertEqual(registered['trigger'],'every_user_login')
                self.assertIn('apply-display.py',Path(registered['launcher']).read_text())
                self.assertTrue(Path(registered['script']).exists())
                manual=Path(registered['manual_script']).read_text(encoding='utf-8-sig')
                self.assertIn('set-resolution-registry.ps1',manual)
                self.assertLess(manual.index('set-resolution-registry.ps1'),manual.index('apply-display.py'))
                self.assertIn('-Verb RunAs',manual)
    def test_gnome_refuses_multi_monitor_and_checks_current_mode(self):
        gnome=load('gnome-display.py')
        mode=('mode',1920,1080,60,1,[1],{'is-current':True})
        spec=('Virtual1','vendor','product','serial')
        spares=[(f'Virtual{number}','vendor','product','serial') for number in range(2,9)]
        spare=spares[0]
        monitors=[(output,[],{}) for output in spares]+[(spec,[mode],{})]
        state=(1,monitors,[(0,0,1,0,True,[spec],{})],{})
        self.assertTrue(gnome.verify(state));self.assertEqual(gnome.select_mode(state)[2][0],'mode')
        self.assertEqual(gnome.select_mode(state)[1],spec)
        config=ET.fromstring(gnome.monitor_configuration(state)).find('configuration')
        self.assertEqual(config.findtext('logicalmonitor/monitor/monitorspec/connector'),'Virtual1')
        self.assertEqual(config.findtext('logicalmonitor/monitor/mode/width'),'1920')
        self.assertEqual([node.text for node in config.findall('disabled/monitorspec/connector')],
                         [output[0] for output in spares])
        state[2][0]=(0,0,1.5,0,True,[spec],{})
        self.assertFalse(gnome.verify(state))
        with self.assertRaises(RuntimeError):
            gnome.select_mode((1,monitors,[(0,0,1,0,True,[spec,spare],{})],{}))
        with self.assertRaises(RuntimeError):
            gnome.select_mode((1,monitors,state[2]+[(1920,0,1,0,False,[spare],{})],{}))

    def test_native_x11_uses_only_the_active_output(self):
        gnome=load('gnome-display.py')
        visible=('Screen 0: minimum 1 x 1, current 1920 x 1080, maximum 16384 x 16384\n'
                 'Virtual1 connected primary 1920x1080+0+0 (normal)\n'
                 '   1920x1080     60.00*\n'
                 'Virtual2 connected (normal)\n')
        with patch('subprocess.check_output',return_value=visible), patch('subprocess.run') as run:
            self.assertEqual(gnome.native_x11(),[1920,1080])
            run.assert_called_once_with(['xrandr','--output','Virtual1','--mode','1920x1080',
                                         '--fb','1920x1080'],check=True,capture_output=True,text=True)
        with patch('subprocess.check_output',return_value=visible.replace(
                'Virtual2 connected (normal)','Virtual2 connected 1920x1080+1920+0 (normal)')):
            with self.assertRaises(RuntimeError):gnome.native_x11()
    def test_recording_handoff_never_executes_source(self):
        recorder=load('prepare-recording.py')
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'macro.py';path.write_text('raise RuntimeError("must not execute")\n')
            result=recorder.describe(path)
            self.assertFalse(result['source_executed']);self.assertEqual(result['status'],'ready_for_ai_review')
