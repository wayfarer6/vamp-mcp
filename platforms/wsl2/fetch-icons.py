import hashlib
from pathlib import Path
import urllib.request

root = Path("/opt/vamp/models")
root.mkdir(parents=True, exist_ok=True)
url = (
    "https://huggingface.co/microsoft/OmniParser-v2.0/resolve/"
    "f55d0750e5b94db2125ef0b45b0fa4a85ddc59b4/icon_detect/"
)
for remote, name, digest in [
    ("model.pt", "omniparser-icon.pt", "dab3d4351ad00b035db829909a4db98354d5a90f6990e4ac00222a9a95d4bf57"),
    ("LICENSE", "OMNIPARSER-LICENSE", "4df3c306dddaaf4baffdff5ca820cc679ac8cd6c263c6a74517783e42fa7a3b"),
]:
    with urllib.request.urlopen(url + remote, timeout=90) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != digest:
        raise RuntimeError(f"Unexpected SHA-256 for {name}")
    (root / name).write_bytes(data)
