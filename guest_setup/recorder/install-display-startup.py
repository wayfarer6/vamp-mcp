#!/usr/bin/env python3
"""Install a user-session full HD reset at EVERY login, not a one-time RunOnce."""
import json
import os
from pathlib import Path
import shutil
import shlex
import sys


def install(home=None,platform=None,python=None,desktop=None):
    platform=platform or sys.platform
    home=Path(home or Path.home());python=python or sys.executable
    if platform=='win32':
        base=Path(os.environ['LOCALAPPDATA'])/'VAMP/display'
        startup=Path(os.environ['APPDATA'])/'Microsoft/Windows/Start Menu/Programs/Startup'
    else:
        base=home/'.local/share/vamp/display';startup=home/'.config/autostart'
    base.mkdir(parents=True,exist_ok=True);startup.mkdir(parents=True,exist_ok=True)
    for name in ['apply-display.py','windows-display.py','gnome-display.py','session-policy.py','set-resolution-registry.ps1']:
        destination=base/name
        if destination.exists():destination.chmod(0o644)
        shutil.copyfile(Path(__file__).with_name(name),destination)
    command=base/'apply-display.py'
    if platform=='win32':
        gui=Path(python).with_name('pythonw.exe')
        interpreter=str(gui) if gui.is_file() else python
        launcher=startup/'VAMP-Display.cmd'
        launcher.write_text(f'@echo off\n"{interpreter}" "{command}" --output "{base / "result.json"}"\n')
    else:
        def quote(value):return '"'+str(value).replace('\\','\\\\').replace('"','\\"').replace('`','\\`').replace('$','\\$')+'"'
        launcher=startup/'vamp-display.desktop'
        launcher.write_text('[Desktop Entry]\nType=Application\nName=VAMP Display Setup (best effort)\n'
          +f'Exec={quote(python)} {quote(command)}\nTerminal=false\nX-GNOME-Autostart-enabled=true\nOnlyShowIn=GNOME;\n')
        (startup/'vamp-session.desktop').write_text('[Desktop Entry]\nType=Application\nName=VAMP Automation Session\n'
          +f'Exec={quote(python)} {quote(base/"session-policy.py")}\nTerminal=false\nX-GNOME-Autostart-enabled=true\nOnlyShowIn=GNOME;\n')
    if platform=='win32':
        desktop=Path(desktop or home/'Desktop');desktop.mkdir(parents=True,exist_ok=True)
        manual=desktop/'Set-Resolution-1920x1080.cmd'
        manual_script=desktop/'Set-Resolution-1920x1080.ps1'
        quote=lambda value:"'"+str(value).replace("'","''")+"'"
        manual_script.write_text("$ErrorActionPreference='Stop'\n"
          +"$p=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())\n"
          +"if(-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){ $c=Start-Process powershell.exe -Verb RunAs -ArgumentList ('-NoProfile -ExecutionPolicy Unrestricted -File \"'+$PSCommandPath+'\"') -Wait -PassThru; exit $c.ExitCode }\n"
          +"Set-ExecutionPolicy -Scope Process -ExecutionPolicy Unrestricted -Force\n"
          +f"& {quote(base/'set-resolution-registry.ps1')}\n"
          +"Write-Host 'Applying 1920x1080 to the guest display...'\n"
          +f'& {quote(python)} {quote(command)} --output {quote(base/"manual-result.json")}\n'
          +"if ($LASTEXITCODE -ne 0) { Write-Host 'The guest display driver could not apply Full HD. See the output above and check the display driver.'; exit $LASTEXITCODE }\n"
          +"Write-Host 'Resolution applied. Keep guest display scaling at 100%.'\n",encoding='utf-8-sig')
        manual.write_text('@echo off\npowershell.exe -NoProfile -ExecutionPolicy Unrestricted -File "%~dp0Set-Resolution-1920x1080.ps1"\necho Press any key to close this window.\npause >nul\n',encoding='ascii')
    else:
        manual=home/'set-resolution-1920x1080.sh';manual_script=manual
        manual.write_text('#!/bin/sh\nset -eu\necho "Applying 1920x1080 to the guest display..."\n'
          +f'{shlex.quote(python)} {shlex.quote(str(command))} --output {shlex.quote(str(base/"manual-result.json"))}\n'
          +'echo "Resolution applied. Keep guest display scaling at 100%."\n',encoding='utf8')
        manual.chmod(0o755)
    result={'status':'registered','trigger':'every_user_login','launcher':str(launcher),
            'manual_launcher':str(manual),'manual_script':str(manual_script),
            'script':str(command),'result':str(base/'result.json'),'resolution_verified':False}
    (base/'registration.json').write_text(json.dumps(result,indent=2)+'\n')
    return result

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--desktop');args=parser.parse_args()
    print(json.dumps(install(desktop=args.desktop)))
