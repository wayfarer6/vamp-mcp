import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from mcp_vm.provision import create

class ProvisionTests(unittest.TestCase):
    def test_automated_debian_boots_the_stock_iso_without_xorriso(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'debian.iso';source.write_text('iso')
            class Controller:
                config={'vms':{},'libvirt_uri':'qemu:///session'}
                config_path=root/'config.json'
                jobs_root=root/'jobs'
                locks={}
                commands=[]
                def virsh(self,*args):return ''
                def command(self,args,**kwargs):
                    self.commands.append([str(a) for a in args])
                    return subprocess.CompletedProcess(args,0,'','')
            c=Controller()
            with patch('mcp_vm.provision.shutil.which', return_value=None):
                with self.assertRaisesRegex(ValueError, 'Install cpio'):
                    create(c,'auto-debian',iso_path=str(source),memory_mb=2048,cpus=2,disk_gb=20,guest_os='debian')
            self.assertFalse((root / 'vms').exists())
            self.assertEqual(c.commands, [])
            with patch('mcp_vm.provision.shutil.which', return_value='/usr/bin/cpio'):
                result=create(c,'auto-debian',iso_path=str(source),memory_mb=2048,cpus=2,disk_gb=20,guest_os='debian')
            install=next(command for command in c.commands if command[0]=='virt-install')
            location=install[install.index('--location')+1]
            self.assertEqual(location,f'{source},kernel=install.amd/vmlinuz,initrd=install.amd/initrd.gz')
            self.assertTrue(any(str(path).endswith('preseed.cfg') for path in install))
            self.assertNotIn('--import',install)
            self.assertFalse(any('xorriso' in ' '.join(command) or 'remaster_debian_setup' in ' '.join(command) for command in c.commands))
            self.assertEqual(result['status'],'installation_started')

    def test_nested_windows_uses_one_socket_eight_cores_and_agent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'source.qcow2';source.touch()
            class Controller:
                config={'vms':{},'libvirt_uri':'qemu:///session'}
                config_path=root/'config.json'
                jobs_root=root/'jobs'
                locks={}
                commands=[]
                def virsh(self,*args):return ''
                def command(self,args,**kwargs):
                    self.commands.append([str(a) for a in args])
                    return subprocess.CompletedProcess(args,0,json.dumps({'format':'qcow2','virtual-size':64*1024**3}) if args[1]=='info' else '', '')
            c=Controller()
            result=create(c,'nested-test',image_path=str(source),memory_mb=8192,cpus=8,disk_gb=64,guest_os='windows11',nested_virtualization=True)
            command=c.commands[-1]
            self.assertEqual(command[command.index('--vcpus')+1],'8,sockets=1,cores=8,threads=1')
            self.assertIn(',migratable=off,require=',command[command.index('--cpu')+1])
            self.assertIn('unix,target.type=virtio,target.name=org.qemu.guest_agent.0',command)
            self.assertEqual(result['cpu_topology'],{'sockets':1,'cores':8,'threads':1})
            # Validate the generated options against installed virt-install, without starting a VM.
            subprocess.run(['qemu-img','create','-f','qcow2',result['disk_path'],'64G'],check=True,capture_output=True)
            command += ['--dry-run','--print-xml']
            # The command uses a synthetic disk that virt-install is allowed to create in dry-run.
            result=subprocess.run(command,capture_output=True,text=True,timeout=30)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertIn("cores=\"8\"",result.stdout.replace("'",'"'))
            import xml.etree.ElementTree as ET
            xml=ET.fromstring(result.stdout)
            video=xml.find('devices/video/model')
            self.assertEqual(video.get('vram'),'65536')
            self.assertEqual(video.find('resolution').attrib,{'x':'1920','y':'1080'})
