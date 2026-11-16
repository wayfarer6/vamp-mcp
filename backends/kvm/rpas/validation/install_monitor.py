"""Deterministic installation monitoring: UART markers and domain state, no AI."""
import json
from pathlib import Path
import subprocess
import time
from robot.api.deco import keyword,library
from robot.libraries.BuiltIn import BuiltIn
from vnc_robot import VncRobot


@library(scope='SUITE',auto_keywords=False)
class InstallMonitor:
    @keyword
    def wait_for_debian_setup(self, vm_name, serial_log, timeout=1200):
        output=Path(BuiltIn().get_variable_value('${OUTPUT DIR}'));output.mkdir(parents=True,exist_ok=True)
        guest=None;started=time.monotonic();configured=False;booted=False;last_capture=0;failures=0
        def virsh(*args):
            result=subprocess.run(['virsh','-c','qemu:///session',*args],capture_output=True,text=True,timeout=30)
            if result.returncode:raise RuntimeError(result.stderr.strip())
            return result.stdout.strip()
        try:
            while time.monotonic()-started<float(timeout):
                text=Path(serial_log).read_text(errors='replace') if Path(serial_log).exists() else ''
                if 'VAMP-SETUP-FAILED' in text:
                    raise AssertionError('Guest setup failed; inspect the serial log and /var/log/vamp-setup.log')
                configured=configured or 'VAMP-SETUP-CONFIGURED' in text
                state=virsh('domstate',vm_name)
                if state=='paused':
                    virsh('resume',vm_name);state='running'
                if state=='shut off' and configured:
                    if guest:guest.disconnect_vnc();guest=None
                    virsh('start',vm_name);booted=True;continue
                if state=='running':
                    uri=virsh('domdisplay',vm_name)
                    if guest is None:
                        try:
                            guest=VncRobot();guest.connect_vnc(uri);failures=0
                        except Exception:
                            if guest:guest.disconnect_vnc();guest=None
                            failures+=1
                            if failures>=2:raise
                            time.sleep(1);continue
                    try:
                        guest._pump(.5)
                        if time.monotonic()-last_capture>10:
                            guest.capture_guest_screen(output/'latest.png');last_capture=time.monotonic()
                    except (OSError,EOFError,RuntimeError,TimeoutError,ValueError):
                        guest.disconnect_vnc();guest=None
                        time.sleep(.5);continue
                    if configured and 'VAMP-DESKTOP-STARTED' in text:
                        guest.capture_guest_screen(output/'installed-desktop.png')
                        result={'status':'installed_and_prepared','vm_name':vm_name,'setup_marker_verified':True,
                                'desktop_target_started':True,'application_validation_completed':False,
                                'elapsed_seconds':round(time.monotonic()-started,1)}
                        (output/'summary.json').write_text(json.dumps(result,indent=2));return result
                time.sleep(.5)
            raise AssertionError('Installation/setup did not complete within the deadline; inspect serial log and latest.png')
        finally:
            if guest:guest.disconnect_vnc()

    @keyword
    def install_windows_and_wait(self, vm_name, serial_log, timeout=240, boot=False):
        output=Path(BuiltIn().get_variable_value('${OUTPUT DIR}'));output.mkdir(parents=True,exist_ok=True)
        def command(*args):
            result=subprocess.run(['virsh','-c','qemu:///session',*args],capture_output=True,text=True,timeout=30)
            if result.returncode:raise RuntimeError(result.stderr.strip())
            return result.stdout.strip()
        guest=VncRobot();started=time.monotonic();sequence=0
        try:
            if command('domstate',vm_name)=='shut off':
                command('start',vm_name)
            guest.connect_vnc('vnc://127.0.0.1:5900')
            if boot:
                command('reset',vm_name)
                guest._pump(2)
                for _ in range(6):
                    guest.guest_hotkey('enter');guest._pump(.5)
            while time.monotonic()-started<float(timeout):
                text=Path(serial_log).read_text(errors='replace') if Path(serial_log).exists() else ''
                if 'VAMP-WINDOWS-SETUP-FAILED' in text:
                    raise AssertionError('Windows guest setup failed; inspect C:\\ProgramData\\VAMP-Setup\\setup.log')
                if 'VAMP-WINDOWS-SETUP-CONFIGURED' in text:
                    guest.disconnect_vnc();guest.connect_vnc('vnc://127.0.0.1:5900');guest._pump(2)
                    guest.capture_guest_screen(output/'installed-windows.png')
                    result={'status':'installed_and_prepared','vm_name':vm_name,'guest_setup_verified':True,
                            'application_validation_completed':False,'elapsed_seconds':round(time.monotonic()-started,1)}
                    (output/'summary.json').write_text(json.dumps(result,indent=2));return result
                state=command('domstate',vm_name)
                if state=='paused':command('resume',vm_name)
                if state=='shut off':
                    guest.disconnect_vnc();command('start',vm_name);time.sleep(1);guest.connect_vnc('vnc://127.0.0.1:5900')
                try:guest._pump(1)
                except (OSError,EOFError,RuntimeError,TimeoutError,ValueError):
                    guest.disconnect_vnc();time.sleep(1);guest.connect_vnc('vnc://127.0.0.1:5900')
                if sequence%10==0:guest.capture_guest_screen(output/'latest.png')
                sequence+=1
            result={'status':'installation_in_progress','vm_name':vm_name,'elapsed_seconds':round(time.monotonic()-started,1)}
            (output/'summary.json').write_text(json.dumps(result,indent=2));return result
        finally:guest.disconnect_vnc()
