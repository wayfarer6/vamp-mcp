"""Generated adapter: keep detailed input and coordinates in Python/local data."""
from pathlib import Path
from robot.api.deco import keyword,library
from recording_runtime import RecordedWorkflow


@library(scope='SUITE',auto_keywords=False)
class Workflow(RecordedWorkflow):
    def __init__(self):
        super().__init__(Path(__file__).resolve().parent)

    @keyword
    def verify_naver_login_reached(self,languages='ko,en',device='auto'):
        from robot.libraries.BuiltIn import BuiltIn
        from login_flow import detect_login_form
        from verification import detect_verification
        self.release_recorded_inputs()
        self.spice._pump(2)
        directory=Path(BuiltIn().get_variable_value('${OUTPUT DIR}'))/'destination'
        analysis=self.spice.analyze_guest_ui(str(directory/'ui.json'),languages,device)
        challenge=detect_verification([r for element in analysis['elements'] for r in element.get('readings',[])])
        if challenge['status']!='no_challenge_text':return challenge
        state=detect_login_form(analysis)
        roles=[role for role,element in state.get('form',{}).items() if element['kind']=='ui_region']
        # All semantic fields + browser origin are needed; YOLO must support at least one target region.
        verified=state['status']=='needs_credentials' and bool(roles)
        return {'status':'succeeded' if verified else 'verification_failed',
                'goal':'naver_login_screen_reached','verification':'yolo_ocr',
                'origin_verified':state.get('origin_verified',False),'form_verified':verified,
                'yolo_roles':roles,'login_submitted':False,
                'actions_replayed':self.completed,'details_path':str((directory/'ui.json').resolve()),
                **({} if verified else {'error_summary':state['status']})}
