import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from vm_update import UpdateRun


class UpdateResultTests(unittest.TestCase):
    def test_summary_keeps_full_events_on_disk(self):
        with tempfile.TemporaryDirectory() as directory:
            run=UpdateRun(None,directory)
            run.events=[{'stage':'apt-result','texts':['RPAOK'],'screenshot':'frame.png'}]
            summary=run.finish('succeeded',root_verified=True,root_shell_exited=True)
            self.assertNotIn('events',summary)
            self.assertNotIn('error_summary',summary)
            self.assertTrue(summary['root_verified'])
            self.assertTrue(summary['root_shell_exited'])
            self.assertEqual(json.loads(Path(summary['details_path']).read_text())['events'],run.events)
            self.assertEqual(json.loads((Path(directory)/'summary.json').read_text()),summary)

    def test_failure_summary_is_bounded_and_exit_is_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            run=UpdateRun(None,directory)
            run.events=[{'stage':'apt-result','texts':['Error: '+'x'*1000]}]
            summary=run.finish('failed',root_verified=True)
            self.assertLessEqual(len(summary['error_summary']),300)
            self.assertIsNone(summary['root_shell_exited'])
            self.assertNotIn('events',summary)

    def test_cli_default_and_debug_output_without_controlling_vm(self):
        import rpa
        with tempfile.TemporaryDirectory() as directory:
            run=UpdateRun(None,directory)
            run.events=[{'stage':'apt-result','texts':['RPAOK']}]
            summary=run.finish('succeeded',root_verified=True,root_shell_exited=True)
            for flag in [[],['--full-result']]:
                with self.subTest(flag=flag),patch('rpa.SpiceRobot') as robot, \
                     patch('sys.argv',['rpa.py','vm-update',*flag]):
                    robot.return_value.update_sandbox_vm.return_value=summary
                    stream=io.StringIO()
                    with contextlib.redirect_stdout(stream):
                        rpa.main()
                    result=json.loads(stream.getvalue())
                    self.assertEqual('events' in result,bool(flag))
                    robot.return_value.disconnect_spice.assert_called_once()
