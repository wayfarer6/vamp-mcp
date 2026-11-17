"""Run the first-logon orchestrator against a stub bundle, without host setup."""
import json
import importlib.util
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
import zipfile

ROOT=Path(__file__).resolve().parents[1]


@unittest.skipUnless(sys.platform=='win32','Windows PowerShell orchestration test')
class WindowsPostinstallTests(unittest.TestCase):
    def test_download_command_survives_virtualbox_batch_echo(self):
        spec=importlib.util.spec_from_file_location('windows_hook_provision',ROOT/'backends/virtualbox/provision.py')
        provision=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(provision)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'postwin.ps1').write_text("'done' | Set-Content (Join-Path $env:TEMP 'hook-complete')",encoding='utf8')
            class Handler(SimpleHTTPRequestHandler):
                def __init__(self,*args,**kwargs):
                    super().__init__(*args,directory=str(root),**kwargs)
                def log_message(self,*args):
                    pass
            server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
            thread=threading.Thread(target=server.serve_forever,daemon=True)
            thread.start()
            try:
                hook=provision.post_install_command('windows11',f'http://127.0.0.1:{server.server_port}')
                batch=root/'post.cmd'
                batch.write_bytes((f'@echo off\r\necho Running: "{hook}" > "{root / "hook.log"}"\r\n{hook}\r\n').encode())
                result=subprocess.run(['cmd.exe','/d','/c',str(batch)],capture_output=True,text=True,timeout=45,
                    env={**os.environ,'TEMP':str(root),'TMP':str(root)})
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertTrue((root/'hook-complete').exists(),result.stdout+result.stderr)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def run_hook(self, fail=False):
        temporary=tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root=Path(temporary.name)
        (root/'temp').mkdir()
        source=root/'bundle.zip'
        with zipfile.ZipFile(source,'w') as archive:
            setup="throw 'expected-test-failure'" if fail else "'configured' | Set-Content (Join-Path $env:TEMP 'setup-ran')"
            archive.writestr('recorder/setup.ps1',setup)
        quote=lambda value:"'"+str(value).replace("'","''")+"'"
        entry=root/'postwin-fixture.ps1'
        code=(ROOT/'guest_setup/http/postwin.ps1').read_text()
        code=code.replace('if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){','if($false){')
        code=code.replace('Set-ExecutionPolicy -Scope Process -ExecutionPolicy Unrestricted -Force','')
        entry.write_text(code,encoding='utf8')
        harness=root/'run.ps1'
        harness.write_text(
            "$ErrorActionPreference='Stop'\n"
            +f"$env:ProgramData={quote(root/'program-data')}\n"
            +f"$env:TEMP={quote(root/'temp')}\n"
            +f"$env:APPDATA={quote(root/'app-data')}\n"
            +"$env:USERNAME='test-guest'\n"
            +"function Invoke-WebRequest { param($Uri,$OutFile,[switch]$UseBasicParsing,$TimeoutSec) "
            +f"Copy-Item -LiteralPath {quote(source)} -Destination $OutFile }}\n"
            +f"& {quote(entry)}\n",
            encoding='utf8',
        )
        result=subprocess.run(['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',str(harness)],capture_output=True,text=True)
        state=json.loads((root/'program-data/RPA-Recorder-Setup/postinstall-result.json').read_text(encoding='utf-8-sig'))
        return root,result,state

    def test_first_login_executes_setup_without_another_login(self):
        root,result,state=self.run_hook()
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(state['status'],'completed')
        self.assertTrue((root/'temp/setup-ran').exists())
        self.assertFalse((root/'app-data/Microsoft/Windows/Start Menu/Programs/Startup/RPA-Recorder-Setup.cmd').exists())

    def test_setup_failure_cannot_be_reported_as_completed(self):
        _,result,state=self.run_hook(fail=True)
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(state['status'],'failed')
        self.assertIn('expected-test-failure',state['error'])
