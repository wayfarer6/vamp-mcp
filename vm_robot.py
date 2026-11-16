"""Guest transport facade. Existing Spice library alias remains compatible."""
from robot.api.deco import keyword, library
from guest_vision import GuestVision


@library(scope='SUITE', auto_keywords=False)
class VMRobot(GuestVision):
    def __init__(self):
        self.transport = None

    @keyword
    def connect_spice(self, uri='vnc://127.0.0.1:5900', timeout=20):
        """Compatibility keyword: chooses VNC or SPICE from the actual URI."""
        self.disconnect_spice()
        if uri.startswith('vnc://'):
            from vnc_robot import VncRobot
            self.transport = VncRobot()
            return self.transport.connect_vnc(uri, timeout)
        if uri.startswith(('spice://', 'spice+unix://')):
            from spice_robot import SpiceRobot
            self.transport = SpiceRobot()
            return self.transport.connect_spice(uri, timeout)
        raise ValueError('Expected a vnc:// or spice:// URI')

    @keyword
    def disconnect_spice(self):
        if self.transport:
            if hasattr(self.transport, 'disconnect_vnc'):
                self.transport.disconnect_vnc()
            else:
                self.transport.disconnect_spice()
            self.transport = None

    @property
    def inputs(self):
        return self.transport.inputs

    def _pump(self, seconds=.05):
        return self.transport._pump(seconds)

    def _image(self):
        return self.transport._image()

    @keyword
    def screen_info(self):
        return self.transport.screen_info()

    @keyword
    def capture_guest_screen(self, path='artifacts/guest.png'):
        return self.transport.capture_guest_screen(path)

    @keyword
    def guest_hotkey(self, *keys):
        return self.transport.guest_hotkey(*keys)

    @keyword
    def guest_write(self, text, interval=.03):
        return self.transport.guest_write(text, interval)

    @keyword
    def guest_move_to(self, x, y):
        return self.transport.guest_move_to(x, y)

    @keyword
    def guest_move_relative(self, dx, dy, step=5):
        return self.transport.guest_move_relative(dx, dy, step)

    @keyword
    def guest_click(self, x, y):
        return self.transport.guest_click(x, y)
