"""Fetch the pinned OmniParser detector and license, verifying their SHA-256."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
from tempfile import NamedTemporaryFile
from urllib.request import urlopen

MODEL_ROOT = Path(__file__).resolve().parents[1] / 'models'

def cache_directory():
    return Path(os.environ.get('VAMP_HOME', Path.home() / '.vamp')).expanduser().resolve() / 'models'


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def ensure_weights(directory, *, root=MODEL_ROOT, open_url=urlopen):
    directory = Path(directory)
    manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
    base = f'https://huggingface.co/{manifest["repository"]}/resolve/{manifest["revision"]}/'
    directory.mkdir(parents=True, exist_ok=True)
    paths = {}
    for entry in manifest['files']:
        target = directory / entry['file']
        local = root / entry['file']
        if target.exists():
            if digest(target) != entry['sha256']:
                # Git can check out the bundled license with CRLF on Windows.
                if target != local or target.name != 'OMNIPARSER-LICENSE' or hashlib.sha256(
                    target.read_bytes().replace(b'\r\n', b'\n')
                ).hexdigest() != entry['sha256']:
                    raise RuntimeError(f'Existing model file checksum mismatch: {target}')
            paths[entry['file']] = target
            continue
        if local.exists() and digest(local) == entry['sha256']:
            paths[entry['file']] = local
            continue

        temporary = None
        try:
            with NamedTemporaryFile(dir=directory, suffix='.part', delete=False) as stream:
                temporary = Path(stream.name)
                with open_url(base + entry['remote'], timeout=120) as response:
                    shutil.copyfileobj(response, stream, length=1024 * 1024)
            if digest(temporary) != entry['sha256']:
                raise RuntimeError(f'Download checksum mismatch: {target.name}')
            temporary.replace(target)
            paths[entry['file']] = target
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    return paths


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', action='store_true', help='Use the per-user VAMP model cache')
    args = parser.parse_args()
    for path in ensure_weights(cache_directory() if args.cache else MODEL_ROOT).values():
        print(path)
