"""Debian GNOME guest: persist native full HD using Mutter's session D-Bus API."""

import os
import xml.etree.ElementTree as ET


def single_active_monitor(monitors,logical):
    if not logical and len(monitors)==1:
        return monitors[0]
    if len(logical)==1 and len(logical[0][5])==1:
        # VMSVGA advertises unused connectors even with one configured monitor.
        active_spec=logical[0][5][0]
        matches=[monitor for monitor in monitors if monitor[0]==active_spec]
        if len(matches)==1:
            return matches[0]
    return None


def select_mode(state):
    serial,monitors,logical,properties=state
    monitor=single_active_monitor(monitors,logical)
    if monitor is None:
        raise RuntimeError('Expected one guest monitor; refusing to disable other displays')
    spec,modes,_=monitor
    matches=[m for m in modes if (int(m[1]),int(m[2]))==(1920,1080) and 1.0 in [float(x) for x in m[5]]]
    if not matches:raise RuntimeError('GNOME driver does not advertise 1920x1080 at scale 1; check guest display drivers')
    return serial,spec,min(matches,key=lambda m:abs(float(m[3])-60.0)),properties


def verify(state):
    _,monitors,logical,_=state
    monitor=single_active_monitor(monitors,logical)
    if monitor is None or len(logical)!=1:return False
    active=[m for m in monitor[1] if m[6].get('is-current',False)]
    return bool(len(active)==1 and (int(active[0][1]),int(active[0][2]))==(1920,1080)
                and float(logical[0][2])==1.0 and int(logical[0][3])==0)


def monitor_configuration(state):
    if not verify(state):
        raise RuntimeError('Cannot persist an unverified GNOME monitor configuration')
    _,monitors,logical,properties=state
    spec,modes,_=single_active_monitor(monitors,logical)
    mode=next(mode for mode in modes if mode[6].get('is-current',False))
    root=ET.Element('monitors',version='2')
    config=ET.SubElement(root,'configuration')
    ET.SubElement(config,'layoutmode').text='physical' if properties.get('layout-mode')==2 else 'logical'
    layout=ET.SubElement(config,'logicalmonitor')
    for key,value in [('x',logical[0][0]),('y',logical[0][1]),('scale',1),('primary','yes')]:
        ET.SubElement(layout,key).text=str(value)
    output=ET.SubElement(layout,'monitor')
    inactive=[monitor[0] for monitor in monitors if monitor[0]!=spec]
    disabled=ET.SubElement(config,'disabled') if inactive else None
    for parent,identity in [(output,spec)]+[(disabled,item) for item in inactive]:
        node=ET.SubElement(parent,'monitorspec')
        for label,value in zip(('connector','vendor','product','serial'),identity):
            ET.SubElement(node,label).text=str(value)
    dimensions=ET.SubElement(output,'mode')
    for key,value in zip(('width','height','rate'),mode[1:4]):
        ET.SubElement(dimensions,key).text=str(value)
    if mode[6].get('is-interlaced',False):
        ET.SubElement(dimensions,'flag').text='interlace'
    return ET.tostring(root,encoding='unicode')


def native_x11():
    import re,subprocess
    visible=subprocess.check_output(['xrandr','--current'],text=True)
    outputs=re.split(r'\n(?=\S+ (?:dis)?connected\b)',visible)[1:]
    active=[output for output in outputs
            if re.match(r'^\S+ connected (?:primary )?\d+x\d+[+-]\d+[+-]\d+\b',output)]
    if len(active)!=1:raise RuntimeError('Expected one native X11 monitor')
    if not re.search(r'^\s+1920x1080\s',active[0],re.M):raise RuntimeError('Native X11 driver does not advertise full HD')
    connector=active[0].split(maxsplit=1)[0]
    subprocess.run(['xrandr','--output',connector,'--mode','1920x1080','--fb','1920x1080'],check=True,capture_output=True,text=True)
    after=subprocess.check_output(['xrandr','--current'],text=True)
    match=re.search(r'current (\d+) x (\d+)',after)
    return [int(match[1]),int(match[2])] if match else None


def apply():
    import dbus
    bus=dbus.SessionBus()
    proxy=bus.get_object('org.gnome.Mutter.DisplayConfig','/org/gnome/Mutter/DisplayConfig')
    interface=dbus.Interface(proxy,'org.gnome.Mutter.DisplayConfig')
    state=interface.GetCurrentState(timeout=15)
    serial,spec,mode,properties=select_mode(state)
    configuration=dbus.Array([dbus.Struct((dbus.Int32(0),dbus.Int32(0),dbus.Double(1.0),
      dbus.UInt32(0),dbus.Boolean(True),dbus.Array([
        dbus.Struct((str(spec[0]),str(mode[0]),dbus.Dictionary({},signature='sv')))],signature='(ssa{sv})')))],signature='(iiduba(ssa{sv}))')
    options=dbus.Dictionary({},signature='sv')
    if properties.get('supports-changing-layout-mode',False) and 'layout-mode' in properties:options['layout-mode']=dbus.UInt32(properties['layout-mode'])
    unattended=os.environ.get('VAMP_GNOME_UNATTENDED')=='1'
    if not unattended or not verify(state):
        # Method 2 waits for acceptance in the desktop shell. The unattended
        # provisioner saves the verified configuration directly instead.
        interface.ApplyMonitorsConfig(serial,dbus.UInt32(1 if unattended else 2),configuration,options,timeout=15)
    observed=interface.GetCurrentState(timeout=15)
    verified=verify(observed)
    native=None
    if os.environ.get('XDG_SESSION_TYPE')=='x11':
        native=native_x11();verified=verified and native==[1920,1080]
    monitor=single_active_monitor(observed[1],observed[2])
    active=[m for m in monitor[1] if m[6].get('is-current',False)] if monitor else []
    result={'status':'succeeded' if verified else 'needs_attention','resolution_verified':verified,
            'observed_resolution':native if native else ([int(active[0][1]),int(active[0][2])] if len(active)==1 else None),
            'x11_framebuffer_verified':native==[1920,1080],
            'scale':float(observed[2][0][2]) if observed[2] else None,
            'mechanism':'Mutter display state with unattended configuration' if unattended
                        else 'GNOME Mutter ApplyMonitorsConfig persistent (method 2)'}
    if unattended and verified:
        result['monitors_xml']=monitor_configuration(observed)
    return result
