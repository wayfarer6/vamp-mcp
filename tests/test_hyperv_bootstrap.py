"""Pure/mocked Hyper-V bootstrap checks; no Windows or hypervisor access."""
import sys
import json
from contextlib import ExitStack
import tempfile
import unittest
import subprocess
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'backends/packer'))
import templates
import runner
import hyperv_bootstrap
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
        data={'switches':[{'Name':'QA','Type':'Internal'}],'addresses':[{'InterfaceAlias':'vEthernet (QA)','IPAddress':'172.20.1.1'}],'execution_policy':'RemoteSigned'}
        with tempfile.TemporaryDirectory() as tmp, patch.object(runner,'require_install_host'), patch.object(runner,'run',return_value=runner.json.dumps(data)) as probe, patch.object(runner,'names',side_effect=AssertionError('inventory called')):
            iso=Path(tmp)/'test.iso';iso.write_bytes(b'fixture')
            request={'backend':'hyperv','guest_os':'debian','iso_path':str(iso),'switch_name':'QA','preflight_only':True}
            result=runner.create(request)
            self.assertEqual(result['request']['bootstrap_host'],'172.20.1.1')
            self.assertEqual(probe.call_args.args[1],['-NoProfile','-NonInteractive','-Command',hyperv_bootstrap.NETWORK_QUERY])
            self.assertFalse(result['vm_created'])
            with self.assertRaisesRegex(ValueError,'not a usable address'):
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
class HyperVReadOnlyPreflightTests(unittest.TestCase):
    @staticmethod
    def probe(policy='Restricted'):
        return {'switches':[{'Name':'Default Switch','Type':'Internal'}],
                'addresses':[{'InterfaceAlias':'vEthernet (Default Switch)','IPAddress':'172.20.1.1'}],
                'execution_policy':policy}

    def test_default_switch_fixed_cmdlets_no_script_or_policy_override(self):
        with patch.object(runner,'run',return_value=json.dumps(self.probe())) as execute:
            network=runner.hyperv_network({})
        self.assertEqual(network['switch'],'Default Switch')
        self.assertEqual(network['host_ipv4'],'172.20.1.1')
        args=execute.call_args.args
        self.assertEqual(args[0],'powershell.exe')
        self.assertEqual(args[1],['-NoProfile','-NonInteractive','-Command',hyperv_bootstrap.NETWORK_QUERY])
        self.assertEqual(execute.call_args.kwargs['timeout'],30)
        query=args[1][-1]
        self.assertIn('Get-VMSwitch',query);self.assertIn('Get-NetIPAddress',query)
        self.assertIn('Get-ExecutionPolicy',query)
        self.assertNotIn('-ExecutionPolicy',args[1])
        for forbidden in ['-File','Set-ExecutionPolicy','Invoke-Expression','EncodedCommand','Unblock-File','RunAs']:
            self.assertNotIn(forbidden,query)
        # Windows PowerShell 5.1-compatible array construction; no PS7 operators.
        self.assertIn('$switches=@(',query);self.assertIn('$addresses=@(',query)
        self.assertNotIn('??',query);self.assertNotIn('?.',query)

    def test_switch_names_stay_data_not_interpolated_commands(self):
        switch="QA '; Write-Output injected; '"
        probe=self.probe();probe['switches'][0]['Name']=switch
        probe['addresses'][0]['InterfaceAlias']='vEthernet ('+switch+')'
        with patch.object(runner,'run',return_value=json.dumps(probe)) as execute:
            result=runner.hyperv_network({'switch_name':switch})
        self.assertEqual(result['switch'],switch)
        self.assertNotIn(switch,execute.call_args.args[1][-1])
        for value in ['', '-bad', 'bad\nname', None]:
            with patch.object(runner,'run') as execute:
                with self.assertRaises(ValueError):runner.hyperv_network({'switch_name':value})
                execute.assert_not_called()

    def test_invalid_or_missing_probe_policy_and_addresses_fail_closed(self):
        for changes in ({'execution_policy':None},{'execution_policy':'unexpected'}, {'addresses':[]}, {'switches':[]}):
            with self.assertRaises(ValueError):hyperv_bootstrap.select_network(self.probe()|changes,'Default Switch')
        probe=self.probe();probe['addresses'].append({'InterfaceAlias':'vEthernet (Default Switch)','IPAddress':'172.20.1.2'})
        with self.assertRaises(ValueError):hyperv_bootstrap.select_network(probe,'Default Switch')
        selected=hyperv_bootstrap.select_network(probe,'Default Switch','172.20.1.2')
        self.assertEqual(selected['host_ipv4'],'172.20.1.2')
        with self.assertRaises(ValueError):hyperv_bootstrap.select_network(probe,'Default Switch','192.168.2.1')

    def guarded_create(self, request):
        # Every mutation boundary is a failing mock, including storage allocation.
        with ExitStack() as stack:
            stack.enter_context(patch.object(runner,'check_request',side_effect=lambda r:dict(r)))
            stack.enter_context(patch.object(runner,'run',return_value=json.dumps(self.probe())))
            for name in ['conflicts','names','home','directory','write']:
                stack.enter_context(patch.object(runner,name,side_effect=AssertionError('Unexpected mutation boundary: '+name)))
            stack.enter_context(patch.object(runner.subprocess,'Popen',side_effect=AssertionError('Unexpected worker spawn')))
            stack.enter_context(patch.object(Path,'mkdir',side_effect=AssertionError('Unexpected directory write')))
            return runner.create(request)

    def test_restricted_preflight_reports_blocked_without_mutation(self):
        result=self.guarded_create({'backend':'hyperv','guest_os':'debian','name':'QA','preflight_only':True})
        self.assertEqual(result['status'],'preflight_ready')
        self.assertTrue(result['deployment_blocked']);self.assertFalse(result['vm_created'])
        self.assertEqual(result['windows_execution_policy'],'Restricted')
        self.assertEqual(result['request']['bootstrap_host'],'172.20.1.1')

    def test_restricted_creation_fails_before_any_mutation(self):
        for guest in ['debian','windows11']:
            with self.assertRaisesRegex(ValueError,'Restricted'):
                self.guarded_create({'backend':'hyperv','guest_os':guest,'name':'QA','windows_confirmed':True})

    def test_windows_license_gate_does_not_probe_or_mutate(self):
        with patch.object(runner,'check_request',side_effect=lambda r:r),patch.object(runner,'run',side_effect=AssertionError('No probe expected')):
            result=runner.create({'backend':'hyperv','guest_os':'windows11','name':'QA'})
        self.assertEqual(result['status'],'needs_windows_confirmation');self.assertFalse(result['vm_created'])

    def test_read_only_cim_failure_remains_failure_without_fallback(self):
        failure=subprocess.CalledProcessError(1,'powershell.exe',stderr='CIM access denied')
        with patch.object(runner,'run',side_effect=failure) as execute:
            with self.assertRaisesRegex(RuntimeError,'CIM access denied'):runner.hyperv_network({})
        self.assertEqual(execute.call_count,1)

if __name__=='__main__':unittest.main()
