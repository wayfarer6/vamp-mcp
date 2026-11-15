#!/usr/bin/env python3
"""Install a user-session full HD reset at EVERY login, not a one-time RunOnce."""
import json
import os
from pathlib import Path
import shutil
import sys


def install(home=None,platform=None,python=None):
    platform=platform or sys.platform
    home=Path(home or Path.home());python=python or sys.executable
    if platform=='win32':
        base=Path(os.environ['LOCALAPPDATA'])/'VAMP/display'
        startup=Path(os.environ['APPDATA'])/'Microsoft/Windows/Start Menu/Programs/Startup'
    else:
        base=home/'.local/share/vamp/display';startup=home/'.config/autostart'
    base.mkdir(parents=True,exist_ok=True);startup.mkdir(parents=True,exist_ok=True)
    for name in ['apply-display.py','windows-display.py','gnome-display.py']:
        shutil.copy2(Path(__file__).with_name(name),base/name)
    command=base/'apply-display.py'
    if platform=='win32':
        gui=Path(python).with_name('pythonw.exe')
        interpreter=str(gui) if gui.is_file() else python
        launcher=startup/'VAMP-Display.cmd'
        launcher.write_text(f'@echo off\n"{interpreter}" "{command}" --output "{base / "result.json"}"\n')
    else:
        def quote(value):return '"'+str(value).replace('\\','\\\\').replace('"','\\"').replace('`','\\`').replace('$','\\$')+'"'
        launcher=startup/'vamp-display.desktop'
        launcher.write_text('[Desktop Entry]\nType=Application\nName=VAMP Native Full HD\n'
          +f'Exec={quote(python)} {quote(command)}\nTerminal=false\nX-GNOME-Autostart-enabled=true\nOnlyShowIn=GNOME;\n')
    result={'status':'registered','trigger':'every_user_login','launcher':str(launcher),
            'script':str(command),'result':str(base/'result.json'),'resolution_verified':False}
    (base/'registration.json').write_text(json.dumps(result,indent=2)+'\n')
    return result

if __name__=='__main__':print(json.dumps(install()))
