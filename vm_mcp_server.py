#!/usr/bin/env python3
"""Stdio VM MCP server. Keep all diagnostic output off stdout."""
import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager
from typing import Any,Literal
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from mcp_vm.controller import VMController

@asynccontextmanager
async def model_lifespan(server):
    # Detached workers survive the MCP session and are reused by later calls.
    if sys.platform != 'win32' and os.environ.get('VAMP_PRELOAD_MODELS', '1') != '0':
        try:
            from model_daemon import ensure_services
            states=await asyncio.to_thread(ensure_services, wait=False)
            logging.getLogger('vamp').info('Vision workers: %s', sorted(states))
        except (ImportError, OSError, RuntimeError, TimeoutError) as error:
            logging.getLogger('vamp').warning('Vision preload unavailable: %s', error)
    yield {}


mcp=FastMCP('VAMP',lifespan=model_lifespan,instructions='Before repeated CUA, OCR or multimodal work, use the VAMP RPA Library provider rpa_search and rpa_details to find a compatible reviewed skill. Prefer reuse when authorized; read compact results and verify expected outcomes. Fall back to targeted CUA when no suitable skill exists or verification fails. Use VM profiles to keep Debian and Windows RPAs separate. Prefer compact results and OCR. Token efficiency: run reusable RPA and outcome checks locally; on success return compact status, verification and evidence paths. Do not forward full OCR text, YOLO arrays, unchanged screenshots, base64 images, full logs or source into the model context by default. For failure, ambiguity, UI changes or requested inspection, read only a targeted region/query/page first. Local OCR/YOLO reduces model tokens only when outputs stay local or compact; do not claim a measured saving without a comparable benchmark. When authoring or repairing GUI RPAs, include task-specific local OCR/YOLO verification in Python and assert its result in Robot by default; add artifact checks when available. Input dispatch or an arbitrary detection alone is not success. Hyper-V console launch is not RDP input automation. Credentials stay in dedicated local flows.')
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
async def vm_run_rpa(vm_name:str,rpa_id:str,entry:str='run',variables:dict[str,str]|None=None,timeout:int=600,record_video:bool=False) -> dict[str,Any]:
    """Run one compatible RPA and return its compact result. Login submission and recorded replay require their explicit entrypoint/variables. Long CPU OCR tasks may need a client timeout >= timeout."""
    return await invoke(controller.run_rpa,vm_name,rpa_id,entry,variables,timeout,record_video)


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
async def virtualbox_create(iso_path:str,name:str|None=None,memory_mb:int|None=None,cpus:int|None=None,
                            disk_mb:int|None=None,image_index:int=1,windows_confirmed:bool=False,
                            guest_os:str|None=None,preflight_only:bool=False) -> dict[str,Any]:
    """Create a NEW VirtualBox VM and launch unattended install. Disclose public vboxuser/password123! defaults. Starts separate frontend; returns started, not installation verified."""
    from backends.virtualbox.provision import create
    return await invoke(create,iso_path=iso_path,name=name,memory_mb=memory_mb,cpus=cpus,
                        disk_mb=disk_mb,image_index=image_index,windows_confirmed=windows_confirmed,
                        guest_os=guest_os,preflight_only=preflight_only)


@mcp.tool(annotations=WRITE, structured_output=True)
async def vm_create(name: str, image_path: str = '', iso_path: str = '', seed_iso_path: str = '',
                    memory_mb: int = 3072, cpus: int = 2, disk_gb: int = 20, guest_os: Literal['debian', 'windows11'] = 'debian',
                    preseed_path: str = '', setup_script_path: str = '', nested_virtualization: bool = False) -> dict[str, Any]:
    """Create a NEW Debian or Windows KVM/VNC guest from a local standalone qcow2 or installer ISO. Optional cloud-init seed ISO. Never replaces existing VMs; returns boot/install requested, not installed."""
    return await invoke(controller.create_vm, name, image_path, iso_path, seed_iso_path, memory_mb, cpus, disk_gb, guest_os, preseed_path, setup_script_path, nested_virtualization)


@mcp.tool(annotations=WRITE, structured_output=True)
async def vm_lifecycle(vm_name: str,
                       action: Literal['shutdown', 'reboot', 'pause', 'resume', 'snapshot-create', 'snapshot-list', 'snapshot-revert'],
                       snapshot_name: str = '') -> dict[str, Any]:
    """Manage one configured libvirt VM. Snapshot revert replaces guest state; shutdown/reboot are graceful requests. Inspect resulting state separately."""
    return await invoke(controller.lifecycle, vm_name, action, snapshot_name)


@mcp.tool(annotations=READ, structured_output=True)
async def vm_viewer_info(vm_name: str) -> dict[str, Any]:
    """Read the actual loopback VNC TCP endpoint for a VS Code or external viewer. Also works while paused."""
    return await invoke(controller.viewer_info, vm_name)


@mcp.tool(annotations=WRITE, structured_output=True)
async def vm_exchange_prepare(vm_name: str, backend: Literal['kvm','virtualbox','hyperv']='kvm') -> dict[str,Any]:
    """Prepare a VM exchange folder. KVM uses the standard QEMU guest agent; VirtualBox uses Guest Additions shared folders; Hyper-V uses PowerShell Direct with a private credential dialog."""
    return await invoke(controller.exchange,backend,vm_name,'prepare')


@mcp.tool(annotations=WRITE, structured_output=True)
async def vm_file_put(vm_name: str, local_path: str, guest_path: str,
                      backend: Literal['kvm','virtualbox','hyperv']='kvm',overwrite: bool=False,
                      prompt_credentials: bool=False) -> dict[str,Any]:
    """Copy a <=1 GiB host file to a relative path under the VM exchange folder. No file contents in responses. Existing destinations require overwrite=true. VirtualBox returns staged until guest delivery is separately verified."""
    return await invoke(controller.exchange,backend,vm_name,'put',local_path,guest_path,overwrite,prompt_credentials)


@mcp.tool(annotations=WRITE, structured_output=True)
async def vm_file_get(vm_name: str, guest_path: str, local_path: str,
                      backend: Literal['kvm','virtualbox','hyperv']='kvm',overwrite: bool=False,
                      prompt_credentials: bool=False) -> dict[str,Any]:
    """Copy a <=1 GiB VM exchange file to a host path and report size/SHA-256. Hyper-V guest credentials are entered in a private Windows dialog when prompt_credentials=true, never tool arguments."""
    return await invoke(controller.exchange,backend,vm_name,'get',local_path,guest_path,overwrite,prompt_credentials)


if __name__=='__main__':mcp.run(transport='stdio')
