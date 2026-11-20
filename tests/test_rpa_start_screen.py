import unittest
import json
import os
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from backends.library.replay import ElevationHandoff, OutcomeScreenBlocked, VNC, VBox, replay, run
from backends.virtualbox.history import detail


class FixtureDriver:
    def __init__(self):
        self.events = []
        self.closed = False

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
        metadata = {'id': 'fixture-rpa', 'backend': 'virtualbox', 'resolution': [1920, 1080]}
        actions = [{'op': 'click', 'x': 10, 'y': 20, 'button': 'left', 'clicks': 1, 'interval': 0}]
        with TemporaryDirectory() as folder, patch.dict(os.environ, {'VAMP_DATA_DIR': folder}), \
             patch('backends.library.replay.load', return_value=(metadata, actions)), \
             patch('backends.library.replay.VBox', return_value=driver), \
             patch('backends.library.replay.inspect_elevation_screen', return_value=True):
            result = await run({'vm_id': 'fixture-vm', 'pause_on_uac': True})
            record = detail(result['run_id'])
        self.assertEqual(result['status'], 'operator_handoff')
        self.assertEqual(driver.events, [])
        self.assertEqual(record['vm'], 'fixture-vm')
        self.assertEqual(record['evidence_status'], 'event_only')
        self.assertEqual(record['artifacts'], [])
        event, = record['events']
        self.assertEqual(event['kind'], 'elevation_handoff')
        self.assertEqual(event['created_at'], result['at'])
        self.assertEqual(json.loads(event['payload_json']), {
            'rpa_id': 'fixture-rpa', 'reason': 'uac_prompt_detected', 'actions_completed': 0,
            'policy': 'operator_confirmation_required',
        })

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
                        with self.assertRaises(OutcomeScreenBlocked):
                            await replay(driver, actions, [1920, 1080], outcome_text='Export complete')
                self.assertTrue(driver.closed)

    async def test_scratch_promotion_requires_new_outcome_text(self):
        actions = [{'op': 'click', 'x': 10, 'y': 20, 'button': 'left', 'clicks': 1, 'interval': 0}]
        for before, accepted in [('Export complete', False), ('Ready', True)]:
            with self.subTest(before=before):
                driver = FixtureDriver()
                readings = [[{'text': text, 'confidence': 0.95}] for text in (before, 'Export complete')]
                with patch('backends.library.replay.recognize_start_screen', side_effect=readings):
                    options = {'outcome_text': 'Export complete', 'require_new_outcome': True}
                    if accepted:
                        self.assertEqual(await replay(driver, actions, [1920, 1080], **options), 1)
                    else:
                        with self.assertRaisesRegex(OutcomeScreenBlocked, 'already present'):
                            await replay(driver, actions, [1920, 1080], **options)
                self.assertEqual(driver.events, ['move', 'left'] if accepted else [])
                self.assertTrue(driver.closed)

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
