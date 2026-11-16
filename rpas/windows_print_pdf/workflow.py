"""Print through the guest GUI; independently validate the new PDF artifact."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time
import uuid
import base64
from robot.api.deco import keyword, library
from robot.libraries.BuiltIn import BuiltIn


@library(scope='SUITE', auto_keywords=False)
class Workflow:
    @keyword
    def require_fhd_desktop(self):
        desktop=BuiltIn().get_library_instance('Desktop')
        if desktop.frame.size!=(1920,1080):raise AssertionError('Expected fixed FHD guest before input')

    @keyword
    def validate_pdf_name(self, name):
        if name == 'auto':
            name = 'vamp-invoice-'+uuid.uuid4().hex+'.pdf'
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}\.pdf', name):
            raise ValueError('Use a plain ASCII .pdf filename')
        self.started = time.time()
        return name

    @keyword
    def require_new_guest_pdf(self, config_path, name):
        self.validate_filename_only(name)
        config = json.loads(Path(config_path).read_text())
        if config['backend'] != 'kvm': raise ValueError('Unsupported verification backend')
        from mcp_vm.controller import VMController
        from mcp_vm.file_transfer import GuestAgent
        agent = GuestAgent(VMController(config['vm_config']), config['vm'])
        try:
            pid = agent.call('guest-exec', path=agent.python,
                arg=['-c','import pathlib,sys; print(int((pathlib.Path(sys.argv[1])/sys.argv[2]).exists()))',agent.root,name],
                **{'capture-output':True})['pid']
            deadline = time.monotonic()+30
            while time.monotonic()<deadline:
                result=agent.call('guest-exec-status',pid=pid)
                if result.get('exited'):
                    if result.get('exitcode') or base64.b64decode(result.get('out-data','')).strip()!=b'0':
                        raise AssertionError('PDF target exists or cannot be verified; use a new filename')
                    return
                time.sleep(.1)
            raise TimeoutError('Guest file preflight timed out')
        finally: agent.close()

    @keyword
    def select_pdf_printer(self):
        desktop = BuiltIn().get_library_instance('Desktop')
        # Korean Windows print-dialog locators, verified on the lab desktop.
        # Park the pointer outside this modal so it cannot cover its button text.
        desktop.remote_move(.98, .5)
        desktop.verify_remote_text('Microsoft Print to PDF', 'printer-verified')
        exact=[line for line in desktop.last_ocr['lines'] if line['text'].strip()=='인쇄']
        if len(exact)==1:
            desktop.click_remote_text('인쇄')
            return
        # A stale software cursor may cover the label in a hypervisor frame.
        # Corroborate a single short Korean label directly left of Cancel.
        anchors=[line for line in desktop.last_ocr['lines'] if line['text'].strip()=='취소' and line['language']=='ko']
        if len(anchors)!=1:raise AssertionError('Cannot uniquely locate the print-dialog Cancel anchor')
        ax1,ay1,ax2,ay2=anchors[0]['xyxy'];cy=(ay1+ay2)/2
        candidates=[]
        for line in desktop.last_ocr['lines']:
            x1,y1,x2,y2=line['xyxy']
            if line['language']=='ko' and 0 < ax1-x2 < 300 and abs((y1+y2)/2-cy)<20 and x2-x1<100:
                candidates.append(line)
        if len(candidates)!=1:raise AssertionError('Cannot uniquely identify the primary print action beside Cancel')
        x1,y1,x2,y2=candidates[0]['xyxy']
        desktop.remote_click((x1+x2)/2/(desktop.frame.width-1),(y1+y2)/2/(desktop.frame.height-1))

    @keyword
    def verify_pdf_artifact(self, config_path, name):
        self.validate_filename_only(name)
        config = json.loads(Path(config_path).read_text())
        target = Path(BuiltIn().get_variable_value('${OUTPUT DIR}'))/name
        if target.exists(): raise ValueError('Choose a new output directory; PDF evidence is never overwritten')
        if config['backend'] == 'kvm':
            from mcp_vm.controller import VMController
            from mcp_vm.file_transfer import get
            controller = VMController(config['vm_config'])
            deadline = time.monotonic()+30
            while True:
                try:
                    get(controller, config['vm'], name, str(target))
                    break
                except RuntimeError:
                    if time.monotonic() >= deadline: raise
                    time.sleep(1)
        else:
            raise ValueError('Unsupported PDF verification backend')
        if not target.read_bytes().startswith(b'%PDF-'): raise AssertionError('Not a PDF')
        metadata = subprocess.run(['pdfinfo', str(target)], capture_output=True, text=True, check=True).stdout
        if 'Microsoft: Print To PDF' not in metadata: raise AssertionError('Expected the native Microsoft PDF printer producer')
        text = subprocess.run(['pdftotext', str(target), '-'], capture_output=True, text=True, check=True).stdout
        verification = 'pdf_text_and_sha256'
        if not text.strip():
            # The Windows printer can emit outlined glyphs without a text layer.
            rendered = target.with_suffix('')
            subprocess.run(['pdftoppm','-scale-to','1600','-png','-singlefile',str(target),str(rendered)],check=True)
            from model_daemon import request
            evidence = request('ocr', {'op':'predict','image':str(rendered.with_suffix('.png')),'languages':['en']})
            rendered.with_suffix('.ocr.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2))
            text = ' '.join(line['text'] for line in evidence['lines'])
            verification = 'rendered_pdf_ocr_and_sha256'
        for expected in ('VAMP ERP Invoice', 'VAMP-2026-001', '192,500'):
            if expected not in text: raise AssertionError('PDF content missing: '+expected)
        return {'status':'succeeded','verification':verification,'pdf':str(target),
                'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'bytes':target.stat().st_size,
                'printer':'Microsoft Print to PDF','expected_total_krw':192500}

    def validate_filename_only(self, name):
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}\.pdf', name): raise ValueError('Invalid PDF name')
