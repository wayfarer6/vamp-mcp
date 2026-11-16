"""Replay reviewed, AST-parsed actions on guest devices. Never exec recorder code."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid
import xml.etree.ElementTree as ET
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT))
from guest_keys import SCANCODES,SHIFTED

VNC_KEYS={'ctrl':'Ctrl','ctrlright':'Ctrl_R','alt':'Alt','altright':'Alt_R','shift':'Shift','shiftright':'Shift_R','super':'Super_L','superright':'Super_R','enter':'Return','esc':'Escape','space':'space','backspace':'BackSpace','delete':'Delete','tab':'Tab','left':'Left','right':'Right','up':'Up','down':'Down','home':'Home','end':'End','pageup':'Page_Up','pagedown':'Page_Down','insert':'Insert','capslock':'Caps_Lock'}
EXTRA={'shiftright':54,'ctrlright':0x11d,'altright':0x138,'superright':0x15c,'home':0x147,'end':0x14f,'pageup':0x149,'pagedown':0x151,'insert':0x152,'capslock':58}


def load(request):
    identifier=str(uuid.UUID(request['id']));folder=Path(request['registry']).resolve()/identifier
    metadata=json.loads((folder/'rpa.json').read_text(encoding='utf8'))
    if metadata.get('id')!=identifier or metadata.get('format')!='vamp-saved-rpa':raise ValueError('Unknown saved RPA')
    if not(folder/'.git').is_dir():raise ValueError('Version history is missing. Edit and save this RPA in the library first')
    committed=subprocess.run(['git','-C',str(folder),'diff','--quiet','HEAD','--','source.py','actions.json','rpa.json'],capture_output=True,timeout=15)
    if committed.returncode:raise ValueError('RPA has uncommitted changes. Save and review a new revision before replay')
    if metadata.get('reviewed') is not True or request.get('confirmed') is not True:raise ValueError('Review this RPA in the library and explicitly confirm execution first')
    if hashlib.sha256((folder/'source.py').read_bytes()).hexdigest()!=metadata['source_sha256']:raise ValueError('RPA source changed; recreate and review it before running')
    raw=(folder/'actions.json').read_bytes()
    if hashlib.sha256(raw).hexdigest()!=metadata['actions_sha256']:raise ValueError('RPA actions changed; recreate and review it before running')
    values=request.get('inputs',{})
    if not isinstance(values,dict) or set(values)!=set(metadata['inputs']) or any(not isinstance(v,str) or len(v)>10000 for v in values.values()):raise ValueError('Supply exactly the declared input names as strings')
    actions=json.loads(raw)
    for action in actions:
        if action.get('op')=='write':
            action['text']=re.sub(r'\$\{([A-Za-z_][A-Za-z0-9_]*)\}',lambda m:values[m[1]] if m[1] in values else m[0],action['text'])
    uuid.UUID(request['vm_id'])
    return metadata,actions

class VBox:
    def __init__(self,vm):
        import contextlib
        self.vm=vm;self.held=set();self.implicit=set();self.owns_shift=False;self.mask=0;self.x=1;self.y=1
        try:from vboxapi import VirtualBoxManager
        except ImportError:raise ValueError('VirtualBox mouse SDK is missing. Run VAMP Python setup on Windows, or configure VAMP Mouse Python Executable with vboxapi on Linux/macOS') from None
        self.manager=VirtualBoxManager(None,None);self.box=self.manager.getVirtualBox();machine=self.box.findMachine(vm)
        if str(machine.state) not in ('5','Running'):raise ValueError('Start the target VM before replay')
        self.session=self.manager.getSessionObject();machine.lockMachine(self.session,1);self.console=self.session.console
    def geometry(self):return list(self.console.display.getScreenResolution(0)[:2])
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

async def replay(driver,actions,resolution):
    completed=0
    try:
        if driver.geometry()!=resolution:raise ValueError(f'Recorded guest resolution {resolution} does not match {driver.geometry()}; recalibrate rather than guessing')
        for a in actions:
            op=a['op']
            if op=='wait':await asyncio.sleep(a['seconds'])
            elif op=='key_down':driver.down(a['key'])
            elif op=='key_up':driver.up(a['key'])
            elif op=='write':
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
    finally:driver.close()
    return completed

async def run(request):
    metadata,actions=load(request)
    if metadata['backend']=='virtualbox':
        completed=await replay(VBox(request['vm_id']),actions,metadata['resolution'])
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
            completed=await replay(VNC(client),actions,metadata['resolution'])
    else:raise ValueError('This backend has no recorded desktop replay adapter')
    return {'status':'completed_unverified','rpa_id':metadata['id'],'actions_completed':completed,'expected_result':metadata['expected_result'],'message':'Replay completed. Verify the expected application result; no screenshot or model call was made.'}

if __name__=='__main__':
    try:print(json.dumps(asyncio.run(asyncio.wait_for(run(json.load(sys.stdin)),timeout=600)),ensure_ascii=False))
    except Exception as error:print(json.dumps({'status':'error','message':str(error)}));sys.exit(1)
