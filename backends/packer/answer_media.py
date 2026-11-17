"""Create a small answer ISO without external ADK/xorriso dependencies."""
import sys
import pycdlib

if __name__=='__main__':
    iso=pycdlib.PyCdlib()
    iso.new(interchange_level=3,joliet=3,vol_ident='VAMP_SETUP')
    iso.add_file(sys.argv[1],iso_path='/AUTOUNATTEND.XML;1',joliet_path='/Autounattend.xml')
    iso.add_file(sys.argv[3],iso_path='/VAMPPOST.PS1;1',joliet_path='/vamp-postinstall.ps1')
    if len(sys.argv)>4:
        import os
        name=os.path.basename(sys.argv[4])
        # Vendor ISO is nested inside answer media; no additional controller or
        # unsupported guest storage driver is needed to reach it during setup.
        iso.add_file(sys.argv[4],iso_path='/DRIVERS.ISO;1',joliet_path='/'+name)
    iso.write(sys.argv[2]);iso.close()
