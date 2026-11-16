"""Live installed VSIX viewer checks: WebSocket frames, endpoint table and reconnect."""
import hashlib
import json
from pathlib import Path
from robot.api.deco import keyword,library
from robot.libraries.BuiltIn import BuiltIn
from backends.kvm.rpas.validation.vault_ui import VaultUI


@library(scope='SUITE',auto_keywords=False)
class ViewerUI(VaultUI):
    @keyword
    def verify_live_vnc_viewer(self):
        self.vm_name=BuiltIn().get_variable_value('${VM_NAME}','vamp-debian-final')
        self.viewer=next((f for f in self.page.frames if f.locator('#vnc-address').count() and self.vm_name in f.locator('table').inner_text() and f.locator('#vnc-address').is_visible()),None)
        if self.viewer is None:
            self.command('VAMP: Open KVM Viewer')
            self.input(self.vm_name)
            self.pause(1)
            self.viewer=next(f for f in self.page.frames if f.locator('#vnc-address').count())
        self.viewer.locator('#status').filter(has_text='연결됨').wait_for(timeout=15000)
        self.metrics={'transport':'rfb-websocket','websockets':0,'received_frames':0,'received_bytes':0,'http_requests':[]}
        def websocket(ws):
            self.metrics['websockets']+=1
            def received(data):
                self.metrics['received_frames']+=1
                self.metrics['received_bytes']+=len(data)
            ws.on('framereceived',received)
        self.page.on('websocket',websocket)
        self.page.on('request',lambda request:self.metrics['http_requests'].append(request.url.split('?')[0]))
        self.viewer.locator('#reconnect').click()
        self.pause(2)
        assert '연결됨' in self.viewer.locator('#status').inner_text()
        assert self.metrics['websockets']>=1, self.metrics
        assert self.metrics['received_frames']>=4 and self.metrics['received_bytes']>1000, self.metrics
        assert not any('screenshot' in url.casefold() or '/capture' in url.casefold() for url in self.metrics['http_requests'])
        address=self.viewer.locator('#vnc-address').inner_text()
        assert address=='127.0.0.1:5900', address
        assert self.vm_name in self.viewer.locator('table').inner_text()
        self.viewer.locator('#copy-address').click();self.viewer.locator('#copy-address').filter(has_text='복사됨').wait_for(timeout=5000)
        canvas=self.viewer.locator('canvas')
        self.metrics['canvas_dimensions']=canvas.evaluate('(c)=>[c.width,c.height]')
        assert self.metrics['canvas_dimensions']==[1920,1080], self.metrics
        self.metrics['view_only']=True
        self.metrics['endpoint']=address
        self.page.screenshot(path=str(self.output/'live-viewer-and-address-table.png'))
        (self.output/'stream-evidence.json').write_text(json.dumps(self.metrics,indent=2))

    @keyword
    def verify_viewer_resize_and_reconnect(self):
        previous=self.viewer.locator('canvas').bounding_box()
        self.page.set_viewport_size({'width':1200,'height':800});self.pause(1)
        resized=self.viewer.locator('canvas').bounding_box()
        assert resized['width']<previous['width'], (previous,resized)
        assert self.viewer.locator('table').is_visible()
        self.page.screenshot(path=str(self.output/'viewer-resized.png'))
        self.viewer.locator('#reconnect').click();self.pause(1.5)
        assert '연결됨' in self.viewer.locator('#status').inner_text()
        self.page.set_viewport_size({'width':1920,'height':1080});self.pause(.5)
        self.page.screenshot(path=str(self.output/'viewer-reconnected.png'))
        (self.output/'resize-evidence.json').write_text(json.dumps({'status':'passed','before':previous,'resized':resized,'reconnected':True},indent=2))
