"""Replay reviewed, AST-parsed actions on guest devices. Never exec recorder code."""
import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
import unicodedata
import uuid
import xml.etree.ElementTree as ET
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT))
from guest_keys import SCANCODES,SHIFTED

VNC_KEYS={'ctrl':'Ctrl','ctrlright':'Ctrl_R','alt':'Alt','altright':'Alt_R','shift':'Shift','shiftright':'Shift_R','super':'Super_L','superright':'Super_R','enter':'Return','esc':'Escape','space':'space','backspace':'BackSpace','delete':'Delete','tab':'Tab','left':'Left','right':'Right','up':'Up','down':'Down','home':'Home','end':'End','pageup':'Page_Up','pagedown':'Page_Down','insert':'Insert','capslock':'Caps_Lock'}
EXTRA={'shiftright':54,'ctrlright':0x11d,'altright':0x138,'superright':0x15c,'home':0x147,'end':0x14f,'pageup':0x149,'pagedown':0x151,'insert':0x152,'capslock':58}


VAULT_REFERENCE = re.compile(r'(?:\$\{vault:([^{}#\x00-\x1f]+)#(username|password|totp)\}|\{\{vault:([^{}#\x00-\x1f]+)#(username|password|totp)\}\})')


def vault_references(actions):
    references = []
    for index, action in enumerate(actions):
        if action.get('op') != 'write':
            continue
        text = action['text']
        if '${vault:' not in text and '{{vault:' not in text:
            continue
        match = VAULT_REFERENCE.fullmatch(text) if len(text) <= 1024 else None
        if match:
            entry = match[1] or match[3]
            if all(part.strip() and part not in ('.', '..') for part in entry.split('/')):
                references.append({'action_index': index, 'entry': entry, 'field': match[2] or match[4],
                                   'status': 'approval_required'})
                continue
        references.append({'action_index': index, 'status': 'placeholder_unresolved'})
    return references


def load(request):
    identifier=str(uuid.UUID(request['id']));folder=Path(request['registry']).resolve()/identifier
    if not(folder/'.git').is_dir():raise ValueError('Version history is missing. Edit and save this RPA in the library first')
    revision = subprocess.run(['git', '-C', str(folder), 'rev-parse', '--verify', 'HEAD'],
                              capture_output=True, text=True, timeout=15)
    replay_commit = revision.stdout.strip()
    if revision.returncode or not re.fullmatch(r'[0-9a-f]{40}', replay_commit):
        raise ValueError('Could not identify the reviewed RPA revision')
    reviewed_files = {'source.py', 'actions.json', 'rpa.json'}
    tracked = subprocess.run(['git', '-C', str(folder), 'ls-tree', '--name-only', replay_commit, '--', *sorted(reviewed_files)],
                             capture_output=True, text=True, timeout=15)
    if tracked.returncode or set(tracked.stdout.splitlines()) != reviewed_files:
        raise ValueError('All replay inputs must be committed before replay')
    committed=subprocess.run(['git','-C',str(folder),'diff','--quiet',replay_commit,'--',*sorted(reviewed_files)],capture_output=True,timeout=15)
    if committed.returncode:raise ValueError('RPA has uncommitted changes. Save and review a new revision before replay')
    def committed_bytes(name):
        result = subprocess.run(['git', '-C', str(folder), 'show', f'{replay_commit}:{name}'],
                                capture_output=True, timeout=15)
        if result.returncode:
            raise ValueError('Could not read the reviewed RPA revision')
        return result.stdout

    metadata=json.loads(committed_bytes('rpa.json'))
    if metadata.get('id')!=identifier or metadata.get('format')!='vamp-saved-rpa':raise ValueError('Unknown saved RPA')
    if metadata.get('reviewed') is not True or (request.get('dry_run') is not True and request.get('confirmed') is not True):
        raise ValueError('Review this RPA in the library and explicitly confirm execution first')
    source = (folder/'source.py').read_bytes()
    committed_source = committed_bytes('source.py')
    # The catalog hashes recorder bytes before Git's Windows CRLF conversion.
    source_hash = metadata['source_sha256']
    expected_hash = request.get('expected_source_sha256')
    if expected_hash is not None and expected_hash != source_hash:
        raise ValueError('The reviewed RPA source does not match the expected SHA-256.')
    if (source.replace(b'\r\n', b'\n') != committed_source.replace(b'\r\n', b'\n')
            or source_hash not in {hashlib.sha256(source).hexdigest(), hashlib.sha256(committed_source).hexdigest()}):
        raise ValueError('RPA source changed; recreate and review it before running')
    raw=committed_bytes('actions.json')
    if hashlib.sha256(raw).hexdigest()!=metadata['actions_sha256']:raise ValueError('RPA actions changed; recreate and review it before running')
    actions=json.loads(raw)
    substitute_inputs(actions, metadata['inputs'], request.get('inputs',{}))
    uuid.UUID(request['vm_id'])
    return {**metadata, 'replay_commit': replay_commit},actions


def substitute_inputs(actions, names, values):
    if not isinstance(values,dict) or set(values)!=set(names) or any(not isinstance(v,str) or len(v)>10000 for v in values.values()):raise ValueError('Supply exactly the declared input names as strings')
    for action in actions:
        if action.get('op')=='write':
            action['text']=re.sub(r'\$\{([A-Za-z_][A-Za-z0-9_]*)\}',lambda m:values[m[1]] if m[1] in values else m[0],action['text'])

class VBox:
    def __init__(self,vm):
        import contextlib
        self.vm=vm;self.held=set();self.implicit=set();self.owns_shift=False;self.mask=0;self.x=1;self.y=1
        try:from vboxapi import VirtualBoxManager
        except ImportError:raise ValueError('VirtualBox mouse SDK is missing. Run VAMP Python setup on Windows, or configure VAMP Mouse Python Executable with vboxapi on Linux/macOS') from None
        self.manager=VirtualBoxManager(None,None);self.box=self.manager.getVirtualBox();machine=self.box.findMachine(vm)
        if machine.state != self.manager.constants.MachineState_Running:
            raise ValueError('Start the target VM before replay')
        self.session=self.manager.getSessionObject()
        machine.lockMachine(self.session,self.manager.constants.LockType_Shared)
        self.console=self.session.console
    def geometry(self):return list(self.console.display.getScreenResolution(0)[:2])
    async def capture(self, path, resolution):
        png = self.console.display.takeScreenShotToArray(0, *resolution, self.manager.constants.BitmapFormat_PNG)
        path.write_bytes(bytes(png))
    def _scans(self,key,release=False):
        base=SHIFTED.get(key,key.lower());scan={**SCANCODES,**EXTRA}.get(base)
        if scan is None:raise ValueError('Unsupported VirtualBox key: '+key)
        code=scan&0xff;return ([0xe0] if scan>0xff else [])+[code | (0x80 if release else 0)]
    def down(self,key):
        if key in self.held:return
        if key in SHIFTED or (len(key)==1 and key.isupper()):
            if 'shift' not in self.held:self.down('shift');self.owns_shift=True
            self.implicit.add(key)
        self.console.keyboard.putScancodes(self._scans(key));self.held.add(key)
    def up(self,key):
        if key not in self.held:return
        self.console.keyboard.putScancodes(self._scans(key,True));self.held.discard(key)
        self.implicit.discard(key)
        if not self.implicit and self.owns_shift:
            self.owns_shift=False;self.up('shift')
    def move(self,x,y):
        if not self.console.mouse.absoluteSupported:raise ValueError('Enable USB tablet input for this VM')
        self.x=int(x)+1;self.y=int(y)+1;self.console.mouse.putMouseEventAbsolute(self.x,self.y,0,0,self.mask)
    def click(self,button):
        mask={'left':1,'right':2,'middle':4}[button];self.console.mouse.putMouseEventAbsolute(self.x,self.y,0,0,mask);self.console.mouse.putMouseEventAbsolute(self.x,self.y,0,0,0)
    def scroll(self,n):self.console.mouse.putMouseEventAbsolute(self.x,self.y,-int(n),0,0)
    async def drain(self):pass
    def close(self):
        try:
            for key in list(self.held):self.up(key)
        finally:self.session.unlockMachine()

class VNC:
    def __init__(self,client):self.client=client;self.held={}
    def geometry(self):return [self.client.video.width,self.client.video.height]
    async def capture(self, path, resolution):
        from PIL import Image
        pixels = await asyncio.wait_for(self.client.screenshot(), timeout=15)
        image = Image.fromarray(pixels)
        if image.size != tuple(resolution):
            raise ValueError('The captured VNC frame does not match the recorded guest resolution.')
        image.save(path, format='PNG')
    def key(self,key):return VNC_KEYS.get(key,key.upper() if key.startswith('f') and key[1:].isdigit() else key)
    def down(self,key):
        if key in self.held:return
        keys=[self.key(key)]
        if key in SHIFTED or (len(key)==1 and key.isupper()):keys=['Shift',SHIFTED.get(key,key)]
        hold=self.client.keyboard.hold(*keys);hold.__enter__();self.held[key]=hold
    def up(self,key):
        hold=self.held.pop(key,None)
        if hold:hold.__exit__(None,None,None)
    def move(self,x,y):self.client.mouse.move(int(x),int(y))
    def click(self,button):self.client.mouse.click({'left':0,'middle':1,'right':2}[button])
    def scroll(self,n):
        for _ in range(abs(n)):self.client.mouse.click(3 if n>0 else 4)
    async def drain(self):await self.client.drain()
    def close(self):
        for key in list(self.held):self.up(key)

class VaultDeliveryDenied(Exception):
    completed = 0


def vault_dialogue(message):
    print(json.dumps(message), flush=True)
    line = sys.stdin.readline(4097)
    if not line or len(line) > 4096 or json.loads(line).get('ok') is not True:
        raise VaultDeliveryDenied


def normalized_text(text):
    return ' '.join(unicodedata.normalize('NFKC', text).casefold().split())


def start_screen_language(expected):
    if re.search(r'[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]', expected):
        return 'ko'
    if re.search(r'[\u3040-\u30ff]', expected):
        return 'ja'
    if re.search(r'[\u3400-\u9fff]', expected):
        return 'zh'
    return 'en'


def recognize_start_screen(path, expected):
    from model_daemon import request
    return request('ocr', {'op': 'predict', 'image': str(path),
                           'languages': [start_screen_language(expected)]}, timeout=180)['lines']


class StartScreenBlocked(ValueError):
    pass


class OutcomeScreenBlocked(ValueError):
    def __init__(self, message, *, expected_occurrences=None, observed_occurrences=None):
        super().__init__(message)
        self.expected_occurrences = expected_occurrences
        self.observed_occurrences = observed_occurrences


class ElevationHandoff(ValueError):
    def __init__(self, completed, reason, phase, program_name=None, observed_at=None, prompt_kind=None):
        self.completed = completed
        self.reason = reason
        self.phase = phase
        self.program_name = program_name
        self.prompt_kind = prompt_kind
        self.observed_at = observed_at or datetime.now(timezone.utc).isoformat()
        super().__init__('Check the guest desktop before continuing.')


@dataclass(frozen=True)
class ElevationPrompt:
    program_name: str | None
    kind: str


def elevation_program_name(lines):
    """Read only the label immediately above a localized UAC publisher row."""
    publisher_labels = ('verified publisher:', 'publisher:', '확인된 게시자:', '게시자:')
    boxed = [(item['text'].strip(), item['xyxy'], item.get('language')) for item in lines
             if float(item['confidence']) >= 0.8 and isinstance(item.get('xyxy'), list)
             and len(item['xyxy']) == 4]
    names = set()
    for publisher, (left, top, _, _), language in boxed:
        if not normalized_text(publisher).startswith(publisher_labels):
            continue
        # A second OCR language can identify the same box but truncate the label.
        candidates = [(top - box[3], text) for text, box, candidate_language in boxed
                      if candidate_language == language and 0 < top - box[3] <= 64
                      and left - 16 <= box[0] <= left + 120
                      and 1 <= len(text) <= 96 and any(char.isalpha() for char in text)
                      and all(char.isalnum() or char in ' ._()-' for char in text)]
        if candidates:
            gap = min(distance for distance, _ in candidates)
            names.update(text for distance, text in candidates if distance - gap <= 4)
    return names.pop() if len(names) == 1 else None


def inspect_elevation_screen(path, resume_text=None):
    from model_daemon import request
    language = start_screen_language(resume_text) if resume_text is not None else None
    languages = ['en', 'ko']
    if language and language not in languages:
        languages.append(language)
    lines = request('ocr', {'op': 'predict', 'image': str(path),
                            'languages': languages}, timeout=45)['lines']
    elevation_lines = [line for line in lines if line.get('language', 'en') in ('en', 'ko')]
    readings = [(normalized_text(line['text']), float(line['confidence'])) for line in elevation_lines]
    headings = ('user account control', '사용자 계정 컨트롤')
    prompt_scores = [confidence for text, confidence in readings if any(heading in text for heading in headings)]
    if any(confidence >= 0.8 for confidence in prompt_scores):
        visible = [text for text, confidence in readings if confidence >= 0.8]
        credential = any(re.match(r'(?:password|pin)\s*:', text)
                         or 'administrator user name and password' in text
                         or '암호를 입력' in text or text.startswith(('암호:', 'pin 입력'))
                         for text in visible)
        consent = any('do you want to allow' in text or '변경할 수 있도록 허용' in text for text in visible)
        kind = 'credential' if credential else 'consent' if consent else 'unknown'
        return ElevationPrompt(elevation_program_name(elevation_lines), kind)
    model = os.environ.get('VAMP_UAC_YOLO_MODEL')
    if model:
        weights = Path(model)
        if not weights.is_absolute() or not weights.is_file():
            raise ValueError('Configure an absolute path to the local UAC model.')
        if detect_local_class(path, str(weights), 'uac_prompt'):
            return ElevationPrompt(None, 'unknown')
    if prompt_scores or not any(text and confidence >= 0.8 for text, confidence in readings):
        raise ValueError('The guest frame did not provide a confident elevation check.')
    if language is not None:
        outcome_lines = [line for line in lines if line.get('language') == language]
        if text_occurrences(outcome_lines, resume_text) != 1:
            raise StartScreenBlocked('The resume text must appear exactly once after the UAC prompt clears.')
    return None


async def require_clear_elevation_screen(driver, resolution, completed, phase, resume_text=None):
    try:
        if driver.geometry() != resolution:
            raise ValueError('Guest resolution changed.')
        with TemporaryDirectory(prefix='vamp-elevation-') as folder:
            screenshot = Path(folder) / 'screen.png'
            await driver.capture(screenshot, resolution)
            detected = await asyncio.to_thread(inspect_elevation_screen, screenshot, resume_text)
            if driver.geometry() != resolution:
                raise ValueError('Guest resolution changed during elevation verification.')
    except StartScreenBlocked:
        raise
    except Exception as error:
        raise ElevationHandoff(completed, 'screen_unverified', phase) from error
    if detected:
        raise ElevationHandoff(completed, 'uac_prompt_detected', phase, getattr(detected, 'program_name', None),
                               prompt_kind=getattr(detected, 'kind', None))


async def check_elevation_boundary(driver, resolution, completed, phase, wait_seconds, resume_text, on_resume,
                                   on_wait=None):
    try:
        await require_clear_elevation_screen(driver, resolution, completed, phase)
        return
    except ElevationHandoff as blocked:
        if blocked.reason != 'uac_prompt_detected' or not wait_seconds or driver.held:
            raise
        if on_wait is not None:
            on_wait(blocked)
        program_name = blocked.program_name
        observed_at = blocked.observed_at
        prompt_kind = blocked.prompt_kind
    try:
        async with asyncio.timeout(wait_seconds):
            while True:
                await asyncio.sleep(2)
                try:
                    await require_clear_elevation_screen(driver, resolution, completed, phase, resume_text)
                    await require_clear_elevation_screen(driver, resolution, completed, phase, resume_text)
                except (ElevationHandoff, StartScreenBlocked):
                    continue
                break
    except TimeoutError as error:
        raise ElevationHandoff(completed, 'uac_resume_not_verified', phase, program_name, observed_at,
                               prompt_kind=prompt_kind) from error
    if on_resume is not None:
        on_resume(completed, phase, program_name, observed_at, prompt_kind)


def detect_local_class(screenshot, model, label):
    from model_daemon import request

    result = request('yolo', {
        'op': 'predict', 'image': str(screenshot), 'model': model,
        'required_class': label, 'confidence': 0.35,
    }, timeout=90)
    if result.get('verified_class') != label or not isinstance(result.get('targets'), list):
        raise ValueError('The local detector did not confirm the configured modal class.')
    return any(target['label'] == label for target in result['targets'])


async def screen_match_count(driver, resolution, expected, *, verify_absence=False, forbidden_modal=None):
    with TemporaryDirectory(prefix='vamp-rpa-screen-') as folder:
        screenshot = Path(folder) / 'screen.png'
        await driver.capture(screenshot, resolution)
        lines = await asyncio.to_thread(recognize_start_screen, screenshot, expected)
        if forbidden_modal:
            model, label = forbidden_modal
            if await asyncio.to_thread(detect_local_class, screenshot, model, label):
                raise OutcomeScreenBlocked('The configured blocking modal is visible after scratch replay.')
    return text_occurrences(lines, expected, verify_absence=verify_absence)


def text_occurrences(lines, expected, *, verify_absence=False):
    phrase = re.compile(r'(?<![\w-])' + re.escape(normalized_text(expected)) + r'(?![\w-])')
    readings = [(normalized_text(line['text']), float(line['confidence'])) for line in lines]
    if verify_absence and (
        not any(text and confidence >= 0.8 for text, confidence in readings)
        or any(confidence < 0.8 and phrase.search(text) for text, confidence in readings)
    ):
        raise ValueError('The expected text could not be ruled out from the OCR readings.')
    return sum(len(phrase.findall(text)) for text, confidence in readings if confidence >= 0.8)


async def verify_start(driver, resolution, expected):
    try:
        matches = await screen_match_count(driver, resolution, expected)
    except Exception as exc:
        raise StartScreenBlocked('Starting screen could not be verified. Check guest capture and host OCR before replaying.') from exc
    if matches != 1:
        raise StartScreenBlocked('Starting screen mismatch. Expected text must appear exactly once before replay.')


async def verify_outcome_screen(driver, resolution, expected, forbidden_modal=None):
    try:
        if driver.geometry() != resolution:
            raise ValueError('Guest resolution changed during replay.')
        matches = await screen_match_count(driver, resolution, expected, forbidden_modal=forbidden_modal)
    except OutcomeScreenBlocked:
        raise
    except Exception as exc:
        raise OutcomeScreenBlocked('The guest outcome screen could not be verified.') from exc
    if matches != 1:
        raise OutcomeScreenBlocked('Expected outcome text must appear exactly once after replay.',
                                   expected_occurrences=1, observed_occurrences=matches)


async def replay(driver,actions,resolution,vault_steps=None,*,start_text=None,outcome_text=None,
                 require_new_outcome=False,forbidden_modal=None,pause_on_uac=False,
                 uac_wait_seconds=0,uac_resume_text=None,on_uac_resume=None,on_uac_wait=None):
    completed=0
    async def check_uac(phase):
        await check_elevation_boundary(driver, resolution, completed, phase, uac_wait_seconds,
                                       uac_resume_text, on_uac_resume, on_uac_wait)
    try:
        if pause_on_uac and resolution != [1920, 1080]:
            raise ValueError('Guest UAC replay requires a 1920x1080 recording and guest display.')
        actual = driver.geometry()
        if actual != resolution:raise ValueError(f'Recorded guest resolution {resolution} does not match {actual}; recalibrate rather than guessing')
        if start_text is not None:
            if pause_on_uac:
                await check_uac('before_starting_screen')
            await verify_start(driver, resolution, start_text)
            if driver.geometry() != resolution:
                raise ValueError('Guest resolution changed during starting-screen verification. Replay stopped.')
        if require_new_outcome:
            try:
                existing = await screen_match_count(driver, resolution, outcome_text, verify_absence=True)
                if driver.geometry() != resolution:
                    raise ValueError('Guest resolution changed during baseline verification.')
            except Exception as exc:
                raise OutcomeScreenBlocked('The scratch outcome baseline could not be verified.') from exc
            if existing:
                raise OutcomeScreenBlocked('The expected outcome text is already present before scratch replay.',
                                           expected_occurrences=0, observed_occurrences=existing)
        for a in actions:
            if pause_on_uac:
                await check_uac('before_action')
            op=a['op']
            if op=='wait':await asyncio.sleep(a['seconds'])
            elif op=='key_down':driver.down(a['key'])
            elif op=='key_up':driver.up(a['key'])
            elif op=='write':
                if vault_steps and completed in vault_steps:
                    if driver.held:
                        raise VaultDeliveryDenied
                    await driver.drain()
                    if pause_on_uac:
                        await check_uac('before_vault_delivery')
                    vault_dialogue({'vault':'deliver',**vault_steps[completed]})
                else:
                    for character in a['text']:
                        key={'\n':'enter','\t':'tab'}.get(character,character);driver.down(key);driver.up(key);await driver.drain();await asyncio.sleep(a.get('interval',.03))
            elif op=='hotkey':
                try:
                    for key in a['keys']:driver.down(key)
                finally:
                    for key in reversed(a['keys']):driver.up(key)
            elif op=='press':
                for _ in range(a['presses']):
                    for key in a['keys']:driver.down(key);driver.up(key)
                    await asyncio.sleep(a['interval'])
            elif op in ('move','click'):
                driver.move(a['x'],a['y'])
                if op=='click':
                    for _ in range(a['clicks']):driver.click(a['button']);await driver.drain();await asyncio.sleep(a['interval'])
            elif op=='scroll':
                if 'x' in a:driver.move(a['x'],a['y'])
                driver.scroll(a['clicks'])
            else:raise ValueError('Unsupported replay operation: '+op)
            await driver.drain();completed+=1;await asyncio.sleep(.01)
        if pause_on_uac:
            await check_uac('after_last_action')
        if outcome_text is not None:
            await verify_outcome_screen(driver, resolution, outcome_text, forbidden_modal)
    except VaultDeliveryDenied as error:
        error.completed = completed
        raise
    finally:driver.close()
    return completed

async def run(request, dialogue=False):
    metadata,actions=load(request)
    wait_seconds = request.get('uac_wait_seconds', 0)
    resume_text = request.get('uac_resume_text')
    if (type(wait_seconds) is not int or not 0 <= wait_seconds <= 120
            or (wait_seconds and (request.get('pause_on_uac') is not True or metadata['backend'] not in ('virtualbox', 'kvm')
                                  or not isinstance(resume_text, str) or not 1 <= len(resume_text.strip()) <= 240))
            or (resume_text is not None and not wait_seconds)):
        raise ValueError('UAC resume requires VirtualBox or KVM, pause_on_uac, a wait of up to 120 seconds, and exact post-approval screen text.')
    resume_events = []
    wait_events = []

    def record_handoff(error):
        from backends.virtualbox.history import record_elevation_handoff
        recorded_at = datetime.now(timezone.utc).isoformat() if error.reason == 'uac_resume_not_verified' else None
        return record_elevation_handoff(request['vm_id'], metadata['id'], error.reason, error.completed,
                                        error.observed_at, error.phase, metadata['replay_commit'],
                                        error.program_name, error.prompt_kind, recorded_at=recorded_at,
                                        backend=metadata['backend'])

    def record_wait(error):
        try:
            wait_events.append(record_handoff(error))
        except (OSError, sqlite3.Error):
            wait_events.append(None)

    def attach_elevation_history(result):
        if wait_events:
            result['elevation_wait_run_ids'] = [run_id for run_id in wait_events if run_id is not None]
        if resume_events:
            result['elevation_resume_run_ids'] = [run_id for run_id in resume_events if run_id is not None]
        if None in wait_events or None in resume_events:
            result['history_status'] = 'unavailable'

    def record_resume(completed, phase, program_name, observed_at, prompt_kind):
        from backends.virtualbox.history import record_event_run
        payload = {'rpa_id': metadata['id'], 'replay_commit': metadata['replay_commit'], 'backend': metadata['backend'],
                   'actions_completed': completed, 'phase': phase, 'prompt_observed_at': observed_at,
                   'policy': 'operator_wait_screen_verified', 'program_identity': 'unverified'}
        if program_name is not None:
            payload['program_name_ocr'] = program_name
        if prompt_kind is not None:
            payload['prompt_kind'] = prompt_kind
        try:
            resume_events.append(record_event_run(request['vm_id'], 'resumed', 'elevation_resumed',
                                                   payload, datetime.now(timezone.utc).isoformat()))
        except (OSError, sqlite3.Error):
            resume_events.append(None)
    start_text = metadata.get('start_text')
    if start_text is not None and (not isinstance(start_text, str) or not 1 <= len(start_text.strip()) <= 240):
        raise ValueError('Invalid reviewed starting-screen text')
    references=vault_references(actions)
    unresolved=any(item['status']=='placeholder_unresolved' for item in references)
    if request.get('dry_run') is True or unresolved or (references and not dialogue):
        return {
            'status': 'placeholder_unresolved' if unresolved else 'approval_required' if references else 'validated',
            'rpa_id': metadata['id'], 'actions_completed': 0, 'references': references,
        }
    vault_steps={item['action_index']:item for item in references}
    if dialogue and references:
        vault_dialogue({'vault':'preflight','references':references})
    async def replay_on(driver):
        return await replay(driver, actions, metadata['resolution'], vault_steps, start_text=start_text,
                            pause_on_uac=request.get('pause_on_uac') is True, uac_wait_seconds=wait_seconds,
                            uac_resume_text=resume_text, on_uac_resume=record_resume, on_uac_wait=record_wait)

    try:
        if metadata['backend'] == 'virtualbox':
            completed = await replay_on(VBox(request['vm_id']))
        elif metadata['backend']=='kvm':
            import asyncvnc
            uri=request.get('libvirt_uri','qemu:///session')
            if uri not in ('qemu:///session','qemu:///system'):raise ValueError('Only local libvirt connections are supported')
            def virsh(*args):
                p=subprocess.run(['virsh','-c',uri,*args],capture_output=True,text=True,timeout=30)
                if p.returncode:raise RuntimeError(p.stderr[:300])
                return p.stdout
            if virsh('domstate',request['vm_id']).strip()!='running':raise ValueError('Start the target VM before replay')
            xml=ET.fromstring(virsh('dumpxml',request['vm_id']));graphics=xml.find("devices/graphics[@type='vnc']")
            if graphics is None:raise ValueError('The target needs a localhost VNC display')
            listen=graphics.find('listen');host=graphics.get('listen') or (listen.get('address') if listen is not None else None) or '127.0.0.1';port=int(graphics.get('port','-1'))
            if host not in ('127.0.0.1','localhost','::1') or not 1<=port<=65535:raise ValueError('Only active localhost VNC is supported')
            async with asyncvnc.connect(host,port,password=os.environ.get('VAMP_VNC_PASSWORD')) as client:
                completed = await replay_on(VNC(client))
        else:raise ValueError('This backend has no recorded desktop replay adapter')
    except ElevationHandoff as error:
        observed_at=error.observed_at
        result={'status':'operator_handoff','reason':error.reason,'rpa_id':metadata['id'],
                'actions_completed':error.completed,'phase':error.phase,
                'program_identity':'unverified','replay_commit':metadata['replay_commit'],
                'at':observed_at,'message':str(error)}
        if error.program_name is not None:
            result['program_name_ocr'] = error.program_name
        if error.prompt_kind is not None:
            result['prompt_kind'] = error.prompt_kind
        try:
            result['run_id'] = record_handoff(error)
        except (OSError, sqlite3.Error):
            result['history_status']='unavailable'
        attach_elevation_history(result)
        return result
    result = {'status':'completed_unverified','rpa_id':metadata['id'],'actions_completed':completed,'resolved':len(references),'expected_result':metadata['expected_result'],'message':'Replay completed. Verify the expected application result.'}
    attach_elevation_history(result)
    return result

if __name__=='__main__':
    dialogue=sys.argv[1:]==['--vault-dialogue']
    try:
        request=json.loads(sys.stdin.readline()) if dialogue else json.load(sys.stdin)
        print(json.dumps(asyncio.run(asyncio.wait_for(run(request,dialogue),timeout=600)),ensure_ascii=False))
    except VaultDeliveryDenied as error:
        print(json.dumps({'status':'approval_required','actions_completed':error.completed,
                          'message':'Vault delivery did not receive confirmation. Replay stopped.'}))
    except StartScreenBlocked as error:
        print(json.dumps({'status':'starting_screen_blocked','actions_completed':0,'message':str(error)}))
    except Exception as error:print(json.dumps({'status':'error','message':str(error)}));sys.exit(1)
