import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from mcp_vm.controller import VMController
from rpa_package import ROOT


class MCPControllerTests(unittest.TestCase):
    def controller(self):return VMController(ROOT/'config/vm-mcp.json')

    def test_guest_os_profile_blocks_debian_update_on_windows(self):
        controller=self.controller()
        with patch.object(controller,'profile',return_value=(controller.config['vms']['windows-RPA'],'spice://example:5900')), \
             patch.object(controller,'command') as execute:
            with self.assertRaises(ValueError):controller.run_rpa('windows-RPA','debian_update')
            execute.assert_not_called()

    def test_caller_cannot_override_spice_uri_or_pass_password_variable(self):
        controller=self.controller()
        for variables in [{'SPICE_URI':'spice://other:5900'},{'NAVER_PASSWORD':'private'}]:
            with self.subTest(variables=list(variables)),patch.object(controller,'command') as execute:
                with self.assertRaises(ValueError):controller.run_rpa('debian13','naver_login',variables=variables)
                execute.assert_not_called()

    def test_evidence_cannot_read_config_or_escape_artifacts(self):
        controller=self.controller()
        for path in ['config/sandbox-vm.json','artifacts/../config/sandbox-vm.json']:
            with self.assertRaises(ValueError):controller.read_evidence(path)

    def test_evidence_is_paged_and_filters_before_paging(self):
        controller=self.controller()
        with tempfile.TemporaryDirectory(dir=ROOT/'artifacts') as directory:
            path=Path(directory)/'ocr.json'
            path.write_text(json.dumps([{'text':str(i)+' login','confidence':.99,'xyxy':[0,0,10,10]} for i in range(15)]))
            result=controller.read_evidence(str(path),offset=2,limit=3,query='login')
            self.assertEqual(result['total'],15)
            self.assertEqual([item['text'] for item in result['items']],['2 login','3 login','4 login'])
            with self.assertRaises(ValueError):controller.read_evidence(str(path),limit=100)

    def test_hyperv_does_not_launch_on_linux(self):
        controller=self.controller()
        with patch('mcp_vm.controller.sys.platform','linux'),patch.object(controller,'command') as execute:
            self.assertEqual(controller.hyperv_console('VM')['status'],'unsupported_host')
            execute.assert_not_called()
