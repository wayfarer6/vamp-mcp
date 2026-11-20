"""Save a reviewed recorder definition in its own local Git repository."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT))
from recording_converter import parse_recording


def git(folder,*args,check=True):
    try:p=subprocess.run(['git','-C',str(folder),*args],capture_output=True,text=True,timeout=30)
    except FileNotFoundError:raise ValueError('Git is required for per-RPA version history. Install Git and try again') from None
    if check and p.returncode:raise ValueError('RPA Git operation failed: '+p.stderr.strip()[:300])
    return p.stdout.strip()


def validate_recording_request(request):
    title=str(request.get('title','')).strip();description=str(request.get('description','')).strip()
    if not 1<=len(title)<=120 or not 10<=len(description)<=4000:raise ValueError('Enter a title and a description of at least 10 characters')
    backend=request.get('backend','virtualbox')
    if backend not in ('virtualbox','kvm'):raise ValueError('Recorded replay supports VirtualBox or KVM; Hyper-V desktop input is not implemented')
    width=int(request.get('width',1920));height=int(request.get('height',1080))
    if not 320<=width<=16384 or not 200<=height<=16384:raise ValueError('Enter the recorded guest screen resolution')
    source=Path(request['source_path']).resolve(strict=True)
    if source.suffix.lower()!='.py' or source.stat().st_size>5_000_000:raise ValueError('Choose a Python recorder script under 5 MB')
    raw=source.read_bytes();actions=parse_recording(raw.decode('utf-8-sig'),width,height)
    names=request.get('inputs',[])
    if not isinstance(names,list) or len(names)>20 or any(not isinstance(n,str) or not re.fullmatch('[A-Za-z_][A-Za-z0-9_]{0,63}',n) for n in names):raise ValueError('Input names must contain only letters, digits and underscores')
    for name in names:
        if not any('${'+name+'}' in a.get('text','') for a in actions):raise ValueError(f'Input {name} has no ${{{name}}} placeholder in the recorded text')
    if len(actions)>10000 or any(a.get('seconds',0)>60 or a.get('interval',0)>10 or a.get('presses',0)>1000 or a.get('clicks',0)>1000 for a in actions):raise ValueError('Split large recordings or long delays into smaller tasks')
    return title,description,backend,width,height,raw,actions,names


def validate_revision(request):
    _,_,backend,width,height,raw,actions,names=validate_recording_request(request)
    if not actions:
        raise ValueError('A repair must contain at least one recorded action')
    return {
        'status':'static_validation_passed','backend':backend,'resolution':[width,height],
        'inputs':names,'action_count':len(actions),'source_sha256':hashlib.sha256(raw).hexdigest(),
        'source_executed':False,'guest_verified':False,'committed':False,
    }


def register(root,request):
    title,description,backend,width,height,raw,actions,names=validate_recording_request(request)
    root=Path(root).resolve();root.mkdir(parents=True,exist_ok=True,mode=0o700)
    git(root,'--version')
    identifier=str(uuid.UUID(request['id'])) if request.get('id') else str(uuid.uuid4())
    folder=root/identifier;previous=None
    if request.get('id'):
        previous=json.loads((folder/'rpa.json').read_text(encoding='utf8'))
        if previous.get('format')!='vamp-saved-rpa':raise ValueError('Unknown editable definition')
    start_text = request.get('start_text', (previous or {}).get('start_text', ''))
    if not isinstance(start_text, str) or len(start_text.strip()) > 240:
        raise ValueError('Starting-screen text must be at most 240 characters')
    start_text = start_text.strip()
    if previous is None:folder.mkdir(mode=0o700)
    folder.chmod(0o700)
    lock=folder/'.rpa-save.lock'
    try:fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    except FileExistsError:raise ValueError('Another update is saving this RPA. Retry after it finishes') from None
    try:
        os.close(fd)
        if request.get('expected_commit') and git(folder,'rev-parse','HEAD')!=request['expected_commit']:raise ValueError('RPA changed since it was read. Read the latest revision before repairing')
        if request.get('expected_commit') and git(folder,'status','--porcelain','--untracked-files=no'):
            raise ValueError('The RPA has uncommitted changes. Preserve them before repairing')
        version='1.0.0'
        if previous:
            old=str(previous.get('version','1.0.0')).split('.');version='.'.join(old[:2]+[str(int(old[2])+1)])
        definition={'format':'vamp-saved-rpa','id':identifier,'name':title,'description':description,
          'when_to_use':str(request.get('when_to_use',''))[:2000],'expected_result':str(request.get('expected_result',''))[:2000],
          'tags':[str(t).strip()[:80] for t in request.get('tags',[])[:20] if str(t).strip()],
          'inputs':names,'backend':backend,'resolution':[width,height],'reviewed':request.get('reviewed') is True,
          'version':version,'entrypoints':[{'name':'run','file':'source.py'}],
          'source_sha256':hashlib.sha256(raw).hexdigest(),'action_count':len(actions),'source_executed':False}
        if start_text:
            definition['start_text'] = start_text
        encoded=(json.dumps(actions,ensure_ascii=False,indent=2)+'\n').encode();definition['actions_sha256']=hashlib.sha256(encoded).hexdigest()
        (folder/'source.py').write_bytes(raw);(folder/'actions.json').write_bytes(encoded)
        (folder/'rpa.json').write_text(json.dumps(definition,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
        (folder/'README.md').write_text(f'# {title}\n\n{description}\n\n## When to use\n\n{definition["when_to_use"]}\n\n## Expected result\n\n{definition["expected_result"]}\n\nVersion: {version}. Backend: {backend}. Recorded resolution: {width}×{height}.\n\nParsed without executing source. Agent replay needs review and explicit confirmation. Inputs use ${{name}} placeholders. completed_unverified requires application-result verification. This folder has independent local Git history; exports include the latest committed files without .git.\n',encoding='utf8')
        (folder/'.gitignore').write_text('.rpa-save.lock\n*.part\n',encoding='utf8')
        for file in folder.iterdir():
            if file.is_file():file.chmod(0o600)
        if not(folder/'.git').is_dir():git(folder,'init','--quiet')
        git(folder,'add','--','source.py','actions.json','rpa.json','README.md','.gitignore')
        message=str(request.get('commit_message') or f'{"Update" if previous else "Create"} {title} v{version}')[:200]
        git(folder,'-c','user.name=VAMP','-c','user.email=vamp@localhost','commit','--quiet','-m',message)
        return {'status':'registered','definition':definition,'folder':str(folder),'commit':git(folder,'rev-parse','HEAD')}
    finally:lock.unlink(missing_ok=True)

if __name__=='__main__':
    try:
        request=json.load(sys.stdin)
        root=request.pop('registry')
        result=validate_revision(request) if request.pop('validate_only',False) else register(root,request)
        print(json.dumps(result,ensure_ascii=False))
    except Exception as error:print(json.dumps({'status':'error','message':str(error)}));sys.exit(1)
