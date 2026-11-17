"""Universal SSH provisioning for Packer-built Debian and Windows guests."""
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'backends/packer'))
import templates


class DebianSshTests(unittest.TestCase):
    def test_preseed_installs_the_openssh_server(self):
        text=(ROOT/'guest_setup/http/debian-preseed.cfg').read_text()
        include=[line for line in text.splitlines() if line.startswith('d-i pkgsel/include')]
        self.assertEqual(len(include),1,include)
        self.assertIn('openssh-server',include[0].split())

    def test_rendered_preseed_always_carries_ssh_even_when_the_seed_is_customized(self):
        text='d-i passwd/username string vboxuser\nd-i pkgsel/include string sudo python3\nd-i preseed/late_command string echo old\n'
        rendered=templates.ensure_openssh_preseed(text)
        include=[line for line in rendered.splitlines() if line.startswith('d-i pkgsel/include')]
        self.assertEqual(include,['d-i pkgsel/include string sudo python3 openssh-server'])
        self.assertNotIn('late_command',rendered)
        # Re-rendering the shipped seed must not duplicate the package.
        shipped=templates.ensure_openssh_preseed((ROOT/'guest_setup/http/debian-preseed.cfg').read_text())
        self.assertEqual(shipped.count('openssh-server'),1)
        # A seed without a package line still gets one.
        self.assertIn('d-i pkgsel/include string openssh-server',templates.ensure_openssh_preseed('d-i time/zone string UTC\n'))

    def test_debian_template_renders_the_ssh_seed_and_postinstall(self):
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory)/'build';folder.mkdir()
            iso=Path(directory)/'debian.iso';iso.write_bytes(b'iso')
            templates.render({'backend':'kvm','guest_os':'debian','iso_path':str(iso),'cpus':2,'memory_mb':4096,'disk_mb':32768},
                             folder,'0'*64,'http://10.0.2.2:8421','http://10.0.2.2:9999/complete/token')
            seed=(folder/'http/preseed.cfg').read_text()
            self.assertIn('openssh-server',seed)
            self.assertIn('postdeb.sh',seed)
            post=(ROOT/'guest_setup/http/postdeb.sh').read_text()
            self.assertIn('apt-get install -y openssh-server',post)
            self.assertIn('systemctl enable "$ssh_unit"',post)
            self.assertIn('NOPASSWD:ALL',post)
            for account in ('vboxuser','vagrant'):
                self.assertIn(account,post)
            self.assertEqual(subprocess.run(['sh','-n',str(ROOT/'guest_setup/http/postdeb.sh')],capture_output=True).returncode,0)


class WindowsSshTests(unittest.TestCase):
    def setUp(self):
        self.post=(ROOT/'guest_setup/http/postwin.ps1').read_text()

    def test_guest_setup_installs_and_enables_openssh_server(self):
        self.assertIn("Add-WindowsCapability -Online -Name $capability.Name",self.post)
        self.assertIn("Get-WindowsCapability -Online -Name 'OpenSSH.Server*'",self.post)
        self.assertIn("Set-Service -Name sshd -StartupType Automatic",self.post)
        self.assertIn("Start-Service sshd",self.post)
        self.assertIn("New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP'",self.post)
        self.assertIn("-LocalPort 22",self.post)
        self.assertIn("HKLM:\\SOFTWARE\\OpenSSH",self.post)
        self.assertIn("Name DefaultShell",self.post)
        self.assertIn('WindowsPowerShell\\v1.0\\powershell.exe',self.post)
        # SSH must be in place before the bundle download, not gated behind it.
        self.assertLess(self.post.index('Set-Service -Name sshd'),self.post.index('vamp-guest-setup.zip'))

    def test_first_logon_orchestrator_verifies_the_ssh_server(self):
        script=templates.windows_postinstall('http://10.0.2.2:8421','http://10.0.2.2:9999/complete/token','virtualbox')
        self.assertIn('postwin.ps1',script)
        self.assertIn('OpenSSH Server service is missing',script)
        self.assertIn("Name DefaultShell",script)
        self.assertIn("OpenSSH-Server-In-TCP",script)
        # The check runs after the driver reboot, on the pass that finishes the image.
        self.assertLess(script.index('drivers-installed.json'),script.index('OpenSSH Server service is missing'))

    def test_windows_template_writes_the_ssh_aware_postinstall(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(templates,'answer_iso'):
            folder=Path(directory)/'build';folder.mkdir()
            iso=Path(directory)/'windows.iso';iso.write_bytes(b'iso')
            templates.render({'backend':'virtualbox','guest_os':'windows11','iso_path':str(iso),'cpus':2,'memory_mb':4096,'disk_mb':65536,'windows_confirmed':True},
                             folder,'0'*64,'http://10.0.2.2:8421','http://10.0.2.2:9999/complete/token')
            script=(folder/'vamp-postinstall.ps1').read_text()
            self.assertIn('OpenSSH Server service is missing',script)
            self.assertIn('postwin.ps1',script)


if __name__=='__main__':
    unittest.main()
