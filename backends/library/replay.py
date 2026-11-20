"""Replay reviewed, AST-parsed actions on guest devices. Never exec recorder code."""
import asyncio
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
    metadata=json.loads((folder/'rpa.json').read_text(encoding='utf8'))
    if metadata.get('id')!=identifier or metadata.get('format')!='vamp-saved-rpa':raise ValueError('Unknown saved RPA')
    if not(folder/'.git').is_dir():raise ValueError('Version history is missing. Edit and save this RPA in the library first')
    reviewed_files = {'source.py', 'actions.json', 'rpa.json'}
    tracked = subprocess.run(['git', '-C', str(folder), 'ls-tree', '--name-only', 'HEAD', '--', *sorted(reviewed_files)],
                             capture_output=True, text=True, timeout=15)
    if tracked.returncode or set(tracked.stdout.splitlines()) != reviewed_files:
        raise ValueError('All replay inputs must be committed before replay')
    committed=subprocess.run(['git','-C',str(folder),'diff','--quiet','HEAD','--',*sorted(reviewed_files)],capture_output=True,timeout=15)
    if committed.returncode:raise ValueError('RPA has uncommitted changes. Save and review a new revision before replay')
    if metadata.get('reviewed') is not True or (request.get('dry_run') is not True and request.get('confirmed') is not True):
        raise ValueError('Review this RPA in the library and explicitly confirm execution first')
    if hashlib.sha256((folder/'source.py').read_bytes()).hexdigest()!=metadata['source_sha256']:raise ValueError('RPA source changed; recreate and review it before running')
    raw=(folder/'actions.json').read_bytes()
    if hashlib.sha256(raw).hexdigest()!=metadata['actions_sha256']:raise ValueError('RPA actions changed; recreate and review it before running')
    actions=json.loads(raw)
    substitute_inputs(actions, metadata['inputs'], request.get('inputs',{}))
    uuid.UUID(request['vm_id'])
    return metadata,actions


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
        Image.fromarray(pixels).save(path, format='PNG')
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


def recognize_start_screen(path, expected):
    language = 'en'
    if re.search(r'[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]', expected):
        language = 'ko'
    elif re.search(r'[\u3040-\u30ff]', expected):
        language = 'ja'
    elif re.search(r'[\u3400-\u9fff]', expected):
        language = 'zh'
    from model_daemon import request
    return request('ocr', {'op': 'predict', 'image': str(path), 'languages': [language]}, timeout=180)['lines']


class StartScreenBlocked(ValueError):
    pass


class OutcomeScreenBlocked(ValueError):
    pass


class ElevationHandoff(ValueError):
    def __init__(self, completed, reason):
        self.completed = completed
        self.reason = reason
        super().__init__('Check the guest desktop before continuing.')


def inspect_elevation_screen(path):
    from model_daemon import request
    lines = request('ocr', {'op': 'predict', 'image': str(path),
                            'languages': ['en', 'ko']}, timeout=45)['lines']
    readings = [(normalized_text(line['text']), float(line['confidence'])) for line in lines]
    headings = ('user account control', '사용자 계정 컨트롤')
    prompt_scores = [confidence for text, confidence in readings if any(heading in text for heading in headings)]
    if any(confidence >= 0.8 for confidence in prompt_scores):
        return True
    if prompt_scores or not any(text and confidence >= 0.8 for text, confidence in readings):
        raise ValueError('The guest frame did not provide a confident elevation check.')
    return False


async def require_clear_elevation_screen(driver, resolution, completed):
    try:
        if driver.geometry() != resolution:
            raise ValueError('Guest resolution changed.')
        with TemporaryDirectory(prefix='vamp-elevation-') as folder:
            screenshot = Path(folder) / 'screen.png'
            await driver.capture(screenshot, resolution)
            detected = await asyncio.to_thread(inspect_elevation_screen, screenshot)
    except Exception as error:
        raise ElevationHandoff(completed, 'screen_unverified') from error
    if detected:
        raise ElevationHandoff(completed, 'uac_prompt_detected')


async def screen_match_count(driver, resolution, expected, *, verify_absence=False):
    with TemporaryDirectory(prefix='vamp-rpa-screen-') as folder:
        screenshot = Path(folder) / 'screen.png'
        await driver.capture(screenshot, resolution)
        lines = await asyncio.to_thread(recognize_start_screen, screenshot, expected)
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


async def verify_outcome_screen(driver, resolution, expected):
    try:
        if driver.geometry() != resolution:
            raise ValueError('Guest resolution changed during replay.')
        matches = await screen_match_count(driver, resolution, expected)
    except Exception as exc:
        raise OutcomeScreenBlocked('The guest outcome screen could not be verified.') from exc
    if matches != 1:
        raise OutcomeScreenBlocked('Expected outcome text must appear exactly once after replay.')


async def replay(driver,actions,resolution,vault_steps=None,*,start_text=None,outcome_text=None,
                 require_new_outcome=False,pause_on_uac=False):
    completed=0
    try:
        actual = driver.geometry()
        if actual != resolution:raise ValueError(f'Recorded guest resolution {resolution} does not match {actual}; recalibrate rather than guessing')
        if start_text is not None:
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
                raise OutcomeScreenBlocked('The expected outcome text is already present before scratch replay.')
        for a in actions:
            if pause_on_uac:
                await require_clear_elevation_screen(driver, resolution, completed)
            op=a['op']
            if op=='wait':await asyncio.sleep(a['seconds'])
            elif op=='key_down':driver.down(a['key'])
            elif op=='key_up':driver.up(a['key'])
            elif op=='write':
                if vault_steps and completed in vault_steps:
                    if driver.held:
                        raise VaultDeliveryDenied
                    await driver.drain()
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
        if outcome_text is not None:
            await verify_outcome_screen(driver, resolution, outcome_text)
        if pause_on_uac:
            await require_clear_elevation_screen(driver, resolution, completed)
    except VaultDeliveryDenied as error:
        error.completed = completed
        raise
    finally:driver.close()
    return completed

async def run(request, dialogue=False):
    metadata,actions=load(request)
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
    if metadata['backend']=='virtualbox':
        try:
            completed=await replay(VBox(request['vm_id']),actions,metadata['resolution'],vault_steps,start_text=start_text,
                                   pause_on_uac=request.get('pause_on_uac') is True)
        except ElevationHandoff as error:
            from backends.virtualbox.history import record_elevation_handoff
            observed_at=datetime.now(timezone.utc).isoformat()
            result={'status':'operator_handoff','reason':error.reason,'rpa_id':metadata['id'],
                    'actions_completed':error.completed,'at':observed_at,'message':str(error)}
            try:
                result['run_id']=record_elevation_handoff(request['vm_id'],metadata['id'],error.reason,
                                                          error.completed,observed_at)
            except (OSError, sqlite3.Error):
                result['history_status']='unavailable'
            return result
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
            completed=await replay(VNC(client),actions,metadata['resolution'],vault_steps,start_text=start_text)
    else:raise ValueError('This backend has no recorded desktop replay adapter')
    return {'status':'completed_unverified','rpa_id':metadata['id'],'actions_completed':completed,'resolved':len(references),'expected_result':metadata['expected_result'],'message':'Replay completed. Verify the expected application result.'}

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
