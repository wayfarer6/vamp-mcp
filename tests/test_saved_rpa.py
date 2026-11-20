import asyncio
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from tests.test_rpa_start_screen import FixtureDriver
from backends.virtualbox.history import detail

ROOT=Path(__file__).resolve().parents[1]
def module(name):
    spec=importlib.util.spec_from_file_location(name,ROOT/'backends/library'/f'{name}.py')
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result
registry=module('registry');replay=module('replay')
class SavedRPATests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.source=self.root/'source.py';self.source.write_text("import pyautogui\npyautogui.write('${query}')\npyautogui.press('enter')\n")
        self.request={'title':'Search invoice','description':'Enter a query into the guest search field','source_path':str(self.source),'backend':'kvm','width':640,'height':480,'inputs':['query'],'reviewed':True}

    def test_virtualbox_revision_validation_preserves_registered_source_and_head(self):
        request = {**self.request, 'backend': 'virtualbox'}
        saved = registry.register(self.root / 'catalog', request)
        folder = Path(saved['folder'])
        original = (folder / 'source.py').read_bytes()
        self.source.write_text("import pyautogui\npyautogui.write('${query}')\npyautogui.press('tab')\n")
        result = registry.validate_revision(request)
        self.assertEqual(result['status'], 'static_validation_passed')
        self.assertEqual(result['action_count'], 2)
        self.assertFalse(result['guest_verified'])
        self.assertFalse(result['committed'])

        with self.assertRaisesRegex(ValueError, 'placeholder'):
            registry.validate_revision({**request, 'inputs': ['missing']})
        self.assertEqual((folder / 'source.py').read_bytes(), original)
        self.assertEqual(registry.git(folder, 'rev-parse', 'HEAD'), saved['commit'])
        self.assertEqual(registry.git(folder, 'status', '--porcelain'), '')

    def test_reviewed_virtualbox_definition_enforces_its_saved_starting_text(self):
        root = self.root / 'catalog'
        self.source.write_text("import pyautogui\npyautogui.click(10, 20)\n")
        saved = registry.register(root, {**self.request, 'backend': 'virtualbox',
                                         'width': 1920, 'height': 1080, 'inputs': [], 'start_text': 'QA-042'})
        request = {'registry': str(root), 'id': saved['definition']['id'],
                   'vm_id': '01234567-89ab-cdef-0123-456789abcdef', 'confirmed': True}
        for text in ('QA-999', 'Dashboard', 'QA-042 QA-042', 'QA-042'):
            with self.subTest(text=text):
                driver = FixtureDriver()
                with patch.object(replay, 'VBox', return_value=driver), \
                     patch.object(replay, 'recognize_start_screen',
                                  return_value=[{'text': text, 'confidence': 0.95}]):
                    if text == 'QA-042':
                        result = asyncio.run(replay.run(request))
                        self.assertEqual(result['actions_completed'], 1)
                        self.assertEqual(driver.events, ['move', 'left'])
                    else:
                        with self.assertRaisesRegex(replay.StartScreenBlocked, 'Starting screen mismatch'):
                            asyncio.run(replay.run(request))
                        self.assertEqual(driver.events, [])

    def test_virtualbox_scratch_revision_replays_synthetic_actions_without_saving(self):
        vm = '01234567-89ab-cdef-0123-456789abcdef'
        request = {
            **self.request, 'backend': 'virtualbox', 'scratch_vm': vm,
            'test_inputs': {'query': 'fixture'}, 'outcome_text': 'Export complete',
        }
        with patch('backends.library.scratch.require_virtualbox_scratch', return_value=vm) as check, \
             patch('backends.library.replay.VBox') as driver, \
             patch('backends.library.replay.replay', new_callable=AsyncMock) as run:
            run.return_value = 2
            result = registry.test_revision(request)
            check.assert_called_once_with(vm)
            driver.assert_called_once_with(vm)
            args = run.await_args
            self.assertEqual(args.args[1][0]['text'], 'fixture')
            self.assertEqual(args.kwargs['outcome_text'], 'Export complete')
        self.assertEqual(result['status'], 'scratch_screen_verified')
        self.assertFalse(result['artifact_verified'])
        self.assertFalse(result['committed'])

    def test_virtualbox_scratch_promotion_preserves_head_on_failure_and_advances_on_success(self):
        root = self.root / 'catalog'
        request = {**self.request, 'backend': 'virtualbox'}
        original = registry.register(root, request)
        folder = Path(original['folder'])
        vm = '01234567-89ab-cdef-0123-456789abcdef'
        request.update(id=original['definition']['id'], expected_commit=original['commit'],
                       scratch_vm=vm, outcome_text='Export complete', test_inputs={'query': 'fixture'})
        self.source.write_text("import pyautogui\npyautogui.write('${query}')\npyautogui.press('tab')\n")
        baseline, expected = 'a' * 64, 'b' * 64
        artifact = ('/tmp/fixture.csv', 'fixture', self.root / 'fixture-password', baseline, expected)
        modal = (str(self.root / 'modal.pt'), 'blocking_dialog')
        with patch.dict(os.environ, {'VAMP_REPAIR_MODAL_MODEL': '', 'VAMP_REPAIR_MODAL_LABEL': ''}), \
             patch('backends.library.scratch.require_virtualbox_scratch') as scratch:
            with self.assertRaisesRegex(ValueError, 'modal detector'):
                registry.test_and_commit(root, request)
            scratch.assert_not_called()
            self.assertEqual(registry.git(folder, 'rev-parse', 'HEAD'), original['commit'])
        with patch('backends.library.scratch.require_virtualbox_scratch', return_value=vm), \
             patch('backends.library.scratch.scratch_artifact_settings', return_value=artifact), \
             patch('backends.library.scratch.scratch_modal_settings', return_value=modal) as modal_settings, \
             patch('backends.library.scratch.scratch_artifact_hash') as artifact_hash, \
             patch('backends.library.replay.VBox'), \
             patch('backends.library.replay.replay', new_callable=AsyncMock) as run:
            artifact_hash.side_effect = [baseline]
            run.side_effect = ValueError('Expected outcome text is already present.')
            with self.assertRaisesRegex(ValueError, 'already present'):
                registry.test_and_commit(root, request)
            self.assertTrue(run.await_args.kwargs['require_new_outcome'])
            self.assertEqual(run.await_args.kwargs['forbidden_modal'], modal)
            modal_settings.assert_called_once_with(required=True)
            artifact_hash.assert_called_once_with(vm, artifact)
            self.assertEqual(registry.git(folder, 'rev-parse', 'HEAD'), original['commit'])

            artifact_hash.side_effect = [baseline, 'c' * 64]
            run.side_effect = None
            run.return_value = 2
            with self.assertRaisesRegex(ValueError, 'SHA-256 does not match') as failed:
                registry.test_and_commit(root, request)
            with patch.dict(os.environ, {'VAMP_DATA_DIR': str(self.root / 'audit')}):
                response = registry.scratch_failure(request, failed.exception)
                audit = detail(response['run_id'])
            self.assertEqual(response['verification_stage'], 'result_artifact')
            self.assertFalse(response['committed'])
            self.assertEqual(audit['vm'], vm)
            self.assertEqual(audit['artifacts'], [])
            event, = audit['events']
            self.assertEqual(event['kind'], 'repair_verification')
            self.assertEqual(json.loads(event['payload_json']), {
                'rpa_id': request['id'], 'stage': 'result_artifact',
                'expected_commit': original['commit'], 'committed': False,
            })
            with patch.dict(os.environ, {'VAMP_DATA_DIR': str(self.root / 'audit'),
                                         'VAMP_REPAIR_CAPTURE_FAILURE': '1'}), \
                 patch('backends.virtualbox.history.capture') as capture:
                with_screenshot = registry.scratch_failure(request, failed.exception)
            capture.assert_called_once_with(with_screenshot['run_id'], 'after-repair-failure')
            self.assertEqual(with_screenshot['failure_screenshot'], 'saved')
            self.assertEqual(registry.git(folder, 'rev-parse', 'HEAD'), original['commit'])
            self.assertEqual(registry.git(folder, 'status', '--porcelain'), '')

            artifact_hash.side_effect = [baseline, expected]
            result = registry.test_and_commit(root, request)
        self.assertEqual(result['status'], 'verified_commit_needs_review')
        self.assertTrue(result['modal_check_verified'])
        self.assertEqual(registry.git(folder, 'rev-parse', 'HEAD'), result['commit'])
        self.assertEqual(registry.git(folder, 'rev-parse', 'HEAD^'), original['commit'])
        self.assertEqual((folder / 'source.py').read_bytes(), self.source.read_bytes())
        self.assertFalse(json.loads((folder / 'rpa.json').read_text())['reviewed'])
    def test_registers_title_description_contract_without_executing_source(self):
        saved=registry.register(self.root/'catalog',self.request)
        self.assertEqual(saved['definition']['name'],'Search invoice');self.assertFalse(saved['definition']['source_executed']);self.assertEqual(saved['definition']['action_count'],2)
        request={'registry':str(self.root/'catalog'),'id':saved['definition']['id'],'vm_id':'12345678-1234-1234-1234-123456789abc','inputs':{'query':'November'},'confirmed':True}
        metadata,actions=replay.load(request);self.assertEqual(actions[0]['text'],'November')
        self.assertEqual(metadata['replay_commit'], saved['commit'])
        request['confirmed']=False
        with self.assertRaisesRegex(ValueError,'confirm'):replay.load(request)
        request['confirmed']=True;(Path(saved['folder'])/'source.py').write_text('changed')
        with self.assertRaisesRegex(ValueError,'uncommitted|source changed'):replay.load(request)
    def test_rejects_unreviewed_unsupported_and_unused_input_names(self):
        bad={**self.request,'inputs':['missing']}
        with self.assertRaisesRegex(ValueError,'placeholder'):registry.register(self.root/'catalog',bad)
        with self.assertRaisesRegex(ValueError,'Hyper-V'):registry.register(self.root/'catalog',{**self.request,'backend':'hyperv'})
        saved=registry.register(self.root/'catalog',{**self.request,'reviewed':False})
        with self.assertRaisesRegex(ValueError,'Review'):replay.load({'registry':str(self.root/'catalog'),'id':saved['definition']['id'],'vm_id':'12345678-1234-1234-1234-123456789abc','confirmed':True,'inputs':{'query':'x'}})
    def test_replay_checks_geometry_and_releases_keys_on_failure(self):
        class Driver:
            def __init__(self):self.closed=False;self.keys=[]
            def geometry(self):return [640,480]
            def down(self,key):self.keys.append(key)
            def up(self,key):self.keys.remove(key)
            async def drain(self):pass
            def close(self):self.closed=True;self.keys=[]
        driver=Driver();count=asyncio.run(replay.replay(driver,[{'op':'hotkey','keys':['ctrl','l']}],[640,480]));self.assertEqual(count,1);self.assertTrue(driver.closed);self.assertEqual(driver.keys,[])
        with self.assertRaisesRegex(ValueError,'resolution'):asyncio.run(replay.replay(Driver(),[],[1920,1080]))

    def test_each_skill_has_independent_git_versions_and_repair_conflict_protection(self):
        saved=registry.register(self.root/'catalog',self.request)
        folder=Path(saved['folder']);self.assertTrue((folder/'.git').is_dir())
        self.source.write_text("import pyautogui\npyautogui.write('${query}')\npyautogui.press('tab')\n")
        repaired=registry.register(self.root/'catalog',{**self.request,'id':saved['definition']['id'],'expected_commit':saved['commit'],'reviewed':False,'commit_message':'Repair tab navigation'})
        self.assertEqual(repaired['definition']['version'],'1.0.1');self.assertNotEqual(saved['commit'],repaired['commit']);self.assertEqual(registry.git(folder,'rev-list','--count','HEAD'),'2')
        with self.assertRaisesRegex(ValueError,'changed since'):registry.register(self.root/'catalog',{**self.request,'id':saved['definition']['id'],'expected_commit':saved['commit']})
