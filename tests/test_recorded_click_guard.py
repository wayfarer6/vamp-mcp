import unittest
from unittest.mock import patch
from PIL import Image
from backends.library.click_guard import ClickBlocked, MIN_CONFIDENCE
from backends.library.replay import replay
from recording_converter import parse_recording


class Guest:
    def __init__(self):
        self.events = []
        self.frame = Image.new('RGB', (200, 100), 'white')
        self.closed = False

    def geometry(self): return list(self.frame.size)
    async def capture(self, path, size): self.frame.save(path)
    async def drain(self): pass
    def move(self, x, y): self.events.append(('move', x, y))
    def click(self, button): self.events.append(button)
    def down(self, key): self.events.append(key)
    def up(self, key): pass
    def close(self): self.closed = True


def click(target='{"ocr":"저장"}'):
    return parse_recording('import pyautogui\npyautogui.click(35, 25)  # vamp-target ' + target)[0]


class RecordedClickTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.guest = Guest()
        self.match = {'text': '저장', 'confidence': MIN_CONFIDENCE, 'xyxy': [10, 10, 60, 40]}

    async def run_actions(self, actions, responses):
        with patch('backends.library.click_guard.detect', side_effect=responses), patch('asyncio.sleep'):
            await replay(self.guest, actions, [200, 100])

    async def test_operator_override_and_disabled_mode(self):
        with patch('backends.library.click_guard.detect', return_value=[self.match]), patch('asyncio.sleep'):
            with self.assertRaisesRegex(ClickBlocked, 'low_confidence'):
                await replay(self.guest, [click()], [200, 100], click_minimum_percent=95)
            self.assertNotIn('left', self.guest.events)
            await replay(self.guest, [click()], [200, 100], click_minimum_percent=80)
            self.assertEqual(self.guest.events.count('left'), 1)
        with patch('backends.library.click_guard.detect', side_effect=AssertionError()) as detector:
            await replay(self.guest, [dict(click(), target=None)], [200, 100], click_minimum_percent=0)
            detector.assert_not_called()
        self.assertEqual(self.guest.events.count('left'), 2)

    async def test_threshold_inclusive_and_fresh_retry(self):
        await self.run_actions([click()], [[], [self.match]])
        self.assertEqual(self.guest.events, [('move', 35, 25), 'left'])

    async def test_stop_and_skip_following_input(self):
        for reason, rows in [('ambiguous_target', [self.match, self.match]),
                             ('low_confidence', [dict(self.match, confidence=MIN_CONFIDENCE-.0001)]),
                             ('target_moved', [dict(self.match, xyxy=[130,10,170,40])]),
                             ('invalid_detector_result', [dict(self.match, confidence=float('nan'))]),
                             ('target_not_found', []),
                             ('detector_or_capture_unavailable', RuntimeError('offline'))]:
            with self.subTest(reason=reason), self.assertRaises(ClickBlocked) as stopped:
                await self.run_actions([click(), {'op':'write','text':'x'}], [rows, rows])
            self.assertEqual(stopped.exception.reason, reason)
            self.assertEqual(self.guest.events, [])
            self.assertTrue(self.guest.closed)

    async def test_missing_target_and_generic_icon(self):
        for action in [dict(click(), target=None), click('{"yolo":"icon"}')]:
            with self.assertRaises(ClickBlocked):
                await self.run_actions([action], [])
        self.assertEqual(self.guest.events, [])

    async def test_each_press_verified_even_inside_repeat(self):
        action = dict(click('{"yolo":"save-icon"}'), clicks=2)
        detected = {'label':'save-icon', 'confidence':.96, 'xyxy':[10,10,60,40]}
        with self.assertRaises(ClickBlocked) as stopped:
            await self.run_actions([action], [[detected], [], []])
        self.assertEqual(stopped.exception.presses, 1)
        self.assertEqual(self.guest.events.count('left'), 1)

    async def test_hover_changing_target_during_inference_blocks_click(self):
        def change(*point):
            self.guest.frame.paste('black' if self.guest.frame.getpixel((20,20))[0] else 'white', (10,10,30,30))
        self.guest.move = change
        with self.assertRaisesRegex(ClickBlocked, 'target_changed'):
            await self.run_actions([click()], [[self.match], [self.match]])
        self.assertEqual(self.guest.events, [])
