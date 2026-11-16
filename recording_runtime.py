"""Python-only coordinates and SPICE replay for generated Robot packages."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from robot.api.deco import keyword,library
from robot.libraries.BuiltIn import BuiltIn
from recording_converter import key_name,number

EXTRA_SCANS={'shiftright':54,'ctrlright':0x11d,'altright':0x138,'superright':0x15c,
 'home':0x147,'end':0x14f,'pageup':0x149,'pagedown':0x151,'insert':0x152,'capslock':58,
 **{f'f{i}':58+i for i in range(1,11)},'f11':87,'f12':88}


@library(scope='SUITE',auto_keywords=False)
class RecordedWorkflow:
    def __init__(self,package):
        self.package=Path(package)
        self.data=None
        self.spice=None
        self.held={}
        self.implicit_shift=set()
        self.completed=0
        self.allowed=False

    @keyword
    def load_recording(self,allow_replay=False):
        path=self.package/'recording.local.json'
        if not path.is_file():
            raise ValueError('Local recording missing; regenerate from your private recorder source')
        self.data=json.loads(path.read_text())
        if self.data.get('format_version')!=1 or len(self.data.get('resolution',[]))!=2:
            raise ValueError('Invalid recording format')
        width,height=self.data['resolution']
        if type(width)!=int or type(height)!=int or min(width,height)<=0:raise ValueError('Invalid resolution')
        actions=self.data.get('actions')
        if not isinstance(actions,list) or not actions:raise ValueError('Recording has no actions')
        required={
            'wait':{'seconds'},'key_down':{'key'},'key_up':{'key'},'write':{'text'},
            'write_env':{'env'},'press':{'keys','presses','interval'},'hotkey':{'keys','interval'},
            'click':{'x','y','button','clicks','interval'},'move':{'x','y'},'scroll':{'clicks'},
        }
        for action in actions:
            if not isinstance(action,dict):raise ValueError('Invalid recording action')
            op=action.get('op')
            if op not in required or not required[op].issubset(action):
                raise ValueError('Unknown or incomplete recording action')
            for key in ['x','y','seconds','interval']:
                if key in action:
                    number(action[key])
                    if key in ('seconds','interval') and action[key]<0:raise ValueError('Negative timing')
            if ('x' in action)!=('y' in action):raise ValueError('Both pointer coordinates are required')
            if 'x' in action and not (0<=action['x']<width and 0<=action['y']<height):
                raise ValueError('Point outside recorded guest resolution')
            if op in ('key_down','key_up'):key_name(action['key'])
            if op in ('press','hotkey'):
                if not isinstance(action['keys'],list) or not action['keys']:raise ValueError('Empty key list')
                for key in action['keys']:key_name(key)
            if op=='press' and (type(action['presses'])!=int or action['presses']<1):raise ValueError('Invalid repeat count')
            if op in ('click','scroll') and type(action['clicks'])!=int:raise ValueError('Invalid click count')
            if op=='click' and (action['clicks']<1 or action['button'] not in ('left','middle','right')):
                raise ValueError('Invalid mouse button or repeat count')
            if op=='write' and (not isinstance(action['text'],str) or not all(32<=ord(c)<=126 or c in '\n\t' for c in action['text'])):
                raise ValueError('Recorded write supports US ASCII only')
            if op=='write_env' and not str(action.get('env','')).isidentifier():raise ValueError('Invalid environment reference')
        self.allowed=str(allow_replay).lower() in ('true','1','yes','on')
        return self.allowed

    @keyword
    def action_count(self):
        return len(self.data['actions'])

    @keyword
    def review_result(self):
        return {'status':'needs_review','recording':str(self.package/'recording.local.json'),
                'action_count':len(self.data['actions']),'guest_os':self.data['guest_os'],
                'message':'Review conversion, coordinates, launcher, credentials and target SPICE URI before ALLOW_REPLAY.'}

    @keyword
    def check_guest_geometry(self):
        if not self.allowed:raise AssertionError('Recorded replay was not enabled')
        self.spice=BuiltIn().get_library_instance('Spice')
        info=self.spice.screen_info()
        if [info['width'],info['height']]!=self.data['resolution']:
            raise AssertionError('Guest resolution differs from recording; recalibrate rather than guessing coordinates')
        if any(a['op'] in ('click','move','scroll') for a in self.data['actions']) and info['mouse_mode']!=2:
            raise AssertionError('Recorded absolute pointer input requires SPICE CLIENT mode')

    def _scan(self,key):
        from guest_keys import SCANCODES,SHIFTED
        key=key_name(key)
        base=SHIFTED.get(key,key.lower())
        code={**SCANCODES,**EXTRA_SCANS}.get(base)
        if code is None:raise ValueError('Recorded key has no SPICE scan code')
        return key,code,key in SHIFTED or len(key)==1 and key.isupper()

    def _down(self,key):
        key,code,shift=self._scan(key)
        if shift and key not in self.held and not any(c in (42,54) for c in self.held.values()):
            if not self.implicit_shift:self.spice.inputs.key_press(42)
            self.implicit_shift.add(key)
        self.spice.inputs.key_press(code)
        self.held[key]=code

    def _up(self,key):
        key,code,_=self._scan(key)
        self.held.pop(key,None)
        if code!=42 or not self.implicit_shift:self.spice.inputs.key_release(code)
        if key in self.implicit_shift:
            self.implicit_shift.remove(key)
            if not self.implicit_shift and 42 not in self.held.values():self.spice.inputs.key_release(42)

    def _move(self,action):
        self.spice.inputs.position(int(action['x']),int(action['y']),0,0)
        self.spice._pump(.05)

    @keyword
    def replay_event(self,index):
        if not self.allowed or self.spice is None:raise AssertionError('Review and geometry check required before replay')
        action=self.data['actions'][int(index)]
        op=action['op']
        if op=='wait':self.spice._pump(action['seconds'])
        elif op=='key_down':self._down(action['key'])
        elif op=='key_up':self._up(action['key'])
        elif op in ('write','write_env'):
            if op=='write_env':
                import os
                value=os.environ.get(action['env'])
                if value is None:raise ValueError('Required private input environment variable is missing')
            else:value=action['text']
            if not isinstance(value,str) or not all(32<=ord(c)<=126 or c in '\n\t' for c in value):
                raise ValueError('Recorded write supports only US ASCII input')
            for char in value:
                key={'\n':'enter','\t':'tab'}.get(char,char)
                self._down(key);self._up(key);self.spice._pump(action.get('interval',.06))
        elif op=='press':
            for _ in range(action['presses']):
                for key in action['keys']:
                    self._down(key);self._up(key);self.spice._pump(action['interval'])
        elif op=='hotkey':
            try:
                for key in action['keys']:self._down(key);self.spice._pump(action['interval'])
            finally:
                for key in reversed(action['keys']):self._up(key)
        elif op=='move':self._move(action)
        elif op=='click':
            self._move(action)
            button={'left':1,'middle':2,'right':3}[action['button']]
            for _ in range(action['clicks']):
                try:
                    self.spice.inputs.button_press(button,1<<(button-1));self.spice._pump(.05)
                finally:self.spice.inputs.button_release(button,0)
                self.spice._pump(action['interval'])
        elif op=='scroll':
            if 'x' in action:self._move(action)
            button=4 if action['clicks']>0 else 5
            for _ in range(abs(action['clicks'])):
                self.spice.inputs.button_press(button,0);self.spice.inputs.button_release(button,0);self.spice._pump(.03)
        if op!='wait':self.spice._pump(.1)
        self.completed+=1

    @keyword
    def release_recorded_inputs(self):
        if not self.spice or not self.spice.inputs:return
        try:
            for code in set(self.held.values())|({42} if self.implicit_shift else set()):
                self.spice.inputs.key_release(code)
            self.spice._pump(.05)
        finally:
            self.held.clear();self.implicit_shift.clear()

    @keyword
    def verify_replay(self,expected_text='',languages='en'):
        self.release_recorded_inputs()
        result={'status':'replayed_unverified','actions_replayed':self.completed,
                'guest_os':self.data['guest_os'],'resolution':self.data['resolution']}
        if not expected_text:return result
        from vision import run_ocr
        from verification import detect_verification
        with TemporaryDirectory(prefix='spice-replay-') as directory:
            screen=self.spice.capture_guest_screen(Path(directory)/'screen.png')
            lines=run_ocr(self.spice,screen,languages,Path(directory)/'ocr.json')
        challenge=detect_verification(lines)
        if challenge['status']!='no_challenge_text':return {**result,**challenge}
        matched=any(expected_text.casefold() in line['text'].casefold() and line['confidence']>=.7 for line in lines)
        return {**result,'status':'succeeded' if matched else 'verification_failed','verification':'ocr_only'}
