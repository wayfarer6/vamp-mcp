"""Disable automatic idle/sleep/lock in the guest GNOME automation account."""
import json
import subprocess
import sys


def apply():
    if sys.platform!='linux':
        return {'status':'unsupported','platform':sys.platform}
    settings=[
        ('org.gnome.desktop.session','idle-delay','uint32 0'),
        ('org.gnome.desktop.screensaver','lock-enabled','false'),
        ('org.gnome.desktop.screensaver','idle-activation-enabled','false'),
        ('org.gnome.settings-daemon.plugins.power','idle-dim','false'),
        ('org.gnome.settings-daemon.plugins.power','sleep-inactive-ac-timeout','0'),
        ('org.gnome.settings-daemon.plugins.power','sleep-inactive-battery-timeout','0'),
        ('org.gnome.settings-daemon.plugins.power','sleep-inactive-ac-type','nothing'),
        ('org.gnome.settings-daemon.plugins.power','sleep-inactive-battery-type','nothing'),
    ]
    for schema,key,value in settings:
        writable=subprocess.check_output(['gsettings','writable',schema,key],text=True).strip()
        if writable=='false':
            current=subprocess.check_output(['gsettings','get',schema,key],text=True).strip()
            if current.strip("'")!=value.strip("'"):
                raise RuntimeError('System policy conflicts with the requested awake session: '+key)
            continue
        subprocess.run(['gsettings','set',schema,key,value],check=True)
    return {'status':'configured','automatic_sleep':False,'automatic_lock':False}


if __name__=='__main__':
    print(json.dumps(apply()))
