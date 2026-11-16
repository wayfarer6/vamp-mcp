"""Windows guest bootstrap run in the logged-in user's session."""
import json
import os
from pathlib import Path
import subprocess
import sys
import shutil
import venv
import zipfile

media = Path(__file__).resolve().parent
desktop = Path(subprocess.check_output(['powershell.exe','-NoProfile','-Command',
    '[Environment]::GetFolderPath("Desktop")'],text=True).strip())
folder = desktop/'RPA-Recorder'
folder.mkdir(parents=True,exist_ok=True)
(folder/'recordings').mkdir(exist_ok=True)
if not (folder/'PyAutoGuiRecorder.py').exists():
    with zipfile.ZipFile(media/'recorder.zip') as archive:
        archive.extractall(folder)
for name in ['prepare-recording.py','RECORDING-GUIDE.txt','vamp-recorder.py','RECORDER-LICENSE']:
    destination=folder/name
    if destination.exists():destination.chmod(0o644)
    # ISO sources may be read-only; copy contents without propagating that flag.
    shutil.copyfile(media/name,destination)
subprocess.run([sys.executable,str(media/'install-display-startup.py')],check=True)
venv.create(folder/'.venv',with_pip=True)
python = folder/'.venv/Scripts/python.exe'
subprocess.run([str(python),'-m','pip','install','-r',str(media/'requirements-recorder.txt')],check=True)
(folder/'Start-Recorder.cmd').write_text('@echo off\ncd /d "%~dp0"\n".venv\\Scripts\\python.exe" vamp-recorder.py\npause\n')
subprocess.run([sys.executable,str(Path(os.environ['LOCALAPPDATA'])/'VAMP/display/apply-display.py'),'--attempts','2','--delay','3'],check=False)
(folder/'installation.json').write_text(json.dumps({'status':'installed','recording_started':False}))
# Remove the one-time provisioning launcher only after successful installation.
startup = Path(os.environ['APPDATA'])/'Microsoft/Windows/Start Menu/Programs/Startup/RPA-Recorder-Setup.cmd'
startup.unlink(missing_ok=True)
print(json.dumps({'status':'installed','folder':str(folder),'recording_started':False}))
