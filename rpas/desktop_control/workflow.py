"""Configurable low-level actions with coordinates and CV handled in Python."""
from pathlib import Path
from robot.api.deco import keyword,library
from robot.libraries.BuiltIn import BuiltIn


@library(scope='SUITE',auto_keywords=False)
class Workflow:
    @keyword
    def perform_desktop_action(self,action='capture',text='',x=0,y=0,keys='',template='',
                               languages='ko,en,ja,zh',device='auto',dx=0,dy=0):
        spice=BuiltIn().get_library_instance('Spice')
        directory=Path(BuiltIn().get_variable_value('${OUTPUT DIR}'))
        if action=='capture':
            return {'status':'captured','screenshot':spice.capture_guest_screen(directory/'guest.png')}
        if action=='screen-info':
            return {'status':'observed',**spice.screen_info()}
        if action=='ocr':
            from vision import run_ocr
            path=spice.capture_guest_screen(directory/'guest.png')
            details=directory/'ocr.json'
            lines=run_ocr(spice,path,languages,details)
            return {'status':'observed','verification':'ocr_only','text_count':len(lines),
                    'details_path':str(details.resolve())}
        if action=='analyze':
            result=spice.analyze_guest_ui(str(directory/'ui.json'),languages,device)
            return {'status':'analyzed','element_count':len(result['elements']),
                    'details_path':str((directory/'ui.json').resolve()),'annotated':result['annotated']}
        if action=='detect':
            result=spice.detect_guest_targets(device=device,output=str(directory/'detections.json'))
            return {'status':'detected','target_count':len(result),'details_path':str((directory/'detections.json').resolve())}
        if action=='click':
            spice.guest_click(x,y)
        elif action=='move':
            spice.guest_move_to(x,y)
        elif action=='move-relative':
            spice.guest_move_relative(dx,dy)
        elif action=='hotkey':
            spice.guest_hotkey(*keys.split('+'))
        elif action=='write':
            spice.guest_write(text)
        elif action=='click-text':
            spice.click_guest_text(text,languages,device)
        elif action=='click-image':
            spice.click_guest_image(template)
        elif action=='find-image':
            return {'status':'found','box':spice.find_guest_image(template)}
        else:
            raise ValueError(f'Unknown desktop action: {action}')
        # Input dispatch is not proof that the application reached a desired state.
        return {'status':'executed','action':action}
