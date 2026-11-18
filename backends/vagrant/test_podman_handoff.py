"""Mock-contract tests only: no Vagrant, archive, guest or existing runtime."""
import unittest
from podman_handoff import render_vagrantfile

class HandoffTests(unittest.TestCase):
    def options(self, provider='virtualbox'):
        metadata = {'provider': provider}
        if provider == 'libvirt':
            metadata.update(format='qcow2', virtual_size=64)
        return dict(provider=provider, metadata=metadata,
                    box_path='/build/debian-podman-' + provider + '.box',
                    box_sha256='a' * 64, private_key_path='/keys/deployment')

    def test_headless_providers(self):
        for provider in ('virtualbox', 'libvirt'):
            text = render_vagrantfile(**self.options(provider))
            self.assertIn("config.vm.provider '" + provider + "'", text)
            self.assertIn('config.ssh.insert_key = false', text)
            self.assertIn("config.ssh.username = 'vamp'", text)
            self.assertNotIn('provision', text)
            self.assertNotIn('public_network', text)
            self.assertNotIn('forwarded_port', text)
        self.assertIn("p.graphics_type = 'none'", render_vagrantfile(**self.options('libvirt')))

    def test_wrong_formats(self):
        for changes in ({'provider': 'kvm'}, {'metadata': {'provider': 'libvirt'}},
                        {'box_path': '/build/disk.qcow2'}, {'box_path': '/build/guest.ova'},
                        {'box_sha256': 'bad'}, {'cpus': True}, {'name': 'bad;name'}):
            with self.assertRaises(ValueError):
                render_vagrantfile(**(self.options() | changes))
        for metadata in ({'provider': 'libvirt', 'format': 'raw', 'virtual_size': 64},
                         {'provider': 'libvirt', 'format': 'qcow2', 'virtual_size': float('nan')}):
            with self.assertRaises(ValueError):
                render_vagrantfile(**(self.options('libvirt') | {'metadata': metadata}))

    def test_local_paths_only(self):
        for path in ('relative.box', 'https://host/x.box', '//host/x.box', '/build/../x.box', '/x\n.box'):
            with self.assertRaises(ValueError):
                render_vagrantfile(**(self.options() | {'box_path': path}))
        with self.assertRaises(ValueError):
            render_vagrantfile(**(self.options() | {'private_key_path': '/keys/insecure_private_key'}))

    def test_ruby_interpolation_literal(self):
        text = render_vagrantfile(**(self.options() | {'private_key_path': "/keys/#{not_code}'key"}))
        self.assertIn("['/keys/#{not_code}\\'key']", text)

    def test_windows_paths_and_content_identity(self):
        text = render_vagrantfile(**(self.options() | {'box_path': r'C:\build\guest.box'}))
        self.assertIn("box_url = 'C:/build/guest.box'", text)
        self.assertIn('podman-virtualbox-' + 'a' * 64, text)

if __name__ == '__main__':
    unittest.main()
