"""Long-lived YOLO/OCR worker using private Unix sockets and in-memory model caches."""
import argparse
import concurrent.futures
import fcntl
import json
import os
from pathlib import Path
import socketserver
import threading
import time
from model_daemon import PROTOCOL,runtime_dir,socket_path


class ModelState:
    def __init__(self,kind,device):
        self.kind=kind;self.device=device;self.cache={};self.lock=threading.Lock()
        self.ready=False;self.warm_error=None;self.started=time.time();self.requests=0
        self.ocr_models=[]
        self.executor=concurrent.futures.ThreadPoolExecutor(max_workers=1)

    def warm(self):
        try:
            with self.lock:
                if self.kind=='yolo':
                    from PIL import Image
                    from inference_device import prepare_detector
                    model,device=prepare_detector('models/omniparser-icon.pt',self.device,self.cache)
                    model.predict(Image.new('RGB',(1280,720)),device=device,imgsz=1280,verbose=False)
                else:
                    from ocr_worker import warmup
                    self.ocr_models=warmup()
            self.ready=True
        except Exception as error:
            self.warm_error=f'{type(error).__name__}: {error}'[:500]

    def status(self):
        return {'kind':self.kind,'running':True,'ready':self.ready,'pid':os.getpid(),
                'started_at':self.started,'requests':self.requests,'warm_error':self.warm_error,'busy':self.lock.locked(),
                'loaded_models':len(self.cache) if self.kind=='yolo' else len(self.ocr_models),
                'device':self.device if self.kind=='yolo' else 'cpu'}

    def predict(self,data):
        image=Path(data['image']).resolve()
        if not image.is_file():raise ValueError('Inference image does not exist')
        started=time.perf_counter()
        with self.lock:
            if self.kind=='ocr':
                from ocr_worker import recognize,_PIPELINES
                lines=recognize(str(image),data.get('languages',['ko','en','ja','zh']))
                self.ocr_models=list(_PIPELINES)
                result={'lines':lines}
            else:
                from inference_device import prepare_detector
                model,device=prepare_detector(data.get('model','models/omniparser-icon.pt'),
                                              data.get('device','auto'),self.cache)
                prediction=model.predict(str(image),device=device,imgsz=1280,
                                          conf=float(data.get('confidence',.35)),verbose=False)[0]
                targets=[]
                for index,box in enumerate(prediction.boxes):
                    coords=[float(v) for v in box.xyxy[0].tolist()]
                    targets.append({'id':index,'label':prediction.names[int(box.cls.item())],
                        'confidence':float(box.conf.item()),'xyxy':coords,
                        'center':[(coords[0]+coords[2])/2,(coords[1]+coords[3])/2]})
                if data.get('annotated'):
                    target=Path(data['annotated']);target.parent.mkdir(parents=True,exist_ok=True)
                    prediction.save(filename=str(target))
                result={'device':device,'targets':targets,'model_speed_ms':prediction.speed}
            self.requests+=1
        return {**result,'elapsed_ms':round((time.perf_counter()-started)*1000,2),
                'service_pid':os.getpid()}


class Server(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):
    daemon_threads=True


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        try:
            data=json.loads(self.rfile.readline(1024*1024))
            if data.get('protocol')!=PROTOCOL:raise ValueError('Model protocol mismatch')
            op=data.get('op')
            if op=='status':result=self.server.state.status()
            elif op=='predict':result=self.server.state.executor.submit(self.server.state.predict,data).result()
            elif op=='shutdown':
                result={'stopping':True}
                threading.Thread(target=self.server.shutdown,daemon=True).start()
            else:raise ValueError('Unsupported model operation')
            response={'ok':True,'result':result}
        except Exception as error:
            response={'ok':False,'error':f'{type(error).__name__}: {error}'[:500]}
        try:
            self.wfile.write(json.dumps(response,ensure_ascii=False).encode()+b'\n');self.wfile.flush()
        except (BrokenPipeError,ConnectionResetError):pass


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--kind',choices=['yolo','ocr'],required=True)
    parser.add_argument('--device',default='auto');args=parser.parse_args()
    path=socket_path(args.kind)
    state=ModelState(args.kind,args.device)
    with (runtime_dir()/f'{args.kind}.lifetime.lock').open('a') as lease:
        try:fcntl.flock(lease,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return
        path.unlink(missing_ok=True)
        with Server(str(path),Handler) as server:
            path.chmod(0o600);server.state=state
            state.executor.submit(state.warm)
            try:server.serve_forever(poll_interval=.1)
            finally:
                path.unlink(missing_ok=True)
                state.executor.shutdown(wait=True,cancel_futures=True)


if __name__=='__main__':main()
