"""Read-only challenge inspection; no clicking or solving is performed."""
from robot.api.deco import keyword,library
from robot.libraries.BuiltIn import BuiltIn


@library(scope='SUITE',auto_keywords=False)
class Workflow:
    @keyword
    def inspect_challenge(self,languages='ko,en,ja,zh'):
        spice=BuiltIn().get_library_instance('Spice')
        return spice.check_guest_verification(languages)
