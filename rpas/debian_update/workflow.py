"""Debian update package: details remain in the shared OCR-only terminal engine."""
from pathlib import Path
from robot.api.deco import keyword,library
from robot.libraries.BuiltIn import BuiltIn


@library(scope='SUITE',auto_keywords=False)
class Workflow:
    @keyword
    def refresh_debian_indexes(self,config='config/sandbox-vm.json',timeout=300):
        spice=BuiltIn().get_library_instance('Spice')
        output=Path(BuiltIn().get_variable_value('${OUTPUT DIR}'))/'update'
        return spice.update_sandbox_vm(config,str(output),timeout)
