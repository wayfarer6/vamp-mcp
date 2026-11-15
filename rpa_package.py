"""Discover and validate the executable files of one versioned RPA package."""
import json
import re
from pathlib import Path

ROOT=Path(__file__).resolve().parent


def load_package(package_id):
    if not re.fullmatch(r'[a-z][a-z0-9_]*',package_id):
        raise ValueError('Invalid RPA id')
    directory=ROOT/'rpas'/package_id
    manifest=json.loads((directory/'manifest.json').read_text())
    required={'format_version','id','name','version','default_entrypoint','entrypoints',
              'python_libraries','dependencies','skill','outputs'}
    if set(manifest)!=required or manifest['format_version']!=1 or manifest['id']!=package_id:
        raise ValueError(f'Invalid manifest header: {package_id}')
    if not re.fullmatch(r'\d+\.\d+\.\d+',manifest['version']):
        raise ValueError(f'Invalid package version: {package_id}')
    entries=manifest['entrypoints']
    names=[entry['name'] for entry in entries]
    if len(names)!=len(set(names)) or manifest['default_entrypoint'] not in names:
        raise ValueError(f'Invalid entrypoint names: {package_id}')
    if not manifest['python_libraries']:
        raise ValueError(f'Python library missing: {package_id}')
    paths=[(entry['file'],'.robot') for entry in entries]
    paths.extend((path,'.py') for path in manifest['python_libraries'])
    for relative,suffix in paths:
        target=(directory/relative).resolve()
        if not target.is_relative_to(directory.resolve()) or target.suffix!=suffix or not target.is_file():
            raise ValueError(f'Invalid package file: {relative}')
    for entry in entries:
        if entry['credentials'] not in ('none','environment_or_prompt','public_sandbox_config'):
            raise ValueError(f'Invalid credential source: {package_id}')
    if manifest['outputs']!={'summary':'${OUTPUT DIR}/summary.json',
        'robot_log':'${OUTPUT DIR}/log.html','robot_report':'${OUTPUT DIR}/report.html'}:
        raise ValueError(f'Invalid output contract: {package_id}')
    return directory,manifest
