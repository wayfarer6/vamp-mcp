import unittest
from types import SimpleNamespace
from unittest.mock import patch

from backends.library.replay import OutcomeScreenBlocked, VNC, VBox, replay


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
