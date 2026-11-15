"""Robot Framework v3 listener: optional low-resolution video and SQLite evidence."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from history import begin,capture,end,event

class RecordingListener:
    ROBOT_LISTENER_API_VERSION=3
    def __init__(self,vm,video='false'):
        self.vm=vm;self.video=str(video).lower() in ('true','1','yes');self.depth=0;self.run_id=None
    def start_suite(self,data,result):
        self.depth+=1
        if self.depth==1:
            try:self.run_id=begin(self.vm,self.video)['run_id']
            except Exception as exc:
                from robot.api import logger
                logger.warn('VAMP evidence initialization failed: '+str(exc))
    def end_test(self,data,result):
        if self.run_id:
            event(self.run_id,'robot_task',{'name':result.name,'status':result.status,'elapsed_ms':int(result.elapsed_time.total_seconds()*1000)})
            try:capture(self.run_id,'task-'+result.status.lower())
            except Exception as exc:event(self.run_id,'capture_error',{'error':str(exc)[:300]})
    def end_suite(self,data,result):
        if self.depth==1 and self.run_id:
            try:end(self.run_id,result.status)
            except Exception as exc:
                from robot.api import logger
                logger.warn('VAMP evidence finalization failed: '+str(exc))
        self.depth-=1
