"""Debian GNOME guest: persist native full HD using Mutter's session D-Bus API."""

def select_mode(state):
    serial,monitors,logical,properties=state
    if len(monitors)!=1 or len(logical)>1:
        raise RuntimeError('Expected one guest monitor; refusing to disable other displays')
    spec,modes,monitor_properties=monitors[0]
    matches=[m for m in modes if (int(m[1]),int(m[2]))==(1920,1080) and 1.0 in [float(x) for x in m[5]]]
    if not matches:raise RuntimeError('GNOME driver does not advertise 1920x1080 at scale 1; check guest display drivers')
    return serial,spec,max(matches,key=lambda m:float(m[3])),properties


def verify(state):
    _,monitors,logical,_=state
    if len(monitors)!=1 or len(logical)!=1:return False
    active=[m for m in monitors[0][1] if m[6].get('is-current',False)]
    return bool(len(active)==1 and (int(active[0][1]),int(active[0][2]))==(1920,1080)
                and float(logical[0][2])==1.0 and int(logical[0][3])==0)


def native_x11():
    import re,subprocess
    visible=subprocess.check_output(['xrandr','--current'],text=True)
    connectors=re.findall(r'^(\S+) connected',visible,re.M)
    if len(connectors)!=1:raise RuntimeError('Expected one native X11 monitor')
    if not re.search(r'^\s+1920x1080\s',visible,re.M):raise RuntimeError('Native X11 driver does not advertise full HD')
    subprocess.run(['xrandr','--output',connectors[0],'--mode','1920x1080','--fb','1920x1080'],check=True,capture_output=True,text=True)
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
    if not verify(state):
        configuration=dbus.Array([dbus.Struct((dbus.Int32(0),dbus.Int32(0),dbus.Double(1.0),
          dbus.UInt32(0),dbus.Boolean(True),dbus.Array([
            dbus.Struct((str(spec[0]),str(mode[0]),dbus.Dictionary({},signature='sv')))],signature='(ssa{sv})')))],signature='(iiduba(ssa{sv}))')
        options=dbus.Dictionary({},signature='sv')
        if properties.get('supports-changing-layout-mode',False) and 'layout-mode' in properties:options['layout-mode']=dbus.UInt32(properties['layout-mode'])
        # Verify the selected monitor/mode before persistently applying.
        interface.ApplyMonitorsConfig(serial,dbus.UInt32(0),configuration,options,timeout=15)
        interface.ApplyMonitorsConfig(serial,dbus.UInt32(2),configuration,options,timeout=15)
    observed=interface.GetCurrentState(timeout=15)
    verified=verify(observed)
    import os
    native=None
    if os.environ.get('XDG_SESSION_TYPE')=='x11':
        native=native_x11();verified=verified and native==[1920,1080]
    active=[m for m in observed[1][0][1] if m[6].get('is-current',False)]
    return {'status':'succeeded' if verified else 'needs_attention','resolution_verified':verified,
            'observed_resolution':native if native else ([int(active[0][1]),int(active[0][2])] if len(active)==1 else None),
            'x11_framebuffer_verified':native==[1920,1080],
            'scale':float(observed[2][0][2]) if observed[2] else None,
            'mechanism':'GNOME Mutter ApplyMonitorsConfig persistent (method 2)'}
