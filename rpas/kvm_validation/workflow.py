"""VNC desktop checks with positive on-screen assertions and local-only fixture."""
import json
import re
from pathlib import Path
import time
from robot.api.deco import keyword, library
from robot.libraries.BuiltIn import BuiltIn


@library(scope='SUITE', auto_keywords=False)
class Workflow:
    def __init__(self):
        self.sequence = 0

    @property
    def guest(self):
        return BuiltIn().get_library_instance('Spice')

    @property
    def output(self):
        return Path(BuiltIn().get_variable_value('${OUTPUT DIR}'))

    @keyword
    def wait_for_visible_text(self, text, timeout=45):
        from vision import run_ocr
        deadline = time.monotonic()+float(timeout)
        while time.monotonic() < deadline:
            self.sequence += 1
            image = self.guest.capture_guest_screen(self.output/f'screen-{self.sequence:03}.png')
            lines = run_ocr(self.guest, image, 'en', self.output/f'ocr-{self.sequence:03}.json')
            normalize=lambda value: re.sub(r'\s*-\s*','-',value).casefold()
            found = [line for line in lines if normalize(text) in normalize(line['text']) and line['confidence'] >= .7]
            if found:
                return found
            self.guest._pump(.5)
        raise AssertionError(f'Expected visible text {text!r}; inspect saved screen/OCR evidence')

    @keyword
    def terminal_keyboard_scenario(self):
        # The prepared Openbox desktop owns an xterm. Bring that existing
        # application forward; desktop icon positions and GNOME launchers vary.
        self.guest.guest_hotkey('alt','tab')
        self.guest._pump(.3)
        self.guest.guest_hotkey('ctrl','c')
        marker='VAMP VERIFIED '+time.strftime('%H%M%S')
        encoded=''.join('\\'+format(ord(c),'03o') for c in marker+'\n')
        self.guest.guest_write("clear; printf '"+encoded+"'")
        self.guest.guest_hotkey('enter')
        self.wait_for_visible_text(marker)
        return {'status':'succeeded','verification':'ocr_only','scenario':'terminal_keyboard'}

    @keyword
    def launch_local_browser(self):
        self.guest.guest_write('firefox-esr --new-window http://127.0.0.1:8080 &')
        self.guest.guest_hotkey('enter')
        self.wait_for_visible_text('VAMP KVM Validation', 90)
        self.guest.guest_hotkey('alt','f10')
        self.guest._pump(1)
        self.wait_for_visible_text('Browser ready')
        return {'status':'succeeded','verification':'ocr_only','scenario':'browser_launch'}

    @keyword
    def click_local_button(self):
        lines = self.wait_for_visible_text('Verify click')
        if len(lines) != 1:
            raise AssertionError('Click target is ambiguous')
        line = lines[0]
        box = line['xyxy']
        self.guest.guest_click((box[0]+box[2])//2, (box[1]+box[3])//2)
        self.wait_for_visible_text('CLICK VERIFIED')
        return {'status':'succeeded','verification':'ocr_only','scenario':'mouse_click'}

    @keyword
    def type_into_local_page(self):
        self.guest.guest_hotkey('ctrl','l')
        self.guest.guest_write('http://127.0.0.1:8080')
        self.guest.guest_hotkey('enter')
        self.guest._pump(1)
        self.wait_for_visible_text('Browser ready')
        self.guest.guest_hotkey('tab')
        self.guest.guest_write('VNC-SHARED-INPUT-VERIFIED')
        self.wait_for_visible_text('VNC-SHARED-INPUT-VERIFIED')
        return {'status':'succeeded','verification':'ocr_only','scenario':'browser_keyboard'}

    @keyword
    def analyze_local_page(self):
        result = self.guest.analyze_guest_ui(str(self.output/'ui-analysis.json'), 'en', 'auto')
        assert result['elements'], 'YOLO/OCR produced no elements'
        assert any('VAMP' in e.get('text','') for e in result['elements']), 'Expected page title missing from visual analysis'
        return {'status':'succeeded','verification':'yolo_ocr','scenario':'visual_analysis',
                'element_count':len(result['elements']),'details_path':str(self.output/'ui-analysis.json')}
