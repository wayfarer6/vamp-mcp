#!/usr/bin/env python3
"""Stdio VM MCP server. Keep all diagnostic output off stdout."""
import asyncio
from typing import Any,Literal
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from mcp_vm.controller import VMController

mcp=FastMCP('VAMP',instructions='Use VM profiles to keep Debian and Windows RPAs separate. Prefer compact results and OCR. Hyper-V console launch is not RDP input automation. Credentials stay in dedicated local flows.')
controller=VMController()
READ=ToolAnnotations(readOnlyHint=True,destructiveHint=False)
WRITE=ToolAnnotations(readOnlyHint=False,destructiveHint=True)


async def invoke(method,*args,**kwargs):
    try:return await asyncio.to_thread(method,*args,**kwargs)
    except (ValueError,RuntimeError,OSError) as error:
        return {'status':'error','error_summary':str(error)[:300]}


@mcp.tool(annotations=READ,structured_output=True)
async def vm_list() -> dict[str,Any]:
    """List configured libvirt guests, or Windows Hyper-V inventory. Does not start VMs."""
    return await invoke(controller.list_vms)


@mcp.tool(annotations=READ,structured_output=True)
async def vm_rpas() -> dict[str,Any]:
    """List versioned Robot/Python RPA packages and their explicit entrypoints."""
    return await invoke(controller.packages)


@mcp.tool(annotations=WRITE,structured_output=True)
async def vm_start(vm_name:str) -> dict[str,Any]:
    """Explicitly request startup of one configured Off libvirt VM. Never force a saved/paused VM."""
    return await invoke(controller.start_vm,vm_name)


@mcp.tool(annotations=READ,structured_output=True)
async def vm_inspect(vm_name:str,mode:Literal['ocr','analyze','screen-info']='ocr',
                     languages:str='ko,en,ja,zh',query:str='',offset:int=0,limit:int=10) -> dict[str,Any]:
    """Observe the current guest using OCR or YOLO+OCR. A SPICE connection can replace its viewer. Evidence is paged; no automatic image upload."""
    return await invoke(controller.inspect,vm_name,mode,languages,query,offset,limit)


@mcp.tool(annotations=READ,structured_output=True)
async def vm_capture(vm_name:str) -> dict[str,Any]:
    """Capture one guest frame locally and return its path, without model-side image interpretation."""
    return await invoke(controller.capture,vm_name)


@mcp.tool(annotations=WRITE,structured_output=True)
async def vm_input(vm_name:str,action:Literal['click','move','write','hotkey'],
                   text:str='',x:int=0,y:int=0,keys:str='') -> dict[str,Any]:
    """Send explicit guest input. x/y are native guest pixels; hotkeys use ctrl+l syntax. Do not pass private passwords through generic text/Robot logs."""
    return await invoke(controller.input,vm_name,action,text,x,y,keys)


@mcp.tool(annotations=WRITE,structured_output=True)
async def vm_run_rpa(vm_name:str,rpa_id:str,entry:str='run',variables:dict[str,str]|None=None,timeout:int=600) -> dict[str,Any]:
    """Run one compatible RPA and return its compact result. Login submission and recorded replay require their explicit entrypoint/variables. Long CPU OCR tasks may need a client timeout >= timeout."""
    return await invoke(controller.run_rpa,vm_name,rpa_id,entry,variables,timeout)


@mcp.tool(annotations=READ,structured_output=True)
async def vm_read_evidence(path:str,offset:int=0,limit:int=10,query:str='') -> dict[str,Any]:
    """Read bounded, paged JSON evidence under artifacts; never reads private recording/config/source files."""
    return await invoke(controller.read_evidence,path,offset,limit,query)


@mcp.tool(annotations=WRITE,structured_output=True)
async def vm_models(action:Literal['start','status','stop','restart']='status') -> dict[str,Any]:
    """Manage persistent Linux/macOS model processes. They outlive RPA and MCP calls; stop is explicit."""
    return await invoke(controller.models,action)


@mcp.tool(annotations=WRITE,structured_output=True)
async def hyperv_open_console(vm_name:str,server:str='localhost',start_vm:bool=False) -> dict[str,Any]:
    """Windows-only code: normal UAC -> optional VM startup -> vmconnect.exe. Not tested on Windows; no RDP screen/input implementation is claimed."""
    return await invoke(controller.hyperv_console,vm_name,server,start_vm)


@mcp.tool(annotations=WRITE,structured_output=True)
async def vm_recorder_media() -> dict[str,Any]:
    """Build independent GPL guest recorder setup ISO. Does not install, mount or start recording in a VM."""
    from scripts.build_recorder_media import build
    return await invoke(build)


@mcp.tool(annotations=WRITE,structured_output=True)
async def virtualbox_create(iso_path:str,name:str|None=None,memory_mb:int=4096,cpus:int=2,
                            disk_mb:int=65536,image_index:int=1) -> dict[str,Any]:
    """Create a NEW VirtualBox VM and launch unattended install. Disclose public vboxuser/password123! defaults. Starts separate frontend; returns started, not installation verified."""
    from backends.virtualbox.provision import create
    return await invoke(create,iso_path=iso_path,name=name,memory_mb=memory_mb,cpus=cpus,
                        disk_mb=disk_mb,image_index=image_index)


if __name__=='__main__':mcp.run(transport='stdio')
