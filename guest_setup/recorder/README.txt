Run inside the VM desktop user's session, not the host.
Windows: run setup-win.cmd from the mounted media in the guest user session
Debian X11: sh /path/to/mounted/media/setup.sh
Creates Desktop/RPA-Recorder, venv, launcher and recordings folder.
Recorder: axel-magard/PyAutoGUI-Recorder, GPL-3.0; LICENSE and source are in recorder.zip.
recorder.zip is committed here so setup runs without the third_party sources; the guest
scripts download it from the vamp-mcp GitHub repository when it is not beside them.
Regenerate it after changing third_party/pyautogui-recorder:
  python3 scripts/build_recorder_zip.py
Use Start recording -> Stop -> Save Python and save a .py file in recordings/
or on the mounted VAMPRecords share. In the host VS Code extension, open
RPA Library -> Create and select the file under Recorded script. If the file
was copied to another host folder, select it with Add RPA Folder first.
Do not record private credentials. The setup does not start recording automatically.
