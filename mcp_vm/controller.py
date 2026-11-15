"""Backend-aware MCP operations. Subprocess output never leaks into MCP stdout."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import uuid
from rpa_package import ROOT,load_package

VARIABLES={'ACTION','TEXT','X','Y','DX','DY','KEYS','TEMPLATE','LANGUAGES','DEVICE',
           'NAVER_URL','CREDENTIAL_SOURCE','VM_CONFIG','APT_TIMEOUT','ALLOW_REPLAY','EXPECTED_TEXT'}


class VMController:
    def __init__(self,config=None):
        self.config_path=Path(config or os.environ.get('VM_MCP_CONFIG',ROOT/'config/vm-mcp.json')).resolve()
        self.config=json.loads(self.config_path.read_text())
        self.locks={name:threading.Lock() for name in self.config['vms']}
        self.jobs_root=ROOT/'artifacts/mcp'

    def command(self,args,timeout=30):
        try:
            return subprocess.run([str(v) for v in args],cwd=ROOT,capture_output=True,text=True,
                                  timeout=timeout,check=False,env={**os.environ,'LC_ALL':'C'})
        except subprocess.TimeoutExpired:
            raise TimeoutError('Host command timed out; guest-side work may still be active') from None

    def virsh(self,*args):
        result=self.command(['virsh','-c',self.config.get('libvirt_uri','qemu:///system'),*args])
        if result.returncode:raise RuntimeError(result.stderr.strip()[:300] or 'libvirt command failed')
        return result.stdout.strip()

    def list_vms(self):
        if sys.platform=='win32':
            command='Get-VM | Select-Object Name,@{n="State";e={[string]$_.State}} | ConvertTo-Json -Compress'
            result=self.command(['powershell.exe','-NoLogo','-NoProfile','-Command',command])
            if result.returncode:raise RuntimeError('Hyper-V VM inventory failed; check host privileges/module')
            rows=json.loads(result.stdout or '[]');rows=[rows] if isinstance(rows,dict) else rows
            return {'status':'observed','backend':'hyperv','vms':[{'name':row['Name'],'state':row['State'],
                     'backend':'hyperv','console_launch_implemented':True,'rdp_input_implemented':False} for row in rows]}
        names=set(self.virsh('list','--all','--name').splitlines())
        rows=[]
        for name,profile in self.config['vms'].items():
            row={'name':name,**profile,'exists':name in names}
            if name in names:
                row['state']=self.virsh('domstate',name)
                if row['state']=='running':row['uri']=self.virsh('domdisplay',name)
            rows.append(row)
        return {'status':'observed','vms':rows}

    def profile(self,vm_name):
        if vm_name not in self.config['vms']:raise ValueError('VM is not present in config/vm-mcp.json')
        profile=self.config['vms'][vm_name]
        if profile['backend']!='spice':raise ValueError('This operation needs the SPICE backend; Hyper-V uses its separate console tool')
        if self.virsh('domstate',vm_name)!='running':raise ValueError('VM is not running; explicitly start it first')
        uri=self.virsh('domdisplay',vm_name)
        if not uri.startswith(('spice://','spice+unix://')):raise ValueError('VM does not expose a SPICE display')
        return profile,uri

    def packages(self):
        rows=[]
        for path in sorted((ROOT/'rpas').glob('*/manifest.json')):
            _,manifest=load_package(path.parent.name)
            rows.append({'id':manifest['id'],'name':manifest['name'],'version':manifest['version'],
                         'default_entrypoint':manifest['default_entrypoint'],'entrypoints':manifest['entrypoints']})
        return {'status':'observed','rpas':rows}

    def run_rpa(self,vm_name,rpa_id,entry='run',variables=None,timeout=600):
        variables=variables or {}
        if any(key not in VARIABLES or not isinstance(value,str) for key,value in variables.items()):
            raise ValueError('Unsupported Robot variable; do not pass private credentials as variables')
        if not 1<=timeout<=1800:raise ValueError('Timeout must be between 1 and 1800 seconds')
        profile,uri=self.profile(vm_name)
        if rpa_id not in profile.get('supported_rpas',[]):raise ValueError('RPA is not configured for this guest OS/VM')
        _,manifest=load_package(rpa_id)
        if entry not in {item['name'] for item in manifest['entrypoints']}:raise ValueError('Unknown RPA entrypoint')
        run_id=uuid.uuid4().hex[:12];output=self.jobs_root/run_id;output.mkdir(parents=True)
        args=[sys.executable,str(ROOT/'scripts/run_rpa.py'),rpa_id,'--entry',entry,'--output',str(output),
              '--var','SPICE_URI:'+uri]
        for key,value in variables.items():args.extend(['--var',key+':'+value])
        try:
            with self.locks[vm_name]:result=self.command(args,timeout=timeout)
        except TimeoutError:
            return {'status':'controller_timeout_unverified','vm_name':vm_name,'run_id':run_id,
                    'error_summary':'Controller timed out; guest command may still be running. Inspect before retry.',
                    'report_path':str(output/'report.html')}
        (output/'process.log').write_text(result.stdout+'\n'+result.stderr)
        summary_path=output/'summary.json'
        summary=json.loads(summary_path.read_text()) if summary_path.is_file() else {
            'status':'error','error_summary':'RPA did not write a summary; inspect the local process/Robot log'}
        return {**summary,'vm_name':vm_name,'run_id':run_id,'robot_exit_code':result.returncode,
                'summary_path':str(summary_path),'report_path':str(output/'report.html')}

    def inspect(self,vm_name,mode='ocr',languages='ko,en,ja,zh',query='',offset=0,limit=10):
        if mode not in ('ocr','analyze','screen-info'):raise ValueError('Mode must be ocr, analyze or screen-info')
        summary=self.run_rpa(vm_name,'desktop_control',variables={'ACTION':mode,'LANGUAGES':languages})
        if summary.get('details_path'):
            evidence=self.read_evidence(summary['details_path'],offset,limit,query)
            return {**summary,'observation':evidence}
        return summary

    def input(self,vm_name,action,text='',x=0,y=0,keys=''):
        if action not in ('click','move','write','hotkey'):raise ValueError('Unsupported VM input action')
        return self.run_rpa(vm_name,'desktop_control',variables={
            'ACTION':action,'TEXT':text,'X':str(x),'Y':str(y),'KEYS':keys})

    def capture(self,vm_name):
        return self.run_rpa(vm_name,'desktop_control',variables={'ACTION':'capture'})

    def start_vm(self,vm_name):
        if vm_name not in self.config['vms']:raise ValueError('VM is not configured')
        if self.config['vms'][vm_name]['backend']!='spice':raise ValueError('Use the Hyper-V console tool for Hyper-V startup')
        state=self.virsh('domstate',vm_name)
        if state=='running':return {'status':'already_running','vm_name':vm_name}
        if state not in ('shut off','shutoff'):raise ValueError('VM is not Off; inspect its state before starting')
        self.virsh('start',vm_name)
        return {'status':'start_requested','vm_name':vm_name}

    def models(self,action='status'):
        if sys.platform=='win32':return {'status':'not_implemented','message':'Persistent model workers currently use Unix sockets; no native Windows port is claimed'}
        if action not in ('start','status','stop','restart'):raise ValueError('Unknown model action')
        result=self.command([sys.executable,ROOT/'scripts/model_service.py',action],timeout=600)
        if result.returncode:raise RuntimeError(result.stderr[-300:] or 'Model process operation failed')
        return json.loads(result.stdout)

    def hyperv_console(self,vm_name,server='localhost',start_vm=False):
        if sys.platform!='win32':return {'status':'unsupported_host','backend':'hyperv','message':'Run this tool on your Windows Hyper-V host'}
        args=[sys.executable,ROOT/'backends/hyperv/scripts/vmconnect.py','--vm',vm_name,'--server',server]
        if start_vm:args.append('--start-vm')
        result=self.command(args,timeout=240)
        try:return json.loads(result.stdout)
        except ValueError:raise RuntimeError('Hyper-V launcher returned no structured result') from None

    def read_evidence(self,path,offset=0,limit=10,query=''):
        if offset<0 or not 1<=limit<=30:raise ValueError('Use offset>=0 and limit between 1 and 30')
        target=Path(path);target=(ROOT/target).resolve() if not target.is_absolute() else target.resolve()
        if not target.is_relative_to((ROOT/'artifacts').resolve()) or target.suffix!='.json':
            raise ValueError('Only JSON evidence under repository artifacts is exposed')
        if target.stat().st_size>16*1024*1024:raise ValueError('Evidence is too large')
        data=json.loads(target.read_text())
        if isinstance(data,list):items=data
        else:items=next((data[key] for key in ('elements','lines','targets') if isinstance(data.get(key),list)),None)
        if items is None:
            return {key:data[key] for key in ('status','error_summary','verification','rpa_id','root_verified','root_shell_exited') if key in data}
        if query:items=[item for item in items if query.casefold() in str(item.get('text','')).casefold()]
        rows=[]
        for item in items[offset:offset+limit]:
            row={key:item[key] for key in ('id','kind','text','language','confidence','ocr_confidence','xyxy','center') if key in item}
            if 'text' in row:row['text']=str(row['text'])[:300]
            rows.append(row)
        return {'total':len(items),'offset':offset,'items':rows,'details_path':str(target)}
