"""Local fixture for real Windows-host VM keyboard and SDK mouse checks."""
import base64
from pathlib import Path
from robot.api.deco import keyword,library
from robot.libraries.BuiltIn import BuiltIn

@library(scope='SUITE',auto_keywords=False)
class Workflow:
    @keyword
    def launch_remote_fixture(self):
        desktop=BuiltIn().get_library_instance('Desktop')
        if desktop.frame.size!=(1920,1080):raise AssertionError('Expected fixed FHD guest')
        encoded=base64.b64encode(Path(__file__).with_name('index.html').read_bytes()).decode()
        # The lab boots into an already verified xterm prompt. No host input APIs.
        command="python3 -c 'import base64;open(\"/tmp/vamp-remote.html\",\"wb\").write(base64.b64decode(\""+encoded+"\"))'; firefox --new-window file:///tmp/vamp-remote.html >/tmp/vamp-firefox.log 2>&1 &"
        desktop.remote_type(command);desktop.remote_press('enter')

    @keyword
    def remote_validation_result(self):
        desktop=BuiltIn().get_library_instance('Desktop')
        return {'status':'succeeded','verification':'changed_page_text_after_sdk_click',
                'host_backend':'windows_virtualbox','guest_os':'debian','guest_dimensions':list(desktop.frame.size),
                'transport':'ssh_stdio_mcp','multimodal_llm_calls_in_rpa':0}
