import hashlib
from pathlib import Path
from types import SimpleNamespace
import unittest

from backends.library.scratch import require_virtualbox_scratch, scratch_artifact_hash


class VirtualBoxRepairScratchTest(unittest.TestCase):
    VM = '01234567-89ab-cdef-0123-456789abcdef'

    def setUp(self):
        self.environment = {'VAMP_REPAIR_SCRATCH_VM': self.VM}
        self.fields = {
            'UUID': self.VM, 'VMState': 'running',
            **{f'nic{index}': 'none' for index in range(1, 9)},
            'clipboard': 'disabled', 'clipboard_file_transfers': 'off',
            'draganddrop': 'disabled', 'vrde': 'off', 'usb': 'off', 'ehci': 'off', 'xhci': 'off',
            'audio_in': 'off', 'audio_out': 'off', 'teleporterenabled': 'off',
            **{f'uart{index}': 'off' for index in range(1, 5)},
            **{f'lpt{index}': 'off' for index in range(1, 3)},
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
            ('xhci', 'on'), ('uart2', '0x03f8,4'), ('audio_in', 'on'),
            ('SharedFolderNameMachineMapping1', 'workspace'),
        ]:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'isolation'):
                self.check(fields={**self.fields, name: value})
        with self.assertRaisesRegex(ValueError, 'nic8'):
            self.check(fields={name: value for name, value in self.fields.items() if name != 'nic8'})

    def test_artifact_hash_checks_guest_file_type_and_copied_bytes(self):
        report = b'Order ID,Status\nORD-1001,Shipped\n'
        settings = ('/tmp/orders.csv', 'fixture', Path('password-file'), '', '')
        operations = []

        def execute(args, **kwargs):
            operations.append(args[3])
            if args[3] == 'stat':
                return SimpleNamespace(returncode=0, stdout=f'  Size: {len(report)} Alloc: 4096 Type: file\n')
            self.assertIn('--no-replace', args)
            Path(args[-1]).write_bytes(report)
            return SimpleNamespace(returncode=0, stdout='')

        self.assertEqual(scratch_artifact_hash(self.VM, settings, execute=execute),
                         hashlib.sha256(report).hexdigest())
        self.assertEqual(operations, ['stat', 'copyfrom'])
        with self.assertRaisesRegex(ValueError, 'regular file'):
            scratch_artifact_hash(self.VM, settings, execute=lambda *a, **k:
                                  SimpleNamespace(returncode=0, stdout='Size: 1 Alloc: 1 Type: symlink\n'))
