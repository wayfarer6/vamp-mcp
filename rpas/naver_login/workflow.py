"""Visual login package. Credentials stay inside Python, outside Robot arguments."""
from pathlib import Path
from robot.api.deco import keyword,library
from robot.libraries.BuiltIn import BuiltIn


@library(scope='SUITE',auto_keywords=False)
class Workflow:
    @keyword
    def detect_naver_login(self,languages='en',device='auto'):
        from login_flow import prepare
        spice=BuiltIn().get_library_instance('Spice')
        output=Path(BuiltIn().get_variable_value('${OUTPUT DIR}'))/'login'
        return prepare(spice,languages,device,output=str(output))

    @keyword
    def summarize_login_state(self,state):
        result={key:state[key] for key in ['status','origin_verified','message','action','matched_rules'] if key in state}
        result['details_path']=str((Path(BuiltIn().get_variable_value('${OUTPUT DIR}'))/'login/state.json').resolve())
        return result

    @keyword
    def submit_login(self,state,credential_source='environment'):
        from login_flow import read_credentials,fill_and_submit
        if credential_source not in ('environment','prompt'):
            raise ValueError('CREDENTIAL_SOURCE must be environment or prompt')
        spice=BuiltIn().get_library_instance('Spice')
        username,password=read_credentials(credential_source=='prompt',spice)
        try:
            return fill_and_submit(spice,state,username,password)
        finally:
            username=password=None
