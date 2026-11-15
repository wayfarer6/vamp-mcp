"""Separate Windows Hyper-V adapter; never import or connect the SPICE engine."""
import importlib.util
from pathlib import Path
from robot.api.deco import keyword,library
from robot.libraries.BuiltIn import BuiltIn


@library(scope='SUITE',auto_keywords=False)
class Workflow:
    @keyword
    def open_vm_console(self,vm_name,server='localhost',start_vm=False):
        path=Path(__file__).resolve().parents[2]/'scripts/vmconnect.py'
        spec=importlib.util.spec_from_file_location('hyperv_vmconnect',path)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        output=Path(BuiltIn().get_variable_value('${OUTPUT DIR}'))/'native-result.json'
        return module.open_console(vm_name,server,start_vm,output)
