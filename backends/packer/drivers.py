"""Stage vendor driver media before Packer starts a new Windows guest."""
import hashlib
import os
from pathlib import Path
import re
import shutil
import tempfile
import urllib.request
from toolchain import home

VIRTIO_URL='https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/virtio-win-0.1.302-1/virtio-win.iso'

def download(url,target,checksum=None):
    target=Path(target);target.parent.mkdir(parents=True,exist_ok=True)
    if target.is_file():
        with target.open('rb') as file:digest=hashlib.file_digest(file,'sha256').hexdigest()
        if checksum is None or digest==checksum:return target
        raise ValueError('Cached driver ISO checksum does not match: '+str(target))
    pending=None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent,delete=False) as file:
            pending=Path(file.name)
            with urllib.request.urlopen(url,timeout=120) as response:shutil.copyfileobj(response,file)
    except Exception:
        if pending:pending.unlink(missing_ok=True)
        raise
    with pending.open('rb') as file:digest=hashlib.file_digest(file,'sha256').hexdigest()
    if checksum and digest!=checksum:pending.unlink();raise ValueError('Driver ISO SHA-256 mismatch')
    pending.replace(target);target.with_suffix('.sha256').write_text(digest+'  '+target.name+'\n')
    return target

def prepare(request,vbox_executable=None,execute=None):
    if request['guest_os']!='windows11':return None
    backend=request['backend']
    if backend=='virtualbox':
        candidates=[Path(vbox_executable).parent/'VBoxGuestAdditions.iso',Path('/usr/share/virtualbox/VBoxGuestAdditions.iso'),Path('/Applications/VirtualBox.app/Contents/MacOS/VBoxGuestAdditions.iso')]
        iso=next((file for file in candidates if file.is_file()),None)
        if iso is None:
            version=re.search(r'\d+\.\d+\.\d+',execute(vbox_executable,['--version']))[0]
            filename='VBoxGuestAdditions_'+version+'.iso';base='https://download.virtualbox.org/virtualbox/'+version+'/'
            sums=urllib.request.urlopen(base+'SHA256SUMS',timeout=30).read().decode()
            digest=next(line.split()[0] for line in sums.splitlines() if line.split()[-1].lstrip('*')==filename)
            iso=download(base+filename,home()/'tools/drivers/virtualbox'/version/'VBoxGuestAdditions.iso',digest)
    elif backend=='kvm':
        # Fixed upstream release over HTTPS. The guest also requires a valid
        # Authenticode signature before running the driver/agent MSI packages.
        iso=download(VIRTIO_URL,home()/'tools/drivers/virtio-win/0.1.302/virtio-win.iso',os.environ.get('VAMP_VIRTIO_ISO_SHA256'))
    else:return None
    request['driver_iso']=str(iso);return iso
