"""Check package ids, entrypoints and local Python libraries without a VM connection."""
from pathlib import Path
import sys

root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root))
from rpa_package import load_package

for manifest_path in sorted((root/'rpas').glob('*/manifest.json')):
    _,manifest=load_package(manifest_path.parent.name)
    print(f"OK {manifest['id']} {manifest['version']}")
