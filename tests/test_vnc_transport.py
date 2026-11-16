"""Exercise the real VNC client against a tiny RFB server, without a second VM."""
import asyncio
import socketserver
import struct
import threading
import unittest
from vnc_robot import VncRobot


class Handler(socketserver.StreamRequestHandler):
    def exact(self, count):
        data=self.rfile.read(count)
        if len(data)!=count:raise EOFError
        return data

    def handle(self):
        try:
            self.wfile.write(b'RFB 003.008\n');self.exact(12)
            self.wfile.write(b'\x01\x01');self.exact(1);self.wfile.write(b'\x00'*4)
            self.server.shared.append(self.exact(1)==b'\x01')
            name=b'VAMP fixture'
            self.wfile.write(struct.pack('>HHBBBBHHHBBBxxxI',4,3,32,24,0,1,255,255,255,0,8,16,len(name))+name)
            while True:
                kind=self.exact(1)[0]
                if kind==0:self.exact(19)
                elif kind==2:
                    count=struct.unpack('>xH',self.exact(3))[0];self.exact(count*4)
                elif kind==3:
                    self.exact(9)
                    self.wfile.write(b'\x00\x00\x00\x01'+struct.pack('>HHHHi',0,0,4,3,0)+bytes([255,0,0,0])*12)
                elif kind==4:
                    packet=self.exact(7);self.server.keys.append((packet[0],int.from_bytes(packet[3:],'big')))
                elif kind==5:self.server.pointers.append(self.exact(5))
                else:raise AssertionError(f'Unexpected RFB message {kind}')
        except (EOFError,ConnectionError,OSError):pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address=True
    daemon_threads=True


class VNCTransportTests(unittest.TestCase):
    def setUp(self):
        self.server=Server(('127.0.0.1',0),Handler)
        self.server.shared=[];self.server.keys=[];self.server.pointers=[]
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.uri=f'vnc://127.0.0.1:{self.server.server_address[1]}'
        self.guest=VncRobot()

    def tearDown(self):
        self.guest.disconnect_vnc();self.server.shutdown();self.server.server_close();self.thread.join()

    def test_shared_handshake_pixels_and_balanced_keyboard_events(self):
        info=self.guest.connect_vnc(self.uri)
        self.assertTrue(info['shared_session']);self.assertEqual((info['width'],info['height']),(4,3))
        self.assertEqual(self.guest._image().getpixel((0,0)),(255,0,0))
        self.guest.guest_hotkey('ctrl','a')
        self.guest._image()  # synchronize prior keyboard events with the server
        self.assertEqual(self.server.shared,[True])
        self.assertEqual(self.server.keys,[(1,65507),(1,97),(0,97),(0,65507)])
        with self.assertRaises(ValueError):self.guest.guest_click(4,0)
        self.assertEqual(self.server.pointers,[])

    def test_text_preserves_uppercase_rfb_keysym_and_releases_shift(self):
        self.guest.connect_vnc(self.uri)
        self.guest.guest_write('Aa',interval=0)
        self.guest._image()
        self.assertEqual(self.server.keys,[(1,65505),(1,65),(0,65),(0,65505),(1,97),(0,97)])

    def test_read_only_viewer_can_coexist_but_second_rpa_is_locked(self):
        self.guest.connect_vnc(self.uri)
        second=VncRobot()
        with self.assertRaisesRegex(RuntimeError,'Another RPA'):second.connect_vnc(self.uri)
        async def observe():
            import asyncvnc
            async with asyncvnc.connect('127.0.0.1',self.server.server_address[1]) as viewer:
                self.assertEqual((await viewer.screenshot()).shape,(3,4,4))
                self.assertEqual(self.guest._image().size,(4,3))
        asyncio.run(observe())
        self.assertEqual(self.server.shared,[True,True])
        self.assertEqual(self.guest._image().size,(4,3))

    def test_uri_credentials_rejected_before_connecting(self):
        with self.assertRaises(ValueError):self.guest.connect_vnc('vnc://user:password@127.0.0.1:5900')
        self.assertEqual(self.server.shared,[])


if __name__=='__main__':unittest.main()
