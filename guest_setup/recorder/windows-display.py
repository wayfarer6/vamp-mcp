"""Windows guest: inspect registry, apply a supported primary mode via user32."""
import ctypes
from ctypes import wintypes as w


def registry_snapshot():
    import winreg
    values=[]
    root=r'SYSTEM\CurrentControlSet\Control\GraphicsDrivers\Configuration'
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,root) as parent:
            for index in range(min(winreg.QueryInfoKey(parent)[0],32)):
                name=winreg.EnumKey(parent,index)
                try:
                    with winreg.OpenKey(parent,name+r'\00\00') as key:
                        values.append({'width':winreg.QueryValueEx(key,'PrimSurfSize.cx')[0],
                                       'height':winreg.QueryValueEx(key,'PrimSurfSize.cy')[0]})
                except OSError:pass
    except OSError:pass
    return {'source':'GraphicsDrivers/Configuration (read only; may contain stale modes)',
            'stored_modes':values}


def apply(width=1920, height=1080):
    if (width, height) not in ((1920, 1080), (2560, 1440)):
        raise ValueError('Supported guest modes are FHD and QHD')
    class Point(ctypes.Structure):
        _fields_=[('x',w.LONG),('y',w.LONG)]
    class Display(ctypes.Structure):
        _fields_=[('position',Point),('orientation',w.DWORD),('fixed_output',w.DWORD)]
    class DeviceMode(ctypes.Structure):
        _fields_=[('device_name',w.WCHAR*32),('spec_version',w.WORD),('driver_version',w.WORD),
          ('size',w.WORD),('driver_extra',w.WORD),('fields',w.DWORD),('display',Display),
          ('color',w.SHORT),('duplex',w.SHORT),('y_resolution',w.SHORT),('tt_option',w.SHORT),
          ('collate',w.SHORT),('form_name',w.WCHAR*32),('log_pixels',w.WORD),
          ('bits_per_pixel',w.DWORD),('width',w.DWORD),('height',w.DWORD),
          ('flags',w.DWORD),('frequency',w.DWORD),('icm_method',w.DWORD),('icm_intent',w.DWORD),
          ('media_type',w.DWORD),('dither_type',w.DWORD),('reserved1',w.DWORD),
          ('reserved2',w.DWORD),('panning_width',w.DWORD),('panning_height',w.DWORD)]
    if ctypes.sizeof(DeviceMode)!=220:raise RuntimeError('Unexpected Windows DEVMODEW ABI')
    user=ctypes.WinDLL('user32',use_last_error=True)
    enum=user.EnumDisplaySettingsW
    enum.argtypes=[w.LPCWSTR,w.DWORD,ctypes.POINTER(DeviceMode)];enum.restype=w.BOOL
    change=user.ChangeDisplaySettingsExW
    change.argtypes=[w.LPCWSTR,ctypes.POINTER(DeviceMode),w.HWND,w.DWORD,ctypes.c_void_p]
    change.restype=w.LONG
    if user.GetSystemMetrics(80)!=1:raise RuntimeError('Expected one guest monitor; refusing to change a multi-monitor layout')
    def current():
        mode=DeviceMode();mode.size=ctypes.sizeof(mode)
        if not enum(None,0xFFFFFFFF,ctypes.byref(mode)):raise RuntimeError('Cannot read current display mode')
        return mode
    before=current();snapshot=registry_snapshot()
    selected=None;index=0
    while True:
        mode=DeviceMode();mode.size=ctypes.sizeof(mode)
        if not enum(None,index,ctypes.byref(mode)):break
        if (mode.width,mode.height,mode.bits_per_pixel)==(width,height,32):
            if selected is None or abs(mode.frequency-before.frequency)<abs(selected.frequency-before.frequency):selected=mode
        index+=1
    mode_source='enumerated'
    if selected is None:
        # Dynamic virtual displays may omit a usable mode from the enumerated list.
        # Reuse the current driver DEVMODE and require CDS_TEST before applying.
        selected=current();selected.width=width;selected.height=height;selected.bits_per_pixel=32
        mode_source='current_mode_with_tested_target'
    selected.fields=0x00080000|0x00100000|0x00040000|0x00400000 # width/height/bpp/frequency
    tested=change(None,ctypes.byref(selected),None,2,None) # CDS_TEST
    if tested!=0:raise RuntimeError(f'Display driver rejected requested mode: {tested}')
    updated=change(None,ctypes.byref(selected),None,1,None) # CDS_UPDATEREGISTRY
    after=current()
    verified=(after.width,after.height)==(width,height) and updated==0
    return {'status':'succeeded' if verified else 'needs_attention','resolution_verified':verified,
            'before':[before.width,before.height],'observed_resolution':[after.width,after.height],
            'mode_source':mode_source,'change_result':int(updated),'restart_required':updated==1,'registry':snapshot,
            'mechanism':'EnumDisplaySettingsW + ChangeDisplaySettingsExW; registry is not edited directly',
            'scale_100_percent_verified':False}
