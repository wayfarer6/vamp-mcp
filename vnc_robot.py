"""Shared-session VNC guest transport. No host keyboard/mouse or guest agent."""
import asyncio
from contextlib import asynccontextmanager
import hashlib
import os
from pathlib import Path
import re
import tempfile
import threading
import time
from urllib.parse import urlparse

from PIL import Image
from guest_keys import SHIFTED
from robot.api.deco import keyword, library

KEYS = {'ctrl':'Ctrl', 'alt':'Alt', 'shift':'Shift', 'super':'Super_L',
        'enter':'Return', 'esc':'Escape', 'space':'space', 'backspace':'BackSpace',
        'delete':'Delete', 'tab':'Tab', 'left':'Left', 'right':'Right', 'up':'Up', 'down':'Down'}


@asynccontextmanager
async def podman_client(command):
    import asyncvnc
    process = await asyncio.create_subprocess_exec(
        *command, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
    )
    try:
        yield await asyncvnc.Client.create(process.stdout, process.stdin)
    finally:
        process.stdin.close()
        try:
            await asyncio.wait_for(process.wait(), 2)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()


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

    async def _serve(self, connection, ready):
        self.stop = asyncio.Event()
        try:
            async with connection as client:
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

    async def _connect(self, connection):
        ready = asyncio.get_running_loop().create_future()
        self.task = asyncio.create_task(self._serve(connection, ready))
        await ready

    @keyword
    def connect_vnc(self, uri='vnc://127.0.0.1:5900', timeout=20):
        import asyncvnc
        parsed = urlparse(uri)
        if parsed.scheme != 'vnc' or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError('Use vnc://host:port; credentials must not be embedded in the URI')
        return self._open(uri, asyncvnc.connect(parsed.hostname, parsed.port or 5900,
                                               password=os.environ.get('VAMP_VNC_PASSWORD')), timeout)

    @keyword
    def connect_podman(self, connection, container_id, binding, timeout=20, *, confirmed=False,
                       node='node', cli='vamp-mcp'):
        """Open an explicitly approved Podman desktop without a network viewer."""
        if confirmed is not True or not connection or not all(re.fullmatch('[a-f0-9]{64}', value)
                                                               for value in (container_id, binding)):
            raise ValueError('Approve a checked Podman connection, full container ID and binding first')
        from shutil import which
        entry = which(cli) if cli == 'vamp-mcp' else cli
        if not entry:
            raise RuntimeError('Install the VAMP MCP package or supply the path to its CLI')
        if os.name == 'nt' and Path(entry).suffix.lower() != '.mjs':
            # npm's Windows shim resolves ../package-name from node_modules/.bin.
            shim = Path(entry).absolute()
            modules = shim.parent.parent if shim.parent.name == '.bin' else shim.parent / 'node_modules'
            entry = str(modules / 'vamp-mcp' / 'bin' / 'vamp-mcp.mjs')
        command = [node, entry, 'podman-screen', '--connection', connection, '--id', container_id,
                   '--binding', binding, '--confirmed']
        info = self._open(f'podman:{container_id}', podman_client(command), timeout, 'podman-rfb')
        if (info['width'], info['height']) != (1920, 1080):
            self.disconnect_vnc()
            raise RuntimeError('The Podman desktop must provide a 1920×1080 framebuffer')
        return info

    def _open(self, endpoint, connection, timeout, transport='vnc'):
        if self.loop is not None:
            raise RuntimeError('Disconnect the current desktop first')
        digest = hashlib.sha256(endpoint.encode()).hexdigest()[:16]
        if os.name == 'nt':
            import msvcrt
            self._lock = open(Path(tempfile.gettempdir()) / f'vamp-vnc-{digest}.lock', 'a+b')
            lock = lambda: msvcrt.locking(self._lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            self._lock = open(f'/tmp/vamp-vnc-{os.getuid()}-{digest}.lock', 'a')
            lock = lambda: fcntl.flock(self._lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            lock()
        except OSError:
            self._lock.close()
            self._lock = None
            raise RuntimeError('Another RPA controls this VNC endpoint; observation viewers may still connect')
        self.transport = transport
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()
        try:
            self._run(self._connect(connection), float(timeout))
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
                'transport':self.transport, 'shared_session':True}

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
            if self.transport == 'podman-rfb' and shifted:
                base = SHIFTED[char] if char in SHIFTED else char.lower()
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
