import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'backends/packer'))
import toolchain
import templates
import images
import runner
import osinfo

class PackerTests(unittest.TestCase):
    def test_native_osinfo_xml_inherits_minima_and_selects_the_requested_guest(self):
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory)/'os/microsoft.com';folder.mkdir(parents=True)
            (folder/'parent.xml').write_text('<libosinfo><os id="win10"><short-id>win10</short-id><distro>win</distro><version>10</version><resources arch="all"><minimum><ram>4294967296</ram><n-cpus>2</n-cpus></minimum></resources></os></libosinfo>')
            (folder/'win11.xml').write_text('<libosinfo><os id="win11"><short-id>win11</short-id><distro>win</distro><version>11</version><derives-from id="win10"/><resources arch="x86_64"><minimum><storage>68719476736</storage></minimum></resources></os></libosinfo>')
            catalog=osinfo.database([Path(directory)])
            profile=osinfo.profile('windows11','installer.iso',catalog,detect=lambda _: {'OSINFO_OS_ID':'win11'})
            self.assertEqual(profile['short_id'],'win11');self.assertEqual(profile['minimum']['ram'],4294967296);self.assertEqual(profile['minimum']['storage'],68719476736)
            with self.assertRaisesRegex(ValueError,'does not match'):osinfo.profile('debian','installer.iso',catalog,detect=lambda _: {'OSINFO_OS_ID':'win11'})

    def test_virt_manager_xml_is_resolved_without_creating_a_probe_vm(self):
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory);code=folder/'OVMF_CODE.fd';variables=folder/'OVMF_VARS.fd';code.touch();variables.touch()
            xml='<domain><os><type machine="pc-q35-8.2">hvm</type><loader>'+str(code)+'</loader><nvram template="'+str(variables)+'"/></os><devices><disk><target bus="virtio"/></disk><interface><model type="virtio"/></interface><video><model type="virtio"/></video></devices></domain>'
            request={'guest_os':'debian','iso_path':'debian.iso','memory_mb':2048,'cpus':2,'disk_mb':32768}
            calls=[]
            with patch.object(osinfo,'profile',return_value={'short_id':'debian13','minimum':{},'recommended':{}}):
                result=osinfo.resolve(request,folder,execute=lambda args:(calls.append(args) or xml))
            self.assertIn('--dry-run',calls[0]);self.assertIn('--print-xml',calls[0]);self.assertEqual(result['machine'],'pc-q35-8.2');self.assertEqual(result['nic'],'virtio')
            self.assertFalse((folder/'profile-probe.qcow2').exists());self.assertTrue((folder/'virt-manager-profile.xml').exists())

    def test_host_distributions_are_pinned_and_unsupported_arch_is_explicit(self):
        for host,arch,key in [('win32','AMD64','windows_amd64'),('linux','x86_64','linux_amd64'),('darwin','arm64','darwin_arm64')]:
            self.assertEqual(toolchain.distribution(host,arch),key)
            self.assertEqual(len(toolchain.POLICY['checksums'][key]),64)
        with self.assertRaises(ValueError):toolchain.distribution('win32','arm64')

    def test_all_builders_share_installation_and_reboot_contract(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(templates,'answer_iso'):
            for backend in ['virtualbox','hyperv','kvm']:
                for guest in ['debian','windows11']:
                    folder=Path(directory)/(backend+'-'+guest);folder.mkdir()
                    iso=Path(directory)/'installer.iso';iso.write_bytes(b'iso')
                    request={'backend':backend,'guest_os':guest,'iso_path':str(iso),'cpus':2,'memory_mb':4096,'disk_mb':65536}
                    template=templates.render(request,folder,'0'*64,'http://10.0.2.2:8421','http://10.0.2.2:9999/complete/token')
                    source=template.read_text()
                    self.assertIn('communicator = "none"',source)
                    self.assertIn('shutdown_timeout = "2h"',source)
                    self.assertIn(toolchain.POLICY['plugins'][backend]['source'],source)
                    self.assertNotIn('iso_checksum = "none"',source)
                    if guest=='debian':
                        preseed=(folder/'http/preseed.cfg').read_text()
                        self.assertIn('VAMP_PACKER_CALLBACK=',preseed)
                        self.assertNotIn('exit/poweroff',preseed,'first desktop reboot must happen before finalization')
                    else:
                        self.assertIn('boot_wait = "1s"',source)
                        self.assertEqual(source.count('<enter><wait1>'),10)
                        ET.parse(folder/'Autounattend.xml')
                        self.assertIn('FirstLogonCommands',(folder/'Autounattend.xml').read_text())

    def test_windows_postlogin_wait_is_60_seconds_and_callback_follows_setup(self):
        answer=ET.fromstring(templates.windows_answer('http://host:8421','http://host:9999/complete/token',1))
        commandline=answer.find('.//{urn:schemas-microsoft-com:unattend}CommandLine').text
        self.assertLessEqual(len(commandline),1024)
        self.assertIn('vamp-postinstall.ps1',commandline)
        command=templates.windows_postinstall('http://host:8421','http://host:9999/complete/token')
        self.assertIn('Start-Sleep -Seconds 60',command)
        self.assertLess(command.index('& $entry'),command.index('-Method POST'))
        self.assertLess(command.index('-Method POST'),command.index('shutdown.exe /s'))

    def test_debian_autologin_is_idempotent_and_preserves_other_sections(self):
        spec=importlib.util.spec_from_file_location('gdm_config',ROOT/'guest_setup/recorder/configure-gdm.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/'daemon.conf';file.write_text('[daemon]\n#AutomaticLoginEnable=false\n[security]\nDisallowTCP=true\n')
            module.configure(file);first=file.read_text();module.configure(file)
            self.assertEqual(file.read_text(),first)
            self.assertEqual(first.count('AutomaticLoginEnable=true'),1)
            self.assertIn('AutomaticLogin=vboxuser',first)
            self.assertIn('DisallowTCP=true',first)
        script=(ROOT/'guest_setup/http/postdeb.sh').read_text()
        self.assertIn('sleep 60',script)
        self.assertIn('test -S "/run/user/$uid/bus"',script)

    def test_golden_inventory_delete_cannot_touch_live_vm_disk(self):
        with tempfile.TemporaryDirectory() as directory,patch.dict(os.environ,{'VAMP_HOME':directory}):
            image_id='a'*32;folder=images.directory(image_id);folder.mkdir(parents=True)
            (folder/'image.json').write_text(json.dumps({'status':'completed','name':'fixture'}))
            artifact=folder/'artifact';artifact.mkdir();(artifact/'disk.qcow2').write_bytes(b'golden')
            live=Path(directory)/'vms/kvm/fixture/disk.qcow2';live.parent.mkdir(parents=True);live.write_bytes(b'live')
            rows=images.list_images();self.assertEqual(rows[0]['files'][0]['path'],str(artifact/'disk.qcow2'))
            pending=images.delete(image_id);self.assertEqual(pending['status'],'needs_confirmation');self.assertTrue(folder.exists())
            images.delete(image_id,True);self.assertFalse(folder.exists());self.assertEqual(live.read_bytes(),b'live')
            with self.assertRaises(ValueError):images.delete('../vms',True)

    def test_active_build_cannot_be_deleted(self):
        with tempfile.TemporaryDirectory() as directory,patch.dict(os.environ,{'VAMP_HOME':directory}):
            folder=images.directory('b'*32);folder.mkdir(parents=True);(folder/'image.json').write_text('{"status":"building"}')
            with self.assertRaisesRegex(ValueError,'finish'):images.delete('b'*32,True)

    def test_preflight_has_no_download_or_hypervisor_side_effect(self):
        with tempfile.TemporaryDirectory() as directory,patch.dict(os.environ,{'VAMP_HOME':directory}),patch.object(runner,'names',side_effect=AssertionError('hypervisor called')):
            iso=Path(directory)/'installer.iso';iso.write_bytes(b'iso')
            result=runner.create({'backend':'virtualbox','guest_os':'debian','iso_path':str(iso),'preflight_only':True})
            self.assertEqual(result['status'],'preflight_ready');self.assertFalse((Path(directory)/'golden').exists())

if __name__=='__main__':unittest.main()
