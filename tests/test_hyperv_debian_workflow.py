import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
import uuid

from backends.packer.hyperv_debian import require_host_tools, require_network, run_build


class HyperVDebianTest(unittest.TestCase):
    def test_missing_answer_media_dependency_is_reported_at_preflight(self):
        with patch('backends.packer.hyperv_debian.importlib.util.find_spec', return_value=None):
            with self.assertRaisesRegex(ValueError, 'missing pycdlib'):
                require_host_tools()

    def test_dhcp_free_build_verifies_provisioning_after_reload(self):
        for ssh_ok in (True, False):
            with self.subTest(ssh_ok=ssh_ok), TemporaryDirectory() as temp:
                root = Path(temp)
                folder, assets, live = (root / name for name in ('golden', 'assets', 'live'))
                source = assets / 'backends/packer/debian-hyperv'
                source.mkdir(parents=True)
                (source / 'Vagrantfile').touch()
                folder.mkdir()
                job = folder / 'offline'
                vm_id = str(uuid.uuid4())
                profile = {
                    'switch': 'QA-Switch', 'guest_ip': '192.168.100.51/24',
                    'gateway': '192.168.100.1', 'dns': '1.1.1.1',
                    'dvd_sha256': 'a' * 64, 'hyperv_daemons_sha256': 'b' * 64,
                    'ssh_private_key': 'fixture-key', 'hyperv_daemons_deb': 'fixture.deb',
                }
                request = {'name': 'QA-VM', 'iso_path': 'fixture.iso', 'hyperv_debian': profile,
                           'memory_mb': 2048, 'cpus': 2, 'disk_mb': 32768}
                calls, states = [], []

                def execute(args, **kwargs):
                    calls.append(args)
                    if Path(args[1]).name == 'prepare.py':
                        self.assertEqual(args[args.index('--guest-ip') + 1], profile['guest_ip'])
                        (job / 'export').mkdir(parents=True)
                        (job / 'deployment.json').write_text('{}')
                        (job / 'provision').mkdir()
                    elif args[1] == 'up':
                        identity = live / '.vagrant/machines/default/hyperv/id'
                        identity.parent.mkdir(parents=True)
                        identity.write_text(vm_id)
                    elif args[1] == 'ssh' and not ssh_ok:
                        raise subprocess.CalledProcessError(1, args)

                def build():
                    return run_build(request, folder, live, assets, lambda: 'packer',
                                     lambda *args: None, dict, lambda: root,
                                     lambda **state: states.append(state))

                with patch.dict(os.environ, VAGRANT_PATH='vagrant'), patch(
                    'backends.packer.hyperv_debian.subprocess.run', side_effect=execute,
                ):
                    if ssh_ok:
                        self.assertEqual(build()['vm_id'], vm_id)
                        self.assertEqual(json.loads((live / 'vamp-ui.json').read_text())['id'], vm_id)
                    else:
                        with self.assertRaises(subprocess.CalledProcessError):
                            build()
                        self.assertFalse((live / 'vamp-ui.json').exists())
                self.assertEqual([args[1] for args in calls[-3:]], ['up', 'reload', 'ssh'])
                self.assertIn('/var/lib/vamp/guest-setup.complete', calls[-1][-1])
                self.assertTrue((folder / 'artifact').is_dir())
                self.assertTrue((live / 'provision').is_dir())
                metadata = json.loads((live / 'deployment.json').read_text())
                self.assertEqual(metadata['ssh_private_key'], profile['ssh_private_key'])
                self.assertEqual(states[-1]['stage'], 'verify_static_ip_after_reboot')

    def test_requires_gateway_on_an_internal_switch(self):
        profile = {'gateway': '192.168.100.1', 'guest_ip': '192.168.100.51/24'}
        network = {'host_ipv4': '192.168.100.1', 'switch_type': 'Internal', 'prefix_length': 24}
        require_network(profile, network)
        with self.assertRaisesRegex(ValueError, 'dedicated internal switch'):
            require_network(profile, {**network, 'switch_type': 'External'})
        with self.assertRaisesRegex(ValueError, 'subnet prefix'):
            require_network(profile, {**network, 'prefix_length': 25})
