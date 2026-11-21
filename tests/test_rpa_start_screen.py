import unittest
import json
import os
from pathlib import Path
from datetime import datetime, timezone
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from backends.library.replay import ElevationHandoff, OutcomeScreenBlocked, StartScreenBlocked, VNC, VBox, replay, run
from backends.virtualbox.history import detail


class FixtureDriver:
    def __init__(self):
        self.events = []
        self.closed = False
        self.held = set()

    def geometry(self):
        return [1920, 1080]

    async def capture(self, path, resolution):
        path.write_bytes(b'fixture')

    async def drain(self):
        pass

    def move(self, x, y):
        self.events.append('move')

    def click(self, button):
        self.events.append(button)

    def close(self):
        self.closed = True


class StartScreenTest(unittest.IsolatedAsyncioTestCase):
    async def test_virtualbox_captures_before_any_input(self):
        await self.check_capture_before_input('virtualbox')

    async def test_kvm_captures_before_any_input(self):
        await self.check_capture_before_input('kvm')

    async def test_virtualbox_uac_handoff_stops_before_next_action(self):
        actions = [{'op': 'click', 'x': 10, 'y': 20, 'button': 'left', 'clicks': 1, 'interval': 0}] * 2
        for next_screen, reason in [(True, 'uac_prompt_detected'), (ValueError('OCR failed'), 'screen_unverified')]:
            with self.subTest(reason=reason):
                driver = FixtureDriver()
                with patch('backends.library.replay.inspect_elevation_screen', side_effect=[False, next_screen]):
                    with self.assertRaises(ElevationHandoff) as blocked:
                        await replay(driver, actions, [1920, 1080], pause_on_uac=True)
                self.assertEqual(blocked.exception.reason, reason)
                self.assertEqual(blocked.exception.completed, 1)
                self.assertEqual(driver.events, ['move', 'left'])
                self.assertTrue(driver.closed)

    async def test_uac_handoff_is_visible_in_virtualbox_run_history(self):
        driver = FixtureDriver()
        commit = 'a' * 40
        metadata = {'id': 'fixture-rpa', 'backend': 'virtualbox', 'resolution': [1920, 1080],
                    'replay_commit': commit}
        actions = [{'op': 'click', 'x': 10, 'y': 20, 'button': 'left', 'clicks': 1, 'interval': 0}]
        lines = [
            {'text': '사용자 계정 컨트롤', 'confidence': .96, 'xyxy': [756, 371, 865, 385]},
            {'text': 'Windows', 'confidence': .93, 'xyxy': [809, 503, 977, 519], 'language': 'en'},
            {'text': 'Windows PowerShell', 'confidence': .99, 'xyxy': [809, 503, 977, 519], 'language': 'ko'},
            {'text': '확인된 게시자: Microsoft Windows', 'confidence': .96, 'xyxy': [757, 552, 977, 569], 'language': 'ko'},
            {'text': 'Unrelated foreground text', 'confidence': .99, 'xyxy': [1350, 500, 1540, 520]},
            {'text': 'Password:', 'confidence': .99},
        ]
        daemon = SimpleNamespace(request=lambda *args, **kwargs: {'lines': lines})
        with TemporaryDirectory() as folder, patch.dict(os.environ, {'VAMP_DATA_DIR': folder}), \
             patch('backends.library.replay.load', return_value=(metadata, actions)), \
             patch('backends.library.replay.VBox', return_value=driver), \
             patch.dict('sys.modules', {'model_daemon': daemon}):
            result = await run({'vm_id': 'fixture-vm', 'pause_on_uac': True})
            record = detail(result['run_id'])
        self.assertEqual(result['status'], 'operator_handoff')
        self.assertEqual(result['phase'], 'before_action')
        self.assertEqual(result['program_identity'], 'unverified')
        self.assertEqual(result['program_name_ocr'], 'Windows PowerShell')
        self.assertEqual(result['prompt_kind'], 'credential')
        self.assertEqual(result['replay_commit'], commit)
        self.assertEqual(driver.events, [])
        self.assertEqual(record['vm'], 'fixture-vm')
        self.assertEqual(record['evidence_status'], 'event_only')
        self.assertEqual(record['artifacts'], [])
        event, = record['events']
        self.assertEqual(event['kind'], 'elevation_handoff')
        self.assertEqual(event['created_at'], result['at'])
        self.assertEqual(json.loads(event['payload_json']), {
            'rpa_id': 'fixture-rpa', 'reason': 'uac_prompt_detected', 'actions_completed': 0,
            'policy': 'operator_confirmation_required', 'phase': 'before_action',
            'program_identity': 'unverified', 'replay_commit': commit,
            'program_name_ocr': 'Windows PowerShell',
            'prompt_kind': 'credential',
        })

    async def test_virtualbox_uac_after_final_action_precedes_outcome_ocr(self):
        driver = FixtureDriver()
        actions = [{'op': 'click', 'x': 10, 'y': 20, 'button': 'left', 'clicks': 1, 'interval': 0}]
        with patch('backends.library.replay.inspect_elevation_screen', side_effect=[False, True]), \
             patch('backends.library.replay.verify_outcome_screen') as verify:
            with self.assertRaises(ElevationHandoff) as blocked:
                await replay(driver, actions, [1920, 1080], pause_on_uac=True, outcome_text='Ready')
        self.assertEqual(blocked.exception.phase, 'after_last_action')
        self.assertEqual(blocked.exception.completed, 1)
        self.assertTrue(driver.closed)
        verify.assert_not_called()

    async def test_virtualbox_uac_precedes_starting_screen_and_rechecks_before_input(self):
        actions = [{'op': 'click', 'x': 10, 'y': 20, 'button': 'left', 'clicks': 1, 'interval': 0}]
        for screens, phase in [([True], 'before_starting_screen'), ([False, True], 'before_action')]:
            with self.subTest(phase=phase):
                driver = FixtureDriver()
                with patch('backends.library.replay.inspect_elevation_screen', side_effect=screens), \
                     patch('backends.library.replay.verify_start') as verify:
                    with self.assertRaises(ElevationHandoff) as blocked:
                        await replay(driver, actions, [1920, 1080], pause_on_uac=True, start_text='QA-042')
                self.assertEqual(blocked.exception.phase, phase)
                self.assertEqual(blocked.exception.completed, 0)
                self.assertEqual(verify.await_count, len(screens) - 1)
                self.assertEqual(driver.events, [])
                self.assertTrue(driver.closed)

    async def test_virtualbox_waits_for_post_uac_screen_then_runs_only_remaining_actions(self):
        driver = FixtureDriver()
        metadata = {'id': 'fixture-rpa', 'backend': 'virtualbox', 'resolution': [1920, 1080],
                    'replay_commit': 'a' * 40, 'expected_result': 'Ready'}
        actions = [{'op': 'click', 'x': 10, 'y': 20, 'button': 'left', 'clicks': 1, 'interval': 0}] * 2
        with TemporaryDirectory() as folder, patch.dict(os.environ, {'VAMP_DATA_DIR': folder}), \
             patch('backends.library.replay.load', return_value=(metadata, actions)), \
             patch('backends.library.replay.VBox', return_value=driver), \
             patch('backends.library.replay.asyncio.sleep'), \
             patch('backends.library.replay.inspect_elevation_screen',
                   side_effect=[False, SimpleNamespace(program_name='Fixture Setup', kind='consent'),
                                False, StartScreenBlocked('app lost focus'), False, False, False]) as inspect, \
             patch('backends.library.replay.datetime') as clock:
            observed = datetime(2026, 11, 20, 10, tzinfo=timezone.utc)
            resumed = datetime(2026, 11, 20, 10, 0, 3, tzinfo=timezone.utc)
            clock.now.side_effect = [observed, resumed]
            result = await run({'vm_id': 'fixture-vm', 'pause_on_uac': True, 'uac_wait_seconds': 10,
                                'uac_resume_text': 'Installed'})
            run_id, = result['elevation_resume_run_ids']
            record = detail(run_id)
            wait_id, = result['elevation_wait_run_ids']
            handoff, = detail(wait_id)['events']
        self.assertEqual(result['actions_completed'], 2)
        self.assertEqual(driver.events, ['move', 'left', 'move', 'left'])
        self.assertEqual([call.args[1] for call in inspect.call_args_list],
                         [None, None, 'Installed', 'Installed', 'Installed', 'Installed', None])
        event, = record['events']
        self.assertEqual(event['kind'], 'elevation_resumed')
        self.assertEqual(event['created_at'], resumed.isoformat())
        payload = json.loads(event['payload_json'])
        self.assertEqual(payload['actions_completed'], 1)
        self.assertEqual(payload['prompt_observed_at'], observed.isoformat())
        self.assertEqual(payload['program_name_ocr'], 'Fixture Setup')
        self.assertEqual(payload['prompt_kind'], 'consent')
        self.assertEqual(payload['policy'], 'operator_wait_screen_verified')
        self.assertEqual(handoff['kind'], 'elevation_handoff')
        self.assertEqual(handoff['created_at'], observed.isoformat())
        handoff_payload = json.loads(handoff['payload_json'])
        self.assertEqual(handoff_payload['actions_completed'], 1)
        self.assertEqual(handoff_payload['program_name_ocr'], 'Fixture Setup')
        self.assertEqual(handoff_payload['prompt_kind'], 'consent')
        self.assertEqual(handoff_payload['policy'], 'operator_confirmation_required')

    def test_resume_text_uses_one_language_and_only_a_clear_frame(self):
        from backends.library.replay import inspect_elevation_screen

        english = dict(text='Installed', confidence=0.95, language='en')
        korean = dict(text='Installed', confidence=0.95, language='ko')
        uac = dict(text='User Account Control', confidence=0.95, language='en')
        cases = [
            ([english, korean], None),
            ([english, english, korean], StartScreenBlocked),
            ([english, korean, uac], 'unknown'),
        ]
        for lines, expected in cases:
            with self.subTest(expected=expected):
                daemon = SimpleNamespace(request=lambda *args, **kwargs: {'lines': lines})
                with patch.dict('sys.modules', {'model_daemon': daemon}):
                    if expected is StartScreenBlocked:
                        with self.assertRaises(StartScreenBlocked):
                            inspect_elevation_screen('fixture.png', 'Installed')
                    elif expected:
                        self.assertEqual(inspect_elevation_screen('fixture.png', 'Installed').kind, expected)
                    else:
                        self.assertIsNone(inspect_elevation_screen('fixture.png', 'Installed'))

    def test_optional_uac_yolo_detection_does_not_override_ocr(self):
        from backends.library.replay import inspect_elevation_screen

        installed = dict(text='Installed', confidence=0.95, language='en')
        prompt = dict(text='User Account Control', confidence=0.95, language='en')
        with TemporaryDirectory() as directory:
            weights = Path(directory) / 'uac.pt'
            weights.touch()
            with patch.dict(os.environ, {'VAMP_UAC_YOLO_MODEL': str(weights)}), \
                 patch('model_daemon.request') as request:
                request.side_effect = [
                    {'lines': [installed]},
                    {'verified_class': 'uac_prompt', 'targets': [{'label': 'uac_prompt'}]},
                ]
                observed = inspect_elevation_screen('fixture.png', 'Installed')
                self.assertEqual(observed.kind, 'unknown')
                self.assertEqual(request.call_args.args[1]['required_class'], 'uac_prompt')

                request.reset_mock()
                request.side_effect = [{'lines': [prompt]}]
                self.assertEqual(inspect_elevation_screen('fixture.png').kind, 'unknown')
                request.assert_called_once()

                request.side_effect = [{'lines': [installed]}, {'verified_class': 'icon', 'targets': []}]
                with self.assertRaisesRegex(ValueError, 'configured modal class'):
                    inspect_elevation_screen('fixture.png', 'Installed')

    async def test_virtualbox_uac_wait_timeout_leaves_remaining_actions_unsent(self):
        driver = FixtureDriver()
        actions = [{'op': 'click', 'x': 10, 'y': 20, 'button': 'left', 'clicks': 1, 'interval': 0}]
        prompt_time = datetime(2026, 11, 20, 10, tzinfo=timezone.utc)
        with patch('backends.library.replay.inspect_elevation_screen', return_value=True), \
             patch('backends.library.replay.datetime') as clock:
            clock.now.side_effect = [prompt_time]
            with self.assertRaises(ElevationHandoff) as blocked:
                await replay(driver, actions, [1920, 1080], pause_on_uac=True,
                             uac_wait_seconds=0.02, uac_resume_text='Installed')
        self.assertEqual(blocked.exception.reason, 'uac_resume_not_verified')
        self.assertEqual(blocked.exception.observed_at, prompt_time.isoformat())
        self.assertEqual(driver.events, [])
        self.assertTrue(driver.closed)

    async def test_uncertain_uac_ocr_stops_before_guest_input(self):
        actions = [{'op': 'click', 'x': 10, 'y': 20, 'button': 'left', 'clicks': 1, 'interval': 0}]
        fixtures = [
            [{'text': 'unclear', 'confidence': 0.3}],
            [{'text': 'Installer', 'confidence': 0.95},
             {'text': 'User Account Control', 'confidence': 0.65}],
        ]
        for lines in fixtures:
            with self.subTest(lines=lines):
                driver = FixtureDriver()
                daemon = SimpleNamespace(request=lambda *args, **kwargs: {'lines': lines})
                with patch.dict('sys.modules', {'model_daemon': daemon}):
                    with self.assertRaises(ElevationHandoff) as blocked:
                        await replay(driver, actions, [1920, 1080], pause_on_uac=True)
                self.assertEqual(blocked.exception.reason, 'screen_unverified')
                self.assertEqual(blocked.exception.completed, 0)
                self.assertEqual(driver.events, [])

    async def test_virtualbox_outcome_requires_one_confident_match_after_input(self):
        actions = [{'op': 'click', 'x': 10, 'y': 20, 'button': 'left', 'clicks': 1, 'interval': 0}]
        for text, accepted in [('Export complete', True), ('Export failed', False),
                               ('Export complete Export complete', False)]:
            with self.subTest(text=text):
                driver = FixtureDriver()

                def recognize(screenshot, expected):
                    self.assertEqual(driver.events, ['move', 'left'])
                    self.assertEqual(screenshot.read_bytes(), b'fixture')
                    self.assertEqual(expected, 'Export complete')
                    return [{'text': text, 'confidence': 0.95}]

                with patch('backends.library.replay.recognize_start_screen', side_effect=recognize):
                    if accepted:
                        self.assertEqual(await replay(driver, actions, [1920, 1080],
                                                      outcome_text='Export complete'), 1)
                    else:
                        with self.assertRaises(OutcomeScreenBlocked) as blocked:
                            await replay(driver, actions, [1920, 1080], outcome_text='Export complete')
                        self.assertEqual(blocked.exception.expected_occurrences, 1)
                        self.assertEqual(blocked.exception.observed_occurrences, text.count('Export complete'))
                self.assertTrue(driver.closed)

    async def test_scratch_promotion_requires_new_outcome_text(self):
        actions = [{'op': 'click', 'x': 10, 'y': 20, 'button': 'left', 'clicks': 1, 'interval': 0}]
        ready = {'text': 'Ready', 'confidence': 0.95}
        complete = {'text': 'Export complete', 'confidence': 0.95}
        for before, failure in (
            ([complete], 'already present'),
            ([], 'baseline could not be verified'),
            ([{'text': 'Ready', 'confidence': 0.45}], 'baseline could not be verified'),
            ([ready, {'text': 'Export complete', 'confidence': 0.55}], 'baseline could not be verified'),
            ([ready], None),
        ):
            with self.subTest(before=before):
                driver = FixtureDriver()
                readings = [before, [complete]]
                with patch('backends.library.replay.recognize_start_screen', side_effect=readings):
                    options = {'outcome_text': 'Export complete', 'require_new_outcome': True}
                    if failure is None:
                        self.assertEqual(await replay(driver, actions, [1920, 1080], **options), 1)
                    else:
                        with self.assertRaisesRegex(OutcomeScreenBlocked, failure):
                            await replay(driver, actions, [1920, 1080], **options)
                self.assertEqual(driver.events, ['move', 'left'] if failure is None else [])
                self.assertTrue(driver.closed)

    async def test_scratch_outcome_rejects_a_visible_or_unverified_modal(self):
        for result, failure in [
            ({'verified_class': 'modal', 'targets': [{'label': 'modal'}]}, 'blocking modal is visible'),
            ({'targets': []}, 'outcome screen could not be verified'),
            ({'verified_class': 'modal', 'targets': []}, None),
        ]:
            with self.subTest(result=result):
                driver = FixtureDriver()
                ocr = [{'text': 'Export complete', 'confidence': 0.95}]

                def detect(kind, request, **kwargs):
                    self.assertEqual(kind, 'yolo')
                    self.assertEqual(request['required_class'], 'modal')
                    return result

                with patch.dict('sys.modules', {'model_daemon': SimpleNamespace(request=detect)}), \
                     patch('backends.library.replay.recognize_start_screen', return_value=ocr):
                    options = {'outcome_text': 'Export complete', 'forbidden_modal': ('model.pt', 'modal')}
                    if failure:
                        with self.assertRaisesRegex(OutcomeScreenBlocked, failure):
                            await replay(driver, [], [1920, 1080], **options)
                    else:
                        self.assertEqual(await replay(driver, [], [1920, 1080], **options), 0)

    async def check_capture_before_input(self, backend):
        actions = [{'op': 'click', 'x': 10, 'y': 20, 'button': 'left', 'clicks': 1, 'interval': 0}]
        png = b'fixture-png'

        def virtualbox_capture(*args):
            self.assertEqual(args, (0, 1920, 1080, 'PNG'))
            return png

        async def vnc_capture():
            return 'fixture-pixels'

        class VBoxFixture(FixtureDriver, VBox):
            capture = VBox.capture

        class VncFixture(FixtureDriver, VNC):
            capture = VNC.capture

        virtualbox = VBoxFixture()
        virtualbox.console = SimpleNamespace(display=SimpleNamespace(takeScreenShotToArray=virtualbox_capture))
        virtualbox.manager = SimpleNamespace(constants=SimpleNamespace(BitmapFormat_PNG='PNG'))
        kvm = VncFixture()
        kvm.client = SimpleNamespace(screenshot=vnc_capture)

        def from_array(pixels):
            self.assertEqual(pixels, 'fixture-pixels')
            return SimpleNamespace(save=lambda path, format: path.write_bytes(png))

        def recognize(path, expected):
            self.assertEqual(path.read_bytes(), png)
            return [{'text': 'QA-042', 'confidence': 0.95}]

        with patch.dict('sys.modules', {'PIL': SimpleNamespace(Image=SimpleNamespace(fromarray=from_array))}), \
             patch('backends.library.replay.recognize_start_screen', side_effect=recognize):
            driver = virtualbox if backend == 'virtualbox' else kvm
            with self.assertRaisesRegex(ValueError, 'Starting screen mismatch'):
                await replay(driver, actions, [1920, 1080], start_text='QA-999')
            self.assertEqual(driver.events, [])
            self.assertTrue(driver.closed)
            self.assertEqual(await replay(driver, actions, [1920, 1080], start_text='QA-042'), 1)
            self.assertEqual(driver.events, ['move', 'left'])

    async def test_replay_requires_one_confident_match_before_input(self):
        actions = [{'op': 'click', 'x': 10, 'y': 20, 'button': 'left', 'clicks': 1, 'interval': 0}]
        for text, confidence, allowed in [
            ('Request QA-042', 0.95, True),
            ('Request QA-999', 0.95, False),
            ('QA-042-archive', 0.95, False),
            ('QA-042 QA-042', 0.95, False),
            ('QA-042', 0.3, False),
        ]:
            with self.subTest(text=text, confidence=confidence):
                driver = FixtureDriver()
                with patch('backends.library.replay.recognize_start_screen', return_value=[
                    {'text': text, 'confidence': confidence},
                ]):
                    if allowed:
                        self.assertEqual(await replay(driver, actions, [1920, 1080], start_text='QA-042'), 1)
                    else:
                        with self.assertRaisesRegex(ValueError, 'Starting screen mismatch'):
                            await replay(driver, actions, [1920, 1080], start_text='QA-042')
                self.assertEqual(driver.events, ['move', 'left'] if allowed else [])
                self.assertTrue(driver.closed)
