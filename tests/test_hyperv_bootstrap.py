"""Pure/mocked Hyper-V bootstrap checks; no Windows or hypervisor access."""
import sys
import tempfile
import unittest
import subprocess
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'backends/packer'))
import templates
import runner
from hyperv_bootstrap import host_ipv4,bootstrap_origin,requested_host

class HyperVBootstrapTests(unittest.TestCase):
    def test_explicit_host_precedence_and_validation(self):
        self.assertEqual(requested_host({'bootstrap_host':'172.20.1.1'},{'VAMP_PACKER_BOOTSTRAP_HOST':'192.168.2.1'}),'172.20.1.1')
        self.assertEqual(requested_host({}, {'VAMP_PACKER_BOOTSTRAP_HOST':'192.168.2.1'}),'192.168.2.1')
        self.assertIsNone(requested_host({},{}))
        for value in ['', '8.8.8.8', '127.0.0.1', 'bad;host']:
            with self.assertRaises(ValueError):requested_host({'bootstrap_host':value},{})
    def test_exact_switch_and_unambiguous_address(self):
        data={'switch':'QA','host_ipv4':'172.20.1.1','host_ipv4_candidates':['172.20.1.1']}
        self.assertEqual(host_ipv4(data,'QA'),'172.20.1.1')
        for update in ({'switch':'wrong'},{'host_ipv4_candidates':[]},{'host_ipv4_candidates':['172.20.1.1','172.20.1.2']},{'host_ipv4':'172.20.1.2'}):
            with self.assertRaises(ValueError):host_ipv4(data|update,'QA')
    def test_preflight_reads_only_the_selected_switch_and_preserves_ip(self):
        data={'switch':'QA','host_ipv4':'172.20.1.1','host_ipv4_candidates':['172.20.1.1']}
        with tempfile.TemporaryDirectory() as tmp, patch.object(runner,'require_install_host'), patch.object(runner,'run',return_value=runner.json.dumps(data)) as probe, patch.object(runner,'names',side_effect=AssertionError('inventory called')):
            iso=Path(tmp)/'test.iso';iso.write_bytes(b'fixture')
            request={'backend':'hyperv','guest_os':'debian','iso_path':str(iso),'switch_name':'QA','preflight_only':True}
            result=runner.create(request)
            self.assertEqual(result['request']['bootstrap_host'],'172.20.1.1')
            self.assertIn('QA',probe.call_args.args[1])
            self.assertFalse(result['vm_created'])
            with self.assertRaisesRegex(ValueError,'no longer matches'):
                runner.create({**request,'bootstrap_host':'172.20.1.2'})
    def test_origin_rejects_missing_unsafe_or_injected_address(self):
        for url in ['http://127.0.0.1:8421','http://0.0.0.0:8421','http://169.254.1.2:8421','http://host:8421','http://172.20.1.1:8421/x','http://u@172.20.1.1:8421','http://172.20.1.1:8421?x=1']:
            with self.assertRaises(ValueError):bootstrap_origin(url)
    def render(self,folder,backend='hyperv',guest='debian'):
        request={'backend':backend,'guest_os':guest,'iso_path':str(folder/'test.iso'),'memory_mb':2048,'cpus':2,'disk_mb':65536}
        with patch.object(templates,'answer_iso'):
            return templates.render(request,folder,'0'*64,'http://172.20.1.1:8421','http://172.20.1.1:9999/complete/test')
    def test_preseed_bind_and_url_agree_download_failure_does_not_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp);text=self.render(folder).read_text()
            self.assertIn('http_bind_address = "172.20.1.1"',text)
            self.assertIn('preseed/url=http://172.20.1.1:{{ .HTTPPort }}',text)
            late=next(l for l in (folder/'http/preseed.cfg').read_text().splitlines() if l.startswith('d-i preseed/late_command'))
            self.assertIn('VAMP_BOOTSTRAP_HOST=172.20.1.1',late)
            command=late.split(' string ',1)[1]
            result=subprocess.run(['/bin/sh','-c','wget(){ return 9; }; sh(){ echo UNEXPECTED; }; '+command],capture_output=True,text=True)
            self.assertEqual(result.returncode,9);self.assertNotIn('UNEXPECTED',result.stdout)
    def test_windows_download_staging_and_failure_before_callback(self):
        s=templates.windows_postinstall('http://172.20.1.1:8421','http://172.20.1.1:9999/complete/test','hyperv')
        self.assertIn("$env:VAMP_BOOTSTRAP_HOST='172.20.1.1'",s)
        self.assertIn('-TimeoutSec 60 -ErrorAction Stop',s)
        self.assertLess(s.index('Bootstrap script download is empty'),s.index('   & $entry'))
        self.assertLess(s.index('completion was not reported'),s.index('-Method POST'))
    def test_virtualbox_render_keeps_previous_httpip_and_download_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp);text=self.render(folder,'virtualbox').read_text()
            self.assertIn('{{ .HTTPIP }}',text);self.assertNotIn('http_bind_address',text)
            self.assertNotIn('VAMP_BOOTSTRAP_HOST',(folder/'http/preseed.cfg').read_text())
        self.assertNotIn('VAMP_BOOTSTRAP_HOST',templates.windows_postinstall('http://10.0.2.2:8421','http://10.0.2.2:9999/complete/test'))
    def test_runner_scopes_hyperv_listeners_and_cleans_up(self):
        text=(ROOT/'backends/packer/runner.py').read_text()
        self.assertIn("host if request['backend']=='hyperv' else '0.0.0.0'",text)
        self.assertIn("make_server(Path(staged['directory']),8421,host,10800)",text)
        self.assertIn('if bootstrap_server:bootstrap_server.shutdown();bootstrap_server.server_close()',text)
        self.assertIn("host=resolve_kvm_bootstrap_host(request)",text)
if __name__=='__main__':unittest.main()
