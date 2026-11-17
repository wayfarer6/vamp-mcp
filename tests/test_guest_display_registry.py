"""Exercise direct registry updates with an in-memory PowerShell provider."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]

@unittest.skipUnless(sys.platform=='win32','PowerShell provider fixture')
class DisplayRegistryTests(unittest.TestCase):
    def test_backup_precedes_verified_size_overwrites_without_host_registry_access(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            script=(ROOT/'guest_setup/recorder/set-resolution-registry.ps1').read_text(encoding='utf-8-sig')
            script=script.replace('if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){','if($false){').replace('Set-ExecutionPolicy -Scope Process -ExecutionPolicy Unrestricted -Force','')
            entry=root/'fixture.ps1';entry.write_text(script,encoding='utf-8-sig')
            harness=root/'run.ps1'
            code=r'''$ErrorActionPreference='Stop'
$env:ProgramData='__ROOT__'
$global:written=@{}
function Get-ChildItem {param($LiteralPath,$ErrorAction)
 if($LiteralPath -like '*Configuration') { [pscustomobject]@{PSPath='profile';Name='HKEY_LOCAL_MACHINE\profile';PSChildName='profile'} }
 elseif($LiteralPath -eq 'profile') { [pscustomobject]@{PSPath='surface';Name='HKEY_LOCAL_MACHINE\profile\00';PSChildName='00'} }
 elseif($LiteralPath -eq 'surface') { [pscustomobject]@{PSPath='monitor';Name='HKEY_LOCAL_MACHINE\profile\00\00';PSChildName='00'} }
}
function Get-Item {param($LiteralPath)
 $key=New-Object PSObject
 $key | Add-Member ScriptMethod GetValueNames { @('PrimSurfSize.cx','PrimSurfSize.cy','ActiveSize.cx','ActiveSize.cy') }
 $key | Add-Member ScriptMethod GetValue {param($name) 1024}
 $key | Add-Member ScriptMethod GetValueKind {param($name) 'DWord'}
 $key
}
function New-ItemProperty {param($LiteralPath,$Path,$Name,$Value,$PropertyType,[switch]$Force)
 if($LiteralPath){
  if(-not @(Get-ChildItemBackup).Count){throw 'Backup must exist before registry writes'}
  $global:written[$LiteralPath+'|'+$Name]=$Value
 }
}
function Get-ChildItemBackup { [IO.Directory]::GetFiles((Join-Path $env:ProgramData 'VAMP\display-registry\backups'),'*.json') }
function Get-ItemPropertyValue {param($LiteralPath,$Name) $global:written[$LiteralPath+'|'+$Name]}
& '__ENTRY__'
$global:written | ConvertTo-Json | Set-Content -LiteralPath '__RESULT__'
'''
            for key,value in {'__ROOT__':root,'__ENTRY__':entry,'__RESULT__':root/'result.json'}.items():
                code=code.replace(key,str(value).replace("'","''"))
            harness.write_text(code,encoding='utf-8-sig')
            result=subprocess.run(['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',str(harness)],capture_output=True,text=True,timeout=30)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            changed=json.loads((root/'result.json').read_text(encoding='utf-8-sig'))
            self.assertEqual(sorted(changed.values()),[1080,1080,1920,1920])
            backup=next((root/'VAMP/display-registry/backups').glob('*.json'))
            before=json.loads(backup.read_text(encoding='utf-8-sig'))
            self.assertEqual(len(before),4)
            self.assertTrue(all(row['Value']==1024 and row['Kind']=='DWord' for row in before))
