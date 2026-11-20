#!/usr/bin/env python3
"""Create a manually editable Robot/Python RPA package; never run a VM action."""
import argparse
import json
from pathlib import Path
import re

ROOT=Path(__file__).resolve().parents[1]


def create_package(package_id,guest_os='windows11',package_root=None):
    if not re.fullmatch('[a-z][a-z0-9_]*',package_id):raise ValueError('Use a lowercase snake_case package id')
    if guest_os not in ('windows11','debian'):raise ValueError('Unsupported guest OS')
    target=(Path(package_root) if package_root else ROOT/'rpas')/package_id
    if target.exists():raise ValueError('Package exists; choose a new id instead of overwriting manual work')
    launcher=('super','r') if guest_os=='windows11' else ('alt','f2')
    manifest={'format_version':1,'id':package_id,'name':package_id,'version':'0.1.0',
        'default_entrypoint':'run','entrypoints':[{'name':'run','file':'run.robot','credentials':'none'}],
        'python_libraries':['workflow.py'],'dependencies':['spice'],'skill':'spice-vm-rpa',
        'outputs':{'summary':'${OUTPUT DIR}/summary.json','robot_log':'${OUTPUT DIR}/log.html',
                   'robot_report':'${OUTPUT DIR}/report.html'}}
    target.mkdir(parents=True)
    (target/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n', encoding='utf-8')
    (target/'workflow.py').write_text(f'''"""Edit detailed input, coordinates and verification here, not in host PyAutoGUI."""
from robot.api.deco import keyword,library
from robot.libraries.BuiltIn import BuiltIn


@library(scope='SUITE',auto_keywords=False)
class Workflow:
    @keyword
    def describe_unconfigured_workflow(self):
        return {{'status':'not_configured','guest_os':{guest_os!r},
                'message':'Implement steps and a positive verification before enabling replay.'}}

    @keyword
    def launch_program(self,command):
        # Called only after an explicit Spice.Connect Spice step in your Robot file.
        spice=BuiltIn().get_library_instance('Spice')
        spice.guest_hotkey({launcher[0]!r},{launcher[1]!r})
        spice._pump(1)
        spice.guest_write(command)
        spice.guest_hotkey('enter')
        # Add a bounded expected-state check; input dispatch is not application success.
''')
    (target/'run.robot').write_text(f'''*** Settings ***
Resource          ${{CURDIR}}/../common.resource
Library           ${{CURDIR}}/workflow.py    WITH NAME    Workflow
Suite Setup       Contract.Begin Result    ${{RPA_ID}}
Suite Teardown    Stop RPA
Task Teardown     Finish RPA Task

*** Variables ***
${{RPA_ID}}         {package_id}

*** Tasks ***
Run Manually Authored RPA
    # Add Spice.Connect Spice, Workflow.Launch Program and positive verification here.
    # Windows: Win+R; Debian GNOME: Alt+F2. Avoid desktop-icon coordinates.
    ${{result}}=    Workflow.Describe Unconfigured Workflow
    Contract.Publish Result    ${{result}}
    Skip    Implement and review your workflow before running VM input.
''')
    (target/'README.md').write_text(f'''# {package_id}\n\nManual RPA template for `{guest_os}`.\n\n- `run.robot`: sequence, branching and assertions.\n- `workflow.py`: Python SPICE/coordinate/vision behavior.\n- `manifest.json`: package metadata.\n- The default task returns `not_configured` and SKIPs without a VM connection.\n- Launch programs through {'Win+R' if guest_os=='windows11' else 'Alt+F2'}, not user-specific desktop icons.\n- Implement positive verification before reporting `succeeded`.\n- See [manual/conversion guide](../../docs/RECORDING_CONVERSION.md).\n''')
    return target


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('id')
    parser.add_argument('--guest-os',choices=['windows11','debian'],default='windows11')
    args=parser.parse_args()
    try:path=create_package(args.id,args.guest_os)
    except (ValueError,OSError) as error:parser.error(str(error))
    print(json.dumps({'status':'created_not_configured','rpa_id':args.id,'package_path':str(path)},indent=2))


if __name__=='__main__':main()
