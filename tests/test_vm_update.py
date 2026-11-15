import unittest
from vm_update import apt_outcome,encoded_printf


class UpdateOutcomeTests(unittest.TestCase):
    def test_echoed_command_cannot_count_as_success(self):
        marker='RPAAPTOKABCDE'
        command=encoded_printf(marker)
        self.assertNotIn(marker,command)
        self.assertEqual(apt_outcome([{'text':command,'confidence':.99}],marker,'RPAFAIL'),
                         'running_or_unverified')

    def test_success_failure_and_warning_are_distinct(self):
        for texts,expected in [(['RPAOK'],'succeeded'),
                               (['WARNING: apt does not have a stable CLI interface. Use with caution in scripts.','RPAOK'],'succeeded'),(['RPAFAIL'],'failed'),
                               (['W: Failed to fetch index','RPAOK'],'completed_with_warnings')]:
            with self.subTest(expected=expected):
                self.assertEqual(apt_outcome([{'text':t,'confidence':.99} for t in texts],
                                             'RPAOK','RPAFAIL'),expected)
