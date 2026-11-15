"""Download and verify the pinned official OmniParser YOLOv8 detector."""
import hashlib
import json
from pathlib import Path
import requests

root = Path(__file__).resolve().parents[1] / 'models'
manifest = json.loads((root/'manifest.json').read_text())
base = f'https://huggingface.co/{manifest["repository"]}/resolve/{manifest["revision"]}/'


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


for entry in manifest['files']:
    target = root / entry['file']
    if target.exists():
        if digest(target) != entry['sha256']:
            raise RuntimeError(f'Existing file checksum mismatch: {target}')
        print(f'Verified: {target}')
        continue
    temporary = target.with_suffix(target.suffix + '.part')
    with requests.get(base + entry['remote'], stream=True, timeout=120) as response:
        response.raise_for_status()
        with temporary.open('wb') as stream:
            for chunk in response.iter_content(1024*1024):
                stream.write(chunk)
    if digest(temporary) != entry['sha256']:
        temporary.unlink()
        raise RuntimeError(f'Download checksum mismatch: {target}')
    temporary.replace(target)
    print(target)
