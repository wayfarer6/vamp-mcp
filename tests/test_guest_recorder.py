from pathlib import Path
from queue import Queue
import runpy
import sys
from tempfile import TemporaryDirectory
from threading import Lock
import unittest
from unittest.mock import Mock, patch

from recording_converter import parse_recording


class GuestRecorderTests(unittest.TestCase):
    def test_save_keeps_the_final_wait_after_input_without_adding_it_twice(self):
        script = Path(__file__).resolve().parents[1] / 'guest_setup/recorder/vamp-recorder.py'
        with patch.dict(sys.modules, {'tkinter': Mock(), 'pynput': Mock()}):
            recorder_class = runpy.run_path(str(script))['Recorder']
        recorder = recorder_class.__new__(recorder_class)
        recorder.active = True
        recorder.recorded_input = False
        recorder.last = 10
        recorder.events = []
        recorder.pending = Queue()
        recorder.held = set()
        recorder.lock = Lock()
        recorder.status = Mock()
        recorder.start_button = Mock()
        recorder.write_health = Mock()
        recorder.copy_path = Mock()
        recorder.shared = True
        with patch('time.monotonic', return_value=12):
            recorder.stop()
        self.assertTrue(recorder.pending.empty())

        recorder.active = True
        with patch('time.monotonic', side_effect=[12, 15]):
            recorder.add("pyautogui.press('enter')")
            recorder.stop()
        with TemporaryDirectory() as folder:
            recorder.folder = Path(folder)
            recorder.save()
            actions = parse_recording(recorder.last_saved.read_text(encoding='utf-8'))
        self.assertEqual([action['op'] for action in actions], ['wait', 'press', 'wait'])
        self.assertEqual(actions[-1]['seconds'], 3)
