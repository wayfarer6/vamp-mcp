"""Robot keywords for a persistent remote MCP desktop session, without host input."""
import asyncio
import base64
import concurrent.futures
import io
import json
import os
from pathlib import Path
import queue
import sys
import threading
import time
from PIL import Image
from robot.api.deco import keyword, library
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


@library(scope='SUITE', auto_keywords=False)
class McpDesktopRobot:
    def __init__(self):
        self.frame = None
        self.requests = queue.Queue()
        self.thread = None

    @keyword
    def connect_remote_desktop(self, config_file):
        config = json.loads(Path(config_file).read_text(encoding='utf8'))
        self.vm = config['vm']
        self.output = Path(config.get('evidence_dir', 'artifacts/mcp-desktop')).resolve()
        self.output.mkdir(parents=True, exist_ok=True)
        ready = concurrent.futures.Future()
        async def serve():
            try:
                params = StdioServerParameters(command=config['command'], args=config.get('args', []),
                    env={**os.environ, **config.get('env', {})})
                async with stdio_client(params, errlog=sys.__stderr__) as streams:
                    async with ClientSession(*streams) as session:
                        await session.initialize()
                        ready.set_result(True)
                        while True:
                            request = await asyncio.to_thread(self.requests.get)
                            if request is None: break
                            name, arguments, future = request
                            try:
                                result = await session.call_tool(name, arguments)
                                if result.isError:
                                    raise RuntimeError('; '.join(c.text for c in result.content if c.type == 'text'))
                                future.set_result(result)
                            except Exception as error: future.set_exception(error)
            except BaseException as error:
                if not ready.done(): ready.set_exception(error)
                else:
                    while not self.requests.empty():
                        item = self.requests.get_nowait()
                        if item: item[2].set_exception(RuntimeError(str(error)))
        self.thread = threading.Thread(target=lambda: asyncio.run(serve()), daemon=True)
        self.thread.start()
        ready.result(timeout=60)
        self.capture_remote_screen('initial')

    def call(self, name, **arguments):
        future = concurrent.futures.Future()
        self.requests.put((name, arguments, future))
        return future.result(timeout=90)

    @keyword
    def disconnect_remote_desktop(self):
        if self.thread:
            self.requests.put(None)
            self.thread.join(timeout=15)
            self.thread = None

    @property
    def surface(self): return self.frame is not None

    def _raw_image(self): return self.frame.copy()

    @keyword
    def capture_remote_screen(self, label='screen'):
        if not label.replace('-', '').replace('_', '').isalnum():
            raise ValueError('Use a simple evidence label')
        response = self.call('remote_vm_screenshot', vm=self.vm)
        item = next(c for c in response.content if c.type == 'image')
        self.frame = Image.open(io.BytesIO(base64.b64decode(item.data))).convert('RGB')
        target = self.output/(label+'.png')
        self.frame.save(target)
        from spice_recording import sample
        sample(self)
        return str(target)

    @keyword
    def wait_and_capture(self, seconds=1, label='screen'):
        deadline = time.monotonic()+float(seconds)
        while time.monotonic() < deadline:
            self.capture_remote_screen(label)
            time.sleep(min(.5, max(0, deadline-time.monotonic())))
        return str(self.output/(label+'.png'))

    @keyword
    def remote_chord(self, keys):
        self.call('remote_vm_send_keys', vm=self.vm, hotkey=keys.split('+'))

    @keyword
    def remote_type(self, text):
        self.call('remote_vm_send_keys', vm=self.vm, text=text)

    @keyword
    def remote_press(self, key):
        self.call('remote_vm_send_keys', vm=self.vm, keys=[key])

    @keyword
    def remote_click(self, x, y):
        self.call('remote_vm_mouse_click', vm=self.vm, x=float(x), y=float(y))

    @keyword
    def remote_move(self, x, y):
        self.call('remote_vm_mouse_move', vm=self.vm, x=float(x), y=float(y))

    @keyword
    def verify_remote_text(self, expected, label='verified'):
        path = self.capture_remote_screen(label)
        from model_daemon import request
        result = request('ocr', {'op':'predict', 'image':path, 'languages':['ko','en']})
        (self.output/(label+'.ocr.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2))
        self.last_ocr = result
        text = ' '.join(line['text'] for line in result['lines'])
        if expected.casefold() not in text.casefold():
            raise AssertionError(f'Expected OCR text {expected!r}; inspect {label}.ocr.json')
        return text

    @keyword
    def analyze_remote_screen(self, label='analyzed'):
        path = self.capture_remote_screen(label)
        from model_daemon import request
        result = request('yolo', {'op':'predict', 'image':path, 'device':'auto', 'confidence':.15})
        (self.output/(label+'.yolo.json')).write_text(json.dumps(result,indent=2))
        if not result['targets']: raise AssertionError('No UI regions detected; inspect evidence')
        return {'targets':len(result['targets']), 'service_pid':result['service_pid']}

    @keyword
    def click_remote_text(self, text):
        matches = [line for line in self.last_ocr['lines'] if line['text'].strip() == text]
        if len(matches) != 1: raise AssertionError(f'Expected one exact OCR button {text!r}, found {len(matches)}')
        x1,y1,x2,y2 = matches[0]['xyxy']
        self.remote_click((x1+x2)/2/(self.frame.width-1),(y1+y2)/2/(self.frame.height-1))
