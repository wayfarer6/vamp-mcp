"""Long-lived model worker with private local IPC and in-memory model caches."""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import socketserver
import threading
import time
from model_daemon import PROTOCOL, WINDOWS, file_lock, pipe_address, pipe_key, runtime_dir, socket_path


class ModelState:
    def __init__(self,kind,device):
        self.kind=kind;self.device=device;self.cache={};self.lock=threading.Lock()
        self.ready=False;self.warm_error=None;self.started=time.time();self.requests=0
        self.ocr_models=[]
        self.ocr_device=None
        self.yolo_model = os.environ.get('VAMP_YOLO_MODEL', 'models/omniparser-icon.pt')
        self.yolo_device = None
        self.executor=concurrent.futures.ThreadPoolExecutor(max_workers=1)
        self.warm_future = None
        self.warm_lock = threading.Lock()

    def schedule_warmup(self):
        with self.warm_lock:
            if self.warm_future is None:
                self.warm_future = self.executor.submit(self.warm)

    def paddle_device(self):
        if self.ocr_device is None:
            from ocr_worker import choose_ocr_device
            self.ocr_device = choose_ocr_device(os.environ.get('VAMP_OCR_DEVICE', 'auto'))
        return self.ocr_device

    def warm(self):
        try:
            with self.lock:
                if self.kind=='yolo':
                    from PIL import Image
                    from inference_device import prepare_detector
                    model,device=prepare_detector(self.yolo_model,self.device,self.cache)
                    model.predict(Image.new('RGB',(1280,720)),device=device,imgsz=1280,verbose=False)
                    self.yolo_device = device
                else:
                    from ocr_worker import warmup
                    self.ocr_models=warmup(device=self.paddle_device())
            self.ready=True
        except Exception as error:
            self.warm_error=f'{type(error).__name__}: {error}'[:500]

    def status(self):
        return {'kind':self.kind,'running':True,'ready':self.ready,'pid':os.getpid(),
                'started_at':self.started,'requests':self.requests,'warm_error':self.warm_error,'busy':self.lock.locked(),
                'loaded_models':len(self.cache) if self.kind=='yolo' else len(self.ocr_models),
                'device':self.yolo_device if self.kind=='yolo' else self.ocr_device}

    def predict(self,data):
        image=Path(data['image']).resolve()
        if not image.is_file():raise ValueError('Inference image does not exist')
        started=time.perf_counter()
        with self.lock:
            if self.kind=='ocr':
                from ocr_worker import recognize,_PIPELINES
                lines=recognize(str(image),data.get('languages',['ko','en','ja','zh']),device=self.paddle_device())
                self.ocr_models=list(_PIPELINES)
                result={'lines':lines,'device':self.ocr_device}
            else:
                from inference_device import prepare_detector
                requested = data.get('device')
                model,device=prepare_detector(data.get('model') or self.yolo_model,
                                              self.device if not requested or requested=='auto' else requested,self.cache)
                prediction=model.predict(str(image),device=device,imgsz=1280,
                                          conf=float(data.get('confidence',.35)),verbose=False)[0]
                required_class = data.get('required_class')
                if required_class is not None and required_class not in prediction.names.values():
                    raise ValueError('The detector does not provide the configured class.')
                self.yolo_device = device
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
                if required_class is not None:
                    result['verified_class'] = required_class
            self.requests+=1
            self.ready=True
        return {**result,'elapsed_ms':round((time.perf_counter()-started)*1000,2),
                'service_pid':os.getpid()}


class UnixServer(socketserver.ThreadingMixIn, getattr(socketserver, 'UnixStreamServer', socketserver.TCPServer)):
    daemon_threads=True


def dispatch(server, message):
    stop = False
    try:
        data = json.loads(message)
        if data.get('protocol') != PROTOCOL:
            raise ValueError('Model protocol mismatch')
        state = server.state
        op = data.get('op')
        if op == 'status':
            result = state.status()
        elif op == 'warm':
            state.schedule_warmup()
            result = {'warming': True}
        elif op == 'predict':
            result = state.executor.submit(state.predict, data).result()
        elif op == 'shutdown':
            result = {'stopping': True}
            stop = True
        else:
            raise ValueError('Unsupported model operation')
        response = {'ok': True, 'result': result}
    except Exception as error:
        response = {'ok': False, 'error': f'{type(error).__name__}: {error}'[:500]}
    return json.dumps(response, ensure_ascii=False).encode(), stop


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        response, stop = dispatch(self.server, self.rfile.readline(1024*1024))
        try:
            self.wfile.write(response + b'\n');self.wfile.flush()
        except (BrokenPipeError,ConnectionResetError):pass
        finally:
            if stop:
                threading.Thread(target=self.server.shutdown, daemon=True).start()


class WindowsPipeServer:
    def __init__(self, state):
        from multiprocessing.connection import Listener
        self.state = state
        self.stopped = threading.Event()
        self.listener = Listener(pipe_address(state.kind), family='AF_PIPE', authkey=pipe_key(state.kind))

    def shutdown(self):
        self.stopped.set()

    def serve(self):
        from multiprocessing import AuthenticationError
        def receive(client):
            try:
                with client:
                    response, stop = dispatch(self, client.recv_bytes(1024*1024))
                    client.send_bytes(response)
                    if stop:
                        self.shutdown()
            except (EOFError, OSError):
                pass

        def accept():
            while not self.stopped.is_set():
                try:
                    client = self.listener.accept()
                except (AuthenticationError, EOFError):
                    continue
                except OSError:
                    self.stopped.set()
                    break
                threading.Thread(target=receive, args=(client,), daemon=True).start()

        threading.Thread(target=accept, daemon=True).start()
        try:
            self.stopped.wait()
        finally:
            self.listener.close()


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--kind',choices=['yolo','ocr'],required=True)
    parser.add_argument('--device',default='auto')
    parser.add_argument('--lazy',action='store_true')
    args=parser.parse_args()
    state=ModelState(args.kind,args.device)
    try:
        with file_lock(runtime_dir()/f'{args.kind}.lifetime.lock', blocking=False):
            try:
                if WINDOWS:
                    server = WindowsPipeServer(state)
                    if not args.lazy:
                        state.schedule_warmup()
                    server.serve()
                else:
                    path = socket_path(args.kind)
                    path.unlink(missing_ok=True)
                    try:
                        with UnixServer(str(path), Handler) as server:
                            path.chmod(0o600)
                            server.state = state
                            if not args.lazy:
                                state.schedule_warmup()
                            server.serve_forever(poll_interval=.1)
                    finally:
                        path.unlink(missing_ok=True)
            finally:
                state.executor.shutdown(wait=True, cancel_futures=True)
    except BlockingIOError:
        return


if __name__=='__main__':main()
