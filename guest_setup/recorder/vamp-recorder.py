# SPDX-License-Identifier: GPL-3.0-only
# VAMP recorder UI adaptation of axel-magard/PyAutoGUI-Recorder.
# Original source/license/provenance are bundled separately in recorder.zip.
# This derivative guest program remains GPL-3.0; host integration is MIT.
"""Visible, user-started recorder. Saves literal PyAutoGUI Python; never evals playback."""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
from datetime import datetime,timezone
import time
import tkinter as tk
from tkinter import ttk,messagebox,simpledialog
from pynput import keyboard,mouse


def output_folder():
    candidates=[]
    if os.environ.get('VAMP_RECORDINGS_DIR'):candidates.append(Path(os.environ['VAMP_RECORDINGS_DIR']))
    if sys.platform=='win32':candidates.append(Path(r'\\VBOXSVR\VAMPRecords'))
    else:candidates += [Path.home()/'VAMP-Shared',Path('/media/sf_VAMPRecords')]
    for folder in candidates:
        try:
            if folder.is_dir() and os.access(folder,os.W_OK):return folder,True
        except OSError:pass
    local=os.environ.get('VAMP_LOCAL_RECORDINGS_DIR')
    folder=Path(local) if local else Path(__file__).resolve().parent/'recordings'
    folder.mkdir(parents=True,exist_ok=True)
    return folder,False


class Recorder:
    def __init__(self):
        self.root=tk.Tk();self.root.title('VAMP Recorder — VM to Robot RPA');self.root.geometry('760x510')
        self.root.configure(bg='#111827');style=ttk.Style();style.theme_use('clam')
        style.configure('TFrame',background='#111827');style.configure('TLabel',background='#111827',foreground='#e5e7eb')
        style.configure('TButton',font=('Segoe UI',11),padding=(12,9));style.configure('TCheckbutton',background='#111827',foreground='#e5e7eb')
        style.configure('Accent.TButton',background='#6750c8',foreground='white')
        self.active=False;self.recorded_input=False;self.events=[];self.pending=queue.Queue();self.lock=threading.Lock();self.last=0
        self.held=set();self.bounds=(0,0,0,0);self.last_saved=None;self.folder,self.shared=output_folder()
        frame=ttk.Frame(self.root,padding=22);frame.pack(fill='both',expand=True)
        ttk.Label(frame,text='VAMP  /  Recorder',font=('Segoe UI',22,'bold')).pack(anchor='w')
        ttk.Label(frame,text='Record in the VM at 1920 × 1080. Keep passwords and certificates out of recordings.').pack(anchor='w',pady=(8,14))
        self.status=tk.StringVar(value='Ready · F8 starts/stops recording')
        ttk.Label(frame,textvariable=self.status,font=('Segoe UI',12,'bold')).pack(anchor='w')
        self.path_label=ttk.Label(frame,text=('SHARED WITH HOST: ' if self.shared else 'LOCAL ONLY: ')+str(self.folder),wraplength=700)
        self.path_label.pack(anchor='w',pady=(8,12))
        buttons=ttk.Frame(frame);buttons.pack(fill='x')
        self.start_button=ttk.Button(buttons,text='● Start recording',style='Accent.TButton',command=self.start);self.start_button.pack(side='left',padx=(0,8))
        ttk.Button(buttons,text='■ Stop',command=self.stop).pack(side='left',padx=(0,8))
        ttk.Button(buttons,text='Save Python',command=self.save).pack(side='left')
        self.preview=tk.Text(frame,height=10,bg='#1f2937',fg='#a7f3d0',insertbackground='white',font=('Consolas',10),state='disabled')
        self.preview.pack(fill='both',expand=True,pady=14)
        bottom=ttk.Frame(frame);bottom.pack(fill='x')
        ttk.Button(bottom,text='Open save folder',command=self.open_folder).pack(side='left',padx=(0,8))
        ttk.Button(bottom,text='Copy last path',command=self.copy_path).pack(side='left')
        ttk.Label(frame,text='Tell the AI the saved host path + VM name + task goal. No auto-playback.',wraplength=700).pack(anchor='w',pady=(12,0))
        self.mouse=mouse.Listener(on_click=self.click);self.keyboard=keyboard.Listener(on_press=self.press,on_release=self.release)
        self.mouse.start();self.keyboard.start();self.root.protocol('WM_DELETE_WINDOW',self.close);self.root.after(50,self.poll)
        self.write_health()
        if sys.platform=='win32':
            script=Path(os.environ['LOCALAPPDATA'])/'VAMP/display/apply-display.py'
            if script.is_file():subprocess.Popen([sys.executable,str(script),'--attempts','2','--delay','3'])
    def write_health(self):
        try:
            (self.folder/'recorder-status.json').write_text(json.dumps({'status':'gui_open',
              'shared_with_host':self.shared,'recording_active':self.active,
              'native_resolution':[self.root.winfo_screenwidth(),self.root.winfo_screenheight()],
              'session_type':os.environ.get('XDG_SESSION_TYPE', 'windows' if sys.platform == 'win32' else 'unknown'),
              'timestamp':datetime.now(timezone.utc).isoformat()},indent=2)+'\n')
        except OSError:pass

    def add(self,code):
        with self.lock:
            if not self.active:return
            now=time.monotonic();delay=max(0,now-self.last);self.last=now
            self.recorded_input=True
            self.pending.put((delay,code))
    def click(self,x,y,button,pressed):
        if not pressed:return
        x0,y0,x1,y1=self.bounds
        if x0<=x<=x1 and y0<=y<=y1:return
        self.add(f'pyautogui.click(x={int(x)}, y={int(y)}, button={button.name!r})')
    @staticmethod
    def key_name(key):return getattr(key,'char',None) or getattr(key,'name',str(key))
    def press(self,key):
        if key==keyboard.Key.f8:self.pending.put(('toggle',None));return
        name=self.key_name(key)
        with self.lock:
            if not self.active or name in self.held:return
            self.held.add(name)
        self.add(f'pyautogui.keyDown({name!r})')
    def release(self,key):
        if key==keyboard.Key.f8:return
        name=self.key_name(key)
        with self.lock:
            if name not in self.held:return
            self.held.discard(name)
        self.add(f'pyautogui.keyUp({name!r})')
    def start(self):
        if self.active:return
        if sys.platform!='win32' and os.environ.get('XDG_SESSION_TYPE')=='wayland':
            messagebox.showwarning('X11 session required','Global recording requires GNOME on Xorg. Log out and choose that session.');return
        with self.lock:self.active=True;self.recorded_input=False;self.last=time.monotonic();self.held.clear()
        self.status.set('● RECORDING · F8 or Stop to pause');self.start_button.configure(state='disabled');self.write_health()
    def stop(self):
        with self.lock:
            elapsed=time.monotonic()-self.last if self.active and self.recorded_input else 0
            self.active=False
            for name in self.held:self.pending.put((0,f'pyautogui.keyUp({name!r})'))
            self.held.clear()
            if elapsed>0.001:self.pending.put((0,f'time.sleep({elapsed:.5f})'))
        self.start_button.configure(state='normal');self.status.set('Stopped · Save Python to share with the AI');self.write_health()
    def poll(self):
        self.bounds=(self.root.winfo_rootx(),self.root.winfo_rooty(),self.root.winfo_rootx()+self.root.winfo_width(),self.root.winfo_rooty()+self.root.winfo_height())
        while True:
            try:delay,code=self.pending.get_nowait()
            except queue.Empty:break
            if delay=='toggle':self.stop() if self.active else self.start();continue
            self.events.append((delay,code));self.preview.configure(state='normal');self.preview.insert('end',code+'\n');self.preview.see('end');self.preview.configure(state='disabled')
        self.root.after(50,self.poll)
    def save(self):
        self.stop()
        # Drain already queued events before serializing, without a nested Tk main loop.
        while not self.pending.empty():
            delay,code=self.pending.get_nowait()
            if delay!='toggle':self.events.append((delay,code))
        if not self.events:messagebox.showinfo('Nothing recorded','Start recording, perform the task, then stop and save.');return
        path=self.folder/('rpa_'+time.strftime('%Y%m%d_%H%M%S')+'_'+str(time.time_ns()%1000000)+'.py')
        lines=['import pyautogui','import time','']
        for delay,code in self.events:
            if delay>0.001:lines.append(f'time.sleep({delay:.5f})')
            if code.startswith('pyautogui.click('):
                label = simpledialog.askstring('Review recorded click', code + '\n\nEnter the visible button text, or yolo: followed by its specific detector class.\nLeave blank to save a draft that stops before this click.', parent=self.root)
                if label and label.strip():
                    value = label.strip()
                    target = {'yolo': value[5:].strip()} if value.startswith('yolo:') else {'ocr': value}
                    if not 1 <= len(next(iter(target.values()))) <= 120:
                        messagebox.showerror('Invalid target', 'Enter 1 to 120 characters. Recording is still available.')
                        return
                    code += '  # vamp-target ' + json.dumps(target, ensure_ascii=True)
            lines.append(code)
        try:
            path.write_text('\n'.join(lines)+'\n',encoding='utf-8');self.last_saved=path
            (path.with_suffix('.handoff.json')).write_text(json.dumps({'recording_path_in_guest':str(path),
                'shared_with_host':self.shared,'expected_native_resolution':[1920,1080],
                'resolution_verified':False,'source_executed':False},indent=2)+'\n')
            self.status.set('Saved: '+path.name);self.copy_path()
            messagebox.showinfo('Recording saved',str(path)+'\n\nPath copied. Tell the AI the VM name and desired outcome.')
        except OSError as exc:messagebox.showerror('Save failed',str(exc))
    def copy_path(self):
        path=str(self.last_saved or self.folder);self.root.clipboard_clear();self.root.clipboard_append(path)
    def open_folder(self):
        if sys.platform=='win32':os.startfile(self.folder)
        else:subprocess.Popen(['xdg-open',str(self.folder)])
    def close(self):
        self.stop();self.mouse.stop();self.keyboard.stop();self.root.destroy()

if __name__=='__main__':Recorder().root.mainloop()
