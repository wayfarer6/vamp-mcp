"""Save a reviewed recorder definition in its own local Git repository."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
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


@contextmanager
def scratch_stage(name):
    try:
        yield
    except Exception as error:
        error.scratch_stage = name
        raise


def scratch_failure(request, error):
    from backends.virtualbox.history import capture, now, record_event_run

    result = {'status': 'error', 'message': str(error), 'committed': False,
              'verification_stage': error.scratch_stage}
    try:
        rpa_id = str(uuid.UUID(request['id']))
    except (TypeError, ValueError, AttributeError):
        return result
    expected_commit = request['expected_commit']
    if not isinstance(expected_commit, str) or not re.fullmatch(r'[a-f0-9]{40}', expected_commit):
        return result
    payload = {'rpa_id': rpa_id, 'stage': error.scratch_stage,
               'expected_commit': expected_commit, 'committed': False}
    observed = getattr(error, 'observed_occurrences', None)
    if observed is not None:
        payload['ocr_comparison'] = {'expected_occurrences': error.expected_occurrences,
                                     'observed_occurrences': observed}
        result['ocr_comparison'] = payload['ocr_comparison']
    try:
        result['run_id'] = record_event_run(request['scratch_vm'], 'scratch_verification_failed',
                                            'repair_verification', payload, now())
    except (OSError, sqlite3.Error):
        result['history_status'] = 'unavailable'
    if result.get('run_id') and os.environ.get('VAMP_REPAIR_CAPTURE_FAILURE') == '1':
        from backends.library.scratch import require_virtualbox_scratch
        try:
            require_virtualbox_scratch(request['scratch_vm'])
            capture(result['run_id'], 'after-repair-failure')
            result['failure_screenshot'] = 'saved'
        except (ValueError, OSError, RuntimeError, sqlite3.Error, subprocess.SubprocessError):
            result['failure_screenshot'] = 'unavailable'
    return result


def test_revision(request):
    import asyncio

    from backends.library.replay import VBox, replay, substitute_inputs, vault_references
    from backends.library.scratch import (
        require_virtualbox_scratch, scratch_artifact_hash, scratch_artifact_settings, scratch_modal_settings,
    )

    _, _, backend, width, height, raw, actions, names = validate_recording_request(request)
    if not actions or backend != 'virtualbox':
        raise ValueError('Scratch replay requires a nonempty VirtualBox recording.')
    outcome = request.get('outcome_text')
    if not isinstance(outcome, str) or not 1 <= len(outcome.strip()) <= 240:
        raise ValueError('Supply the exact expected outcome text.')
    substitute_inputs(actions, names, request.get('test_inputs', {}))
    if vault_references(actions):
        raise ValueError('Scratch replay accepts synthetic inputs without Vault references.')
    promote = bool(request.get('commit_after_test'))
    modal = scratch_modal_settings(required=promote)
    artifact = scratch_artifact_settings() if promote else None
    vm = require_virtualbox_scratch(request.get('scratch_vm'))
    if artifact:
        with scratch_stage('baseline_artifact'):
            if scratch_artifact_hash(vm, artifact) != artifact[3]:
                raise ValueError('The scratch output does not match its reset baseline.')
    async def run():
        return await asyncio.wait_for(replay(
            VBox(vm), actions, [width, height],
            start_text=request.get('start_text') or None, outcome_text=outcome.strip(),
            require_new_outcome=artifact is not None,
            forbidden_modal=modal,
        ), timeout=600)
    with scratch_stage('screen_replay'):
        completed = asyncio.run(run())
    if artifact:
        with scratch_stage('result_artifact'):
            require_virtualbox_scratch(vm)
            if scratch_artifact_hash(vm, artifact) != artifact[4]:
                raise ValueError('The scratch output SHA-256 does not match the expected result.')
    return {
        'status': 'scratch_verified' if artifact else 'scratch_screen_verified', 'actions_completed': completed,
        'source_sha256': hashlib.sha256(raw).hexdigest(),
        'guest_verified': True, 'artifact_verified': bool(artifact), 'modal_check_verified': modal is not None,
        'committed': False,
    }


def register(root,request):
    title,description,backend,width,height,raw,actions,names=validate_recording_request(request)
    source_hash=hashlib.sha256(raw).hexdigest()
    if request.get('verified_source_hash') and source_hash!=request['verified_source_hash']:
        raise ValueError('The candidate source changed after scratch verification.')
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
          'source_sha256':source_hash,'action_count':len(actions),'source_executed':False}
        if start_text:
            definition['start_text'] = start_text
        encoded=(json.dumps(actions,ensure_ascii=False,indent=2)+'\n').encode();definition['actions_sha256']=hashlib.sha256(encoded).hexdigest()
        (folder/'source.py').write_bytes(raw);(folder/'actions.json').write_bytes(encoded)
        (folder/'rpa.json').write_text(json.dumps(definition,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
        (folder/'README.md').write_text(f'# {title}\n\n{description}\n\n## When to use\n\n{definition["when_to_use"]}\n\n## Expected result\n\n{definition["expected_result"]}\n\nVersion: {version}. Backend: {backend}. Recorded resolution: {width}×{height}.\n\nParsed without executing source. Agent replay needs review and explicit confirmation. Inputs use ${{name}} placeholders. completed_unverified requires application-result verification. This folder has independent local Git history; exports include the latest committed files without .git.\n',encoding='utf8')
        (folder/'.gitignore').write_text('.rpa-save.lock\n*.part\n',encoding='utf8')
        # These digests cover the exact verified bytes. Preserve them on checkout
        # even when the host enables CRLF conversion for ordinary text files.
        (folder/'.gitattributes').write_bytes(b'/source.py -text\n/actions.json -text\n')
        for file in folder.iterdir():
            if file.is_file():file.chmod(0o600)
        if not(folder/'.git').is_dir():git(folder,'init','--quiet')
        git(folder,'add','--','source.py','actions.json','rpa.json','README.md','.gitignore','.gitattributes')
        message=str(request.get('commit_message') or f'{"Update" if previous else "Create"} {title} v{version}')[:200]
        git(folder,'-c','user.name=VAMP','-c','user.email=vamp@localhost','commit','--quiet','-m',message)
        return {'status':'registered','definition':definition,'folder':str(folder),'commit':git(folder,'rev-parse','HEAD')}
    finally:lock.unlink(missing_ok=True)

def test_and_commit(root, request):
    if not request.get('expected_commit') or not request.get('id'):
        raise ValueError('Scratch promotion requires an existing RPA and expected commit.')
    identifier=str(uuid.UUID(request['id']))
    folder=Path(root).resolve()/identifier
    expected=request['expected_commit']
    if not re.fullmatch(r'[a-f0-9]{40}',expected) or git(folder,'rev-parse','HEAD')!=expected:
        raise ValueError('RPA changed since it was read. Read the latest revision before repairing.')
    candidate={**request,'commit_after_test':True,'reviewed':False}
    result=test_revision(candidate)
    if result['status'] != 'scratch_verified' or not all(
            result.get(key) is True for key in ('guest_verified', 'modal_check_verified', 'artifact_verified')):
        raise ValueError('Screen, modal and artifact verification are required before promotion.')
    with TemporaryDirectory(prefix='vamp-repair-stage-') as temporary:
        staging=Path(temporary)
        clone=staging/identifier
        git(staging,'clone','--quiet','--no-hardlinks','--',str(folder),str(clone))
        git(clone,'checkout','--quiet','--detach',expected)
        saved=register(staging,{**candidate,'verified_source_hash':result['source_sha256']})
        lock=folder/'.rpa-save.lock'
        try:
            fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
        except FileExistsError as error:
            raise ValueError('Another update is saving this RPA. Retry after it finishes') from error
        try:
            os.close(fd)
            if git(folder,'rev-parse','HEAD')!=expected or git(folder,'status','--porcelain','--untracked-files=no'):
                raise ValueError('The saved RPA changed during verification. Preserve the current revision.')
            git(folder,'fetch','--quiet','--no-tags','--',str(clone),saved['commit'])
            git(folder,'merge','--quiet','--ff-only',saved['commit'])
        finally:
            lock.unlink(missing_ok=True)
    return {**result,'status':'verified_commit_needs_review',
            'committed':True,'commit':saved['commit'],
            'id':saved['definition']['id'],'version':saved['definition']['version']}


if __name__=='__main__':
    try:
        request=json.load(sys.stdin)
        root=request.pop('registry')
        if request.pop('test_only',False):
            result=test_and_commit(root,request) if request.get('commit_after_test') else test_revision(request)
        elif request.pop('validate_only',False):
            result=validate_revision(request)
        else:
            result=register(root,request)
        print(json.dumps(result,ensure_ascii=False))
    except Exception as error:
        result = {'status': 'error', 'message': str(error)}
        if hasattr(error, 'scratch_stage') and request.get('id') and request.get('expected_commit'):
            result = scratch_failure(request, error)
        print(json.dumps(result))
        sys.exit(1)
