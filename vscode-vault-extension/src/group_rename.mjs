// The local editor reads the database password on stdin and emits status only.
export const renameGroupProgram=String.raw`
import base64
import json
import sys
from importlib.metadata import PackageNotFoundError, version

def edit(request):
    try:
        if version('pykeepass') != '4.2.0':
            return 'dependency_missing'
        from pykeepass import PyKeePass
        from lxml import etree
    except (ImportError, PackageNotFoundError):
        return 'dependency_missing'
    database = PyKeePass(request['file'], password=request['password'])
    current = database.root_group
    recycle = database.tree.findtext('./Meta/RecycleBinUUID')
    parts = request['group'].split('/')
    for depth, name in enumerate(parts):
        candidates = [group for group in current.subgroups if group.name == name]
        if len(candidates) != 1:
            return 'group_missing_or_ambiguous'
        if base64.b64encode(candidates[0].uuid.bytes).decode('ascii') == recycle:
            return 'recycle_bin'
        if depth == len(parts) - 1:
            if name == request['name']:
                return 'unchanged'
            if any(group.name == request['name'] for group in current.subgroups):
                return 'group_exists'
        current = candidates[0]
    current.name = request['name']
    expected = etree.tostring(database.tree, method='c14n')
    database.save()
    reopened = PyKeePass(request['file'], password=request['password'])
    if etree.tostring(reopened.tree, method='c14n') != expected:
        return 'roundtrip_failed'
    return 'renamed'

try:
    status = edit(json.load(sys.stdin))
except Exception:
    status = 'roundtrip_failed'
print(json.dumps({'status': status}))
`;
