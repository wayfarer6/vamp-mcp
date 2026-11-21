# SPDX-License-Identifier: GPL-3.0-only
# VAMP recorder UI adaptation of axel-magard/PyAutoGUI-Recorder.
# Original source/license/provenance are bundled separately in recorder.zip.
# This derivative guest program remains GPL-3.0; host integration is MIT.
"""Visible, user-started recorder. Saves literal PyAutoGUI Python; never evals playback."""
import ast
import hashlib
import io
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
from tkinter import ttk,messagebox,simpledialog,filedialog
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


FALLBACK_NOTICE = ("Manual recording does not generate fallback code. "
                   "With verification on, a failed click check stops replay. Review the target or write a recovery step.")
MAX_CAPTURES = 120


def capture_folder(raw):
    digest = hashlib.sha256(raw).hexdigest()
    return Path.home() / '.vamp' / 'recorder-captures' / digest


def button_crop(x, y, size):
    from PIL import ImageGrab
    bounds = (max(0, x - 96), max(0, y - 48), min(size[0], x + 96), min(size[1], y + 48))
    image = ImageGrab.grab(bbox=bounds)
    output = io.BytesIO()
    image.save(output, format='PNG')
    return output.getvalue()


def click_lines(source):
    """Map single-line literal PyAutoGUI clicks without running the source."""
    tree = ast.parse(source)
    aliases = {a.asname or a.name for n in ast.walk(tree) if isinstance(n, ast.Import)
               for a in n.names if a.name == 'pyautogui'}
    rows = []
    for node in sorted((n for n in ast.walk(tree) if isinstance(n, ast.Call)), key=lambda n: n.lineno):
        fn = node.func
        if not (isinstance(fn, ast.Attribute) and isinstance(fn.value, ast.Name)
                and fn.value.id in aliases and fn.attr == 'click'):
            continue
        if node.lineno != node.end_lineno or len(node.args) > 2:
            raise ValueError('Use one single-line literal click per action.')
        args = [ast.literal_eval(a) for a in node.args]
        kw = {a.arg: ast.literal_eval(a.value) for a in node.keywords}
        if set(kw) - {'x', 'y', 'button'}:
            raise ValueError('Only single clicks with literal guest coordinates are supported.')
        x = args[0] if args else kw.get('x')
        y = args[1] if len(args) > 1 else kw.get('y')
        if type(x) is not int or type(y) is not int:
            raise ValueError('The click coordinates must be literal integers.')
        line = source.splitlines()[node.lineno-1].encode('utf8')
        tail = line[node.end_col_offset:].strip()
        if line[:node.col_offset].strip() or (tail and not tail.startswith(b'#')):
            raise ValueError('Put each recorded click on a separate line.')
        rows.append((node.lineno, node.end_col_offset, (x, y, kw.get('button', 'left'))))
    return rows


def checked_source(source, recording, labels):
    observed = click_lines(recording)
    target = click_lines(source)
    if [r[2] for r in target] != [r[2] for r in observed]:
        raise ValueError('The source clicks must match the recorded coordinates, buttons and order.')
    lines = source.splitlines()
    for (line, end, _), (recorded_line, _, _) in zip(target, observed):
        if recorded_line in labels:
            label = labels[recorded_line].strip()
            if not 1 <= len(label) <= 120:
                raise ValueError('Enter a detector class of 1 to 120 characters.')
            prefix = lines[line-1].encode('utf8')[:end].decode('utf8')
            lines[line-1] = prefix + '  # vamp-target ' + json.dumps({'yolo': label})
    return '\n'.join(lines) + '\n'


class Recorder:
    def __init__(self):
        self.root=tk.Tk();self.root.title('VAMP Recorder — VM to Robot RPA');self.root.geometry('780x575')
        self.root.configure(bg='#111827');style=ttk.Style();style.theme_use('clam')
        style.configure('TFrame',background='#111827');style.configure('TLabel',background='#111827',foreground='#e5e7eb')
        style.configure('TButton',font=('Segoe UI',11),padding=(12,9));style.configure('TCheckbutton',background='#111827',foreground='#e5e7eb')
        style.map('TCheckbutton', foreground=[('active', '#111827')])
        style.configure('Accent.TButton',background='#6750c8',foreground='white')
        self.capture_enabled = False
        self.crops = {}
        self.click_count = 0
        self.screen_size = (self.root.winfo_screenwidth(), self.root.winfo_screenheight())
        self.active=False;self.recorded_input=False;self.events=[];self.pending=queue.Queue();self.lock=threading.Lock();self.last=0
        self.held=set();self.bounds=(0,0,0,0);self.last_saved=None;self.folder,self.shared=output_folder()
        frame=ttk.Frame(self.root,padding=22);frame.pack(fill='both',expand=True)
        ttk.Label(frame,text='VAMP  /  Recorder',font=('Segoe UI',22,'bold')).pack(anchor='w')
        ttk.Label(frame,text='Record at 1920 × 1080. Keep credentials out of recordings.',wraplength=700).pack(anchor='w',pady=(8,14))
        self.status=tk.StringVar(value='Ready · F8 starts/stops recording')
        ttk.Label(frame,textvariable=self.status,font=('Segoe UI',12,'bold')).pack(anchor='w')
        self.path_label=ttk.Label(frame,text=('SHARED WITH HOST: ' if self.shared else 'LOCAL ONLY: ')+str(self.folder),wraplength=700)
        self.path_label.pack(anchor='w',pady=(8,12))
        buttons=ttk.Frame(frame);buttons.pack(fill='x')
        self.start_button=ttk.Button(buttons,text='● Start recording',style='Accent.TButton',command=self.start);self.start_button.pack(side='left',padx=(0,8))
        ttk.Button(buttons,text='■ Stop',command=self.stop).pack(side='left',padx=(0,8))
        ttk.Button(buttons,text='Save Python',command=self.save).pack(side='left')
        self.capture_option = tk.BooleanVar(value=False)
        self.capture_check = ttk.Checkbutton(frame, text='Keep button crops in this guest for later YOLO review',
                                             variable=self.capture_option)
        self.capture_check.pack(anchor='w', pady=(8,0))
        ttk.Label(frame, text=FALLBACK_NOTICE, wraplength=700).pack(anchor='w')
        self.preview=tk.Text(frame,height=4,bg='#1f2937',fg='#a7f3d0',insertbackground='white',font=('Consolas',10),state='disabled')
        self.preview.pack(fill='both',expand=True,pady=8)
        bottom=ttk.Frame(frame);bottom.pack(fill='x')
        ttk.Button(bottom,text='Open save folder',command=self.open_folder).pack(side='left',padx=(0,8))
        ttk.Button(bottom,text='Copy last path',command=self.copy_path).pack(side='left')
        ttk.Button(bottom,text='Generate YOLO draft',command=self.generate_draft).pack(side='left',padx=8)
        ttk.Label(frame,text='Share the host path, VM name and task goal after review.',wraplength=700).pack(anchor='w',pady=(12,0))
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

    def add(self,code,point=None):
        with self.lock:
            if not self.active:return
            now=time.monotonic();delay=max(0,now-self.last);self.last=now
            self.recorded_input=True
            self.pending.put((delay,code))
            if point is not None:
                self.click_count += 1
                if self.capture_enabled and len(self.crops) < MAX_CAPTURES:
                    try:
                        self.crops[self.click_count] = button_crop(*point, self.screen_size)
                    except (OSError, ValueError, ImportError, subprocess.SubprocessError):
                        pass  # Missing crops are reported on save; the action is still recorded.
    def click(self,x,y,button,pressed):
        if not pressed:return
        x0,y0,x1,y1=self.bounds
        if x0<=x<=x1 and y0<=y<=y1:return
        self.add(f'pyautogui.click(x={int(x)}, y={int(y)}, button={button.name!r})', (int(x), int(y)))
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
        self.capture_enabled = self.capture_option.get()
        self.capture_check.configure(state='disabled')
        with self.lock:self.active=True;self.recorded_input=False;self.last=time.monotonic();self.held.clear()
        self.status.set('● RECORDING · F8 or Stop to pause');self.start_button.configure(state='disabled');self.write_health()
    def stop(self):
        with self.lock:
            elapsed=time.monotonic()-self.last if self.active and self.recorded_input else 0
            self.active=False
            for name in self.held:self.pending.put((0,f'pyautogui.keyUp({name!r})'))
            self.held.clear()
            if elapsed>0.001:self.pending.put((0,f'time.sleep({elapsed:.5f})'))
        if hasattr(self, 'capture_check'):
            self.capture_check.configure(state='normal')
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
        crop_lines = {}
        click_number = 0
        for delay,code in self.events:
            if delay>0.001:lines.append(f'time.sleep({delay:.5f})')
            if code.startswith('pyautogui.click('):
                click_number += 1
                if click_number in self.crops:
                    crop_lines[len(lines) + 1] = self.crops[click_number]
                label = None if click_number in self.crops else simpledialog.askstring('Review recorded click', code + '\n\nEnter the visible button text, or yolo: followed by its specific detector class.\nLeave blank to save a draft that stops before this click.', parent=self.root)
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
                'resolution_verified':False,'source_executed':False,'fallback_generated':False,
                'button_crops_in_guest':len(crop_lines)},indent=2)+'\n')
            if crop_lines:
                directory = capture_folder(path.read_bytes())
                directory.mkdir(parents=True, exist_ok=True, mode=0o700)
                for line, content in crop_lines.items():
                    (directory / f'{line}.png').write_bytes(content)
            self.status.set('Saved: '+path.name);self.copy_path()
            messagebox.showinfo('Recording saved',str(path)+f'\n\nButton crops available: {len(crop_lines)} of {click_number}.\n'+FALLBACK_NOTICE)
        except OSError as exc:messagebox.showerror('Save failed',str(exc))
    def generate_draft(self):
        if self.active:
            messagebox.showinfo('Stop recording', 'Stop and save your recording before reviewing button crops.')
            return
        choose = lambda title: filedialog.askopenfilename(parent=self.root, title=title,
            initialdir=self.folder, filetypes=[('Python recordings', '*.py')])
        selected = choose('Choose the saved recording with button crops')
        if not selected:
            return
        try:
            recording_path = Path(selected)
            raw = recording_path.read_bytes()
            directory = capture_folder(raw)
            recording = raw.decode('utf-8-sig')
            if not directory.is_dir():
                raise ValueError('No button crops for this version in this guest. Enable capture and record again.')
            original = messagebox.askyesnocancel('Choose draft source',
                'Use the saved recording as the draft source? Choose No to select your matching PyAutoGUI script.')
            if original is None:
                return
            selected_source = selected if original else choose('Choose the matching PyAutoGUI source')
            if not selected_source:
                return
            path = Path(selected_source)
            source = path.read_text(encoding='utf-8-sig')
            checked_source(source, recording, {})  # Check alignment before prompting.
            labels = {}
            for line, _, point in click_lines(recording):
                crop = directory / f'{line}.png'
                if not crop.is_file():
                    continue
                photo = tk.PhotoImage(file=str(crop))
                class Review(simpledialog.Dialog):
                    def body(dialog, master):
                        ttk.Label(master, image=photo).pack()
                        ttk.Label(master, text=f'Click at {point[:2]}. Enter its specific local YOLO class.').pack()
                        ttk.Label(master, text='Leave blank to skip this click. Cancel discards the draft.').pack()
                        dialog.entry = ttk.Entry(master)
                        dialog.entry.pack()
                        return dialog.entry
                    def apply(dialog):
                        dialog.result = dialog.entry.get().strip()
                label = Review(self.root, 'Review captured button').result
                if label is None:
                    return
                if label:
                    labels[line] = label
            if not labels:
                raise ValueError('Choose at least one supported detector class to generate a draft.')
            draft = self.folder / (path.stem + '_yolo_' + str(time.time_ns()) + '.py')
            content = checked_source(source, recording, labels)
            with draft.open('x', encoding='utf8') as stream:
                stream.write(content)
            self.last_saved = draft
            self.copy_path()
            self.status.set('YOLO draft saved: ' + draft.name)
            messagebox.showinfo('YOLO draft saved', f'{len(labels)} click check(s) added. Review and register the draft in RPA Library.\n' + FALLBACK_NOTICE)
        except (OSError, SyntaxError, UnicodeError, ValueError, TypeError, tk.TclError) as exc:
            messagebox.showerror('Cannot generate YOLO draft', str(exc))

    def copy_path(self):
        path=str(self.last_saved or self.folder);self.root.clipboard_clear();self.root.clipboard_append(path)
    def open_folder(self):
        if sys.platform=='win32':os.startfile(self.folder)
        else:subprocess.Popen(['xdg-open',str(self.folder)])
    def close(self):
        self.stop();self.mouse.stop();self.keyboard.stop();self.root.destroy()

if __name__=='__main__':Recorder().root.mainloop()
