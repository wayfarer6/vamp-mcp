import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock,patch
from recording_converter import generate,parse_recording
from recording_runtime import RecordedWorkflow
from scripts.new_rpa import create_package


class ConversionTests(unittest.TestCase):
    def test_ast_does_not_run_arbitrary_python(self):
        with tempfile.TemporaryDirectory() as directory:
            marker=Path(directory)/'executed'
            with self.assertRaises(ValueError):
                parse_recording(f"import os\nos.system({f'touch {marker}'!r})")
            self.assertFalse(marker.exists())
            with self.assertRaises(ValueError):
                parse_recording("import pyautogui as p\np.click(x=__import__('os').getpid(),y=2)")

    def test_key_order_aliases_and_guest_coordinates_are_preserved(self):
        actions=parse_recording('''import pyautogui as p
import time
p.keyDown('cmd')
p.keyDown('r')
p.keyUp('r')
p.keyUp('cmd')
p.keyDown('shift_r')
p.keyUp('shift_r')
p.click(x=789,y=59)
time.sleep(1.5)
''')
        self.assertEqual([a.get('key') for a in actions[:6]],['super','r','r','super','shiftright','shiftright'])
        self.assertEqual((actions[6]['x'],actions[6]['y']),(789,59))
        self.assertEqual(actions[-1]['seconds'],1.5)

    def test_host_viewport_mapping_rejects_chrome_and_window_borders(self):
        source='import pyautogui\npyautogui.click(x=200,y=150)'
        actions=parse_recording(source,coordinate_space='host',viewport=[100,50,960,540])
        self.assertEqual((actions[0]['x'],actions[0]['y']),(200,200))
        with self.assertRaises(ValueError):parse_recording(source,coordinate_space='host')
        with self.assertRaises(ValueError):parse_recording(source,coordinate_space='host',viewport=[300,50,960,540])

    def test_generate_keeps_typed_text_out_of_public_scaffold(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'녹화 🧪.py'
            source.write_text("import pyautogui\npyautogui.write('PRIVATE_RECORDING_VALUE')\n")
            result=generate(source,'example',package_root=root/'rpas')
            package=Path(result['package_path'])
            conversion=json.loads((package/'conversion.json').read_text(encoding='ascii'))
            self.assertEqual(conversion['source_name'],source.name)
            self.assertIn(source.name,(package/'README.md').read_text(encoding='utf-8'))
            self.assertIn('PRIVATE_RECORDING_VALUE',(package/'recording.local.json').read_text())
            if os.name == 'posix':
                self.assertEqual((package/'recording.local.json').stat().st_mode & 0o777,0o600)
            for name in ['workflow.py','run.robot','conversion.json','README.md','manifest.json']:
                self.assertNotIn('PRIVATE_RECORDING_VALUE',(package/name).read_text(encoding='utf-8'))
            with self.assertRaises(ValueError):generate(source,'example',package_root=root/'rpas')
            self.assertEqual(source.read_text(),"import pyautogui\npyautogui.write('PRIVATE_RECORDING_VALUE')\n")

    def test_invalid_input_does_not_leave_a_partial_package(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'bad'
            source.write_text('import pyautogui\npyautogui.click(x=1,y=1)\nraise Exception()')
            with self.assertRaises(ValueError):generate(source,'bad',package_root=root/'rpas')
            self.assertFalse((root/'rpas/bad').exists())


class RuntimeTests(unittest.TestCase):
    def recording(self,directory):
        root=Path(directory)
        (root/'recording.local.json').write_text(json.dumps({'format_version':1,'guest_os':'windows11',
            'resolution':[1920,1080],'actions':[{'op':'key_down','key':'super'}]}))
        return RecordedWorkflow(root)

    def test_default_is_review_only_and_geometry_mismatch_blocks_input(self):
        with tempfile.TemporaryDirectory() as directory:
            workflow=self.recording(directory)
            self.assertFalse(workflow.load_recording())
            self.assertIsNone(workflow.spice)
            with self.assertRaises(AssertionError):workflow.replay_event(0)
            workflow.load_recording(True)
            spice=MagicMock();spice.screen_info.return_value={'width':1280,'height':720,'mouse_mode':2}
            with patch('recording_runtime.BuiltIn') as builtin:
                builtin.return_value.get_library_instance.return_value=spice
                with self.assertRaises(AssertionError):workflow.check_guest_geometry()
            spice.inputs.key_press.assert_not_called()

    def test_raw_win_r_scancodes_and_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            workflow=self.recording(directory);workflow.load_recording(True)
            workflow.spice=MagicMock()
            workflow._down('super');workflow._down('r')
            workflow.spice.inputs.key_press.assert_any_call(0x15b)
            workflow.spice.inputs.key_press.assert_any_call(19)
            workflow.release_recorded_inputs()
            workflow.spice.inputs.key_release.assert_any_call(0x15b)
            workflow.spice.inputs.key_release.assert_any_call(19)
            self.assertEqual(workflow.held,{})

    def test_virtualbox_requires_review_and_checks_geometry_before_input(self):
        vm = '01234567-89ab-cdef-0123-456789abcdef'
        with tempfile.TemporaryDirectory() as directory:
            workflow = self.recording(directory)
            workflow.load_recording()
            with patch('backends.library.replay.VBox') as factory:
                with self.assertRaises(AssertionError):
                    workflow.replay_virtualbox(vm)
                factory.assert_not_called()
                workflow.load_recording(True)
                driver = factory.return_value
                driver.geometry.return_value = [1280, 720]
                with self.assertRaisesRegex(ValueError, 'resolution'):
                    workflow.replay_virtualbox(vm)
                factory.assert_called_once_with(vm)
                driver.down.assert_not_called()
                driver.close.assert_called_once()

    def test_invalid_edited_data_is_rejected_before_replay(self):
        with tempfile.TemporaryDirectory() as directory:
            workflow=self.recording(directory)
            path=Path(directory)/'recording.local.json';data=json.loads(path.read_text())
            data['actions']=[{'op':'wait','seconds':-1}];path.write_text(json.dumps(data))
            with self.assertRaises(ValueError):workflow.load_recording(True)
            self.assertIsNone(workflow.spice)

    def test_manual_scaffold_uses_common_launcher_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            target=create_package('example',package_root=directory)
            self.assertIn("guest_hotkey('super','r')",(target/'workflow.py').read_text())
            self.assertIn('not_configured',(target/'workflow.py').read_text())
            self.assertNotIn('Spice.Connect Spice    ${SPICE_URI}',(target/'run.robot').read_text())
            with self.assertRaises(ValueError):create_package('example',package_root=directory)


class NaverDestinationTests(unittest.TestCase):
    def test_home_login_button_is_insufficient_but_verified_form_succeeds(self):
        from rpas.windows_naver_recorded.workflow import Workflow
        def element(text,x,y,kind='ui_region'):
            return {'text':text,'center':[x,y],'xyxy':[x-40,y-10,x+40,y+10],
                    'ocr_confidence':.99,'kind':kind,'readings':[]}
        with tempfile.TemporaryDirectory() as directory,patch('robot.libraries.BuiltIn.BuiltIn') as builtin:
            builtin.return_value.get_variable_value.return_value=directory
            workflow=Workflow();workflow.spice=MagicMock();workflow.completed=80
            analysis={'screenshot':'frame.png','annotated':'frame.annotated.png',
                      'elements':[element('로그인',900,580)]}
            workflow.spice.analyze_guest_ui.return_value=analysis
            self.assertEqual(workflow.verify_naver_login_reached()['status'],'verification_failed')
            analysis['elements']=[element('nid.naver.com/nidlogin.login',500,90,'text'),
                element('아이디 또는 전화번호',900,330),element('비밀번호',900,430),element('로그인',960,580)]
            result=workflow.verify_naver_login_reached()
            self.assertEqual(result['status'],'succeeded')
            self.assertTrue(result['form_verified'])
            self.assertFalse(result['login_submitted'])
            for item in analysis['elements']:item['kind']='text'
            self.assertEqual(workflow.verify_naver_login_reached()['status'],'verification_failed')
