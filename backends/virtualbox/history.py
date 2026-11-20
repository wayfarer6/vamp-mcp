"""Local SQLite execution history plus bounded, optional VirtualBox screen recording."""
from datetime import datetime,timezone
from contextlib import contextmanager
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import uuid
import time
try:
    from .provision import executable,parse
except ImportError:
    from provision import executable,parse


def data_root():return Path(os.environ.get('VAMP_DATA_DIR',Path.home()/'VAMP')).resolve()
def now():return datetime.now(timezone.utc).isoformat()
@contextmanager
def connect():
    root=data_root();root.mkdir(parents=True,exist_ok=True)
    db=sqlite3.connect(root/'history.sqlite3',timeout=15);db.row_factory=sqlite3.Row
    db.executescript('''PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,vm TEXT,status TEXT,started_at TEXT,finished_at TEXT,robot_status TEXT,error_summary TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_vm ON runs(vm) WHERE status='running';
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,run_id TEXT REFERENCES runs(id),kind TEXT,created_at TEXT,payload_json TEXT);
    CREATE TABLE IF NOT EXISTS artifacts(id INTEGER PRIMARY KEY,run_id TEXT REFERENCES runs(id),kind TEXT,path TEXT UNIQUE,created_at TEXT,bytes INTEGER);
    ''')
    try:
        with db:yield db
    finally:db.close()

def run_command(*args):
    proc=subprocess.run([executable(),*map(str,args)],capture_output=True,text=True,timeout=90)
    if proc.returncode:raise RuntimeError(proc.stderr.strip()[:400] or 'VBoxManage command failed')
    return proc.stdout

def event(run_id,kind,payload):
    with connect() as db:db.execute('INSERT INTO events(run_id,kind,created_at,payload_json) VALUES(?,?,?,?)',(run_id,kind,now(),json.dumps(payload)))

def record_event_run(vm, status, kind, payload, observed_at):
    run_id = uuid.uuid4().hex[:16]
    with connect() as db:
        db.execute('INSERT INTO runs VALUES(?,?,?,?,?,?,?)',
                   (run_id, vm, 'finished', observed_at, observed_at, status, None))
        db.execute('INSERT INTO events(run_id,kind,created_at,payload_json) VALUES(?,?,?,?)',
                   (run_id, kind, observed_at, json.dumps(payload)))
    return run_id


def record_elevation_handoff(vm, rpa_id, reason, actions_completed, observed_at, phase, replay_commit, program_name=None):
    payload = {'rpa_id': rpa_id, 'reason': reason, 'actions_completed': actions_completed,
               'policy': 'operator_confirmation_required', 'phase': phase,
               'program_identity': 'unverified', 'replay_commit': replay_commit}
    if program_name is not None:
        payload['program_name_ocr'] = program_name
    return record_event_run(vm, 'operator_handoff', 'elevation_handoff', payload, observed_at)

def row(run_id):
    with connect() as db:r=db.execute('SELECT * FROM runs WHERE id=?',(run_id,)).fetchone()
    if not r:raise ValueError('Unknown run id')
    return dict(r)

def add_artifact(run_id,kind,path):
    path=Path(path).resolve();size=path.stat().st_size
    if not path.is_relative_to(data_root()/'runs'/run_id):raise ValueError('Artifact outside selected run')
    with connect() as db:
        db.execute('INSERT OR REPLACE INTO artifacts(run_id,kind,path,created_at,bytes) VALUES(?,?,?,?,?)',(run_id,kind,str(path),now(),size))
    return {'kind':kind,'path':str(path),'bytes':size}

def capture(run_id,label='screen',run=run_command):
    item=row(run_id)
    if not label.replace('-','').replace('_','').isalnum():raise ValueError('Invalid screenshot label')
    folder=data_root()/'runs'/run_id;folder.mkdir(parents=True,exist_ok=True)
    path=folder/(label+'-'+uuid.uuid4().hex[:6]+'.png')
    run('controlvm',item['vm'],'screenshotpng',path)
    return add_artifact(run_id,'screenshot',path)

def begin(vm,video=False,run=run_command):
    info=parse(run('showvminfo',vm,'--machinereadable'))
    if info.get('VMState')!='running':raise ValueError('Observation requires a running VM; no implicit startup')
    run_id=uuid.uuid4().hex[:16];folder=data_root()/'runs'/run_id;folder.mkdir(parents=True)
    if video and (info.get('recording_started')=='on' or info.get('recording')=='on'):raise ValueError('VM is already recording; do not replace another recording')
    with connect() as db:db.execute('INSERT INTO runs VALUES(?,?,?,?,?,?,?)',(run_id,vm,'running',now(),None,None,None))
    result={'status':'running','run_id':run_id,'vm':vm,'database':str(data_root()/'history.sqlite3'),'video_started':False}
    try:
        if video:
            for setting,value in [('filename',folder/'screen.webm'),('videofps','5'),('maxtime','180'),('maxfilesize','20'),('opts','vc_enabled=true,ac_enabled=false')]:
                run('controlvm',vm,'recording',setting,value)
            run('controlvm',vm,'recording','videores',640,360)
            run('controlvm',vm,'recording','on')
            state=parse(run('showvminfo',vm,'--machinereadable'))
            if state.get('recording_started')=='off':run('controlvm',vm,'recording','start')
            result['video_started']=True
        event(run_id,'start',{'video_started':result['video_started'],'video_limits':{'width':640,'height':360,'fps':5,'seconds':180,'max_mb':20}})
        try:result['start_screenshot']=capture(run_id,'start',run)
        except Exception as exc:event(run_id,'capture_error',{'error':str(exc)[:300]})
        return result
    except Exception as exc:
        # If recording started but later initialization fails, stop our own recording.
        if result['video_started']:
            try:run('controlvm',vm,'recording','off')
            except Exception:pass
        with connect() as db:db.execute('UPDATE runs SET status=?,finished_at=?,error_summary=? WHERE id=?',('failed',now(),str(exc)[:400],run_id))
        raise

def end(run_id,robot_status='completed',run=run_command):
    item=row(run_id)
    if item['status']!='running':return {'status':item['status'],'run_id':run_id,'already_finished':True}
    with connect() as db:
        start=db.execute("SELECT payload_json FROM events WHERE run_id=? AND kind='start' ORDER BY id LIMIT 1",(run_id,)).fetchone()
    if start and json.loads(start[0]).get('video_started'):
        try:run('controlvm',item['vm'],'recording','stop')
        except Exception as exc:event(run_id,'recording_stop_notice',{'error':str(exc)[:300]})
        try:run('controlvm',item['vm'],'recording','off')
        except Exception as exc:event(run_id,'recording_stop_error',{'error':str(exc)[:300]})
        time.sleep(.3)
    try:capture(run_id,'end',run)
    except Exception as exc:event(run_id,'capture_error',{'error':str(exc)[:300]})
    videos=list((data_root()/'runs'/run_id).glob('*.webm'))+list((data_root()/'runs'/run_id).glob('*.mkv'))
    for video in videos:
        if video.stat().st_size:add_artifact(run_id,'video',video)
    with connect() as db:db.execute('UPDATE runs SET status=?,finished_at=?,robot_status=? WHERE id=?',('finished',now(),robot_status,run_id))
    event(run_id,'end',{'robot_status':robot_status})
    return detail(run_id)

def detail(run_id):
    item=row(run_id)
    with connect() as db:
        item['artifact_count']=db.execute('SELECT count(*) FROM artifacts WHERE run_id=?',(run_id,)).fetchone()[0]
        item['artifacts']=[dict(r) for r in db.execute('SELECT * FROM artifacts WHERE run_id=? ORDER BY id DESC LIMIT 30',(run_id,))]
        initial=db.execute("SELECT payload_json FROM events WHERE run_id=? AND kind='start' ORDER BY id LIMIT 1",(run_id,)).fetchone()
        item['video_requested']=bool(initial and json.loads(initial[0]).get('video_started'))
        item['video_saved']=db.execute("SELECT count(*) FROM artifacts WHERE run_id=? AND kind='video' AND bytes>0",(run_id,)).fetchone()[0]>0
        item['evidence_status']='video_saved' if item['video_saved'] else ('video_missing' if item['video_requested'] else 'screenshots_only')
        if item['robot_status'] in ('operator_handoff','scratch_verification_failed') and not item['artifact_count']:
            item['evidence_status']='event_only'
        item['events']=[dict(r) for r in db.execute('SELECT * FROM events WHERE run_id=? ORDER BY id DESC LIMIT 30',(run_id,))]
    return item

def listing(limit=20):
    if not 1<=limit<=100:raise ValueError('History limit must be 1-100')
    with connect() as db:runs=[dict(r) for r in db.execute('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?',(limit,))]
    return {'status':'observed','database':str(data_root()/'history.sqlite3'),'runs':runs}

def artifact(artifact_id):
    with connect() as db:r=db.execute('SELECT * FROM artifacts WHERE id=?',(artifact_id,)).fetchone()
    if not r:raise ValueError('Unknown artifact id')
    item=dict(r);path=Path(item['path']).resolve()
    if not path.is_relative_to(data_root()/'runs'/item['run_id']) or not path.is_file():raise ValueError('Artifact unavailable')
    return item

if __name__=='__main__':
    try:
        args=json.load(sys.stdin);op=args.pop('action','list')
        functions={'begin':begin,'end':end,'capture':capture,'list':listing,'detail':detail,'artifact':artifact}
        print(json.dumps(functions[op](**args)))
    except Exception as exc:print(json.dumps({'status':'failed','error':str(exc)}));sys.exit(1)
