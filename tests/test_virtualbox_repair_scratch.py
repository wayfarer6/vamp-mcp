import unittest

from backends.library.scratch import require_virtualbox_scratch


class VirtualBoxRepairScratchTest(unittest.TestCase):
    VM = '01234567-89ab-cdef-0123-456789abcdef'

    def setUp(self):
        self.environment = {'VAMP_REPAIR_SCRATCH_VM': self.VM}
        self.fields = {
            'UUID': self.VM, 'VMState': 'running',
            **{f'nic{index}': 'none' for index in range(1, 9)},
            'clipboard': 'disabled', 'clipboard_file_transfers': 'off',
            'draganddrop': 'disabled', 'vrde': 'off', 'usb': 'off', 'teleporterenabled': 'off',
        }

    def check(self, vm=None, fields=None, environment=None):
        return require_virtualbox_scratch(
            vm or self.VM,
            read_config=lambda actual: self.fields if fields is None else fields,
            environment=self.environment if environment is None else environment,
        )

    def test_only_host_configured_running_uuid_passes(self):
        self.assertEqual(self.check(), self.VM)
        with self.assertRaisesRegex(ValueError, 'dedicated'):
            self.check(environment={})
        with self.assertRaisesRegex(ValueError, 'not the host-configured'):
            self.check(vm='01234567-89ab-cdef-0123-456789abcdea')
        with self.assertRaisesRegex(ValueError, 'already be running'):
            self.check(fields={**self.fields, 'VMState': 'poweroff'})

    def test_rejects_configured_channels_and_unknown_settings(self):
        for name, value in [
            ('nic8', 'nat'), ('clipboard', 'bidirectional'),
            ('clipboard_file_transfers', 'on'), ('draganddrop', 'hosttoguest'),
            ('vrde', 'on'), ('usb', 'on'), ('teleporterenabled', 'on'),
            ('SharedFolderNameMachineMapping1', 'workspace'),
        ]:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'isolation'):
                self.check(fields={**self.fields, name: value})
        with self.assertRaisesRegex(ValueError, 'nic8'):
            self.check(fields={name: value for name, value in self.fields.items() if name != 'nic8'})
