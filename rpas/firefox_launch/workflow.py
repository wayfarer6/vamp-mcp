"""Firefox-specific actions; the .robot entrypoint owns execution order."""
from pathlib import Path
from robot.api.deco import keyword,library
from robot.libraries.BuiltIn import BuiltIn


@library(scope='SUITE',auto_keywords=False)
class Workflow:
    @keyword
    def open_firefox(self):
        spice=BuiltIn().get_library_instance('Spice')
        spice.guest_hotkey('alt','f2'); spice._pump(1)
        spice.guest_write('firefox'); spice.guest_hotkey('enter'); spice._pump(5)

    @keyword
    def verify_firefox(self):
        from vision import run_ocr
        spice=BuiltIn().get_library_instance('Spice')
        directory=Path(BuiltIn().get_variable_value('${OUTPUT DIR}'))
        screen=spice.capture_guest_screen(directory/'firefox.png')
        lines=run_ocr(spice,screen,'en',directory/'firefox.ocr.json')
        if not any('firefox' in line['text'].casefold() and line['confidence']>=.7 for line in lines):
            raise AssertionError('Firefox text not verified; inspect firefox.ocr.json')
        return {'status':'succeeded','verification':'ocr_only','screenshot':screen,
                'details_path':str((directory/'firefox.ocr.json').resolve())}
