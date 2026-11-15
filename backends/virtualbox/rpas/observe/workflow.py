"""Separate VirtualBox Robot library, with no SPICE/GI imports."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from client import VirtualBox

class Workflow(VirtualBox):
    pass

# Robot imports a module path; expose the concrete class methods as keywords.
_library = Workflow()
observe_vm = _library.observe_vm
start_vm = _library.start_vm
call_vm_tool = _library.call_vm_tool
