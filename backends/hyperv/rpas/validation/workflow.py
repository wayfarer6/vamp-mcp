"""Run native Hyper-V integration checks from an elevated Windows lab session."""
import base64
import json
from pathlib import Path
import subprocess
import sys
from robot.api.deco import keyword, library
from robot.libraries.BuiltIn import BuiltIn

@library(scope='SUITE',auto_keywords=False)
class Workflow:
    def _powershell(self,script):
        if sys.platform!='win32':raise RuntimeError('Run these scenarios on the Windows lab host')
        encoded=base64.b64encode(("$ErrorActionPreference='Stop';\n"+script).encode('utf-16le')).decode()
        result=subprocess.run(['powershell.exe','-NoProfile','-EncodedCommand',encoded],capture_output=True,text=True,timeout=180)
        if result.returncode:raise AssertionError(result.stderr[-1500:])
        return json.loads(result.stdout)

    @keyword
    def verify_nested_host_resources(self):
        result=self._powershell('''
$c=@(Get-CimInstance Win32_Processor)
$m=(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
$enabled=(Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All).State -eq 'Enabled'
$null=Get-VMHost
@{sockets=$c.Count;cores=($c|Measure-Object NumberOfCores -Sum).Sum;logical_processors=($c|Measure-Object NumberOfLogicalProcessors -Sum).Sum;memory_bytes=$m;hyperv_enabled=$enabled} | ConvertTo-Json -Compress
''')
        assert result['sockets']==1,result
        assert result['cores']==8 and result['logical_processors']==8,result
        assert 7.5*1024**3<=result['memory_bytes']<=8.1*1024**3,result
        assert result['hyperv_enabled'],result
        self._save('host-resources',result)
        return result

    @keyword
    def verify_exact_nested_vm(self,vm_name):
        # JSON/base64 data transport keeps user VM names out of executable source.
        encoded=base64.b64encode(vm_name.encode()).decode()
        result=self._powershell("$n=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+encoded+"'));"+'''
$v=@(Get-VM | Where-Object Name -ceq $n)
if($v.Count -ne 1){throw 'Expected exactly one matching VM'}
if($v[0].State -ne 'Running'){throw 'Nested VM must be running'}
@{name=$v[0].Name;state=[string]$v[0].State;generation=$v[0].Generation;id=$v[0].Id.ToString()} | ConvertTo-Json -Compress
''')
        self._save('nested-vm',result)
        return result

    @keyword
    def open_actual_vmconnect(self,vm_name):
        import importlib.util
        path=Path(__file__).resolve().parents[2]/'scripts/vmconnect.py'
        spec=importlib.util.spec_from_file_location('lab_vmconnect',path)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        output=Path(BuiltIn().get_variable_value('${OUTPUT DIR}'))/'vmconnect-result.json'
        result=module.open_console(vm_name,output=output)
        assert result['status']=='launch_requested',result
        return result

    def _save(self,name,result):
        output=Path(BuiltIn().get_variable_value('${OUTPUT DIR}'));output.mkdir(parents=True,exist_ok=True)
        (output/(name+'.json')).write_text(json.dumps(result,indent=2))
