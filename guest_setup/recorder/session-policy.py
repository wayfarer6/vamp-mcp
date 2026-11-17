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
        ('org.gnome.settings-daemon.plugins.power','sleep-inactive-ac-type','nothing'),
        ('org.gnome.settings-daemon.plugins.power','sleep-inactive-battery-type','nothing'),
    ]
    for schema,key,value in settings:
        subprocess.run(['gsettings','set',schema,key,value],check=True)
    return {'status':'configured','automatic_sleep':False,'automatic_lock':False}


if __name__=='__main__':
    print(json.dumps(apply()))
