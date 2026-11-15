"""Robot demo library. Real FHD VM footage, padded without scaling to QHD."""
import asyncio
import json
from pathlib import Path
import subprocess
import sys
import threading
import time
ROOT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT/'backends/virtualbox'))
from client import request
from provision import executable,parse

class Workflow:
    ROBOT_LIBRARY_SCOPE='SUITE'
    def __init__(self):self.vm=None
    def vbox(self,*args):
        r=subprocess.run([executable(),*map(str,args)],capture_output=True,text=True,timeout=90)
        if r.returncode:raise RuntimeError(r.stderr[-1000:] or r.stdout[-1000:])
        return r.stdout
    def begin_demo(self,vm,name,title):
        info=parse(self.vbox('showvminfo',vm,'--machinereadable'))
        if info.get('VMState')!='running':raise ValueError('Start and unlock the test VM first')
        if info.get('recording_started')=='on':raise ValueError('Another recording is active')
        if not name.replace('-','').isalnum():raise ValueError('Invalid demo name')
        self.name=name;self.title=title;self.events=[];self.started=time.monotonic()
        self.folder=ROOT/'artifacts/demos'/(name+'-'+time.strftime('%Y%m%d-%H%M%S'))
        self.folder.mkdir(parents=True)
        self.vm=vm
        self.frames=[];self.capture_errors=[];self.stop_capture=threading.Event()
        def capture_frames():
            while not self.stop_capture.is_set():
                started=time.monotonic();path=self.folder/('frame-%05d.png'%len(self.frames))
                try:
                    self.vbox('controlvm',vm,'screenshotpng',path)
                    self.frames.append((time.monotonic()-self.started,path))
                except Exception as exc:
                    self.capture_errors.append(str(exc));break
                self.stop_capture.wait(max(0,.5-(time.monotonic()-started)))
        self.capture_thread=threading.Thread(target=capture_frames,daemon=True)
        self.capture_thread.start()
    def mark(self,text):self.events.append({'seconds':round(time.monotonic()-self.started,2),'text':text})
    def tool(self,name,arguments='{}',screenshot=''):
        result=asyncio.run(request(name,json.loads(arguments),screenshot or None));self.mark(name+' completed')
        (self.folder/(name+'-'+str(len(self.events))+'.json')).write_text(json.dumps(result,indent=2),encoding='utf-8')
        return result
    def verify_text(self,text):
        shot=self.folder/'assertion.png';self.vbox('controlvm',self.vm,'screenshotpng',shot)
        sys.path.insert(0,str(ROOT))
        from model_daemon import request as infer
        result=infer('ocr',{'op':'predict','image':str(shot),'languages':['en']})
        found=' '.join(l['text'] for l in result['lines'])
        (self.folder/'ocr.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
        if text.lower() not in found.lower():raise AssertionError(f'OCR missing {text!r}: {found[:400]}')
        self.mark('OCR verified: '+text)
    def verify_saved_recording(self,vm,share,x,y):
        import ast
        candidates=[p for p in Path(share).glob('rpa_*.py') if p.stat().st_mtime>=time.time()-(time.monotonic()-self.started)-2]
        if not candidates:raise AssertionError('No new recording saved in the host share')
        path=max(candidates,key=lambda p:p.stat().st_mtime)
        result=self.tool('vm_recording_share',json.dumps({'vm':vm,'action':'inspect','filename':path.name}))
        source=path.read_text(encoding='utf-8')
        found=False
        for node in ast.walk(ast.parse(source)):
            if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and node.func.attr=='click':
                values={k.arg:ast.literal_eval(k.value) for k in node.keywords}
                if values.get('x')==int(x) and values.get('y')==int(y):found=True
        if not found:raise AssertionError('Expected click missing from saved source')
        if path.name not in json.dumps(result):raise AssertionError('MCP did not inspect the chosen saved source')
        self.mark('Saved source verified without execution: click (%s, %s)'%(x,y))
    def prepare_windows_host_launcher(self,share,repo,node,output):
        def quote(value):return "'"+str(value).replace("'", "''")+"'"
        (Path(share)/'host-launch.ps1').write_text("& "+quote(repo+'/scripts/windows/stdio-demo.ps1')+
            " -NodeDirectory "+quote(node)+" -OutputDirectory "+quote(output)+"\n",encoding='utf-8')
    def verify_windows_host_report(self,share):
        path=Path(share)/'host-demo/result.json'
        if path.stat().st_mtime < time.time()-(time.monotonic()-self.started)-2:
            raise AssertionError('Windows report predates this Robot run')
        report=json.loads(path.read_text(encoding='utf-8'))
        if report.get('status')!='passed' or not report.get('host','').startswith('Windows'):
            raise AssertionError('Windows-host checks did not pass')
        expected={'vm_list','vamp_setup','vm_run_history'}
        if not expected.issubset({c['tool'] for c in report['checks']}):
            raise AssertionError('Missing required stdio checks')
        (self.folder/'windows-host-verification.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        self.mark('Fresh Windows-host JSON verified: inventory, setup and history')
    def prepare_nested_launcher(self,folder,repo,node,vm,output,shared_output):
        def quote(value):
            return "'"+str(value).replace("'", "''")+"'"
        path=Path(folder).parent/'nested-launch.ps1'
        path.write_text("& "+quote(repo+'/scripts/windows/nested-demo.ps1')+
            " -VM "+quote(vm)+" -NodeDirectory "+quote(node)+
            " -OutputDirectory "+quote(output)+" -SharedOutput "+quote(shared_output)+"\n",encoding='utf-8')
    def verify_nested_firmware(self,folder):
        folder=Path(folder)
        report_path=folder/'nested-result.json'
        if report_path.stat().st_mtime < time.time()-(time.monotonic()-self.started)-2:
            raise AssertionError('Nested report predates this Robot run')
        report=json.loads(report_path.read_text(encoding='utf-8'))
        if report['status']!='transport_passed_visual_assertion_pending':raise AssertionError(report.get('error',report['status']))
        sys.path.insert(0,str(ROOT))
        from model_daemon import request as infer
        result=infer('ocr',{'op':'predict','image':str(folder/'nested.png'),'languages':['en']})
        found=' '.join(line['text'] for line in result['lines'])
        before=infer('ocr',{'op':'predict','image':str(folder/'nested-before.png'),'languages':['en']})
        before_text=' '.join(line['text'] for line in before['lines'])
        if 'Boot Manager Menu' not in before_text or 'devicemanager' not in ''.join(found.lower().split()):
            raise AssertionError('EFI menu transition missing: '+before_text[:300]+' -> '+found[:400])
        (self.folder/'nested-verification.json').write_text(json.dumps({'windows_report':report,'ocr':result,'before_ocr':before,'visual_assertion':'passed; ESC changed Boot Manager Menu to firmware main menu','installed_guest_os_tested':False},indent=2),encoding='utf-8')
        self.mark('Windows-host nested VM firmware menu transition verified by OCR')
    def finish_demo(self,status):
        if not self.vm:return
        self.stop_capture.set();self.capture_thread.join(timeout=95);self.vm=None
        self.mark('Robot '+status)
        (self.folder/'timeline.json').write_text(json.dumps(self.events,indent=2),encoding='utf-8')
        if status!='PASS':return
        if self.capture_thread.is_alive() or self.capture_errors:raise RuntimeError('Screen capture failed: '+str(self.capture_errors))
        if len(self.frames)<2:raise RuntimeError('Not enough captured frames')
        import imageio_ffmpeg
        ff=imageio_ffmpeg.get_ffmpeg_exe()
        from PIL import Image
        for _,path in self.frames:
            with Image.open(path) as frame:
                if frame.size!=(1920,1080):raise AssertionError('Guest resolution changed during capture')
        concat=[]
        for i,(stamp,path) in enumerate(self.frames):
            concat.append("file '"+path.name+"'")
            duration=self.frames[i+1][0]-stamp if i+1<len(self.frames) else .5
            concat.append('duration %.6f'%duration)
        concat.append("file '"+self.frames[-1][1].name+"'")
        (self.folder/'frames.txt').write_text('\n'.join(concat)+'\n')
        dest=ROOT/'docs/media';dest.mkdir(exist_ok=True);out=dest/(self.name+'.mp4')
        (self.folder/'caption.txt').write_text(self.title+'\nReal VM screen captures (~2 fps), native FHD on a QHD canvas | Robot + MCP',encoding='utf-8')
        cmd=[ff,'-y','-f','concat','-safe','0','-i',str(self.folder/'frames.txt'),'-vf','pad=2560:1440:(ow-iw)/2:(oh-ih)/2:color=0x111827,drawtext=textfile=caption.txt:fontcolor=white:fontsize=28:x=80:y=55','-r','10','-an','-c:v','libx264','-preset','fast','-crf','27','-pix_fmt','yuv420p','-movflags','+faststart',str(out)]
        r=subprocess.run(cmd,cwd=self.folder,capture_output=True,timeout=180)
        if r.returncode:raise RuntimeError(r.stderr.decode()[-1800:])
        subprocess.run([ff,'-y','-i',str(out),'-t','8','-vf','fps=2,scale=640:-1',str(dest/(self.name+'.gif'))],capture_output=True,check=True,timeout=90)
        subprocess.run([ff,'-v','error','-i',str(out),'-f','null','-'],capture_output=True,check=True,timeout=90)
        import cv2
        cap=cv2.VideoCapture(str(out));dims=[int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))];cap.release()
        if dims!=[2560,1440] or out.stat().st_size>20*1024*1024:raise AssertionError('Invalid size/dimensions')
        (dest/(self.name+'.json')).write_text(json.dumps({'robot_passed':True,'capture_method':'timestamped VM screenshots, nominal 2 fps','captured_frames':len(self.frames),'native_resolution':[1920,1080],'delivery_resolution':dims,'upscaled':False,'bytes':out.stat().st_size,'timeline':self.events},indent=2),encoding='utf-8')


_library = Workflow()
begin_demo = _library.begin_demo
mark = _library.mark
tool = _library.tool
verify_text = _library.verify_text
verify_saved_recording = _library.verify_saved_recording
verify_nested_firmware = _library.verify_nested_firmware
finish_demo = _library.finish_demo

prepare_nested_launcher = _library.prepare_nested_launcher

prepare_windows_host_launcher = _library.prepare_windows_host_launcher
verify_windows_host_report = _library.verify_windows_host_report
