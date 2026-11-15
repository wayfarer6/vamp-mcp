"""Naver navigation and OCR verification, using only SPICE guest input."""
from pathlib import Path
from robot.api.deco import keyword,library
from robot.libraries.BuiltIn import BuiltIn


@library(scope='SUITE',auto_keywords=False)
class Workflow:
    @keyword
    def navigate_to_naver(self,url='https://www.naver.com'):
        spice=BuiltIn().get_library_instance('Spice')
        spice.guest_hotkey('ctrl','l'); spice.guest_write(url)
        spice.guest_hotkey('enter'); spice._pump(10); spice.guest_hotkey('esc')

    @keyword
    def verify_naver(self):
        from vision import run_ocr
        spice=BuiltIn().get_library_instance('Spice')
        directory=Path(BuiltIn().get_variable_value('${OUTPUT DIR}'))
        screen=spice.capture_guest_screen(directory/'naver.png')
        lines=run_ocr(spice,screen,'en',directory/'naver.ocr.json')
        visible=[line['text'].casefold() for line in lines if line['confidence']>=.7]
        address_ok=any('www.naver.com' in text for text in visible)
        page_ok=any('naver' in text and 'naver.com' not in text for text in visible)
        if not (address_ok and page_ok):
            raise AssertionError('Naver address and page/title text not verified; inspect naver.ocr.json')
        return {'status':'succeeded','verification':'ocr_only','screenshot':screen,
                'details_path':str((directory/'naver.ocr.json').resolve())}
