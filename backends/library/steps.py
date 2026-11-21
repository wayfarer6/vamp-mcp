"""Compile reviewed guest action ranges. Only immutable Git blobs are read for imports."""
import hashlib
import ast
import io
import json
from pathlib import Path
import re
import subprocess
import tokenize
import uuid

NAME = re.compile(r'[A-Za-z][A-Za-z0-9_-]{0,47}')


def sections(source):
    """Read standalone Python comment tokens, never marker-like text in strings."""
    lines = source.splitlines()
    found = {}
    active = None
    marker = re.compile(r'#\s*vamp-(step|end):\s*(' + NAME.pattern + r')\s*')
    for token in tokenize.generate_tokens(io.StringIO(source, newline=None).readline):
        if token.type != tokenize.COMMENT or not re.match(r'#\s*vamp-(?:step|end):', token.string):
            continue
        line, column = token.start
        match = marker.fullmatch(token.string)
        if lines[line - 1][:column].strip() or not match:
            raise ValueError(f'Use a standalone step marker with a valid ID on line {line}.')
        kind, name = match.groups()
        if kind == 'step':
            if active or name in found:
                raise ValueError(f'Duplicate or nested step marker on line {line}.')
            active = (name, line)
        else:
            if not active or active[0] != name:
                raise ValueError(f'Unmatched end marker on line {line}.')
            found[name] = [active[1] + 1, line - 1]
            active = None
    if active:
        raise ValueError(f'Missing end marker for {active[0]}.')
    return found


def annotate_sections(source, plan):
    """Return an editable candidate. Keep imported steps in their owning recording."""
    lines = source.splitlines(keepends=True)
    existing = sections(source)
    occupied = [(a - 1, b + 1) for a, b in existing.values()]
    statements = [(n.lineno, n.end_lineno) for n in ast.walk(ast.parse(source))
                  if isinstance(n, (ast.Expr, ast.Import, ast.ImportFrom))]
    inserts = []
    updated = []
    newline = '\r\n' if '\r\n' in source else '\n'
    for spec in plan:
        if 'lines' not in spec:
            updated.append(dict(spec))
            continue
        name = spec['name']
        first, last = spec['lines']
        if existing.get(name) != [first, last]:
            if name in existing or last > len(lines) or any(first <= b and a <= last for a, b in occupied):
                raise ValueError('Choose distinct complete ranges for step comments.')
            if any(a < first <= b or a <= last < b for a, b in statements):
                raise ValueError('Extend the range to include the entire Python statement.')
            indent = re.match(r'[ \t]*', lines[first - 1]).group()
            inserts.append((first, last, name, indent))
            occupied.append((first, last))
        updated.append({**{k: v for k, v in spec.items() if k != 'lines'}, 'section': name})
    for first, last, name, indent in sorted(inserts, reverse=True):
        if not lines[last - 1].endswith(('\r', '\n')):
            lines[last - 1] += newline
        lines.insert(last, f'{indent}# vamp-end: {name}{newline}')
        lines.insert(first - 1, f'{indent}# vamp-step: {name}{newline}')
    return ''.join(lines), updated


def committed(folder, revision, name):
    result = subprocess.run(['git', '-C', str(folder), 'show', f'{revision}:{name}'],
                            capture_output=True, timeout=20)
    if result.returncode:
        raise ValueError('Pinned step revision is unavailable in this catalog.')
    return result.stdout


def imported(root, use, backend, resolution):
    if not isinstance(use, dict) or set(use) != {'id', 'commit', 'step'}:
        raise ValueError('Specify an RPA id, commit and step.')
    identifier = str(uuid.UUID(use['id']))
    revision = use['commit']
    if not re.fullmatch('[a-f0-9]{40}', revision) or not NAME.fullmatch(use['step']):
        raise ValueError('Choose a named step at an exact Git commit.')
    folder = (root / identifier).resolve()
    if folder.parent != root or not (folder / '.git').is_dir():
        raise ValueError('Pinned RPA is missing from this catalog.')
    meta = json.loads(committed(folder, revision, 'rpa.json'))
    if (meta.get('format') != 'vamp-saved-rpa' or meta.get('id') != identifier
            or meta.get('reviewed') is not True or meta.get('backend') != backend
            or meta.get('resolution') != resolution):
        raise ValueError('The pinned step must be reviewed and match the backend and resolution.')
    raw = committed(folder, revision, 'actions.json')
    if hashlib.sha256(raw).hexdigest() != meta['actions_sha256']:
        raise ValueError('Pinned action digest mismatch.')
    actions = [a.copy() for a in json.loads(raw) if a.get('step') == use['step']]
    if not actions or 'enter_text' not in actions[0] or 'exit_text' not in actions[-1]:
        raise ValueError('Step or checkpoint missing from pinned revision.')
    return actions


def check_keys(actions):
    held = set()
    for a in actions:
        if a['op'] == 'key_down':
            held.add(a['key'])
        elif a['op'] == 'key_up':
            if a['key'] not in held:
                raise ValueError('The range begins with a key held by another step.')
            held.remove(a['key'])
    if held:
        raise ValueError('Extend the range to include all key releases.')


def compile_plan(plan, source_actions, registry, backend, resolution, source=''):
    if not isinstance(plan, list) or not 1 <= len(plan) <= 64:
        raise ValueError('A step plan contains 1 to 64 steps.')
    result, names = [], set()
    marked = sections(source)
    spans = [(node.lineno, node.end_lineno) for node in ast.walk(ast.parse(source))
             if isinstance(node, ast.Expr)]
    for spec in plan:
        if not isinstance(spec, dict):
            raise ValueError('Expected a step definition.')
        name = spec.get('name', '')
        if not isinstance(name, str) or not NAME.fullmatch(name) or name in names:
            raise ValueError('Use a unique step ID starting with a letter (up to 48 characters).')
        names.add(name)
        if 'use' in spec:
            if set(spec) != {'name', 'use'}:
                raise ValueError('Pinned steps inherit their reviewed entry and completion checks.')
            actions = imported(Path(registry).resolve(), spec['use'], backend, resolution)
        else:
            locator = 'section' if 'section' in spec else 'lines'
            if set(spec) != {'name', locator, 'entry', 'exit'}:
                raise ValueError('Local steps need a range or named section, entry text and completion text.')
            lines = marked.get(spec['section']) if locator == 'section' else spec['lines']
            if lines is None:
                raise ValueError(f'Missing source markers for {name}.')
            if (not isinstance(lines, list) or len(lines) != 2 or any(type(n) != int for n in lines)
                    or not 1 <= lines[0] <= lines[1]):
                raise ValueError('Choose an inclusive range of source lines starting at 1.')
            if any(not isinstance(spec[k], str) or not 1 <= len(spec[k].strip()) <= 240 for k in ('entry','exit')):
                raise ValueError('Specify visible entry and completion text (1 to 240 characters).')
            if any(a < lines[0] <= b or a <= lines[1] < b for a, b in spans):
                raise ValueError('Include the entire Python statement in a step.')
            held_before = set()
            for prior in source_actions:
                if prior['line'] >= lines[0]:
                    break
                if prior['op'] == 'key_down':
                    held_before.add(prior['key'])
                elif prior['op'] == 'key_up':
                    held_before.discard(prior['key'])
            if held_before:
                raise ValueError('Start the range before the held key is pressed.')
            actions = [a.copy() for a in source_actions if lines[0] <= a['line'] <= lines[1]]
            if not actions:
                raise ValueError(f'No recorded actions in the range for {name}.')
            actions[0]['enter_text'] = spec['entry'].strip()
            actions[-1]['exit_text'] = spec['exit'].strip()
        if result and result[-1]['exit_text'] != actions[0]['enter_text']:
            raise ValueError(f'The entry text for {name} must match the preceding completion text.')
        check_keys(actions)
        for action in actions:
            action['step'] = name
        result.extend(actions)
        if len(result) > 10000:
            raise ValueError('Split plans with more than 10,000 actions.')
    return result

