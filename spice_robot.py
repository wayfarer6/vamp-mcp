"""Robot Framework library: guest pixels and input through SPICE, no guest agent."""
import ctypes
import fcntl
import hashlib
import os
import json
import time
from pathlib import Path

import gi
gi.require_version('SpiceClientGLib', '2.0')
from gi.repository import GLib, GObject, SpiceClientGLib as Spice
from PIL import Image
from guest_vision import GuestVision
from robot.api.deco import keyword, library

from guest_keys import SCANCODES, SHIFTED


@library(scope='SUITE', auto_keywords=False)
class SpiceRobot(GuestVision):
    def __init__(self):
        self.session = None
        self.inputs = None
        self.display = None
        self.main = None
        self.surface = None
        self.failure = None
        self.models = {}
        self._lock = None
        self._closing = False
        self.inputs_ready = False

    def _pump(self, seconds=0.05):
        deadline = time.monotonic() + float(seconds)
        ctx = GLib.MainContext.default()
        while time.monotonic() < deadline:
            for _ in range(100):
                if not ctx.pending():
                    break
                ctx.iteration(False)
            if self.failure:
                raise RuntimeError(self.failure)
            time.sleep(0.005)
        from spice_recording import sample
        sample(self)

    def _event(self, channel, event):
        if self._closing:
            return
        if event == Spice.ChannelEvent.OPENED and isinstance(channel, Spice.InputsChannel):
            self.inputs_ready = True
        if event == Spice.ChannelEvent.CLOSED:
            self.failure = 'SPICE channel closed; another viewer may have taken the connection'
        if event in (Spice.ChannelEvent.ERROR_CONNECT, Spice.ChannelEvent.ERROR_TLS,
                     Spice.ChannelEvent.ERROR_AUTH, Spice.ChannelEvent.ERROR_IO):
            self.failure = f'SPICE channel failed: {event}'

    def _new_channel(self, session, channel):
        GObject.Object.connect(channel, 'channel-event', self._event)
        if isinstance(channel, Spice.InputsChannel):
            self.inputs = channel
        elif isinstance(channel, Spice.MainChannel):
            self.main = channel
        elif isinstance(channel, Spice.DisplayChannel) and channel.get_property('channel-id') == 0:
            self.display = channel
            GObject.Object.connect(channel, 'display-primary-create', self._primary)
            GObject.Object.connect(channel, 'display-primary-destroy', self._destroy)
        Spice.Channel.connect(channel)

    def _primary(self, channel, fmt, width, height, stride, shmid, data):
        self.surface = (fmt, width, height, stride, data)

    def _destroy(self, channel):
        self.surface = None

    @keyword
    def connect_spice(self, uri='spice://127.0.0.1:5900', timeout=20):
        self._closing = False
        self.inputs_ready = False
        self.failure = None
        digest = hashlib.sha256(uri.encode()).hexdigest()[:16]
        self._lock = open(f'/tmp/spice-rpa-{os.getuid()}-{digest}.lock', 'a')
        try:
            fcntl.flock(self._lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self._lock.close()
            self._lock = None
            raise RuntimeError('Another RPA session controls this SPICE endpoint; wait for it to finish')
        # Screen/input transport also works without optional OCR/YOLO runtimes.
        # Perception requests start and retain their own model workers lazily.
        self.session = Spice.Session()
        self.session.set_property('uri', uri)
        self.session.set_property('enable-audio', False)
        self.session.set_property('enable-usbredir', False)
        GObject.Object.connect(self.session, 'channel-new', self._new_channel)
        if not Spice.Session.connect(self.session):
            raise RuntimeError('SPICE connection could not start')
        deadline = time.monotonic() + float(timeout)
        while not (self.inputs_ready and self.surface):
            if time.monotonic() > deadline:
                self.disconnect_spice()
                raise TimeoutError('Waiting for SPICE inputs and primary display')
            self._pump()
        self._pump(0.5)
        return self.screen_info()

    @keyword
    def disconnect_spice(self):
        self._closing = True
        if self.session:
            self.session.disconnect()
        self.session = self.inputs = self.display = self.main = self.surface = None
        self.inputs_ready = False
        if self._lock:
            fcntl.flock(self._lock, fcntl.LOCK_UN)
            self._lock.close()
            self._lock = None

    @keyword
    def screen_info(self):
        self._pump()
        if not self.surface:
            raise RuntimeError('No SPICE primary surface')
        return {'width': self.surface[1], 'height': self.surface[2],
                'mouse_mode': int(self.main.get_property('mouse-mode'))}

    def _image(self):
        self._pump(0.1)
        return self._raw_image()

    def _raw_image(self):
        if not self.surface:
            raise RuntimeError('No SPICE primary surface')
        fmt, w, h, stride, data = self.surface
        if fmt != 32:
            raise RuntimeError(f'Unsupported SPICE surface format {fmt}; expected xRGB32 (32)')
        # GI exposes the framebuffer as an integer pointer. Copy while on the GLib thread.
        pixels = ctypes.string_at(int(data), abs(stride) * h)
        return Image.frombytes('RGB', (w, h), pixels, 'raw', 'BGRX', abs(stride), 1 if stride > 0 else -1)

    @keyword
    def capture_guest_screen(self, path='artifacts/guest.png'):
        target = Path(path).resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        self._image().save(target)
        return str(target)

    @keyword
    def guest_hotkey(self, *keys):
        codes = [SCANCODES[k.lower()] for k in keys]
        pressed = []
        try:
            for code in codes:
                self.inputs.key_press(code)
                pressed.append(code)
                self._pump(0.04)
        finally:
            for code in reversed(pressed):
                self.inputs.key_release(code)
            self._pump(0.1)

    @keyword
    def guest_write(self, text, interval=0.06):
        # Physical US-layout keys; no clipboard or guest shell transport.
        for char in text:
            base = SHIFTED.get(char, char.lower())
            if base not in SCANCODES:
                raise ValueError(f'Unsupported US keyboard character: {char!r}')
            shift = char in SHIFTED or char.isupper()
            self.guest_hotkey(*(['shift'] if shift else []), base)
            self._pump(float(interval))

    @keyword
    def guest_move_to(self, x, y):
        info = self.screen_info()
        x, y = int(x), int(y)
        if not (0 <= x < info['width'] and 0 <= y < info['height']):
            raise ValueError('Coordinates outside guest screen')
        if info['mouse_mode'] != 2:
            raise RuntimeError('Absolute click requires CLIENT mode; use Guest Move Relative in SERVER mode')
        self.inputs.position(x, y, 0, 0)
        self._pump()

    @keyword
    def guest_move_relative(self, dx, dy, step=5):
        if int(self.main.get_property('mouse-mode')) != 1:
            raise RuntimeError('Relative motion requires SERVER mouse mode')
        dx, dy, step = int(dx), int(dy), int(step)
        if step <= 0:
            raise ValueError('step must be positive')
        while dx or dy:
            sx, sy = max(-step, min(step, dx)), max(-step, min(step, dy))
            self.inputs.motion(sx, sy, 0)
            dx, dy = dx-sx, dy-sy
            self._pump(0.01)

    @keyword
    def guest_click(self, x, y):
        self.guest_move_to(x, y)
        try:
            self.inputs.button_press(1, 1)
            self._pump(0.08)
        finally:
            self.inputs.button_release(1, 0)
            self._pump(0.1)
