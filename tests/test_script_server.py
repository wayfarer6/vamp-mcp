import json
from pathlib import Path
import shutil
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile

from scripts import script_server

ROOT=Path(__file__).resolve().parents[1]

class ScriptServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.previous=script_server.os.environ.get('VAMP_SCRIPT_SERVER_DIR')
        script_server.os.environ['VAMP_SCRIPT_SERVER_DIR']=str(self.root/'state')
        self.addCleanup(self.restore_env)
        self.staged=script_server.stage(ROOT/'guest_setup',self.root/'stage')

    def restore_env(self):
        if self.previous is None:script_server.os.environ.pop('VAMP_SCRIPT_SERVER_DIR',None)
        else:script_server.os.environ['VAMP_SCRIPT_SERVER_DIR']=self.previous

    def test_windows_checkout_shells_are_normalized_in_http_and_archives(self):
        import tarfile
        self.assertNotIn(b'\r', (self.root/'stage/postdeb.sh').read_bytes())
        self.assertIn(b'/etc/systemd/system/display-manager.service',(self.root/'stage/postdeb.sh').read_bytes())
        with tarfile.open(self.root/'stage/vamp-guest-setup.tar.gz') as archive:
            for member in archive.getmembers():
                if member.isfile() and member.name.endswith('.sh'):
                    self.assertNotIn(b'\r',archive.extractfile(member).read(),member.name)

    def test_stage_places_bootstraps_bundles_and_manifest(self):
        files=set(self.staged['files'])
        for name in ('debian-preseed.cfg','setup.sh','setup.ps1','setup-all.ps1','setup-win.cmd','postdeb.sh','postwin.ps1',
                     'vamp-guest-setup.tar.gz','vamp-guest-setup.zip','vamp-setup.json',
                     'recorder/setup.sh','recorder/recorder.zip','vault/setup-guest-vault.sh'):
            self.assertIn(name,files)
        manifest=json.loads((self.root/'stage/vamp-setup.json').read_text())
        self.assertEqual(manifest['port'],8421)
        self.assertIn('8421',manifest['commands']['debian_recorder'])
        self.assertEqual(manifest['guest_hosts']['virtualbox_nat'],'10.0.2.2')
        self.assertGreater(manifest['bundles']['zip']['bytes'],0)

    def test_bundle_contains_the_recorder_payload(self):
        with zipfile.ZipFile(self.root/'stage/vamp-guest-setup.zip') as archive:
            names=set(archive.namelist())
        self.assertIn('recorder/setup.sh',names)
        self.assertIn('recorder/recorder.zip',names)
        self.assertIn('vault/setup-guest-vault.ps1',names)

    def test_fixed_default_port_is_8421(self):
        self.assertEqual(script_server.SCRIPT_SERVER_PORT,8421)
        self.assertEqual(script_server.guest_commands()['base_url'],'http://10.0.2.2:8421')

    def test_server_serves_setup_and_hides_listings(self):
        server=script_server.make_server(Path(self.staged['directory']),port=0,bind='127.0.0.1',ttl=0)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(lambda:(server.shutdown(),server.server_close(),thread.join(timeout=5)))
        port=server.server_address[1]
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/healthz',timeout=5) as response:
            health=json.loads(response.read())
        self.assertEqual(health['service'],'vamp-script-server')
        self.assertEqual(health['port'],port)
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/setup.sh',timeout=5) as response:
            body=response.read().decode()
        self.assertIn('vamp-guest-setup.tar.gz',body)
        self.assertIn('8421',body)
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/',timeout=5) as response:
            self.assertEqual(json.loads(response.read())['port'],8421)
        for path in ('/recorder/','/../etc/passwd'):
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(f'http://127.0.0.1:{port}{path}',timeout=5)
            self.assertEqual(error.exception.code,404)

    def test_windows_bootstrap_downloads_the_zip_bundle(self):
        text=(self.root/'stage/setup.ps1').read_text()
        self.assertIn("vamp-guest-setup.zip",text)
        self.assertIn('Invoke-WebRequest',text)
        self.assertIn("recorder/setup.ps1",text)

    def test_committed_recorder_bundle_carries_the_program(self):
        # recorder.zip is committed so a clean checkout and the published
        # packages can stage guest setup without third_party sources.
        bundle=ROOT/'guest_setup/recorder/recorder.zip'
        self.assertTrue(bundle.is_file())
        with zipfile.ZipFile(bundle) as archive:
            names=set(archive.namelist())
            self.assertIn('PyAutoGuiRecorder.py',names)
            self.assertIn('LICENSE',names)
            self.assertEqual(archive.read('PyAutoGuiRecorder.py').replace(b'\r\n',b'\n'),
                             (ROOT/'third_party/pyautogui-recorder/PyAutoGuiRecorder.py').read_bytes().replace(b'\r\n',b'\n'))

    def test_stage_survives_a_copy_without_recorder_sources(self):
        clean=self.root/'clean'
        shutil.copytree(ROOT/'guest_setup',clean/'guest_setup')
        staged=script_server.stage(clean/'guest_setup',clean/'stage')
        self.assertIn('recorder/recorder.zip',staged['files'])
        self.assertTrue(script_server._recorder_zip_usable(clean/'stage/recorder/recorder.zip'))

    def test_recorder_bundle_downloads_when_nothing_is_local(self):
        server=script_server.make_server(Path(self.staged['directory']),port=0,bind='127.0.0.1',ttl=0)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(lambda:(server.shutdown(),server.server_close(),thread.join(timeout=5)))
        url=f"http://127.0.0.1:{server.server_address[1]}/recorder/recorder.zip"
        target=self.root/'downloaded/recorder.zip'
        script_server.download_recorder_zip(target,url)
        self.assertTrue(script_server._recorder_zip_usable(target))
        # A page that is not a zip must not be staged as a bundle.
        with self.assertRaises(RuntimeError):
            script_server.download_recorder_zip(self.root/'bad/recorder.zip',
                                                f"http://127.0.0.1:{server.server_address[1]}/setup.ps1")
        self.assertFalse((self.root/'bad/recorder.zip').exists())

if __name__=='__main__':
    unittest.main()
