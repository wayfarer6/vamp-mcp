"""Shared-session VNC guest transport. No host keyboard/mouse or guest agent."""
import asyncio
import fcntl
import hashlib
import os
from pathlib import Path
import threading
import time
from urllib.parse import urlparse

from PIL import Image
from guest_keys import SHIFTED
from robot.api.deco import keyword, library

KEYS = {'ctrl':'Ctrl', 'alt':'Alt', 'shift':'Shift', 'super':'Super_L',
        'enter':'Return', 'esc':'Escape', 'space':'space', 'backspace':'BackSpace',
        'delete':'Delete', 'tab':'Tab', 'left':'Left', 'right':'Right', 'up':'Up', 'down':'Down'}


@library(scope='SUITE', auto_keywords=False)
class VncRobot:
    def __init__(self):
        self.loop = None
        self.thread = None
        self.client = None
        self.frame = None
        self._lock = None
        self.last_capture = 0

    def _run(self, coroutine, timeout=20):
        return asyncio.run_coroutine_threadsafe(coroutine, self.loop).result(timeout)

    async def _serve(self, host, port, ready):
        import asyncvnc
        self.stop = asyncio.Event()
        try:
            async with asyncvnc.connect(host, port, password=os.environ.get('VAMP_VNC_PASSWORD')) as client:
                from vnc_video import enable_resize
                enable_resize(client)
                self.client = client
                self.io_lock = asyncio.Lock()
                ready.set_result(True)
                await self.stop.wait()
        except BaseException as error:
            if not ready.done():
                ready.set_exception(error)
            else:
                raise
        finally:
            self.client = None

    async def _connect(self, host, port):
        ready = asyncio.get_running_loop().create_future()
        self.task = asyncio.create_task(self._serve(host, port, ready))
        await ready

    @keyword
    def connect_vnc(self, uri='vnc://127.0.0.1:5900', timeout=20):
        parsed = urlparse(uri)
        if parsed.scheme != 'vnc' or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError('Use vnc://host:port; credentials must not be embedded in the URI')
        digest = hashlib.sha256(uri.encode()).hexdigest()[:16]
        self._lock = open(f'/tmp/vamp-vnc-{os.getuid()}-{digest}.lock', 'a')
        try:
            fcntl.flock(self._lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self._lock.close()
            self._lock = None
            raise RuntimeError('Another RPA controls this VNC endpoint; observation viewers may still connect')
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()
        try:
            self._run(self._connect(parsed.hostname, parsed.port or 5900), timeout)
            self._capture()
            return self.screen_info()
        except BaseException:
            self.disconnect_vnc()
            raise

    async def _close(self):
        if hasattr(self, 'stop'):
            self.stop.set()
        if hasattr(self, 'task'):
            if self.client is None and not self.task.done():
                self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass

    @keyword
    def disconnect_vnc(self):
        try:
            if self.loop is not None:
                try:
                    self._run(self._close(), 5)
                finally:
                    self.loop.call_soon_threadsafe(self.loop.stop)
                    self.thread.join(timeout=5)
        finally:
            self.loop = self.thread = self.client = self.frame = None
            if self._lock:
                fcntl.flock(self._lock, fcntl.LOCK_UN)
                self._lock.close()
                self._lock = None

    async def _get_frame(self):
        async with self.io_lock:
            pixels = await asyncio.wait_for(self.client.screenshot(), timeout=15)
            return Image.fromarray(pixels).convert('RGB')

    def _capture(self):
        self.frame = self._run(self._get_frame())
        self.last_capture = time.monotonic()
        from spice_recording import sample
        sample(self)
        return self.frame.copy()

    @property
    def surface(self):
        return self.frame is not None

    def _raw_image(self):
        if self.frame is None:
            raise RuntimeError('No VNC frame available')
        return self.frame.copy()

    def _image(self):
        return self._capture()

    def _pump(self, seconds=.05):
        deadline = time.monotonic()+float(seconds)
        while time.monotonic() < deadline:
            if self.client is not None and time.monotonic()-self.last_capture >= .5:
                self._capture()
            time.sleep(min(.02, max(0, deadline-time.monotonic())))

    @keyword
    def screen_info(self):
        image = self._raw_image()
        return {'width':image.width, 'height':image.height, 'mouse_mode':2,
                'transport':'vnc', 'shared_session':True}

    @keyword
    def capture_guest_screen(self, path='artifacts/guest.png'):
        target = Path(path).resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        self._image().save(target)
        return str(target)

    async def _keys(self, keys):
        async with self.io_lock:
            self.client.keyboard.press(*keys)
            await self.client.drain()

    @keyword
    def guest_hotkey(self, *keys):
        mapped = [KEYS.get(k.lower(), k.upper() if k.lower().startswith('f') and k[1:].isdigit() else k) for k in keys]
        self._run(self._keys(mapped))
        self._pump(.08)

    @keyword
    def guest_write(self, text, interval=.03):
        # RFB keysyms; no clipboard injection and no host input.
        import asyncvnc
        unsupported = [char for char in text if char not in asyncvnc.key_codes and char != '\n']
        if unsupported:
            raise ValueError('Unsupported VNC keysyms in text')
        for char in text:
            # RFB carries the resulting keysym. QEMU normalizes lowercase
            # keysyms even while Shift is pressed, so preserve uppercase here.
            base=SHIFTED.get(char, char)
            shifted=char in SHIFTED or char.isupper()
            self._run(self._keys(['Return'] if char=='\n' else (['Shift',base] if shifted else [base])))
            self._pump(float(interval))

    async def _mouse(self, x, y, click=False):
        async with self.io_lock:
            self.client.mouse.move(x, y)
            if click:
                self.client.mouse.click()
            await self.client.drain()

    @keyword
    def guest_move_to(self, x, y):
        x, y = int(x), int(y)
        info = self.screen_info()
        if not 0 <= x < info['width'] or not 0 <= y < info['height']:
            raise ValueError('Coordinates outside guest screen')
        self._run(self._mouse(x, y))
        self._pump(.05)

    @keyword
    def guest_click(self, x, y):
        self.guest_move_to(x, y)
        self._run(self._mouse(int(x), int(y), True))
        self._pump(.15)

    @keyword
    def guest_move_relative(self, dx, dy, step=5):
        raise ValueError('VNC uses absolute guest pixels; use Guest Move To')
